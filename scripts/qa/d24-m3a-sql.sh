#!/usr/bin/env bash
# D24 M3-A: run the real M1 + M2-C + M2-B + M3-A migrations (and the M3-A rollback) against a DISPOSABLE Postgres container.
# Container df-d24-m3a-pg-<pid>: no published ports, no volumes, removed on exit. It never touches any other database.
# Exercises: hardened d24_register_invoice (invoice-id lock, in-function account binding), creation-intent ledger (fingerprint, safe-retry window, needs_review,
# recovery lease, attempt history, operator reconciliation), ownership registry, duplicates, concurrency, crash points, cross-tenant, forged account/livemode,
# out-of-order events, audit, rollback.
# Usage: bash scripts/qa/d24-m3a-sql.sh
set -uo pipefail

NAME=df-d24-m3a-pg-$$
MIG="src/lib/supabase/migrations"
M_CLAIM="$MIG/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="$MIG/20270203110000_d24_hosted_invoice_facts.sql"
M_C="$MIG/20270206090000_d24_m2c_drain_recovery.sql"
M_B="$MIG/20270207090000_d24_operator_actions.sql"
M_A="$MIG/20270208090000_d24_m3a_intent_ledger.sql"
M_RB="$MIG/rollback/20270208090000_d24_m3a_intent_ledger_rollback.sql"
STUB="scripts/qa/d24/stubs/auth-roles.sql"
cd "$(dirname "$0")/../.."
for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_B" "$M_A" "$M_RB" "$STUB"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done

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
# run as an authenticated end user: asu USER_UUID AAL SQL  (AAL = aal1|aal2|none)
asu() {
  local claims exp; exp=$(( $(date +%s) + 3600 ))
  case "$2" in
    none) claims='{}' ;;
    *) claims="{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"$2\",\"exp\":$exp}" ;;
  esac
  docker exec -i "$NAME" psql -U postgres -qAt -c "set role authenticated; select set_config('request.jwt.claims', '$claims', false) is not null; $3" </dev/null 2>&1 \
    | tr '
' ' ' | sed -E 's/^SET t //; s/ERROR:  /ERR /' | sed -E 's/ +$//' | cut -c1-700
}

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
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$STUB" >/dev/null || { echo "auth stub failed"; exit 2; }
for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_B"; do docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null || { echo "prerequisite migration failed: $f"; exit 2; }; done
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
PLAT=00000000-0000-0000-0000-0000000000b1   # platform admin
OWA=00000000-0000-0000-0000-0000000000b2    # studio owner of SA
OWB=00000000-0000-0000-0000-0000000000b3    # studio owner of SB
NOB=00000000-0000-0000-0000-0000000000b4    # no role
H=hash1
FP=$(printf 'a%.0s' $(seq 1 64))
FP2=$(printf 'b%.0s' $(seq 1 64))
q "insert into public.studios (id, name, stripe_connected_account_id) values ('$SA','A','acct_aaa'),('$SB','B','acct_bbb'),('$SC','C',null),('$SD','D','platform')" >/dev/null
q "insert into public.profiles values ('$PLAT','platform_admin'),('$OWA',null),('$OWB',null),('$NOB',null)" >/dev/null
q "insert into public.user_studio_roles (user_id, studio_id, role) values ('$OWA','$SA','studio_owner'),('$OWB','$SB','studio_owner')" >/dev/null

claim() { q "select (public.claim_payment_provider_event('stripe','$1','x','$H','${2:-$O1}'))->>'outcome'"; }
ap() { local acct="null"; [ "$5" != "null" ] && acct="'$5'"
  q "select public.d24_apply_event('$1','${7:-$O1}','$3',$4,$acct,${9:-false},'${8:-$H}','$2','$6'::jsonb)::text"; }
pj() { echo "{\"invoice_id\":\"$1\",\"object_id\":\"$2\",\"status\":\"paid\",\"amount_requested\":$3,\"amount_paid\":$3,\"currency\":\"usd\"}"; }
reg() { q "select (public.d24_register_invoice('$1',$2,'$3',false,'event_fee','bo-$3'))->>'outcome'"; }
rowof() { q "select $3 from public.hosted_invoices where stripe_invoice_id='$2' and coalesce(stripe_account_id,'')='$1'"; }
# begin STUDIO TYPE OBJ KEY [FP] -> intent id
bg() { q "select (public.d24_intent_begin('$1','$2','$3','$4','${5:-$FP}'))->>'intent_id'"; }
# claim recovery: cr INTENT [FP] [STUDIO] -> outcome/replay_permitted
cr() { q "select (public.d24_intent_claim_recovery('$1','${3:-$SA}','${2:-$FP}'))->>'outcome'||'/'||(public.d24_intent_claim_recovery('$1','${3:-$SA}','${2:-$FP}'))->>'replay_permitted'" ; }
crj() { q "select public.d24_intent_claim_recovery('$1','${3:-$SA}','${2:-$FP}')"; }
st_of() { q "select status from public.hosted_invoice_creation_intents where id='$1'"; }
# test fixtures only: they need the writer flag / bypass the identity guard that the real functions satisfy
age() { q "begin; select set_config('d24.writer','on',true); update public.hosted_invoice_creation_intents set updated_at = now() - interval '$2' where id='$1'; commit;" >/dev/null; }
ageC() { q "alter table public.hosted_invoice_creation_intents disable trigger hosted_invoice_intents_guard_trg; update public.hosted_invoice_creation_intents set created_at = now() - interval '$2' where id='$1'; alter table public.hosted_invoice_creation_intents enable trigger hosted_invoice_intents_guard_trg" >/dev/null; }

# 1. shape, privileges ---------------------------------------------------------------------------------------------------------
check "5 new tables exist" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name in ('hosted_invoice_creation_intents','hosted_invoice_creation_intent_events','hosted_invoice_creation_attempts','hosted_invoice_creation_config','hosted_invoice_business_object_types')")" "5"
check "RLS on all 5 new tables" "$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('hosted_invoice_creation_intents','hosted_invoice_creation_intent_events','hosted_invoice_creation_attempts','hosted_invoice_creation_config','hosted_invoice_business_object_types') and c.relrowsecurity")" "5"
check "service_role holds SELECT only on the new tables" "$(q "select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where grantee='service_role' and (table_name like 'hosted_invoice_creation%' or table_name='hosted_invoice_business_object_types')")" "SELECT"
check "anon/authenticated/public hold no privilege on the new tables" "$(q "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated','public') and (table_name like 'hosted_invoice_creation%' or table_name='hosted_invoice_business_object_types')")" "0"
for fn in "d24_intent_begin(uuid,text,text,text,text,uuid)" "d24_intent_mark_provider_created(uuid,uuid,text,boolean,boolean,text)" "d24_intent_register(uuid,uuid)" "d24_intent_fail(uuid,uuid,text,boolean)" "d24_intent_record_outcome(uuid,uuid,text,boolean)" "d24_intent_claim_recovery(uuid,uuid,text,integer)" "d24_intent_flag_review(uuid,uuid,text)" "d24_intent_list_recoverable(integer,integer,uuid)" "d24_register_invoice(uuid,text,text,boolean,text,text,uuid)"; do
  check "service_role may execute $fn" "$(q "select has_function_privilege('service_role','public.$fn','execute')")" "t"
  check "anon/authenticated may not execute $fn" "$(q "select has_function_privilege('anon','public.$fn','execute') or has_function_privilege('authenticated','public.$fn','execute')")" "f"
done
for fn in "d24_op_flag_creation_review(uuid,text)" "d24_op_attach_creation_invoice(uuid,text,boolean,text,text)" "d24_op_abandon_creation(uuid,text)" "d24_op_list_creation_reviews(integer)"; do
  check "authenticated may execute $fn (checks inside)" "$(q "select has_function_privilege('authenticated','public.$fn','execute')")" "t"
  check "service_role/anon may NOT execute $fn" "$(q "select has_function_privilege('service_role','public.$fn','execute') or has_function_privilege('anon','public.$fn','execute')")" "f"
done
for fn in "_d24_studio_account(uuid)" "_d24_check_owner(uuid,text,text)" "_d24_intent_lock(uuid,uuid)" "_d24_safe_window()" "_d24_attempt(uuid,uuid,text,text,boolean)" "d24_intent_set_window(integer)" "d24_register_business_object_type(text,regprocedure)"; do
  check "service_role may NOT execute helper $fn" "$(q "select has_function_privilege('service_role','public.$fn','execute')")" "f"
done
check "every SECURITY DEFINER d24 function pins its search_path" "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%d24%' and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=%', false)")" "0"
check "the ownership registry is EMPTY by default" "$(q "select count(*) from public.hosted_invoice_business_object_types")" "0"
check "the safe-retry window defaults to 12h" "$(q "select safe_retry_minutes from public.hosted_invoice_creation_config")" "720"
check "service_role cannot write the ownership registry" "$(as service_role "insert into public.hosted_invoice_business_object_types values ('x','public.d24_intent_register(uuid,uuid)'::regprocedure)" | grep -c 'permission denied')" "1"
check "service_role cannot write intents directly" "$(as service_role "insert into public.hosted_invoice_creation_intents (studio_id,business_object_type,business_object_id,idempotency_key,request_fingerprint,stripe_account_id) values ('$SA','event_fee','x1','key-direct-1','$FP','acct_aaa')" | grep -c 'permission denied')" "1"
check "even the owner role is refused a direct intent insert (no writer flag)" "$(as postgres "insert into public.hosted_invoice_creation_intents (studio_id,business_object_type,business_object_id,idempotency_key,request_fingerprint,stripe_account_id) values ('$SA','event_fee','x1','key-direct-1','$FP','acct_aaa')" | grep -c 'only allowed through the d24 functions')" "1"
check "service_role cannot change the safe-retry window" "$(as service_role "update public.hosted_invoice_creation_config set safe_retry_minutes=1380" | grep -c 'permission denied')" "1"
check "even the owner cannot change the window outside d24_intent_set_window" "$(as postgres "update public.hosted_invoice_creation_config set safe_retry_minutes=1380" | grep -c 'only be changed through d24_intent_set_window')" "1"
has "service_role cannot call d24_intent_set_window" "$(as service_role "select public.d24_intent_set_window(60)")" "permission denied"
has "a window of 0 is refused" "$(st "public.d24_intent_set_window(0)")" "STATE 23514"
has "a window at or above Stripe's 24h minimum (1381+) is refused" "$(st "public.d24_intent_set_window(1381)")" "STATE 23514"
check "a valid window can be set by the owner, and is capped" "$(q "select public.d24_intent_set_window(1380)" >/dev/null; q "select safe_retry_minutes from public.hosted_invoice_creation_config")" "1380"
q "select public.d24_intent_set_window(720)" >/dev/null

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
claim evt_r1 >/dev/null
ap evt_r1 invoice_payment invoice_payment.paid 30000 acct_aaa "$(pj in_r1 inpay_r1 10)" >/dev/null
st "public.d24_register_invoice('$SB',null,'in_r1',false,'event_fee','bo-in_r1')" >/dev/null
check "A's facts are attributed and NOT flagged account_scope_mismatch after B's refused attempt" "$(rowof acct_aaa in_r1 "studio_id = '$SA' and not (anomaly_codes @> array['account_scope_mismatch'])")" "t"
for i in 1 2 3 4 5 6; do
  ( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SA',null,'in_race',false,'event_fee','bo-race')" </dev/null >"$TMPD/ra_$i.txt" 2>&1 ) &
  ( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SB',null,'in_race',false,'event_fee','bo-race')" </dev/null >"$TMPD/rb_$i.txt" 2>&1 ) &
done
wait
check "12-way two-studio race leaves exactly ONE registry row for the invoice id" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_race'")" "1"
check "no race session deadlocked" "$(cat "$TMPD"/ra_*.txt "$TMPD"/rb_*.txt | grep -c 'deadlock detected')" "0"
check "every loser got the deterministic scope conflict (no raw unique violation)" "$(cat "$TMPD"/ra_*.txt "$TMPD"/rb_*.txt | grep -c 'duplicate key')" "0"
( docker exec -i "$NAME" psql -U postgres -qAt -c "begin; select public.d24_register_invoice('$SA',null,'in_dl2',false,'event_fee','bo-dl2'); select pg_sleep(2); commit;" </dev/null >"$TMPD/dl2_1.txt" 2>&1 ) &
sleep 1
( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SB',null,'in_dl2',false,'event_fee','bo-dl2')" </dev/null >"$TMPD/dl2_2.txt" 2>&1 ) &
wait
check "(was 14h) two crossed-scope registrations no longer deadlock" "$(cat "$TMPD"/dl2_1.txt "$TMPD"/dl2_2.txt | grep -c 'deadlock detected')" "0"
check "...the second is refused with the scope conflict" "$(grep -c 'd24_invoice_id_scope_conflict' "$TMPD/dl2_2.txt")" "1"
check "...exactly one registration for A exists" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_dl2' and studio_id='$SA'")" "1"
claim evt_dla >/dev/null; claim evt_dlb >/dev/null
ap evt_dla invoice_payment invoice_payment.paid 31000 acct_dla "$(pj in_dl inpay_dla 11)" >/dev/null
ap evt_dlb invoice_payment invoice_payment.paid 31001 acct_dlb "$(pj in_dl inpay_dlb 22)" >/dev/null
SNAP=$(q "select (select count(*) from public.hosted_invoice_source_events)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_invoices)")
( docker exec -i "$NAME" psql -U postgres -qAt -c "begin; select pg_advisory_xact_lock(hashtextextended('d24:acct_dla:in_dl',0)); select pg_sleep(4); select pg_advisory_xact_lock(hashtextextended('d24:acct_aaa:in_dl',0)); commit;" </dev/null >"$TMPD/dl_1.txt" 2>&1 ) &
for _ in $(seq 1 60); do [ "$(q "select count(*) from pg_locks where locktype='advisory' and granted")" -ge 1 ] && break; sleep 1; done; sleep 1
( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_register_invoice('$SA',null,'in_dl',false,'event_fee','bo-in_dl')" </dev/null >"$TMPD/dl_2.txt" 2>&1 ) &
wait
check "(14h kept) a register crossing a two-key holder deadlocks for exactly one session (40P01)" "$(cat "$TMPD"/dl_1.txt "$TMPD"/dl_2.txt | grep -c 'deadlock detected')" "1"
reg $SA null in_dl >/dev/null
check "...retry registers exactly once" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_dl'")" "1"
check "...retry is idempotent" "$(reg $SA null in_dl)" "already_registered"
check "...no duplicate evidence rows" "$(q "select (select count(*) from public.hosted_invoice_source_events)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_invoices)")" "$SNAP"
check "...the foreign scope is not attributed and is flagged" "$(rowof acct_dla in_dl "studio_id is null")/$(rowof acct_dla in_dl "anomaly_codes @> array['account_scope_mismatch']")" "t/t"
q "update public.studios set stripe_connected_account_id='acct_aaa2' where id='$SA'" >/dev/null
has "after a reconnect the OLD account assertion is refused" "$(st "public.d24_register_invoice('$SA','acct_aaa','in_r9',false,'event_fee','bo')")" "STATE 42501 d24_account_mismatch"
check "...and a fresh registration binds the CURRENT account" "$(reg $SA null in_r9)" "registered"
check "...stored under the current account" "$(q "select stripe_account_id from public.hosted_invoice_registry where stripe_invoice_id='in_r9'")" "acct_aaa2"
q "update public.studios set stripe_connected_account_id='acct_aaa' where id='$SA'" >/dev/null

# 3. ownership registry ------------------------------------------------------------------------------------------------------
q "create table public.qa_objects (id text primary key, studio_id uuid not null)" >/dev/null
OBJS=""; for n in $(seq 1 30); do OBJS="$OBJS('o-a$n','$SA'),"; done
q "insert into public.qa_objects values $OBJS ('o-b1','$SB'),('o-b2','$SB')" >/dev/null
$P <<'SQL'
create function public.d24_owns_qa_event_fee(p_studio uuid, p_obj text) returns boolean language sql stable
  set search_path = pg_catalog, public as $$ select exists (select 1 from public.qa_objects where id = p_obj and studio_id = p_studio) $$;
create function public.qa_volatile_owner(p_studio uuid, p_obj text) returns boolean language sql volatile as $$ select true $$;
create function public.qa_wrong_sig(p_studio uuid) returns boolean language sql stable as $$ select true $$;
SQL
KEY1=idem-a1-0000001
has "begin on an unregistered type fails closed" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$FP','$ACT')")" "STATE 22023 d24_business_object_type_unsupported"
check "...and wrote nothing" "$(q "select count(*) from public.hosted_invoice_creation_intents")" "0"
has "a volatile ownership function cannot be registered" "$(st "public.d24_register_business_object_type('event_fee','public.qa_volatile_owner(uuid,text)'::regprocedure)")" "STATE 22023"
has "a wrong-signature ownership function cannot be registered" "$(st "public.d24_register_business_object_type('event_fee','public.qa_wrong_sig(uuid)'::regprocedure)")" "STATE 22023"
has "a subscription-named type cannot be registered" "$(st "public.d24_register_business_object_type('studio_subscription','public.d24_owns_qa_event_fee(uuid,text)'::regprocedure)")" "STATE 23514"
q "select public.d24_register_business_object_type('event_fee','public.d24_owns_qa_event_fee(uuid,text)'::regprocedure)" >/dev/null
check "registering the real ownership function works (owner only)" "$(q "select count(*) from public.hosted_invoice_business_object_types")" "1"
has "service_role cannot call the registrar" "$(as service_role "select public.d24_register_business_object_type('x','public.d24_owns_qa_event_fee(uuid,text)'::regprocedure)")" "permission denied"

# 4. begin ------------------------------------------------------------------------------------------------------------------
B1=$(q "select public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$FP','$ACT')")
check "begin creates a pending intent" "$(echo "$B1" | grep -o '"outcome": "[a-z]*"')/$(echo "$B1" | grep -o '"status": "[a-z_]*"')" '"outcome": "created"/"status": "pending"'
I1=$(q "select ('$B1'::jsonb)->>'intent_id'")
check "the account is resolved from the studio, not supplied" "$(q "select stripe_account_id from public.hosted_invoice_creation_intents where id='$I1'")" "acct_aaa"
check "the request fingerprint is stored" "$(q "select request_fingerprint from public.hosted_invoice_creation_intents where id='$I1'")" "$FP"
check "begin audited creation" "$(q "select string_agg(event_kind||':'||coalesce(from_status,'-')||'>'||to_status, ',') from public.hosted_invoice_creation_intent_events where intent_id='$I1'")" "created:->pending"
check "replay of begin with the same key and fingerprint is idempotent" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$FP','$ACT'))->>'outcome'")" "existing"
check "...same intent id" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$FP','$ACT'))->>'intent_id'")" "$I1"
check "...attempt_count counts the retries (1 + 2)" "$(q "select attempt_count from public.hosted_invoice_creation_intents where id='$I1'")" "3"
check "...retry history: begin + 2 replays, appended" "$(q "select string_agg(attempt_kind, ',' order by id) from public.hosted_invoice_creation_attempts where intent_id='$I1'")" "begin,begin_replay,begin_replay"
check "...still one row" "$(q "select count(*) from public.hosted_invoice_creation_intents")" "1"
has "same key, different object: key conflict" "$(st "public.d24_intent_begin('$SA','event_fee','o-a2','$KEY1','$FP')")" "STATE 23505 d24_idempotency_key_conflict"
has "TEST 4: same key, changed request fingerprint: refused, never a new intent" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','$FP2')")" "STATE 23505 d24_request_fingerprint_mismatch"
check "...no intent was added and the original is untouched" "$(q "select count(*) from public.hosted_invoice_creation_intents")/$(q "select request_fingerprint from public.hosted_invoice_creation_intents where id='$I1'")" "1/$FP"
has "a malformed fingerprint is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1','not-a-hash')")" "STATE 22023"
has "a missing fingerprint is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','$KEY1',null)")" "STATE 22023"
has "different key, same live object: refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','idem-a1-0000002','$FP')")" "STATE 23505 d24_object_has_live_intent"
has "cross-studio object (B's object, A's request) is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-b1','idem-x-0000001','$FP')")" "STATE 42501 d24_business_object_not_owned"
has "nonexistent object is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-none','idem-x-0000002','$FP')")" "STATE 42501 d24_business_object_not_owned"
has "a studio without a connected account is refused" "$(st "public.d24_intent_begin('$SC','event_fee','o-a1','idem-x-0000003','$FP')")" "STATE 42501 d24_studio_account_unavailable"
has "a subscription type is refused before any lookup" "$(st "public.d24_intent_begin('$SA','studio_subscription','o-a1','idem-x-0000004','$FP')")" "STATE 22023"
has "a malformed key is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a1','short','$FP')")" "STATE 22023"
has "NULL studio is refused" "$(st "public.d24_intent_begin(null,'event_fee','o-a1','idem-x-0000005','$FP')")" "STATE 22023"
check "refusals wrote nothing" "$(q "select count(*) from public.hosted_invoice_creation_intents")" "1"
check "the same idempotency key in ANOTHER studio is an independent intent" "$(q "select (public.d24_intent_begin('$SB','event_fee','o-b1','$KEY1','$FP'))->>'outcome'")" "created"
for i in $(seq 1 10); do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select (public.d24_intent_begin('$SA','event_fee','o-a2','idem-conc-0000001','$FP'))->>'outcome'" </dev/null >"$TMPD/cb_$i.txt" 2>&1 ) & done
wait
check "10 concurrent begins (same key): exactly one created" "$(cat "$TMPD"/cb_*.txt | grep -c '^created$')/$(cat "$TMPD"/cb_*.txt | grep -c '^existing$')" "1/9"
check "...one row" "$(q "select count(*) from public.hosted_invoice_creation_intents where idempotency_key='idem-conc-0000001'")" "1"
for i in $(seq 1 8); do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select (public.d24_intent_begin('$SA','event_fee','o-a3','idem-obj-000000$i','$FP'))->>'outcome'" </dev/null >"$TMPD/ob_$i.txt" 2>&1 ) & done
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
check "refusals left the intent pending" "$(st_of $I1)" "pending"
check "mark records Stripe's invoice id + livemode" "$(mk $I1 $SA in_m1 false false "'acct_aaa'")" "provider_created"
check "mark is idempotent" "$(mk $I1 $SA in_m1)" "already_recorded"
has "mark with a different invoice id is refused" "$(st "public.d24_intent_mark_provider_created('$I1','$SA','in_m2',false,false)")" "STATE 23505 d24_intent_invoice_conflict"
check "the recorded values" "$(q "select stripe_invoice_id||'/'||livemode||'/'||status from public.hosted_invoice_creation_intents where id='$I1'")" "in_m1/false/provider_created"
I2=$(bg $SA event_fee o-a4 idem-a4-0000001)
has "an invoice id already on another intent is refused" "$(st "public.d24_intent_mark_provider_created('$I2','$SA','in_m1',false,false)")" "STATE 23505"
# account changed while an invoice exists at Stripe: the invoice must still be recorded; register must fail closed into needs_review
I8=$(bg $SA event_fee o-a8 idem-a8-0000001)
q "update public.studios set stripe_connected_account_id='acct_changed' where id='$SA'" >/dev/null
has "begin retry after a reconnect is refused" "$(st "public.d24_intent_begin('$SA','event_fee','o-a4','idem-a4-0000001','$FP')")" "STATE 42501 d24_account_changed"
check "mark after a reconnect STILL records the invoice (never orphan it)" "$(mk $I8 $SA in_m8 false false "'acct_aaa'")" "provider_created"
check "TEST 9: register after a reconnect moves the intent to needs_review (mismatch), not registered" "$(q "select (public.d24_intent_register('$I8','$SA'))->>'outcome'")/$(st_of $I8)/$(q "select review_reason from public.hosted_invoice_creation_intents where id='$I8'")" "needs_review/needs_review/account_changed"
check "...nothing was registered" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m8'")" "0"
I13=$(bg $SA event_fee o-a12 idem-a12-000001)
q "update public.studios set stripe_connected_account_id=null where id='$SA'" >/dev/null
check "claim_recovery after the account was removed moves the intent to needs_review" "$(crj $I13 | grep -o '"outcome": "[a-z_]*"')/$(st_of $I13)" '"outcome": "needs_review"/needs_review'
q "update public.studios set stripe_connected_account_id='acct_aaa' where id='$SA'" >/dev/null

# 6. register: crash points, atomicity, out-of-order, no settlement inference --------------------------------------------------------
PAYS=$(q "select count(*) from public.hosted_invoice_payments")
$P <<'SQL'
create table public.qa_flags (k text primary key);
create function public.qa_fault() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.qa_flags where k = 'registry_fault') then raise exception 'qa registry fault' using errcode = 'XX001'; end if;
  return new;
end $$;
create trigger qa_fault_trg before insert on public.hosted_invoice_registry for each row execute function public.qa_fault();
insert into public.qa_flags values ('registry_fault');
SQL
has "TEST 8: provider invoice found but registration FAILS unexpectedly: raised" "$(st "public.d24_intent_register('$I1','$SA')")" "STATE XX001"
check "...intent stays provider_created (Stripe success, DB failure: no half state, recoverable)" "$(st_of $I1)" "provider_created"
check "...nothing was registered" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m1'")" "0"
check "the app records the failure (retryable) and the intent stays recoverable" "$(q "select (public.d24_intent_fail('$I1','$SA','registration_failed'))->>'outcome'")" "recorded"
age $I1 "1 hour"
check "list_recoverable returns the provider_created intent" "$(q "select (public.d24_intent_list_recoverable(15,50,'$SA')) @> jsonb_build_array(jsonb_build_object('intent_id','$I1','status','provider_created'))")" "t"
check "claim_recovery on provider_created says register_only (no Stripe replay)" "$(crj $I1 | grep -o '"outcome": "[a-z_]*"')/$(crj $I1 | grep -o '"replay_permitted": [a-z]*')" '"outcome": "register_only"/"replay_permitted": false'
q "delete from public.qa_flags" >/dev/null
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
check "crash after begin: retry begin reuses the pending intent" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a4','idem-a4-0000001','$FP'))->>'intent_id'")" "$I2"
# TEST 1 / 2: crash before the Stripe request, and crash after Stripe success before ANY db update: recovery works from the PENDING intent alone
I11=$(bg $SA event_fee o-a10 idem-a10-000001 $FP)
check "TEST 1: crash before the Stripe request: intent is pending, no provider data" "$(q "select status||'/'||coalesce(stripe_invoice_id,'-') from public.hosted_invoice_creation_intents where id='$I11'")" "pending/-"
CL1=$(crj $I11)
check "...recovery claim permits a replay with the ORIGINAL key (inside the window, fingerprint matches)" "$(echo "$CL1" | grep -o '"outcome": "[a-z_]*"')/$(echo "$CL1" | grep -o '"replay_permitted": [a-z]*' | head -1)" '"outcome": "replay_permitted"/"replay_permitted": true'
check "TEST 2: Stripe succeeded, process died before recording: replay returns the same invoice; pending -> provider_created" "$(mk $I11 $SA in_m10 false false "'acct_aaa'")" "provider_created"
check "...-> registered" "$(q "select (public.d24_intent_register('$I11','$SA'))->>'outcome'")" "registered"
check "...a SECOND full replay of the sequence is idempotent and converges" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a10','idem-a10-000001','$FP'))->>'outcome'")/$(mk $I11 $SA in_m10)/$(q "select (public.d24_intent_register('$I11','$SA'))->>'outcome'")" "existing_terminal/already_recorded/already_registered"
check "...exactly one registry row, one intent, no second invoice" "$(q "select (select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m10')||'/'||(select count(*) from public.hosted_invoice_creation_intents where business_object_id='o-a10')")" "1/1"
I12=$(bg $SA event_fee o-a11 idem-a11-000001)
mk $I12 $SA in_m11 >/dev/null
has "a replay that yields a different invoice id is refused, never a second invoice" "$(st "public.d24_intent_mark_provider_created('$I12','$SA','in_m12',false,false)")" "STATE 23505 d24_intent_invoice_conflict"
# concurrent registers on one intent
I5=$(bg $SA event_fee o-a5 idem-a5-0000001)
mk $I5 $SA in_m5 >/dev/null
for i in $(seq 1 8); do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select (public.d24_intent_register('$I5','$SA'))->>'outcome'" </dev/null >"$TMPD/cr_$i.txt" 2>&1 ) & done
wait
check "8 concurrent registers: one registered, the rest already_registered" "$(cat "$TMPD"/cr_*.txt | grep -c '^registered$')/$(cat "$TMPD"/cr_*.txt | grep -c '^already_registered$')" "1/7"
check "...one registry row" "$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m5'")" "1"
# TEST 9 (ownership variant): the object moved to another studio before registration
I14=$(bg $SA event_fee o-a13 idem-a13-000001)
mk $I14 $SA in_m13 >/dev/null
q "update public.qa_objects set studio_id='$SB' where id='o-a13'" >/dev/null
check "TEST 9: provider invoice ownership mismatch at register: needs_review, never registered" "$(q "select (public.d24_intent_register('$I14','$SA'))->>'outcome'")/$(st_of $I14)/$(q "select review_reason from public.hosted_invoice_creation_intents where id='$I14'")/$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_m13'")" "needs_review/needs_review/business_object_not_owned/0"
q "update public.qa_objects set studio_id='$SA' where id='o-a13'" >/dev/null
has "...and, ownership restored, a new key for the same object is STILL refused while the first intent is in review" "$(st "public.d24_intent_begin('$SA','event_fee','o-a13','idem-a13-000002','$FP')")" "STATE 23505 d24_object_has_live_intent"
I6=$(bg $SA event_fee o-a6 idem-a6-0000001)
mk $I6 $SA in_m6 >/dev/null
reg $SA null in_m6 >/dev/null
check "intent_register after a direct registration with a DIFFERENT object is a conflict -> needs_review, not a takeover" "$(q "select (public.d24_intent_register('$I6','$SA'))->>'outcome'")/$(q "select review_reason from public.hosted_invoice_creation_intents where id='$I6'")" "needs_review/registration_conflict"

# 7. recovery: lease, window, fingerprint, unknown outcome, retries --------------------------------------------------------------
I7=$(bg $SA event_fee o-a7 idem-a7-0000001)
FO=$(q "select (public.d24_intent_fail('$I7','$SA','stripe_timeout'))->>'outcome'")
check "TEST 3: a retryable failure keeps the intent pending/recoverable" "$FO/$(q "select status||'/'||failure_count||'/'||last_error_code from public.hosted_invoice_creation_intents where id='$I7'")" "recorded/pending/1/stripe_timeout"
check "free text / hostile error codes are sanitized" "$(q "select (public.d24_intent_fail('$I7','$SA','Card 4242 declined: secret sk_live_x'))->>'last_error_code'")" "unsanitized_error_code"
check "...retry with the same key + fingerprint is still allowed inside the window" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a7','idem-a7-0000001','$FP'))->>'outcome'")" "existing"
check "...retry history records the failures and the replay" "$(q "select string_agg(attempt_kind||':'||coalesce(outcome_code,'-'), ',' order by id) from public.hosted_invoice_creation_attempts where intent_id='$I7'")" "begin:-,failure:stripe_timeout,failure:unsanitized_error_code,begin_replay:-"
# fingerprint changed at recovery
I15=$(bg $SA event_fee o-a14 idem-a14-000001)
check "TEST 4b: recovery with a CHANGED fingerprint moves the intent to needs_review, no replay" "$(crj $I15 $FP2 | grep -o '"outcome": "[a-z_]*"')/$(st_of $I15)/$(q "select review_reason from public.hosted_invoice_creation_intents where id='$I15'")" '"outcome": "needs_review"/needs_review/fingerprint_mismatch'
# TEST 5: concurrent workers recovering the same intent
I16=$(bg $SA event_fee o-a15 idem-a15-000001)
for i in $(seq 1 8); do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select (public.d24_intent_claim_recovery('$I16','$SA','$FP'))->>'outcome'" </dev/null >"$TMPD/cl_$i.txt" 2>&1 ) & done
wait
check "TEST 5: 8 concurrent workers recover the same intent: exactly ONE gets the replay, the rest see the lease" "$(cat "$TMPD"/cl_*.txt | grep -c '^replay_permitted$')/$(cat "$TMPD"/cl_*.txt | grep -c '^lease_held$')" "1/7"
check "...a single recovery_replay attempt was recorded" "$(q "select count(*) from public.hosted_invoice_creation_attempts where intent_id='$I16' and attempt_kind='recovery_replay'")" "1"
q "begin; select set_config('d24.writer','on',true); update public.hosted_invoice_creation_intents set recovery_lease_expires_at = now() - interval '1 second' where id='$I16'; commit;" >/dev/null
check "...once the lease expired another worker may claim" "$(crj $I16 | grep -o '"outcome": "[a-z_]*"')" '"outcome": "replay_permitted"'
# TEST 6: timeout with unknown result
I17=$(bg $SA event_fee o-a16 idem-a16-000001)
check "TEST 6: a timeout is recorded as outcome_unknown" "$(q "select (public.d24_intent_record_outcome('$I17','$SA','stripe_timeout',true))->>'outcome'")/$(q "select outcome_unknown from public.hosted_invoice_creation_intents where id='$I17'")" "recorded/t"
has "...a permanent fail is refused while the outcome is unknown (an invoice may exist)" "$(st "public.d24_intent_fail('$I17','$SA','gave_up',true)")" "STATE 55000 d24_intent_outcome_unknown"
check "...inside the window the ORIGINAL key may be replayed" "$(crj $I17 | grep -o '"outcome": "[a-z_]*"')" '"outcome": "replay_permitted"'
check "...a timeout cleared the lease; the unknown flag is sticky" "$(q "select (public.d24_intent_record_outcome('$I17','$SA','stripe_timeout',false))->>'outcome'")/$(q "select outcome_unknown from public.hosted_invoice_creation_intents where id='$I17'")" "recorded/t"
check "...the unknown flag clears only when the invoice id is recorded" "$(mk $I17 $SA in_m17 false false "'acct_aaa'")/$(q "select outcome_unknown from public.hosted_invoice_creation_intents where id='$I17'")" "provider_created/f"
# TEST 7: recovery after the window
I18=$(bg $SA event_fee o-a17 idem-a17-000001)
ageC $I18 "13 hours"
check "TEST 7: recovery after the safe window: needs_review, NO replay permitted" "$(crj $I18 | grep -o '"outcome": "[a-z_]*"')/$(crj $I18 | grep -o '"replay_permitted": [a-z]*' | head -1)/$(q "select review_reason from public.hosted_invoice_creation_intents where id='$I18'")" '"outcome": "needs_review"/"replay_permitted": false/window_expired'
check "...begin with the same key no longer replays either" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a17','idem-a17-000001','$FP'))->>'outcome'")" "needs_review"
has "...and a replacement key for the same object cannot start a second invoice" "$(st "public.d24_intent_begin('$SA','event_fee','o-a17','idem-a17-000002','$FP')")" "STATE 23505 d24_object_has_live_intent"
I19=$(bg $SA event_fee o-a18 idem-a18-000001)
ageC $I19 "13 hours"
check "begin on an expired pending intent moves it to needs_review itself (no worker needed)" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a18','idem-a18-000001','$FP'))->>'outcome'")/$(st_of $I19)" "needs_review/needs_review"
q "select public.d24_intent_set_window(600)" >/dev/null
I20=$(bg $SA event_fee o-a19 idem-a19-000001)
ageC $I20 "11 hours"
check "a shortened (10h) window is honoured: an 11h-old pending intent is expired" "$(crj $I20 | grep -o '"outcome": "[a-z_]*"')" '"outcome": "needs_review"'
q "select public.d24_intent_set_window(720)" >/dev/null
I21=$(bg $SA event_fee o-a20 idem-a20-000001)
ageC $I21 "11 hours"
check "...and at the default 12h window the same age is still inside" "$(crj $I21 | grep -o '"outcome": "[a-z_]*"')" '"outcome": "replay_permitted"'
# fail closed: a missing config row is a zero window
q "alter table public.hosted_invoice_creation_config disable trigger hosted_invoice_creation_config_guard_trg; delete from public.hosted_invoice_creation_config" >/dev/null
I22=$(bg $SA event_fee o-a21 idem-a21-000001)
check "FAIL CLOSED: with the config row missing, every pending intent counts as expired" "$(crj $I22 | grep -o '"outcome": "[a-z_]*"')" '"outcome": "needs_review"'
q "insert into public.hosted_invoice_creation_config (singleton) values (true); alter table public.hosted_invoice_creation_config enable trigger hosted_invoice_creation_config_guard_trg" >/dev/null
check "...config restored" "$(q "select safe_retry_minutes from public.hosted_invoice_creation_config")" "720"
has "flag_review by the app moves a pending intent to needs_review (idempotent)" "$(q "select public.d24_intent_flag_review('$(bg $SA event_fee o-a22 idem-a22-000001)','$SA','ambiguous_response')")" '"outcome": "needs_review"'
check "claim_recovery on a terminal intent permits nothing" "$(crj $I1 | grep -o '"outcome": "[a-z_]*"')" '"outcome": "terminal"'
check "list_recoverable includes idle pending intents and excludes needs_review/terminal" "$(q "select (public.d24_intent_list_recoverable(1,200,'$SA')) @> jsonb_build_array(jsonb_build_object('intent_id','$I18'))")" "f"
age $I7 "2 hours"
check "list_recoverable honours the idle threshold" "$(q "select (public.d24_intent_list_recoverable(15,200,'$SA')) @> jsonb_build_array(jsonb_build_object('intent_id','$I7'))")/$(q "select (public.d24_intent_list_recoverable(3000,200,'$SA')) @> jsonb_build_array(jsonb_build_object('intent_id','$I7'))")" "t/f"
check "list_recoverable is bounded (limit clamped)" "$(q "select jsonb_array_length(public.d24_intent_list_recoverable(1,0,null)) <= 1 and jsonb_array_length(public.d24_intent_list_recoverable(-5,100000,null)) <= 200")" "t"
check "list_recoverable studio filter" "$(q "select count(*) from jsonb_array_elements(public.d24_intent_list_recoverable(1,200,'$SB')) e where e->>'studio_id' <> '$SB'")" "0"
I23=$(bg $SA event_fee o-a23 idem-a23-000001)
mk $I23 $SA in_m23 >/dev/null
reg $SA null in_m23 >/dev/null
has "a permanent fail of an intent whose invoice is already registered is refused (would free the slot for a duplicate)" "$(st "public.d24_intent_fail('$I23','$SA','x',true)")" "STATE 55000 d24_intent_has_invoice"
I9=$(bg $SA event_fee o-a9 idem-a9-0000001)
FO=$(q "select (public.d24_intent_fail('$I9','$SA','registration_rejected',true))->>'outcome'")
check "permanent failure is terminal" "$FO/$(st_of $I9)" "failed/failed"
check "fail on a terminal intent is a no-op" "$(q "select (public.d24_intent_fail('$I9','$SA','again',true))->>'outcome'")" "noop_terminal"
check "...failure_count unchanged" "$(q "select failure_count from public.hosted_invoice_creation_intents where id='$I9'")" "1"
has "mark on a failed intent is refused" "$(st "public.d24_intent_mark_provider_created('$I9','$SA','in_m7',false,false)")" "STATE 55000 d24_intent_state"
check "begin on a terminal key reports existing_terminal (caller must not call Stripe)" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a9','idem-a9-0000001','$FP'))->>'outcome'")" "existing_terminal"
check "...and does not bump attempt_count" "$(q "select attempt_count from public.hosted_invoice_creation_intents where id='$I9'")" "1"
has "fail by another studio is refused" "$(st "public.d24_intent_fail('$I2','$SB','x')")" "STATE 42501 d24_intent_not_found"

# 8. TEST 10: verified-operator reconciliation of unresolved creations -----------------------------------------------------------
R="operator reconciled against the Stripe dashboard"
has "operator functions are CLOSED while the DB switch is off (even for a platform admin at aal2)" "$(asu $PLAT aal2 "select public.d24_op_list_creation_reviews(10)")" "d24_op_disabled"
has "platform admin switches the operator actions on (M2-B switch)" "$(asu $PLAT aal2 "select public.d24_op_set_enabled(true,'enable operator actions for the creation acceptance run')")" '"outcome": "changed"'
has "no JWT: refused" "$(asu $PLAT none "select public.d24_op_list_creation_reviews(10)")" "d24_op_authentication_required"
has "aal1: refused" "$(asu $PLAT aal1 "select public.d24_op_attach_creation_invoice('$I14','in_op1',false,'acct_aaa','$R')")" "d24_op_aal2_required"
has "UNAUTHORIZED: a studio owner of the same studio cannot attach" "$(asu $OWA aal2 "select public.d24_op_attach_creation_invoice('$I14','in_op1',false,'acct_aaa','$R')")" "d24_op_platform_admin_required"
has "WRONG TENANT: a studio owner of another studio cannot attach" "$(asu $OWB aal2 "select public.d24_op_attach_creation_invoice('$I14','in_op1',false,'acct_aaa','$R')")" "d24_op_platform_admin_required"
has "a user with no role cannot flag" "$(asu $NOB aal2 "select public.d24_op_flag_creation_review('$I2','$R')")" "d24_op_platform_admin_required"
has "service_role cannot call the operator functions" "$(as service_role "select public.d24_op_list_creation_reviews(10)")" "permission denied"
check "refusals changed nothing" "$(st_of $I14)/$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_op1'")" "needs_review/0"
has "a reason is mandatory" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I14','in_op1',false,'acct_aaa','no')")" "d24_op_reason_required"
has "the review queue lists the unresolved creations (platform admin)" "$(asu $PLAT aal2 "select e->>'intent_id' from jsonb_array_elements(public.d24_op_list_creation_reviews(200)) e where e->>'intent_id'='$I14'")" "$I14"
has "a studio owner cannot read the review queue" "$(asu $OWA aal2 "select public.d24_op_list_creation_reviews(10)")" "d24_op_platform_admin_required"
has "attach to an intent that is not in review is refused" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I2','in_op1',false,'acct_aaa','$R')")" "d24_intent_state"
has "attach with an account other than the intent's account is refused (wrong scope)" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I14','in_op1',false,'acct_bbb','$R')")" "d24_account_mismatch"
has "attach with a malformed invoice id is refused" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I14','garbage',false,'acct_aaa','$R')")" "malformed"
has "attach of an invoice already registered to ANOTHER intent/object is refused (never a second owner)" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I18','in_m1',false,'acct_aaa','$R')")" "d24_registration_conflict"
claim evt_op1 >/dev/null
ap evt_op1 invoice_payment invoice_payment.paid 33000 acct_aaa "$(pj in_op1 inpay_op1 7)" >/dev/null
has "attach with a livemode that contradicts recorded webhook facts is refused" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I18','in_op1',true,'acct_aaa','$R')")" "d24_livemode_mismatch"
q "update public.qa_objects set studio_id='$SB' where id='o-a17'" >/dev/null
has "attach is refused while the business object is not owned by the studio (metadata/operator claim cannot override ownership)" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I18','in_op1',false,'acct_aaa','$R')")" "d24_business_object_not_owned"
q "update public.qa_objects set studio_id='$SA' where id='o-a17'" >/dev/null
check "every refused attach left the intent in needs_review" "$(st_of $I18)/$(q "select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_op1'")" "needs_review/0"
OPA=$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I18','in_op1',false,'acct_aaa','$R')")
check "AUTHORIZED: platform admin at aal2 attaches the trustworthy Stripe invoice: needs_review -> registered (and adopts the earlier event)" "$(echo "$OPA" | grep -o '"outcome": "registered"')/$(rowof acct_aaa in_op1 "studio_id = '$SA'")/$(st_of $I18)" '"outcome": "registered"/t/registered'
check "...registered through d24_register_invoice under the studio's account" "$(q "select studio_id::text||'/'||stripe_account_id||'/'||business_object_id from public.hosted_invoice_registry where stripe_invoice_id='in_op1'")" "$SA/acct_aaa/o-a17"
check "...audited with the verified actor and the reason" "$(q "select event_kind||'|'||from_status||'>'||to_status||'|'||actor_user_id::text||'|'||reason from public.hosted_invoice_creation_intent_events where intent_id='$I18' and event_kind='operator_attached'")" "operator_attached|needs_review>registered|$PLAT|$R"
check "...no settlement was inferred (the only payment fact is Stripe's own event)" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_id='in_op1'")" "1"
has "attaching again is refused (terminal)" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I18','in_op1',false,'acct_aaa','$R')")" "d24_intent_state"
has "attach of a DIFFERENT invoice than the one the intent recorded is refused" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I14','in_op1',false,'acct_aaa','$R')")" "d24_intent_invoice_conflict"
has "the operator attaches the invoice the intent itself recorded (provider invoice found, mismatch resolved)" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I14','in_m13',false,'acct_aaa','$R')")" '"outcome": "registered"'
# review fixes
has "REVIEW P1: a permanent fail of a provider_created intent is refused (the object must not be freed while an invoice exists)" "$(st "public.d24_intent_fail('$I12','$SA','x',true)")" "STATE 55000 d24_intent_has_invoice"
check "REVIEW P1: the trigger itself refuses failed/abandoned while an invoice id is recorded" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set status='failed', settled_at=now() where id='$I12'" | grep -c 'cannot be failed or abandoned')" "1"
check "REVIEW P2: begin on a provider_created intent says register_only (never a Stripe replay)" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a11','idem-a11-000001','$FP'))->>'outcome'")" "register_only"
I24=$(bg $SA event_fee o-a24 idem-a24-000001)
q "select public.d24_intent_flag_review('$I24','$SA','window_expired')" >/dev/null
check "REVIEW P2: a late Stripe response on a needs_review intent still RECORDS the invoice id" "$(mk $I24 $SA in_m24 false false "'acct_aaa'")" "recorded_in_review"
check "...status stays needs_review with the invoice recorded" "$(st_of $I24)/$(q "select stripe_invoice_id from public.hosted_invoice_creation_intents where id='$I24'")" "needs_review/in_m24"
has "...so an operator can no longer abandon it (attach is forced)" "$(asu $PLAT aal2 "select public.d24_op_abandon_creation('$I24','$R')")" "d24_intent_has_invoice"
I25=$(bg $SA event_fee o-a25 idem-a25-000001)
ageC $I25 "13 hours"
check "REVIEW P2: a Stripe response arriving after the window records the id but fails closed" "$(mk $I25 $SA in_m25 false false "'acct_aaa'")/$(st_of $I25)/$(q "select review_reason||'/'||stripe_invoice_id from public.hosted_invoice_creation_intents where id='$I25'")" "needs_review/needs_review/window_expired_provider/in_m25"
I26=$(bg $SA event_fee o-a26 idem-a26-000001)
mk $I26 $SA in_m26 >/dev/null
$P <<'SQL'
create or replace function public.qa_fault2() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.qa_flags where k = 'priv_fault') then raise exception 'qa permission bug' using errcode = '42501'; end if;
  return new;
end $$;
create trigger qa_fault2_trg before insert on public.hosted_invoice_registry for each row execute function public.qa_fault2();
insert into public.qa_flags values ('priv_fault');
SQL
has "REVIEW P2: an unexpected 42501 (not a deliberate d24_* refusal) is re-raised, not turned into needs_review" "$(st "public.d24_intent_register('$I26','$SA')")" "STATE 42501 qa permission bug"
check "...the intent stays provider_created and retryable" "$(st_of $I26)" "provider_created"
q "delete from public.qa_flags; drop trigger qa_fault2_trg on public.hosted_invoice_registry" >/dev/null
# flag + abandon
has "operator flags a pending creation for review (audited)" "$(asu $PLAT aal2 "select public.d24_op_flag_creation_review('$I2','$R')")" '"outcome": "needs_review"'
check "...event recorded with actor and reason" "$(q "select count(*) from public.hosted_invoice_creation_intent_events where intent_id='$I2' and event_kind='operator_flagged' and actor_user_id='$PLAT' and reason='$R'")" "1"
has "flagging again is idempotent" "$(asu $PLAT aal2 "select public.d24_op_flag_creation_review('$I2','$R')")" "already_in_review"
has "a studio owner cannot abandon" "$(asu $OWA aal2 "select public.d24_op_abandon_creation('$I2','$R')")" "d24_op_platform_admin_required"
has "abandon without a reason is refused" "$(asu $PLAT aal2 "select public.d24_op_abandon_creation('$I2','x')")" "d24_op_reason_required"
has "abandon of an intent that records an invoice is refused (attach it instead)" "$(asu $PLAT aal2 "select public.d24_op_abandon_creation('$I8','$R')")" "d24_intent_has_invoice"
has "operator abandons an intent proven to have no invoice" "$(asu $PLAT aal2 "select public.d24_op_abandon_creation('$I2','$R')")" '"outcome": "abandoned"'
check "...the object is released: a new key now works" "$(q "select (public.d24_intent_begin('$SA','event_fee','o-a4','idem-a4-0000002','$FP'))->>'outcome'")" "created"
# I8: reconnect victim; restore binding and attach the real invoice
has "attach after a reconnect is refused until the binding is restored" "$(q "update public.studios set stripe_connected_account_id='acct_changed' where id='$SA'" >/dev/null; asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I8','in_m8',false,'acct_aaa','$R')")" "d24_account_changed"
q "update public.studios set stripe_connected_account_id='acct_aaa' where id='$SA'" >/dev/null
has "...with the binding restored the operator resolves it" "$(asu $PLAT aal2 "select public.d24_op_attach_creation_invoice('$I8','in_m8',false,'acct_aaa','$R')")" '"outcome": "registered"'

# 9. audit + guards -------------------------------------------------------------------------------------------------------------
check "audit of I1: created, provider_created, failure_recorded, registered" "$(q "select string_agg(event_kind, ',' order by id) from public.hosted_invoice_creation_intent_events where intent_id='$I1'")" "created,provider_created,failure_recorded,registered"
check "audit rows carry codes only (no free text) except operator reasons" "$(q "select count(*) from public.hosted_invoice_creation_intent_events where error_code !~ '^[a-z][a-z0-9_]{0,63}\$'")" "0"
check "every state change to needs_review is audited" "$(q "select count(*) from public.hosted_invoice_creation_intents i where review_reason is not null and not exists (select 1 from public.hosted_invoice_creation_intent_events e where e.intent_id=i.id and e.to_status='needs_review')")" "0"
check "audit events are append-only (update)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intent_events set error_code='x' where intent_id='$I1'" | grep -c 'append-only')" "1"
check "audit events are append-only (delete)" "$(as postgres "select set_config('d24.writer','on',false); delete from public.hosted_invoice_creation_intent_events" | grep -c 'append-only')" "1"
check "audit events are append-only (truncate)" "$(as postgres "truncate public.hosted_invoice_creation_intent_events" | grep -c 'append-only')" "1"
check "attempt history is append-only (update)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_attempts set outcome_code='x'" | grep -c 'append-only')" "1"
check "attempt history is append-only (delete)" "$(as postgres "select set_config('d24.writer','on',false); delete from public.hosted_invoice_creation_attempts" | grep -c 'append-only')" "1"
check "attempt history cannot be inserted directly" "$(as postgres "insert into public.hosted_invoice_creation_attempts (intent_id, studio_id, attempt_kind) values ('$I1','$SA','begin')" | grep -c 'only allowed through the d24 functions')" "1"
check "intents cannot be deleted" "$(as postgres "select set_config('d24.writer','on',false); delete from public.hosted_invoice_creation_intents where id='$I1'" | grep -c 'cannot be deleted')" "1"
check "intents cannot be truncated" "$(as postgres "truncate public.hosted_invoice_creation_intents" | grep -c -E 'append-only|foreign key')" "1"
check "a terminal intent cannot change" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set last_error_code='x' where id='$I1'" | grep -c 'terminal intent cannot change')" "1"
check "an illegal transition is refused (registered -> pending)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set status='pending' where id='$I1'" | grep -c 'illegal intent transition')" "1"
check "needs_review cannot go back to pending" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set status='pending' where id='$I18'" | grep -c 'illegal intent transition')" "1"
check "identity columns are immutable (studio)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set studio_id='$SB' where id='$I16'" | grep -c 'identity columns are immutable')" "1"
check "identity columns are immutable (account)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set stripe_account_id='acct_bbb' where id='$I16'" | grep -c 'identity columns are immutable')" "1"
check "the request fingerprint is immutable" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set request_fingerprint='$FP2' where id='$I16'" | grep -c 'identity columns are immutable')" "1"
check "created_at is immutable" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set created_at = now() where id='$I16'" | grep -c 'identity columns are immutable')" "1"
check "the idempotency key is immutable" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set idempotency_key='idem-changed-0001' where id='$I16'" | grep -c 'identity columns are immutable')" "1"
check "pending cannot jump to registered" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set status='registered' where id='$I16'" | grep -c -E 'illegal intent transition|violates check')" "1"
check "a recorded provider invoice cannot be swapped" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set stripe_invoice_id='in_other' where id='$I5'" | grep -c 'cannot change')" "1"
check "counters cannot decrease" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set attempt_count=1 where id='$I16' and attempt_count>1" | grep -c 'cannot decrease')" "1"
check "needs_review requires a reason code" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set status='needs_review' where id='$I16'" | grep -c 'violates check constraint')" "1"
check "no intent function created credit notes or status transitions" "$(q "select (select count(*) from public.hosted_credit_notes)||'/'||(select count(*) from public.hosted_invoice_status_transitions)")" "0/0"
check "no function ever finalized/sent/collected: no payment row was created by the ledger (all payment facts come from Stripe events)" "$(q "select count(*) from public.hosted_invoice_payments where first_event_id not like 'evt\_%'")" "0"

# 10. a later package registers its ownership function with ONE call; no M3-A function is edited --------------------------------
$P <<'SQL'
create table public.qa_client_invoices (id text primary key, studio_id uuid not null);
insert into public.qa_client_invoices values ('ci-1', '00000000-0000-0000-0000-00000000005a');
create function public.d24_owns_studio_client_invoice(p_studio uuid, p_obj text) returns boolean language sql stable
  set search_path = pg_catalog, public as $$ select exists (select 1 from public.qa_client_invoices where id = p_obj and studio_id = p_studio) $$;
SQL
has "before registration the new type fails closed" "$(st "public.d24_intent_begin('$SA','studio_client_invoice','ci-1','idem-ci1-000001','$FP')")" "STATE 22023 d24_business_object_type_unsupported"
q "select public.d24_register_business_object_type('studio_client_invoice','public.d24_owns_studio_client_invoice(uuid,text)'::regprocedure)" >/dev/null
check "after the single registration call begin works for the new type" "$(q "select (public.d24_intent_begin('$SA','studio_client_invoice','ci-1','idem-ci1-000001','$FP'))->>'outcome'")" "created"
has "...and still refuses another studio's object of that type" "$(st "public.d24_intent_begin('$SB','studio_client_invoice','ci-1','idem-ci1-000002','$FP')")" "STATE 42501 d24_business_object_not_owned"
q "delete from public.hosted_invoice_business_object_types where business_object_type='studio_client_invoice'" >/dev/null
has "removing the registry row (the new package's rollback) fails closed again" "$(st "public.d24_intent_begin('$SA','studio_client_invoice','ci-1','idem-ci1-000003','$FP')")" "STATE 22023 d24_business_object_type_unsupported"

# 11. rollback + re-apply ------------------------------------------------------------------------------------------------------
r=$(docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_RB" 2>&1 | tr -d '\n' | cut -c1-140)
has "rollback is refused while intent evidence exists" "$r" "rollback refused"
check "refused rollback left the schema intact" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "4"
docker exec "$NAME" psql -U postgres -qAt -c "create database d24m3fresh" >/dev/null
F="docker exec -i $NAME psql -U postgres -d d24m3fresh -v ON_ERROR_STOP=1 -qAt"
$F <<'SQL'
create schema if not exists public;
create table public.studios (id uuid primary key default gen_random_uuid(), stripe_connected_account_id text);
create table public.payment_provider_events (id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text, created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
$F < "$STUB" >/dev/null 2>&1
for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_B"; do $F < "$f" >/dev/null 2>&1; done
M1FN=$($F -c "select md5(pg_get_functiondef('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)'::regprocedure))")
$F < "$M_A" >/dev/null 2>&1
check "fresh DB: migration applies" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "4"
check "fresh DB: register_invoice is the hardened body" "$($F -c "select pg_get_functiondef('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)'::regprocedure) like '%d24inv:%'")" "t"
$F < "$M_RB" >/dev/null 2>&1
check "fresh DB: rollback removes every M3-A object" "$($F -c "select (select count(*) from information_schema.tables where table_schema='public' and (table_name like 'hosted_invoice_creation%' or table_name='hosted_invoice_business_object_types'))||'/'||(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'd24_intent%' or p.proname like 'd24_op_%creation%' or p.proname in ('_d24_studio_account','_d24_check_owner','_d24_intent_guard','_d24_bot_guard','_d24_intent_json','_d24_intent_lock','_d24_intent_event','_d24_intent_to_review','_d24_attempt','_d24_safe_window','_d24_creation_config_guard','_d24_clean_code','d24_register_business_object_type')))")" "0/0"
check "fresh DB: rollback restores the M1 d24_register_invoice VERBATIM" "$($F -c "select md5(pg_get_functiondef('public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)'::regprocedure))")" "$M1FN"
check "fresh DB: the M2-B operator functions are untouched by the rollback" "$($F -c "select count(*) from pg_proc where proname in ('d24_op_set_enabled','_d24_op_caller','d24_op_dismiss_unmatched')")" "3"
$F < "$M_A" >/dev/null 2>&1
check "fresh DB: migration re-applies after rollback" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "4"
$F -c "insert into public.studios values ('$SA','acct_aaa')" >/dev/null
$F -c "create function public.d24_owns_x(uuid,text) returns boolean language sql stable as 'select true'" >/dev/null
$F -c "select public.d24_register_business_object_type('event_fee','public.d24_owns_x(uuid,text)'::regprocedure)" >/dev/null
$F -c "select public.d24_intent_begin('$SA','event_fee','o1','idem-fresh-0001','$FP')" >/dev/null
{ echo "set d24.m3a_rollback_exported='yes';"; cat "$M_RB"; } | $F >/dev/null 2>&1
check "rollback with the export acknowledgement removes evidence-bearing tables" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted_invoice_creation%'")" "0"

echo "SQL RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
