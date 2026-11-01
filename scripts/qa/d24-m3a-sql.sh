#!/usr/bin/env bash
# D24 M3-A: run the real M1 + M2-C + M3-A migrations (and the M3-A rollback) against a DISPOSABLE Postgres container.
# Container df-d24-m3a-pg-<pid>: no published ports, no volumes, removed on exit. It never touches any other database.
# Exercises: hardened d24_register_invoice (invoice-id lock, in-function account binding), creation-intent ledger, ownership registry,
# duplicates, concurrency, crash points, cross-tenant, forged account/livemode, out-of-order events, audit, rollback.
# Usage: bash scripts/qa/d24-m3a-sql.sh
set -uo pipefail

NAME=df-d24-m3a-pg-$$
MIG="src/lib/supabase/migrations"
M_CLAIM="$MIG/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="$MIG/20270203110000_d24_hosted_invoice_facts.sql"
M_C="$MIG/20270206090000_d24_m2c_drain_recovery.sql"
M_A="$MIG/20270208090000_d24_m3a_intent_ledger.sql"
M_RB="$MIG/rollback/20270208090000_d24_m3a_intent_ledger_rollback.sql"
cd "$(dirname "$0")/../.."
for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_A" "$M_RB"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"; cleanup' EXIT
cleanup

docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=d24-local-only postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
docker exec "$NAME" pg_isready -U postgres >/dev/null

P="docker exec -i $NAME psql -U postgres -v ON_ERROR_STOP=1 -qAt"
q() { $P -c "$1"; }
as() { docker exec -i "$NAME" psql -U postgres -qAt -c "set role $1; $2" </dev/null 2>&1 | tr '
' ' ' | sed -E 's/^SET //; s/ERROR:  /ERR /' | sed -E 's/ +$//' | cut -c1-900; }
try() { docker exec -i "$NAME" psql -U postgres -qAt -c "$1" </dev/null 2>&1 | tr '
' ' ' | sed -E 's/ERROR:  /ERR /' | cut -c1-500; }
# st "<expression>" -> "STATE <sqlstate> <message>" or "NOSTATE" (runs the expression inside a catching DO block)
st() { try "do \$\$ begin perform $1; raise notice 'NOSTATE'; exception when others then raise notice 'STATE % %', sqlstate, sqlerrm; end \$\$"; }

$P <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;
create table public.studios (id uuid primary key default gen_random_uuid(), name text, stripe_connected_account_id text);
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text,
  created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
for f in "$M_CLAIM" "$M_D24" "$M_C"; do docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null || { echo "prerequisite migration failed: $f"; exit 2; }; done
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_A" >/dev/null || { echo "M3A migration failed to apply"; exit 2; }

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi; }
has() { check "$1" "$(echo "$2" | grep -c -F -- "$3")" "1"; }

SA=00000000-0000-0000-0000-00000000005a
SB=00000000-0000-0000-0000-00000000005b
SC=00000000-0000-0000-0000-00000000005c   # no connected account
SD=00000000-0000-0000-0000-00000000005d   # malformed account
O1=00000000-0000-0000-0000-0000000000a1
ACT=00000000-0000-0000-0000-0000000000c1
H=hash1
q "insert into public.studios (id, name, stripe_connected_account_id) values ('$SA','A','acct_aaa'),('$SB','B','acct_bbb'),('$SC','C',null),('$SD','D','platform')" >/dev/null

claim() { q "select (public.claim_payment_provider_event('stripe','$1','x','$H','${2:-$O1}'))->>'outcome'"; }
ap() { local acct="null"; [ "$5" != "null" ] && acct="'$5'"
  q "select public.d24_apply_event('$1','${7:-$O1}','$3',$4,$acct,${9:-false},'${8:-$H}','$2','$6'::jsonb)::text"; }
pj() { echo "{\"invoice_id\":\"$1\",\"object_id\":\"$2\",\"status\":\"paid\",\"amount_requested\":$3,\"amount_paid\":$3,\"currency\":\"usd\"}"; }
reg() { q "select (public.d24_register_invoice('$1',$2,'$3',false,'event_fee','bo-$3'))->>'outcome'"; }
rowof() { q "select $3 from public.hosted_invoices where stripe_invoice_id='$2' and coalesce(stripe_account_id,'')='$1'"; }
# age an intent (test fixture only: needs the writer flag the d24 functions set)
age() { q "begin; select set_config('d24.writer','on',true); update public.hosted_invoice_creation_intents set updated_at = now() - interval '$2' where id='$1'; commit;" >/dev/null; }

# 1. shape, privileges ---------------------------------------------------------------------------------------------------------
check "3 new tables exist" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name in ('hosted_invoice_creation_intents','hosted_invoice_creation_intent_events','hosted_invoice_business_object_types')")" "3"
check "RLS on all 3 new tables" "$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('hosted_invoice_creation_intents','hosted_invoice_creation_intent_events','hosted_invoice_business_object_types') and c.relrowsecurity")" "3"
check "service_role holds SELECT only on the new tables" "$(q "select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where grantee='service_role' and (table_name like 'hosted_invoice_creation%' or table_name='hosted_invoice_business_object_types')")" "SELECT"
check "anon/authenticated/public hold no privilege on the new tables" "$(q "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated','public') and (table_name like 'hosted_invoice_creation%' or table_name='hosted_invoice_business_object_types')")" "0"
for fn in "d24_intent_begin(uuid,text,text,text,uuid)" "d24_intent_mark_provider_created(uuid,uuid,text,boolean,boolean,text)" "d24_intent_register(uuid,uuid)" "d24_intent_fail(uuid,uuid,text,boolean)" "d24_intent_abandon(uuid,uuid,text,integer)" "d24_intent_list_recoverable(integer,integer,uuid)" "d24_register_invoice(uuid,text,text,boolean,text,text,uuid)"; do
  check "service_role may execute $fn" "$(q "select has_function_privilege('service_role','public.$fn','execute')")" "t"
  check "anon/authenticated may not execute $fn" "$(q "select has_function_privilege('anon','public.$fn','execute') or has_function_privilege('authenticated','public.$fn','execute')")" "f"
done
for fn in "_d24_studio_account(uuid)" "_d24_check_owner(uuid,text,text)" "_d24_intent_lock(uuid,uuid)" "_d24_intent_event(uuid,uuid,text,text,text,text)" "d24_register_business_object_type(text,regprocedure)"; do
  check "service_role may NOT execute helper $fn" "$(q "select has_function_privilege('service_role','public.$fn','execute')")" "f"
done
check "every SECURITY DEFINER d24 function pins its search_path" "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%d24%' and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=%', false)")" "0"
check "the ownership registry is EMPTY by default" "$(q "select count(*) from public.hosted_invoice_business_object_types")" "0"
check "service_role cannot write the ownership registry" "$(as service_role "insert into public.hosted_invoice_business_object_types values ('x','public.d24_intent_register(uuid,uuid)'::regprocedure)" | grep -c 'permission denied')" "1"
check "service_role cannot write intents directly" "$(as service_role "insert into public.hosted_invoice_creation_intents (studio_id,business_object_type,business_object_id,idempotency_key,stripe_account_id) values ('$SA','event_fee','x1','key-direct-1','acct_aaa')" | grep -c 'permission denied')" "1"
check "even the owner role is refused a direct intent insert (no writer flag)" "$(as postgres "insert into public.hosted_invoice_creation_intents (studio_id,business_object_type,business_object_id,idempotency_key,stripe_account_id) values ('$SA','event_fee','x1','key-direct-1','acct_aaa')" | grep -c 'only allowed through the d24 functions')" "1"

# 2. hardened d24_register_invoice (M2-A blockers) -------------------------------------------------------------------------------
check "registration resolves the account from the studio (no assertion)" "$(reg $SA null in_r1)" "registered"
check "...and stored it" "$(q "select stripe_account_id from public.hosted_invoice_registry where stripe_invoice_id='in_r1'")" "acct_aaa"
check "idempotent re-registration" "$(reg $SA null in_r1)" "already_registered"
check "idempotent with a matching account assertion" "$(reg $SA "'acct_aaa'" in_r1)" "already_registered"
has "a studio with no connected account is refused" "$(st "public.d24_register_invoice('$SC',null,'in_r2',false,'event_fee','bo')")" "STATE 42501 d24_studio_account_unavailable"
has "a malformed (platform) studio account is refused" "$(st "public.d24_register_invoice('$SD',null,'in_r2',false,'event_fee','bo')")" "STATE 42501 d24_studio_account_unavailable"
has "an unknown studio is refused" "$(st "public.d24_register_invoice('00000000-0000-0000-0000-0000000000ff',null,'in_r2',false,'event_fee','bo')")" "STATE 42501 d24_studio_account_unavailable"
has "a supplied account that is not the studio's is refused (forgery)" "$(st "public.d24_register_invoice('$SA','acct_bbb','in_r2',false,'event_fee','bo')")" "STATE 42501 d24_account_mismatch"
has "binding a studio to someone else's account is impossible" "$(st "public.d24_register_invoice('$SB','acct_aaa','in_r2',false,'event_fee','bo')")" "STATE 42501 d24_account_mismatch"
has "NULL livemode is refused" "$(st "public.d24_register_invoice('$SA',null,'in_r2',null,'event_fee','bo')")" "STATE 22023"
has "a malformed invoice id is refused" "$(st "public.d24_register_invoice('$SA',null,'garbage',false,'event_fee','bo')")" "STATE 22023"
check "none of the refusals registered anything" "$(q "select count(*) from public.hosted_invoice_registry")" "1"
has "studio B cannot register studio A's invoice id under B's own account" "$(st "public.d24_register_invoice('$SB',null,'in_r1',false,'event_fee','bo-in_r1')")" "STATE 23505 d24_invoice_id_scope_conflict"
check "...and no second registry row exists for it" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_r1'")" "1"
has "the same studio with a different object is still a conflict" "$(st "public.d24_register_invoice('$SA',null,'in_r1',false,'event_fee','other')")" "STATE 23505 d24_registration_conflict"
# scope-conflict must not flag the legitimate owner's facts: an A event arrives, B tries to take the id
claim evt_r1 >/dev/null
ap evt_r1 invoice_payment invoice_payment.paid 30000 acct_aaa "$(pj in_r1 inpay_r1 10)" >/dev/null
st "public.d24_register_invoice('$SB',null,'in_r1',false,'event_fee','bo-in_r1')" >/dev/null
check "A's facts are attributed and NOT flagged account_scope_mismatch after B's refused attempt" "$(rowof acct_aaa in_r1 "studio_id = '$SA' and not (anomaly_codes @> array['account_scope_mismatch'])")" "t"
# concurrent: 6 sessions per studio racing to register the same invoice id
for i in 1 2 3 4 5 6; do
  ( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SA',null,'in_race',false,'event_fee','bo-race')" </dev/null >"$TMPD/ra_$i.txt" 2>&1 ) &
  ( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SB',null,'in_race',false,'event_fee','bo-race')" </dev/null >"$TMPD/rb_$i.txt" 2>&1 ) &
done
wait
check "12-way two-studio race leaves exactly ONE registry row for the invoice id" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_race'")" "1"
check "no race session deadlocked" "$(cat "$TMPD"/ra_*.txt "$TMPD"/rb_*.txt | grep -c 'deadlock detected')" "0"
check "every loser got the deterministic scope conflict (no raw unique violation)" "$(cat "$TMPD"/ra_*.txt "$TMPD"/rb_*.txt | grep -c 'duplicate key')" "0"
# 14h replacement a: two registrations with crossed scopes no longer deadlock; they serialize
( docker exec -i "$NAME" psql -U postgres -qAt -c "begin; select public.d24_register_invoice('$SA',null,'in_dl2',false,'event_fee','bo-dl2'); select pg_sleep(2); commit;" </dev/null >"$TMPD/dl2_1.txt" 2>&1 ) &
sleep 1
( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SB',null,'in_dl2',false,'event_fee','bo-dl2')" </dev/null >"$TMPD/dl2_2.txt" 2>&1 ) &
wait
check "(was 14h) two crossed-scope registrations no longer deadlock" "$(cat "$TMPD"/dl2_1.txt "$TMPD"/dl2_2.txt | grep -c 'deadlock detected')" "0"
check "...the second is refused with the scope conflict" "$(grep -c 'd24_invoice_id_scope_conflict' "$TMPD/dl2_2.txt")" "1"
check "...exactly one registration for A exists" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_dl2' and studio_id='$SA'")" "1"
# 14h replacement b: a registration crossing a drain-style holder of two key locks still deadlocks once, safely
claim evt_dla >/dev/null; claim evt_dlb >/dev/null
ap evt_dla invoice_payment invoice_payment.paid 31000 acct_dla "$(pj in_dl inpay_dla 11)" >/dev/null
ap evt_dlb invoice_payment invoice_payment.paid 31001 acct_dlb "$(pj in_dl inpay_dlb 22)" >/dev/null
SNAP=$(q "select (select count(*) from public.hosted_invoice_source_events)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_invoices)")
( docker exec -i "$NAME" psql -U postgres -qAt -c "begin; select pg_advisory_xact_lock(hashtextextended('d24:acct_dla:in_dl',0)); select pg_sleep(3); select pg_advisory_xact_lock(hashtextextended('d24:acct_aaa:in_dl',0)); commit;" </dev/null >"$TMPD/dl_1.txt" 2>&1 ) &
sleep 1
( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SA',null,'in_dl',false,'event_fee','bo-in_dl')" </dev/null >"$TMPD/dl_2.txt" 2>&1 ) &
wait
check "(14h kept) a register crossing a two-key holder deadlocks for exactly one session (40P01)" "$(cat "$TMPD"/dl_1.txt "$TMPD"/dl_2.txt | grep -c 'deadlock detected')" "1"
reg $SA null in_dl >/dev/null
check "...retry registers exactly once" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_dl'")" "1"
check "...retry is idempotent" "$(reg $SA null in_dl)" "already_registered"
check "...no duplicate evidence rows" "$(q "select (select count(*) from public.hosted_invoice_source_events)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_invoices)")" "$SNAP"
check "...the foreign scope is not attributed and is flagged" "$(rowof acct_dla in_dl "studio_id is null")/$(rowof acct_dla in_dl "anomaly_codes @> array['account_scope_mismatch']")" "t/t"
# reconnect: the studio's account changed; registrations follow the studio, assertions of the old account are refused
q "update public.studios set stripe_connected_account_id='acct_aaa2' where id='$SA'" >/dev/null
has "after a reconnect the OLD account assertion is refused" "$(st "public.d24_register_invoice('$SA','acct_aaa','in_r9',false,'event_fee','bo')")" "STATE 42501 d24_account_mismatch"
check "...and a fresh registration binds the CURRENT account" "$(reg $SA null in_r9)" "registered"
check "...stored under the current account" "$(q "select stripe_account_id from public.hosted_invoice_registry where stripe_invoice_id='in_r9'")" "acct_aaa2"
q "update public.studios set stripe_connected_account_id='acct_aaa' where id='$SA'" >/dev/null

# 3. ownership registry ------------------------------------------------------------------------------------------------------
q "create table public.qa_objects (id text primary key, studio_id uuid not null)" >/dev/null
q "insert into public.qa_objects values ('o-a1','$SA'),('o-a2','$SA'),('o-a3','$SA'),('o-a4','$SA'),('o-a5','$SA'),('o-a6','$SA'),('o-a7','$SA'),('o-a8','$SA'),('o-a9','$SA'),('o-a10','$SA'),('o-a11','$SA'),('o-b1','$SB'),('o-b2','$SB')" >/dev/null
$P <<'SQL'
create function public.d24_owns_qa_event_fee(p_studio uuid, p_obj text) returns boolean language sql stable
  set search_path = pg_catalog, public as $$ select exists (select 1 from public.qa_objects where id = p_obj and studio_id = p_studio) $$;
create function public.qa_volatile_owner(p_studio uuid, p_obj text) returns boolean language sql volatile as $$ select true $$;
create function public.qa_wrong_sig(p_studio uuid) returns boolean language sql stable as $$ select true $$;
SQL
KEY1=idem-a1-0000001
has "begin on an unregistered type fails closed" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$ACT')")" "STATE 22023 d24_business_object_type_unsupported"
check "...and wrote nothing" "$(q "select count(*) from public.hosted_invoice_creation_intents")" "0"
has "a volatile ownership function cannot be registered" "$(st "public.d24_register_business_object_type('event_fee','public.qa_volatile_owner(uuid,text)'::regprocedure)")" "STATE 22023"
has "a wrong-signature ownership function cannot be registered" "$(st "public.d24_register_business_object_type('event_fee','public.qa_wrong_sig(uuid)'::regprocedure)")" "STATE 22023"
has "a subscription-named type cannot be registered" "$(st "public.d24_register_business_object_type('studio_subscription','public.d24_owns_qa_event_fee(uuid,text)'::regprocedure)")" "STATE 23514"
q "select public.d24_register_business_object_type('event_fee','public.d24_owns_qa_event_fee(uuid,text)'::regprocedure)" >/dev/null
check "registering the real ownership function works (owner only)" "$(q "select count(*) from public.hosted_invoice_business_object_types")" "1"
has "service_role cannot call the registrar" "$(as service_role "select public.d24_register_business_object_type('x','public.d24_owns_qa_event_fee(uuid,text)'::regprocedure)")" "permission denied"

# 4. begin ------------------------------------------------------------------------------------------------------------------
B1=$(q "select public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$ACT')")
check "begin creates a pending intent" "$(echo "$B1" | grep -o '"outcome": "[a-z]*"')/$(echo "$B1" | grep -o '"status": "[a-z_]*"')" '"outcome": "created"/"status": "pending"'
I1=$(q "select ('$B1'::jsonb)->>'intent_id'")
check "the account is resolved from the studio, not supplied" "$(q "select stripe_account_id from public.hosted_invoice_creation_intents where id='$I1'")" "acct_aaa"
check "begin audited creation" "$(q "select string_agg(event_kind||':'||coalesce(from_status,'-')||'>'||to_status, ',') from public.hosted_invoice_creation_intent_events where intent_id='$I1'")" "created:->pending"
check "replay of begin with the same key is idempotent" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$ACT'))->>'outcome'")" "existing"
check "...same intent id" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$ACT'))->>'intent_id'")" "$I1"
check "...attempt_count counts the retries (1 + 2)" "$(q "select attempt_count from public.hosted_invoice_creation_intents where id='$I1'")" "3"
check "...still one row" "$(q "select count(*) from public.hosted_invoice_creation_intents")" "1"
has "same key, different object: key conflict" "$(st "public.d24_intent_begin('$SA','event_fee','o-a2','$KEY1')")" "STATE 23505 d24_idempotency_key_conflict"
has "different key, same live object: refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','idem-a1-0000002')")" "STATE 23505 d24_object_has_live_intent"
has "cross-studio object (B's object, A's request) is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-b1','idem-x-0000001')")" "STATE 42501 d24_business_object_not_owned"
has "nonexistent object is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-none','idem-x-0000002')")" "STATE 42501 d24_business_object_not_owned"
has "a studio without a connected account is refused" "$(st "public.d24_intent_begin('$SC','event_fee','o-a1','idem-x-0000003')")" "STATE 42501 d24_studio_account_unavailable"
has "a subscription type is refused before any lookup" "$(st "public.d24_intent_begin('$SA','studio_subscription','o-a1','idem-x-0000004')")" "STATE 22023"
has "a malformed key is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','short')")" "STATE 22023"
has "NULL studio is refused" "$(st "public.d24_intent_begin(null,'event_fee','o-a1','idem-x-0000005')")" "STATE 22023"
check "refusals wrote nothing" "$(q "select count(*) from public.hosted_invoice_creation_intents")" "1"
check "the same idempotency key in ANOTHER studio is an independent intent" "$(q "select (public.d24_intent_begin('$SB','event_fee','o-b1','$KEY1'))->>'outcome'")" "created"
# concurrent begins, same key
for i in $(seq 1 10); do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select (public.d24_intent_begin('$SA','event_fee','o-a2','idem-conc-0000001'))->>'outcome'" </dev/null >"$TMPD/cb_$i.txt" 2>&1 ) & done
wait
check "10 concurrent begins (same key): exactly one created" "$(cat "$TMPD"/cb_*.txt | grep -c '^created$')/$(cat "$TMPD"/cb_*.txt | grep -c '^existing$')" "1/9"
check "...one row" "$(q "select count(*) from public.hosted_invoice_creation_intents where idempotency_key='idem-conc-0000001'")" "1"
# concurrent begins, different keys, same object
for i in $(seq 1 8); do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select (public.d24_intent_begin('$SA','event_fee','o-a3','idem-obj-000000$i'))->>'outcome'" </dev/null >"$TMPD/ob_$i.txt" 2>&1 ) & done
wait
check "8 concurrent begins (different keys, one object): exactly one live intent" "$(q "select count(*) from public.hosted_invoice_creation_intents where business_object_id='o-a3'")" "1"
check "...the losers got the deterministic refusal" "$(cat "$TMPD"/ob_*.txt | grep -c 'd24_object_has_live_intent')" "7"

# 5. mark_provider_created ----------------------------------------------------------------------------------------------------
mk() { q "select (public.d24_intent_mark_provider_created('$1','${2:-$SA}','$3',${4:-false},${5:-false},${6:-null}))->>'outcome'"; }
has "livemode from Stripe must match the key mode (live invoice, test key)" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','in_m1',true,false)")" "STATE 42501 d24_livemode_mismatch"
has "...(test invoice, live key)" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','in_m1',false,true)")" "STATE 42501 d24_livemode_mismatch"
has "NULL livemode refused" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','in_m1',null,false)")" "STATE 22023"
has "NULL key mode refused" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','in_m1',false,null)")" "STATE 22023"
has "a forged account assertion is refused" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','in_m1',false,false,'acct_bbb')")" "STATE 42501 d24_account_mismatch"
has "a malformed invoice id is refused" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','not_an_invoice',false,false)")" "STATE 22023"
has "another studio cannot mark A's intent (indistinguishable from missing)" "$(st "public.d24_intent_mark_provider_created('$I1','$SB','in_m1',false,false)")" "STATE 42501 d24_intent_not_found"
has "an unknown intent id is the same refusal" "$(st "public.d24_intent_mark_provider_created('00000000-0000-0000-0000-0000000000ee','$SA','in_m1',false,false)")" "STATE 42501 d24_intent_not_found"
check "refusals left the intent pending" "$(q "select status from public.hosted_invoice_creation_intents where id='$I1'")" "pending"
check "mark records Stripe's invoice id + livemode" "$(mk $I1 $SA in_m1 false false "'acct_aaa'")" "provider_created"
check "mark is idempotent" "$(mk $I1 $SA in_m1)" "already_recorded"
has "mark with a different invoice id is refused" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','in_m2',false,false)")" "STATE 23505 d24_intent_invoice_conflict"
check "the recorded values" "$(q "select stripe_invoice_id||'/'||livemode||'/'||status from public.hosted_invoice_creation_intents where id='$I1'")" "in_m1/false/provider_created"
I2=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a4','idem-a4-0000001'))->>'intent_id'")
has "an invoice id already on another intent is refused" "$(st "public.d24_intent_mark_provider_created('$I2','$SA','in_m1',false,false)")" "STATE 23505"
# account changed between begin and mark
I8=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a8','idem-a8-0000001'))->>'intent_id'")
q "update public.studios set stripe_connected_account_id='acct_changed' where id='$SA'" >/dev/null
has "begin retry after a reconnect is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a4','idem-a4-0000001')")" "STATE 42501 d24_account_changed"
check "mark after a reconnect STILL records the invoice (it exists at Stripe under the intent's account; never orphan it)" "$(mk $I8 $SA in_m8 false false "'acct_aaa'")" "provider_created"
has "register after a reconnect is refused" "$(st "public.d24_intent_register('$I8','$SA')")" "STATE 42501 d24_account_changed"
has "register of another intent after a reconnect is refused too" "$(st "public.d24_intent_register('$I1','$SA')")" "STATE 42501 d24_account_changed"
q "update public.studios set stripe_connected_account_id=null where id='$SA'" >/dev/null
has "register after the account was removed is refused" "$(st "public.d24_intent_register('$I8','$SA')")" "STATE 42501 d24_studio_account_unavailable"
q "update public.studios set stripe_connected_account_id='acct_aaa' where id='$SA'" >/dev/null
check "the reconnect-orphan candidate is recoverable once the binding is restored" "$(q "select (public.d24_intent_register('$I8','$SA'))->>'outcome'")" "registered"

# 6. register: crash points, atomicity, out-of-order, no settlement inference --------------------------------------------------------
PAYS=$(q "select count(*) from public.hosted_invoice_payments")
q "update public.qa_objects set studio_id='$SB' where id='o-a1'" >/dev/null
has "register fails when the object no longer belongs to the studio" "$(st "public.d24_intent_register('$I1','$SA')")" "STATE 42501 d24_business_object_not_owned"
check "...intent stays provider_created (Stripe success, DB failure: no half state)" "$(q "select status from public.hosted_invoice_creation_intents where id='$I1'")" "provider_created"
check "...nothing was registered" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m1'")" "0"
check "the app records the failure (retryable) and the intent stays recoverable" "$(q "select (public.d24_intent_fail('$I1','$SA','ownership_check_failed'))->>'outcome'")" "recorded"
age $I1 "1 hour"
check "list_recoverable returns the provider_created intent" "$(q "select (public.d24_intent_list_recoverable(15,50,'$SA')) @> jsonb_build_array(jsonb_build_object('intent_id','$I1','status','provider_created'))")" "t"
q "update public.qa_objects set studio_id='$SA' where id='o-a1'" >/dev/null
# webhook event BEFORE registration, forged metadata
claim evt_m1 >/dev/null
ap evt_m1 invoice_payment invoice_payment.paid 32000 acct_aaa "{\"invoice_id\":\"in_m1\",\"object_id\":\"inpay_m1\",\"status\":\"paid\",\"amount_requested\":50,\"amount_paid\":50,\"currency\":\"usd\",\"metadata_studio\":\"$SB\"}" >/dev/null
check "an event before registration is preserved unattributed" "$(rowof acct_aaa in_m1 "studio_id is null")" "t"
RG=$(q "select public.d24_intent_register('$I1','$SA')")
check "register succeeds and adopts the earlier event" "$(echo "$RG" | grep -o '"outcome": "[a-z_]*"')/$(echo "$RG" | grep -o '"adopted_existing_facts": [a-z]*')" '"outcome": "registered"/"adopted_existing_facts": true'
check "...attributed to the registering studio (forged metadata not trusted)" "$(rowof acct_aaa in_m1 "studio_id = '$SA'")" "t"
check "intent is registered and linked to the registry row" "$(q "select (status = 'registered' and registry_id = (select id from public.hosted_invoice_registry where stripe_invoice_id='in_m1' and studio_id='$SA')) from public.hosted_invoice_creation_intents where id='$I1'")" "t"
check "register is idempotent (lost reply)" "$(q "select (public.d24_intent_register('$I1','$SA'))->>'outcome'")" "already_registered"
check "creation/registration inferred no settlement: the only new payment fact is Stripe's own event" "$(q "select count(*) from public.hosted_invoice_payments")" "$((PAYS + 1))"
claim evt_m1b >/dev/null
ap evt_m1b invoice_payment invoice_payment.paid 32001 acct_aaa "$(pj in_m1 inpay_m1b 5)" >/dev/null
check "an event AFTER registration matches the registry" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_id='in_m1' and studio_id='$SA'")" "2"
has "register cannot be called by another studio" "$(st "public.d24_intent_register('$I1','$SB')")" "STATE 42501 d24_intent_not_found"
has "a pending intent cannot be registered" "$(st "public.d24_intent_register('$I2','$SA')")" "STATE 55000 d24_intent_state"
check "crash after begin: retry begin reuses the pending intent" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a4','idem-a4-0000001'))->>'intent_id'")" "$I2"
# crash point (owner rule): Stripe succeeded but the process died before ANY DB update. Recovery must work from the PENDING intent alone.
I11=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a10','idem-a10-000001','$ACT'))->>'intent_id'")
check "crash point: the intent is pending and holds no provider data" "$(q "select status||'/'||coalesce(stripe_invoice_id,'-') from public.hosted_invoice_creation_intents where id='$I11'")" "pending/-"
R1=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a10','idem-a10-000001','$ACT'))->>'outcome'")
check "retry: begin resumes the SAME pending intent" "$R1/$(q "select (public.d24_intent_begin('$SA','event_fee','o-a10','idem-a10-000001','$ACT'))->>'intent_id'")" "existing/$I11"
check "retry: replaying the same key makes Stripe return the same invoice; pending -> provider_created" "$(mk $I11 $SA in_m10 false false "'acct_aaa'")" "provider_created"
check "...-> registered" "$(q "select (public.d24_intent_register('$I11','$SA'))->>'outcome'")" "registered"
check "...a SECOND full replay of the whole sequence is idempotent and converges" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a10','idem-a10-000001','$ACT'))->>'outcome'")/$(mk $I11 $SA in_m10)/$(q "select (public.d24_intent_register('$I11','$SA'))->>'outcome'")" "existing_terminal/already_recorded/already_registered"
check "...exactly one registry row, one intent, no second invoice" "$(q "select (select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m10')||'/'||(select count(*) from public.hosted_invoice_creation_intents where business_object_id='o-a10')")" "1/1"
# the same crash with a replay that returns a DIFFERENT invoice id must not converge silently
I12=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a11','idem-a11-000001'))->>'intent_id'")
mk $I12 $SA in_m11 >/dev/null
has "a replay that yields a different invoice id is refused, never a second invoice" "$(st "public.d24_intent_mark_provider_created('$I12','$SA','in_m12',false,false)")" "STATE 23505 d24_intent_invoice_conflict"
# a later business-object package registers its ownership function with ONE call and no edit to any M3-A function
$P <<'SQL'
create table public.qa_client_invoices (id text primary key, studio_id uuid not null);
insert into public.qa_client_invoices values ('ci-1', '00000000-0000-0000-0000-00000000005a');
create function public.d24_owns_studio_client_invoice(p_studio uuid, p_obj text) returns boolean language sql stable
  set search_path = pg_catalog, public as $$ select exists (select 1 from public.qa_client_invoices where id = p_obj and studio_id = p_studio) $$;
SQL
has "before registration the new type fails closed" "$(st "public.d24_intent_begin('$SA','studio_client_invoice','ci-1','idem-ci1-000001')")" "STATE 22023 d24_business_object_type_unsupported"
q "select public.d24_register_business_object_type('studio_client_invoice','public.d24_owns_studio_client_invoice(uuid,text)'::regprocedure)" >/dev/null
check "after the single registration call begin works for the new type" "$(q "select (public.d24_intent_begin('$SA','studio_client_invoice','ci-1','idem-ci1-000001'))->>'outcome'")" "created"
has "...and still refuses another studio's object of that type" "$(st "public.d24_intent_begin('$SB','studio_client_invoice','ci-1','idem-ci1-000002')")" "STATE 42501 d24_business_object_not_owned"
q "delete from public.hosted_invoice_business_object_types where business_object_type='studio_client_invoice'" >/dev/null
has "removing the registry row (the new package's rollback) fails closed again" "$(st "public.d24_intent_begin('$SA','studio_client_invoice','ci-1','idem-ci1-000003')")" "STATE 22023 d24_business_object_type_unsupported"
# concurrent registers on one intent
I5=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a5','idem-a5-0000001'))->>'intent_id'")
mk $I5 $SA in_m5 >/dev/null
for i in $(seq 1 8); do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select (public.d24_intent_register('$I5','$SA'))->>'outcome'" </dev/null >"$TMPD/cr_$i.txt" 2>&1 ) & done
wait
check "8 concurrent registers: one registered, the rest already_registered" "$(cat "$TMPD"/cr_*.txt | grep -c '^registered$')/$(cat "$TMPD"/cr_*.txt | grep -c '^already_registered$')" "1/7"
check "...one registry row" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m5'")" "1"
# a direct registration of the same invoice under a different object, then the intent register
I6=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a6','idem-a6-0000001'))->>'intent_id'")
mk $I6 $SA in_m6 >/dev/null
reg $SA null in_m6 >/dev/null
has "intent_register after a direct registration with a DIFFERENT object is a conflict, not a takeover" "$(st "public.d24_intent_register('$I6','$SA')")" "STATE 23505 d24_registration_conflict"
check "...intent stays provider_created" "$(q "select status from public.hosted_invoice_creation_intents where id='$I6'")" "provider_created"

# 7. fail / abandon / list_recoverable ------------------------------------------------------------------------------------------
I7=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a7','idem-a7-0000001'))->>'intent_id'")
FO=$(q "select (public.d24_intent_fail('$I7','$SA','stripe_timeout'))->>'outcome'")
check "a retryable failure keeps the intent recoverable" "$FO/$(q "select status||'/'||failure_count||'/'||last_error_code from public.hosted_invoice_creation_intents where id='$I7'")" "recorded/pending/1/stripe_timeout"
check "free text / hostile error codes are sanitized" "$(q "select (public.d24_intent_fail('$I7','$SA','Card 4242 declined: secret sk_live_x'))->>'last_error_code'")" "unsanitized_error_code"
has "abandon of a fresh pending intent is refused (creator may be in flight)" "$(st "public.d24_intent_abandon('$I7','$SA')")" "STATE 55000 d24_intent_too_recent"
age $I7 "2 hours"
has "the abandon age floor cannot be lowered by the caller (Stripe key window)" "$(st "public.d24_intent_abandon('$I7','$SA','x',1)")" "STATE 55000 d24_intent_too_recent"
age $I7 "26 hours"
check "list_recoverable includes it once idle" "$(q "select (public.d24_intent_list_recoverable(15,50,'$SA')) @> jsonb_build_array(jsonb_build_object('intent_id','$I7'))")" "t"
check "list_recoverable honours the idle threshold (not listed when idle < threshold)" "$(q "select (public.d24_intent_list_recoverable(2000,50,'$SA')) @> jsonb_build_array(jsonb_build_object('intent_id','$I7'))")" "f"
check "list_recoverable excludes terminal intents" "$(q "select (public.d24_intent_list_recoverable(1,200,null)) @> jsonb_build_array(jsonb_build_object('intent_id','$I1'))")" "f"
check "list_recoverable is bounded (limit clamped)" "$(q "select jsonb_array_length(public.d24_intent_list_recoverable(1,0,null)) <= 1 and jsonb_array_length(public.d24_intent_list_recoverable(-5,100000,null)) <= 200")" "t"
check "list_recoverable studio filter" "$(q "select count(*) from jsonb_array_elements(public.d24_intent_list_recoverable(1,200,'$SB')) e where e->>'studio_id' <> '$SB'")" "0"
check "abandon after the idle window works" "$(q "select (public.d24_intent_abandon('$I7','$SA','operator_gave_up'))->>'outcome'")" "abandoned"
check "an abandoned object can be re-invoiced under a new key" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a7','idem-a7-0000002'))->>'outcome'")" "created"
has "abandon of a provider_created intent is refused" "$(st "public.d24_intent_abandon('$I6','$SA','x',1)")" "STATE 55000 d24_intent_state"
has "a permanent fail of an intent whose invoice is already registered is refused (would free the slot for a duplicate)" "$(st "public.d24_intent_fail('$I6','$SA','registration_conflict',true)")" "STATE 55000 d24_intent_registered_elsewhere"
I9=$(q "select (public.d24_intent_begin('$SA','event_fee','o-a9','idem-a9-0000001'))->>'intent_id'")
mk $I9 $SA in_m9 >/dev/null
FO=$(q "select (public.d24_intent_fail('$I9','$SA','registration_rejected',true))->>'outcome'")
check "permanent failure is terminal" "$FO/$(q "select status from public.hosted_invoice_creation_intents where id='$I9'")" "failed/failed"
check "fail on a terminal intent is a no-op" "$(q "select (public.d24_intent_fail('$I9','$SA','again',true))->>'outcome'")" "noop_terminal"
check "...failure_count unchanged" "$(q "select failure_count from public.hosted_invoice_creation_intents where id='$I9'")" "1"
has "mark on a failed intent is refused" "$(st "public.d24_intent_mark_provider_created('$I9','$SA','in_m7',false,false)")" "STATE 55000 d24_intent_state"
check "begin on a terminal key reports existing_terminal (caller must not call Stripe)" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a9','idem-a9-0000001'))->>'outcome'")" "existing_terminal"
check "...and does not bump attempt_count" "$(q "select attempt_count from public.hosted_invoice_creation_intents where id='$I9'")" "1"
I10=$(q "select (public.d24_intent_begin('$SB','event_fee','o-b2','idem-b2-0000001'))->>'intent_id'")
q "alter table public.hosted_invoice_creation_intents disable trigger hosted_invoice_intents_guard_trg; update public.hosted_invoice_creation_intents set created_at = now() - interval '30 hours' where id='$I10'; alter table public.hosted_invoice_creation_intents enable trigger hosted_invoice_intents_guard_trg" >/dev/null
check "a pending intent older than the Stripe key window reports stale_key (reconcile with Stripe first)" "$(q "select (public.d24_intent_begin('$SB','event_fee','o-b2','idem-b2-0000001'))->>'outcome'")" "stale_key"
check "...and is not silently re-attempted (attempt_count unchanged)" "$(q "select attempt_count from public.hosted_invoice_creation_intents where id='$I10'")" "1"
has "fail by another studio is refused" "$(st "public.d24_intent_fail('$I2','$SB','x')")" "STATE 42501 d24_intent_not_found"

# 8. audit + guards -------------------------------------------------------------------------------------------------------------
check "audit of I1: created, provider_created, failure_recorded, registered" "$(q "select string_agg(event_kind, ',' order by id) from public.hosted_invoice_creation_intent_events where intent_id='$I1'")" "created,provider_created,failure_recorded,registered"
check "audit rows carry codes only (no free text)" "$(q "select count(*) from public.hosted_invoice_creation_intent_events where error_code !~ '^[a-z][a-z0-9_]{0,63}\$'")" "0"
check "audit events are append-only (update)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intent_events set error_code='x' where intent_id='$I1'" | grep -c 'append-only')" "1"
check "audit events are append-only (delete)" "$(as postgres "select set_config('d24.writer','on',false); delete from public.hosted_invoice_creation_intent_events" | grep -c 'append-only')" "1"
check "audit events are append-only (truncate)" "$(as postgres "truncate public.hosted_invoice_creation_intent_events" | grep -c 'append-only')" "1"
check "intents cannot be deleted" "$(as postgres "select set_config('d24.writer','on',false); delete from public.hosted_invoice_creation_intents where id='$I1'" | grep -c 'cannot be deleted')" "1"
check "intents cannot be truncated" "$(as postgres "truncate public.hosted_invoice_creation_intents" | grep -c -E 'append-only|foreign key')" "1"
check "a terminal intent cannot change" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set last_error_code='x' where id='$I1'" | grep -c 'terminal intent cannot change')" "1"
check "an illegal transition is refused (registered -> pending)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set status='pending' where id='$I1'" | grep -c 'illegal intent transition')" "1"
check "identity columns are immutable (studio)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set studio_id='$SB' where id='$I2'" | grep -c 'identity columns are immutable')" "1"
check "identity columns are immutable (account)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set stripe_account_id='acct_bbb' where id='$I2'" | grep -c 'identity columns are immutable')" "1"
check "pending cannot jump to registered" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set status='registered' where id='$I2'" | grep -c -E 'illegal intent transition|violates check')" "1"
check "a recorded provider invoice cannot be swapped" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set stripe_invoice_id='in_other' where id='$I5'" | grep -c 'cannot change')" "1"
check "counters cannot decrease" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set attempt_count=1 where id='$I2' and attempt_count>1" | grep -c 'cannot decrease')" "1"
check "no intent function created credit notes or status transitions" "$(q "select (select count(*) from public.hosted_credit_notes)||'/'||(select count(*) from public.hosted_invoice_status_transitions)")" "0/0"

# 9. rollback + re-apply ------------------------------------------------------------------------------------------------------
r=$(docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_RB" 2>&1 | tr -d '\n' | cut -c1-140)
has "rollback is refused while intent evidence exists" "$r" "rollback refused"
check "refused rollback left the schema intact" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "2"
docker exec "$NAME" psql -U postgres -qAt -c "create database d24m3fresh" >/dev/null
F="docker exec -i $NAME psql -U postgres -d d24m3fresh -v ON_ERROR_STOP=1 -qAt"
$F <<'SQL'
create schema if not exists public;
create table public.studios (id uuid primary key default gen_random_uuid(), stripe_connected_account_id text);
create table public.payment_provider_events (id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text, created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
$F < "$M_CLAIM" >/dev/null 2>&1; $F < "$M_D24" >/dev/null 2>&1
M1FN=$($F -c "select md5(pg_get_functiondef('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)'::regprocedure))")
$F < "$M_A" >/dev/null 2>&1
check "fresh DB: migration applies" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "2"
check "fresh DB: register_invoice is the hardened body" "$($F -c "select pg_get_functiondef('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)'::regprocedure) like '%d24inv:%'")" "t"
$F < "$M_RB" >/dev/null 2>&1
check "fresh DB: rollback removes every M3-A object" "$($F -c "select (select count(*) from information_schema.tables where table_schema='public' and (table_name like 'hosted_invoice_creation%' or table_name='hosted_invoice_business_object_types'))||'/'||(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'd24_intent%' or p.proname in ('_d24_studio_account','_d24_check_owner','_d24_intent_guard','_d24_bot_guard','_d24_intent_json','_d24_intent_lock','_d24_intent_event','_d24_clean_code','d24_register_business_object_type')))")" "0/0"
check "fresh DB: rollback restores the M1 d24_register_invoice VERBATIM" "$($F -c "select md5(pg_get_functiondef('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)'::regprocedure))")" "$M1FN"
$F < "$M_A" >/dev/null 2>&1
check "fresh DB: migration re-applies after rollback" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "2"
$F -c "insert into public.studios values ('$SA','acct_aaa')" >/dev/null
$F -c "create function public.d24_owns_x(uuid,text) returns boolean language sql stable as 'select true'" >/dev/null
$F -c "select public.d24_register_business_object_type('event_fee','public.d24_owns_x(uuid,text)'::regprocedure)" >/dev/null
$F -c "select public.d24_intent_begin('$SA','event_fee','o1','idem-fresh-0001')" >/dev/null
{ echo "set d24.m3a_rollback_exported='yes';"; cat "$M_RB"; } | $F >/dev/null 2>&1
check "rollback with the export acknowledgement removes evidence-bearing tables" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "0"

echo "SQL RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
