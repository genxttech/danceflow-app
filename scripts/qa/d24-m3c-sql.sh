#!/usr/bin/env bash
# D24 M3-C: run the real M1 + M2-C + M3-A + M3-C migrations (and the M3-C rollback) against a DISPOSABLE Postgres container.
# Container df-d24-m3c-pg-<pid>: no published ports, no volumes, removed on exit. It never touches any other database.
# Exercises: studio-owned client invoice tables, role matrix (owner/admin only), cross-tenant client/reference refusal, forged ids, money arithmetic + bounds,
# fail-closed limits, edit-after-registration refusal, double submit + concurrency, append-only audit, M3-A ownership function + registration link, RLS, rollback.
# Usage: bash scripts/qa/d24-m3c-sql.sh
set -uo pipefail

NAME=df-d24-m3c-pg-$$
MIG="src/lib/supabase/migrations"
M_CLAIM="$MIG/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="$MIG/20270203110000_d24_hosted_invoice_facts.sql"
M_C="$MIG/20270206090000_d24_m2c_drain_recovery.sql"
M_A="$MIG/20270208090000_d24_m3a_intent_ledger.sql"
M_3C="$MIG/20270209090000_d24_m3c_client_invoice.sql"
M_RB="$MIG/rollback/20270209090000_d24_m3c_client_invoice_rollback.sql"
STUB="scripts/qa/d24/stubs/auth-roles.sql"
cd "$(dirname "$0")/../.."
for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_A" "$M_3C" "$M_RB" "$STUB"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done

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
try() { docker exec -i "$NAME" psql -U postgres -qAt -c "$1" </dev/null 2>&1 | tr '
' ' ' | sed -E 's/ERROR:  /ERR /' | cut -c1-600; }
st() { try "do \$\$ begin perform $1; raise notice 'NOSTATE'; exception when others then raise notice 'STATE % %', sqlstate, sqlerrm; end \$\$"; }

# bootstrap <db>: reconstructed base tables, then M1 + M2-C + M3-A (not M3-C)
bootstrap() {
  local db=$1 F="docker exec -i $NAME psql -U postgres -d $1 -v ON_ERROR_STOP=1 -q"
  docker exec "$NAME" psql -U postgres -qAt -c "create database $db" >/dev/null 2>&1
  $F <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;
create table public.studios (id uuid primary key default gen_random_uuid(), name text, stripe_connected_account_id text);
create table public.clients (id uuid primary key default gen_random_uuid(), studio_id uuid not null references public.studios(id), first_name text);
create table public.appointments (id uuid primary key default gen_random_uuid(), studio_id uuid not null references public.studios(id));
create table public.events (id uuid primary key default gen_random_uuid(), studio_id uuid references public.studios(id));
create table public.payments (id uuid primary key default gen_random_uuid(), studio_id uuid not null references public.studios(id), amount numeric);
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text,
  created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
  $F < "$STUB" >/dev/null || return 1
  for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_A"; do $F < "$f" >/dev/null || { echo "prerequisite migration failed: $f"; return 1; }; done
}
bootstrap d24m3c || { echo "bootstrap failed"; exit 2; }
P="docker exec -i $NAME psql -U postgres -d d24m3c -v ON_ERROR_STOP=1 -qAt"
q() { $P -c "$1"; }
try() { docker exec -i "$NAME" psql -U postgres -d d24m3c -qAt -c "$1" </dev/null 2>&1 | tr '
' ' ' | sed -E 's/ERROR:  /ERR /' | cut -c1-700; }
st() { try "do \$\$ begin perform $1; raise notice 'NOSTATE'; exception when others then raise notice 'STATE % %', sqlstate, sqlerrm; end \$\$"; }

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi; }
has() { check "$1" "$(echo "$2" | grep -c -F -- "$3")" "1"; }

SA=00000000-0000-0000-0000-00000000005a
SB=00000000-0000-0000-0000-00000000005b
SC=00000000-0000-0000-0000-00000000005c   # no connected account
UO=00000000-0000-0000-0000-0000000000a1   # A owner
UA=00000000-0000-0000-0000-0000000000a2   # A admin
UI=00000000-0000-0000-0000-0000000000a3   # A instructor
UF=00000000-0000-0000-0000-0000000000a4   # A front desk
UC=00000000-0000-0000-0000-0000000000a5   # A client
UX=00000000-0000-0000-0000-0000000000a6   # A admin, INACTIVE
UN=00000000-0000-0000-0000-0000000000a7   # no role anywhere
UP=00000000-0000-0000-0000-0000000000a8   # platform admin, no studio role
UB=00000000-0000-0000-0000-0000000000b1   # B owner
CA1=00000000-0000-0000-0000-00000000ca01; CA2=00000000-0000-0000-0000-00000000ca02; CB1=00000000-0000-0000-0000-00000000cb01
AP_A=00000000-0000-0000-0000-0000000a9a01; AP_B=00000000-0000-0000-0000-0000000a9b01
EV_A=00000000-0000-0000-0000-0000000e1a01; EV_B=00000000-0000-0000-0000-0000000e1b01
PY_A=00000000-0000-0000-0000-0000000b7a01; PY_B=00000000-0000-0000-0000-0000000b7b01
q "insert into public.studios (id, name, stripe_connected_account_id) values ('$SA','A','acct_aaa'),('$SB','B','acct_bbb'),('$SC','C',null)" >/dev/null
q "insert into public.clients (id, studio_id) values ('$CA1','$SA'),('$CA2','$SA'),('$CB1','$SB')" >/dev/null
q "insert into public.appointments values ('$AP_A','$SA'),('$AP_B','$SB'); insert into public.events values ('$EV_A','$SA'),('$EV_B','$SB'); insert into public.payments (id, studio_id) values ('$PY_A','$SA'),('$PY_B','$SB')" >/dev/null
q "insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$UO','$SA','studio_owner',true),('$UA','$SA','studio_admin',true),('$UI','$SA','instructor',true),('$UF','$SA','front_desk',true),('$UC','$SA','client',true),('$UX','$SA','studio_admin',false),('$UB','$SB','studio_owner',true)" >/dev/null
q "insert into public.profiles (id, platform_role) values ('$UP','platform_admin')" >/dev/null
docker exec -i "$NAME" psql -U postgres -d d24m3c -v ON_ERROR_STOP=1 -q < "$M_3C" >/dev/null || { echo "M3C migration failed to apply"; exit 2; }

FUT=$(( $(date +%s) + 3600 )); PAST=$(( $(date +%s) - 60 ))
# au <uid> <sql> [aal] [exp]  -> run as authenticated with a JWT for uid
au() { local claims="{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"${3:-aal1}\",\"exp\":${4:-$FUT}}"
  docker exec -i "$NAME" psql -U postgres -d d24m3c -qAt -c "set role authenticated; set request.jwt.claims = '$claims'; $2" </dev/null 2>&1 | tr '
' ' ' | sed -E 's/ERROR:  /ERR /' | sed -E 's/ +$//' | cut -c1-700; }
# aust <uid> <expr> [aal] [exp] -> STATE of calling an expression as that user
aust() { local claims="{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"${3:-aal1}\",\"exp\":${4:-$FUT}}"
  docker exec -i "$NAME" psql -U postgres -d d24m3c -qAt -c "set role authenticated; set request.jwt.claims = '$claims'; do \$\$ begin perform $2; raise notice 'NOSTATE'; exception when others then raise notice 'STATE % %', sqlstate, sqlerrm; end \$\$" </dev/null 2>&1 | tr '
' ' ' | cut -c1-700; }
LINE='[{"description":"Private lesson","quantity":2,"unit_price_cents":7500}]'
# save <uid> <studio> <reqkey> <invoice|null> <ver|null> <client> <lines> [reftype] [refid] [refnote]
sv() { # uid studio reqkey invoice ver client lines reftype refid refnote
  local inv="null::uuid" ver="null::integer" rt="null::text" ri="null::uuid" rn="null::text"
  [ "$4" != "null" ] && inv="'$4'::uuid"; [ "$5" != "null" ] && ver="$5"
  [ -n "${8:-}" ] && [ "${8}" != "null" ] && rt="'$8'::text"; [ -n "${9:-}" ] && [ "${9}" != "null" ] && ri="'$9'::uuid"; [ -n "${10:-}" ] && [ "${10}" != "null" ] && rn="'${10}'::text"
  echo "public.studio_client_invoice_save_draft('$2'::uuid,'$3'::uuid,$inv,$ver,'$6'::uuid,$rt,$ri,$rn,'$7'::jsonb)"; }
jf() { echo "$1" | grep -o "\"$2\": [^,}]*" | head -1 | sed -E 's/.*: //; s/"//g'; }
NEWKEY() { q "select gen_random_uuid()"; }

# 1. shape, privileges ---------------------------------------------------------------------------------------------------------
check "4 tables exist" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name in ('studio_client_invoices','studio_client_invoice_lines','studio_client_invoice_audit','studio_client_invoice_limits')")" "4"
check "RLS on all 4" "$(q "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname like 'studio_client_invoice%' and c.relkind='r' and c.relrowsecurity")" "4"
check "authenticated holds SELECT only (3 tables), nothing on limits" "$(q "select string_agg(distinct privilege_type||':'||table_name, ',' order by privilege_type||':'||table_name) from information_schema.role_table_grants where grantee='authenticated' and table_name like 'studio_client_invoice%'")" "SELECT:studio_client_invoice_audit,SELECT:studio_client_invoice_lines,SELECT:studio_client_invoices"
check "service_role holds SELECT only" "$(q "select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where grantee='service_role' and table_name like 'studio_client_invoice%'")" "SELECT"
check "anon/public hold nothing" "$(q "select count(*) from information_schema.role_table_grants where grantee in ('anon','public') and table_name like 'studio_client_invoice%'")" "0"
check "save_draft: authenticated only" "$(q "select has_function_privilege('authenticated','public.studio_client_invoice_save_draft(uuid,uuid,uuid,integer,uuid,text,uuid,text,jsonb)','execute')::text||has_function_privilege('anon','public.studio_client_invoice_save_draft(uuid,uuid,uuid,integer,uuid,text,uuid,text,jsonb)','execute')::text||has_function_privilege('service_role','public.studio_client_invoice_save_draft(uuid,uuid,uuid,integer,uuid,text,uuid,text,jsonb)','execute')::text")" "truefalsefalse"
for fn in "studio_client_invoice_creation_spec(uuid,uuid)" "studio_client_invoice_link_registration(uuid,uuid,uuid,integer,text)"; do
  check "service_role only: $fn" "$(q "select has_function_privilege('service_role','public.$fn','execute')::text||has_function_privilege('authenticated','public.$fn','execute')::text||has_function_privilege('anon','public.$fn','execute')::text")" "truefalsefalse"
done
for fn in "_sci_authorize(uuid,text)" "_sci_parse_lines(jsonb)" "_sci_actor_role(uuid)" "d24_owns_studio_client_invoice(uuid,text)"; do
  check "no API role executes $fn" "$(q "select has_function_privilege('service_role','public.$fn','execute') or has_function_privilege('authenticated','public.$fn','execute') or has_function_privilege('anon','public.$fn','execute')")" "f"
done
check "the permission helper is callable by authenticated only" "$(q "select has_function_privilege('authenticated','public.studio_billing_permission(uuid,text)','execute')::text||has_function_privilege('anon','public.studio_billing_permission(uuid,text)','execute')::text")" "truefalse"
check "every SECURITY DEFINER sci/d24-owner function pins its search_path" "$(q "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like '%sci%' or p.proname like 'studio_%' or p.proname='d24_owns_studio_client_invoice') and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=%', false)")" "0"
check "the type is registered with M3-A and has no 'subscription' in its name" "$(q "select business_object_type from public.hosted_invoice_business_object_types where business_object_type like 'studio_client%'")" "studio_client_invoice"
check "the ownership function is STABLE" "$(q "select provolatile from pg_proc where proname='d24_owns_studio_client_invoice'")" "s"
check "limits ship NULL (fail closed)" "$(q "select coalesce(min_total_cents::text,'null')||'/'||coalesce(max_total_cents::text,'null') from public.studio_client_invoice_limits")" "null/null"
check "no payment-URL / finalize / send / paid column exists" "$(q "select count(*) from information_schema.columns where table_name like 'studio_client_invoice%' and (column_name ~ 'url|hosted|finalized|sent|paid|settle|payment_id')")" "0"
check "no settlement/payment row types are written by this migration (no FK to payments)" "$(q "select count(*) from pg_constraint where conrelid::regclass::text like 'studio_client_invoice%' and confrelid::regclass::text in ('payments','hosted_invoice_payments')")" "0"

# 2. fail closed until the owner supplies the ceiling ------------------------------------------------------------------------------
K0=$(NEWKEY)
has "no limits configured: owner draft refused" "$(aust $UO "$(sv $UO $SA $K0 null null $CA1 "$LINE")")" "STATE 55000 client_invoice_limits_not_configured"
check "...and nothing was written" "$(q "select count(*) from public.studio_client_invoices")" "0"
has "limits cannot be set by service_role" "$(try "set role service_role; update public.studio_client_invoice_limits set min_total_cents=100, max_total_cents=1000")" "permission denied"
has "limits cannot be set by authenticated" "$(au $UO "update public.studio_client_invoice_limits set min_total_cents=100, max_total_cents=1000")" "permission denied"
has "limits: min above max is refused" "$(try "update public.studio_client_invoice_limits set min_total_cents=1000, max_total_cents=100")" "sci_limits_range_chk"
has "limits: below Stripe's 50c minimum is refused" "$(try "update public.studio_client_invoice_limits set min_total_cents=10, max_total_cents=100")" "sci_limits_range_chk"
has "limits: one side NULL is refused" "$(try "update public.studio_client_invoice_limits set min_total_cents=100")" "sci_limits_range_chk"
has "limits row cannot be deleted" "$(try "delete from public.studio_client_invoice_limits")" "cannot be deleted"
q "update public.studio_client_invoice_limits set min_total_cents=500, max_total_cents=500000, max_lines=25, max_quantity=1000" >/dev/null   # TEST VALUES ONLY (not the proposal)

# 3. role matrix -------------------------------------------------------------------------------------------------------------------
K1=$(NEWKEY)
R=$(au $UO "select $(sv $UO $SA $K1 null null $CA1 "$LINE")")
check "studio_owner creates a draft" "$(jf "$R" outcome)/$(jf "$R" status)/$(jf "$R" version)/$(jf "$R" total_cents)/$(jf "$R" line_count)" "created/draft/1/15000/1"
INV1=$(jf "$R" invoice_id)
check "...the response never carries a payment URL" "$(echo "$R" | grep -ci 'url\|hosted\|pay_')" "0"
K2=$(NEWKEY)
R2=$(au $UA "select $(sv $UA $SA $K2 null null $CA2 "$LINE")")
check "studio_admin creates a draft" "$(jf "$R2" outcome)" "created"
INV2=$(jf "$R2" invoice_id)
for who in "$UI:instructor" "$UF:front_desk" "$UC:client" "$UX:inactive-admin" "$UN:no-role" "$UP:platform-admin-without-studio-role" "$UB:other-studio-owner"; do
  u=${who%%:*}; n=${who#*:}
  has "$n is refused (42501 forbidden)" "$(aust $u "$(sv $u $SA $(NEWKEY) null null $CA1 "$LINE")")" "STATE 42501 client_invoice_forbidden"
done
has "anon (no JWT) is refused" "$(try "set role anon; select $(sv x $SA $(NEWKEY) null null $CA1 "$LINE")")" "permission denied"
has "service_role (no JWT) cannot call the draft function" "$(try "set role service_role; select $(sv x $SA $(NEWKEY) null null $CA1 "$LINE")")" "permission denied"
has "authenticated without auth.uid() (no sub) is refused" "$(try "set role authenticated; set request.jwt.claims = '{\"role\":\"authenticated\",\"exp\":$FUT}'; do \$\$ begin perform $(sv x $SA $(NEWKEY) null null $CA1 "$LINE"); exception when others then raise notice 'STATE % %', sqlstate, sqlerrm; end \$\$")" "STATE 42501 client_invoice_authentication_required"
has "an expired session is refused" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE")" aal1 $PAST)" "STATE 42501 client_invoice_session_expired"
has "a JWT claiming role=service_role through authenticated is refused" "$(try "set role authenticated; set request.jwt.claims = '{\"sub\":\"$UO\",\"role\":\"service_role\",\"exp\":$FUT}'; do \$\$ begin perform $(sv x $SA $(NEWKEY) null null $CA1 "$LINE"); exception when others then raise notice 'STATE % %', sqlstate, sqlerrm; end \$\$")" "STATE 42501 client_invoice_authentication_required"
has "NULL studio id is refused" "$(aust $UO "public.studio_client_invoice_save_draft(null::uuid,'$(NEWKEY)'::uuid,null::uuid,null::integer,'$CA1'::uuid,null::text,null::uuid,null::text,'$LINE'::jsonb)")" "STATE 42501 client_invoice_forbidden"
check "AAL1 is allowed and recorded; AAL2 recorded" "$(au $UO "select $(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE")" aal2 >/dev/null; q "select string_agg(actor_aal, ',' order by id) from public.studio_client_invoice_audit where actor_user_id='$UO'")" "aal1,aal2"
check "refusals wrote no invoice" "$(q "select count(*) from public.studio_client_invoices")" "3"

# 4. money arithmetic and bounds --------------------------------------------------------------------------------------------------
bad() { has "refused: $1" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null $CA1 "$2")")" "STATE $3"; }
bad "quantity 0" '[{"description":"x","quantity":0,"unit_price_cents":1000}]' "22023 client_invoice_quantity_invalid"
bad "quantity negative" '[{"description":"x","quantity":-1,"unit_price_cents":1000}]' "22023 client_invoice_quantity_invalid"
bad "quantity fractional" '[{"description":"x","quantity":1.5,"unit_price_cents":1000}]' "22023 client_invoice_quantity_invalid"
bad "quantity above max_quantity" '[{"description":"x","quantity":1001,"unit_price_cents":1}]' "22023 client_invoice_quantity_invalid"
bad "quantity as a string" '[{"description":"x","quantity":"2","unit_price_cents":1000}]' "22023 client_invoice_lines_invalid"
bad "unit price 0" '[{"description":"x","quantity":1,"unit_price_cents":0}]' "22023 client_invoice_amount_invalid"
bad "unit price negative" '[{"description":"x","quantity":1,"unit_price_cents":-100}]' "22023 client_invoice_amount_invalid"
bad "unit price fractional (cents are integers)" '[{"description":"x","quantity":1,"unit_price_cents":1000.5}]' "22023 client_invoice_amount_invalid"
bad "unit price as a string" '[{"description":"x","quantity":1,"unit_price_cents":"1000"}]' "22023 client_invoice_lines_invalid"
bad "unit price above the ceiling" '[{"description":"x","quantity":1,"unit_price_cents":500001}]' "22023 client_invoice_amount_invalid"
bad "quantity x price above the ceiling" '[{"description":"x","quantity":101,"unit_price_cents":5000}]' "22023 client_invoice_amount_invalid"
bad "sum of lines above the ceiling" '[{"description":"a","quantity":1,"unit_price_cents":300000},{"description":"b","quantity":1,"unit_price_cents":300000}]' "22023 client_invoice_total_out_of_range"
bad "total below the floor" '[{"description":"x","quantity":1,"unit_price_cents":499}]' "22023 client_invoice_total_out_of_range"
bad "numeric overflow (1e30)" '[{"description":"x","quantity":1,"unit_price_cents":1e30}]' "22023 client_invoice_amount_invalid"
bad "empty line list" '[]' "22023 client_invoice_line_count_invalid"
bad "26 lines (max_lines 25)" "$(q "select jsonb_agg(jsonb_build_object('description','l'||g,'quantity',1,'unit_price_cents',500))::text from generate_series(1,26) g")" "22023 client_invoice_line_count_invalid"
bad "lines is an object, not an array" '{"description":"x","quantity":1,"unit_price_cents":1000}' "22023 client_invoice_lines_invalid"
bad "NULL lines" 'null' "22023 client_invoice_lines_invalid"
bad "empty description" '[{"description":"  ","quantity":1,"unit_price_cents":1000}]' "22023 client_invoice_description_invalid"
bad "201-char description" "[{\"description\":\"$(printf 'x%.0s' $(seq 1 201))\",\"quantity\":1,\"unit_price_cents\":1000}]" "22023 client_invoice_description_invalid"
bad "control character in a description" '[{"description":"a\u0007b","quantity":1,"unit_price_cents":1000}]' "22023 client_invoice_description_invalid"
bad "unknown key (forged id)" '[{"description":"x","quantity":1,"unit_price_cents":1000,"stripe_invoice_id":"in_x"}]' "22023 client_invoice_lines_invalid"
bad "forged line_total_cents" '[{"description":"x","quantity":2,"unit_price_cents":1000,"line_total_cents":1}]' "22023 client_invoice_lines_invalid"
bad "line is not an object" '[7]' "22023 client_invoice_lines_invalid"
R=$(au $UO "select $(sv $UO $SA $(NEWKEY) null null $CA1 '[{"description":"floor","quantity":1,"unit_price_cents":500}]')")
check "total exactly at the floor is accepted" "$(jf "$R" total_cents)" "500"
R=$(au $UO "select $(sv $UO $SA $(NEWKEY) null null $CA1 '[{"description":"ceiling","quantity":1,"unit_price_cents":500000}]')")
check "total exactly at the ceiling is accepted" "$(jf "$R" total_cents)" "500000"
R=$(au $UO "select $(sv $UO $SA $(NEWKEY) null null $CA1 '[{"description":"a","quantity":3,"unit_price_cents":1999},{"description":"b","quantity":10,"unit_price_cents":333}]')")
check "multi-line arithmetic: 3*1999 + 10*333 = 9327" "$(jf "$R" total_cents)/$(jf "$R" line_count)" "9327/2"
check "stored lines agree with the stored total (DB-computed, line positions 1..n)" "$(q "select sum(line_total_cents)||'/'||string_agg(position::text, ',' order by position) from public.studio_client_invoice_lines where invoice_id='$(jf "$R" invoice_id)'")" "9327/1,2"
has "reference note with a control character is refused" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE" other null "$(printf 'bad\007note')")")" "STATE 22023 client_invoice_input_invalid"

# 5. cross-tenant: client / reference / ids -------------------------------------------------------------------------------------
has "A's owner cannot invoice B's client" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null $CB1 "$LINE")")" "STATE 42501 client_invoice_client_not_in_studio"
has "an unknown client id is refused" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null 00000000-0000-0000-0000-00000000dead "$LINE")")" "STATE 42501 client_invoice_client_not_in_studio"
has "B's owner cannot pass A's studio id (forged studio)" "$(aust $UB "$(sv $UB $SA $(NEWKEY) null null $CA1 "$LINE")")" "STATE 42501 client_invoice_forbidden"
has "B's owner cannot edit A's invoice through B's own studio id (looks missing)" "$(aust $UB "$(sv $UB $SB $(NEWKEY) $INV1 1 $CB1 "$LINE")")" "STATE 42501 client_invoice_not_found"
has "B's owner cannot edit A's invoice through A's studio id" "$(aust $UB "$(sv $UB $SA $(NEWKEY) $INV1 1 $CB1 "$LINE")")" "STATE 42501 client_invoice_forbidden"
has "an unknown invoice id is indistinguishable (not_found)" "$(aust $UO "$(sv $UO $SA $(NEWKEY) 00000000-0000-0000-0000-00000000beef 1 $CA1 "$LINE")")" "STATE 42501 client_invoice_not_found"
for rt in "appointment:$AP_A:$AP_B" "event:$EV_A:$EV_B" "payment:$PY_A:$PY_B"; do
  t=${rt%%:*}; rest=${rt#*:}; own=${rest%%:*}; foreign=${rest#*:}
  R=$(au $UO "select $(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE" $t $own)")
  check "same-studio $t reference accepted" "$(jf "$R" outcome)" "created"
  has "other-studio $t reference refused" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE" $t $foreign)")" "STATE 42501 client_invoice_reference_not_in_studio"
  has "nonexistent $t reference refused" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE" $t 00000000-0000-0000-0000-00000000dead)")" "STATE 42501 client_invoice_reference_not_in_studio"
done
R=$(au $UO "select $(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE" other null 'Recital costume fitting')")
check "free-text 'other' reference accepted" "$(jf "$R" outcome)" "created"
has "unknown reference type refused" "$(aust $UO "$(sv $UO $SA $(NEWKEY) null null $CA1 "$LINE" subscription $EV_A)")" "STATE 22023"
has "reference id without a type refused" "$(aust $UO "public.studio_client_invoice_save_draft('$SA'::uuid,'$(NEWKEY)'::uuid,null::uuid,null::integer,'$CA1'::uuid,null::text,'$EV_A'::uuid,null::text,'$LINE'::jsonb)")" "STATE 22023"
has "typed reference with a note refused" "$(aust $UO "public.studio_client_invoice_save_draft('$SA'::uuid,'$(NEWKEY)'::uuid,null::uuid,null::integer,'$CA1'::uuid,'event','$EV_A'::uuid,'x','$LINE'::jsonb)")" "STATE 22023"
check "the invoice never creates payment/settlement rows" "$(q "select count(*) from public.payments")/$(q "select count(*) from public.hosted_invoice_payments")" "2/0"
# a database-level bypass of the function is also refused (client/reference same-studio trigger, owner role with the writer flag)
has "trigger: even the owner role cannot insert a cross-studio client" "$(try "begin; select set_config('df.sci_writer','on',true); insert into public.studio_client_invoices (studio_id, client_id, request_key, total_cents, line_count, created_by, last_edited_by) values ('$SA','$CB1','$(NEWKEY)',1000,1,'$UO','$UO'); commit")" "client_invoice_client_not_in_studio"
has "trigger: even the owner role cannot insert without the writer flag" "$(try "insert into public.studio_client_invoices (studio_id, client_id, request_key, total_cents, line_count, created_by, last_edited_by) values ('$SA','$CA1','$(NEWKEY)',1000,1,'$UO','$UO')")" "only allowed through the client invoice functions"

# 6. edit rules, versions, double submit, concurrency ------------------------------------------------------------------------------
R=$(au $UO "select $(sv $UO $SA $K1 null null $CA1 "$LINE")")
check "double submit (same request key): outcome 'existing', same invoice" "$(jf "$R" outcome)/$(jf "$R" invoice_id)" "existing/$INV1"
check "...exactly one invoice and one audit row for it" "$(q "select count(*) from public.studio_client_invoices where request_key='$K1'")/$(q "select count(*) from public.studio_client_invoice_audit where invoice_id='$INV1'")" "1/1"
R=$(au $UA "select $(sv $UA $SA $K1 null null $CA1 "$LINE")")
check "the same request key from another staff member also dedupes (per studio)" "$(jf "$R" outcome)" "existing"
R=$(au $UB "select $(sv $UB $SB $K1 null null $CB1 "$LINE")")
check "the same request key in another studio is an independent invoice" "$(jf "$R" outcome)" "created"
NL='[{"description":"Group class","quantity":4,"unit_price_cents":2500},{"description":"Registration","quantity":1,"unit_price_cents":3000}]'
R=$(au $UA "select $(sv $UA $SA $(NEWKEY) $INV1 1 $CA2 "$NL")")
check "admin edits the owner's draft: version 2, new total, lines replaced" "$(jf "$R" outcome)/$(jf "$R" version)/$(jf "$R" total_cents)/$(jf "$R" line_count)/$(jf "$R" client_id)" "updated/2/13000/2/$CA2"
check "...old lines are gone" "$(q "select count(*) from public.studio_client_invoice_lines where invoice_id='$INV1'")" "2"
has "stale version is refused (40001)" "$(aust $UO "$(sv $UO $SA $(NEWKEY) $INV1 1 $CA1 "$LINE")")" "STATE 40001 client_invoice_version_conflict"
has "NULL expected version is refused" "$(aust $UO "$(sv $UO $SA $(NEWKEY) $INV1 null $CA1 "$LINE")")" "STATE 40001 client_invoice_version_conflict"
has "a failed edit (bad money) leaves the invoice untouched" "$(aust $UO "$(sv $UO $SA $(NEWKEY) $INV1 2 $CA1 '[{"description":"x","quantity":0,"unit_price_cents":1}]')")" "STATE 22023"
check "...still version 2, total 13000" "$(q "select version||'/'||total_cents from public.studio_client_invoices where id='$INV1'")" "2/13000"
has "an edit cannot move the invoice to B's client" "$(aust $UO "$(sv $UO $SA $(NEWKEY) $INV1 2 $CB1 "$LINE")")" "STATE 42501 client_invoice_client_not_in_studio"
has "instructor cannot edit" "$(aust $UI "$(sv $UI $SA $(NEWKEY) $INV1 2 $CA1 "$LINE")")" "STATE 42501 client_invoice_forbidden"
# concurrency: same request key
CK=$(NEWKEY)
for i in $(seq 1 8); do ( docker exec -i "$NAME" psql -U postgres -d d24m3c -qAt -c "set role authenticated; set request.jwt.claims = '{\"sub\":\"$UO\",\"role\":\"authenticated\",\"exp\":$FUT}'; select ($(sv $UO $SA $CK null null $CA1 "$LINE"))->>'outcome'" </dev/null >"$TMPD/ck_$i.txt" 2>&1 ) & done
wait
check "8 concurrent submits (one request key): exactly one created, 7 existing" "$(cat "$TMPD"/ck_*.txt | grep -c '^created$')/$(cat "$TMPD"/ck_*.txt | grep -c '^existing$')" "1/7"
check "...one invoice, one audit row" "$(q "select count(*) from public.studio_client_invoices where request_key='$CK'")/$(q "select count(*) from public.studio_client_invoice_audit a join public.studio_client_invoices i on i.id=a.invoice_id where i.request_key='$CK'")" "1/1"
# concurrency: edits with the same expected version
V=$(q "select version from public.studio_client_invoices where id='$INV2'")
for i in $(seq 1 6); do ( docker exec -i "$NAME" psql -U postgres -d d24m3c -qAt -c "set role authenticated; set request.jwt.claims = '{\"sub\":\"$UA\",\"role\":\"authenticated\",\"exp\":$FUT}'; do \$\$ begin perform $(sv $UA $SA $(NEWKEY) $INV2 $V $CA2 "[{\"description\":\"edit $i\",\"quantity\":1,\"unit_price_cents\":$((1000 + i))}]"); raise notice 'WON'; exception when others then raise notice 'LOST %', sqlstate; end \$\$" </dev/null >"$TMPD/ce_$i.txt" 2>&1 ) & done
wait
check "6 concurrent edits with the same expected version: exactly one wins, five get 40001" "$(cat "$TMPD"/ce_*.txt | grep -c 'WON')/$(cat "$TMPD"/ce_*.txt | grep -c 'LOST 40001')" "1/5"
check "...version advanced exactly once; lines match the winner's total" "$(q "select (i.version - $V)||'/'||(i.total_cents = (select sum(line_total_cents) from public.studio_client_invoice_lines where invoice_id=i.id))::text from public.studio_client_invoices i where i.id='$INV2'")" "1/true"

# 7. direct writes, immutability of evidence, total consistency -----------------------------------------------------------------
has "authenticated cannot INSERT an invoice" "$(au $UO "insert into public.studio_client_invoices (studio_id, client_id, request_key, total_cents, line_count, created_by, last_edited_by) values ('$SA','$CA1','$(NEWKEY)',1000,1,'$UO','$UO')")" "permission denied"
has "authenticated cannot UPDATE an invoice" "$(au $UO "update public.studio_client_invoices set total_cents=1 where id='$INV1'")" "permission denied"
has "authenticated cannot DELETE an invoice" "$(au $UO "delete from public.studio_client_invoices where id='$INV1'")" "permission denied"
has "authenticated cannot write lines" "$(au $UO "update public.studio_client_invoice_lines set quantity=9")" "permission denied"
has "authenticated cannot write the audit" "$(au $UO "delete from public.studio_client_invoice_audit")" "permission denied"
has "service_role cannot write invoices" "$(try "set role service_role; update public.studio_client_invoices set total_cents=1")" "permission denied"
has "owner role: invoice delete refused" "$(try "begin; select set_config('df.sci_writer','on',true); delete from public.studio_client_invoices where id='$INV1'; commit")" "evidence is permanent"
has "owner role: truncate refused" "$(try "truncate public.studio_client_invoices cascade")" "not allowed"
has "owner role: line update refused" "$(try "begin; select set_config('df.sci_writer','on',true); update public.studio_client_invoice_lines set quantity=9; commit")" "lines are replaced, never updated"
has "owner role: audit update refused" "$(try "update public.studio_client_invoice_audit set total_cents=1")" "not allowed"
has "owner role: audit delete refused" "$(try "delete from public.studio_client_invoice_audit")" "not allowed"
has "owner role: audit truncate refused" "$(try "truncate public.studio_client_invoice_audit")" "not allowed"
has "total consistency: a stored total that disagrees with the lines fails at COMMIT" "$(try "begin; select set_config('df.sci_writer','on',true); update public.studio_client_invoices set total_cents = total_cents + 1, version = version + 1 where id='$INV1'; commit")" "client_invoice_total_mismatch"
has "total consistency: a line change without the total fails at COMMIT" "$(try "begin; select set_config('df.sci_writer','on',true); delete from public.studio_client_invoice_lines where invoice_id='$INV1' and position=2; commit")" "client_invoice_total_mismatch"
check "...nothing changed" "$(q "select total_cents||'/'||line_count||'/'||(select count(*) from public.studio_client_invoice_lines where invoice_id='$INV1') from public.studio_client_invoices where id='$INV1'")" "13000/2/2"
has "immutable column (studio_id) cannot change" "$(try "begin; select set_config('df.sci_writer','on',true); update public.studio_client_invoices set studio_id='$SB', version=version+1 where id='$INV1'; commit")" "immutable column changed"
has "a line cannot be re-pointed to another studio's invoice (composite FK)" "$(try "begin; select set_config('df.sci_writer','on',true); insert into public.studio_client_invoice_lines (invoice_id, studio_id, position, description, quantity, unit_price_cents, line_total_cents) values ('$INV1','$SB',9,'x',1,1000,1000); commit")" "foreign key"
has "line check: line_total must equal quantity*unit" "$(try "begin; select set_config('df.sci_writer','on',true); insert into public.studio_client_invoice_lines (invoice_id, studio_id, position, description, quantity, unit_price_cents, line_total_cents) values ('$INV1','$SA',9,'x',2,1000,1); commit")" "sci_line_total_chk"
has "currency is immutable (and USD-only by CHECK)" "$(try "begin; select set_config('df.sci_writer','on',true); update public.studio_client_invoices set currency='eur', version=version+1 where id='$INV1'; commit")" "immutable column changed"

# 8. RLS reads ---------------------------------------------------------------------------------------------------------------------
NA=$(q "select count(*) from public.studio_client_invoices where studio_id='$SA'")
check "owner sees all of A's invoices" "$(au $UO "select count(*) from public.studio_client_invoices")" "$NA"
check "admin sees A's invoices" "$(au $UA "select count(*) from public.studio_client_invoices")" "$NA"
check "B's owner sees only B's" "$(au $UB "select count(*) from public.studio_client_invoices where studio_id='$SA'")/$(au $UB "select count(*) from public.studio_client_invoices")" "0/1"
for who in "$UI:instructor" "$UF:front_desk" "$UC:client" "$UX:inactive" "$UN:no-role"; do
  check "${who#*:} reads no invoice" "$(au ${who%%:*} "select count(*) from public.studio_client_invoices")/$(au ${who%%:*} "select count(*) from public.studio_client_invoice_lines")/$(au ${who%%:*} "select count(*) from public.studio_client_invoice_audit")" "0/0/0"
done
check "owner reads lines and audit of A; B's owner none of them" "$(au $UO "select count(*) > 0 from public.studio_client_invoice_lines")/$(au $UO "select count(*) > 0 from public.studio_client_invoice_audit")/$(au $UB "select count(*) from public.studio_client_invoice_lines where studio_id='$SA'")/$(au $UB "select count(*) from public.studio_client_invoice_audit where studio_id='$SA'")" "t/t/0/0"
has "anon cannot read" "$(try "set role anon; select count(*) from public.studio_client_invoices")" "permission denied"
check "the permission helper answers false for a studio the caller is not in" "$(au $UB "select public.studio_billing_permission('$SA','client_invoice.draft')")/$(au $UB "select public.studio_billing_permission('$SB','client_invoice.draft')")/$(au $UO "select public.studio_billing_permission('$SA','client_invoice.unknown')")" "f/t/f"

# 9. audit integrity ---------------------------------------------------------------------------------------------------------------
check "audit: create + edit for INV1, actor = the JWT subject, role recorded" "$(q "select string_agg(action||':'||version||':'||actor_user_id||':'||actor_role, ',' order by id) from public.studio_client_invoice_audit where invoice_id='$INV1'")" "create:1:$UO:studio_owner,edit:2:$UA:studio_admin"
check "audit: every audit row has a 64-hex content hash and matching totals" "$(q "select count(*) from public.studio_client_invoice_audit where content_sha256 !~ '^[0-9a-f]{64}$'")" "0"
check "audit: one row per create/edit (no row for double submits or refusals)" "$(q "select count(*) from public.studio_client_invoice_audit where action in ('create','edit')")" "$(q "select sum(version) from public.studio_client_invoices")"
check "audit: the edit changed the content hash" "$(q "select count(distinct content_sha256) from public.studio_client_invoice_audit where invoice_id='$INV1'")" "2"

# 10. M3-A ownership function + registration link ------------------------------------------------------------------------------------
own() { q "select public.d24_owns_studio_client_invoice('$1','$2')"; }
check "ownership: own invoice true" "$(own $SA $INV1)" "t"
check "ownership: other studio false" "$(own $SB $INV1)" "f"
check "ownership: unknown uuid false" "$(own $SA 00000000-0000-0000-0000-00000000beef)" "f"
check "ownership: malformed id false (no cast error)" "$(own $SA not-a-uuid)" "f"
check "ownership: NULL studio false" "$(q "select public.d24_owns_studio_client_invoice(null,'$INV1')")" "f"
check "ownership: NULL object is not owned (false)" "$(q "select coalesce(public.d24_owns_studio_client_invoice('$SA',null)::text,'null')")" "false"
KEY1=ci-intent-0000001
has "begin on a foreign invoice id is refused by SQL ownership" "$(st "public.d24_intent_begin('$SB','studio_client_invoice','$INV1','ci-intent-forged01')")" "STATE 42501 d24_business_object_not_owned"
has "begin on a studio with no connected account is refused" "$(st "public.d24_intent_begin('$SC','studio_client_invoice','$INV1','ci-intent-noacct01')")" "STATE 42501"
B1=$(q "select public.d24_intent_begin('$SA','studio_client_invoice','$INV1','$KEY1','$UO')")
I1=$(echo "$B1" | grep -o '"intent_id": "[^"]*"' | sed -E 's/.*: "//; s/"//')
check "M3-A begin accepts the client invoice type" "$(jf "$B1" outcome)/$(jf "$B1" status)" "created/pending"
has "link before the intent is registered is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','$I1',2)")" "STATE 55000 client_invoice_intent_not_registered"
SPEC=$(try "set role service_role; select public.studio_client_invoice_creation_spec('$INV1','$SA')")
check "creation spec: trusted lines + totals for a draft inside the limits" "$(echo "$SPEC" | grep -o '"total_cents": [0-9]*')/$(echo "$SPEC" | grep -o '"line_total_cents"' | wc -l | tr -d ' ')" '"total_cents": 13000/2'
check "creation spec: other studio's view is NULL" "$(q "select coalesce(public.studio_client_invoice_creation_spec('$INV1','$SB')::text,'null')")" "null"
q "update public.studio_client_invoice_limits set max_total_cents = 12000" >/dev/null
check "creation spec: NULL when the stored total exceeds the (lowered) ceiling" "$(q "select coalesce(public.studio_client_invoice_creation_spec('$INV1','$SA')::text,'null')")" "null"
q "update public.studio_client_invoice_limits set max_total_cents = 500000" >/dev/null
q "select public.d24_intent_mark_provider_created('$I1','$SA','in_ci1',false,false)" >/dev/null
has "link while provider_created (not registered) is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','$I1',2)")" "STATE 55000 client_invoice_intent_not_registered"
RG=$(q "select public.d24_intent_register('$I1','$SA')")
check "M3-A register succeeds for the client invoice" "$(jf "$RG" outcome)" "registered"
# the intent exists, but intent for a different object / studio must not link
q "select public.d24_intent_begin('$SA','studio_client_invoice','$INV2','ci-intent-0000002','$UO')" >/dev/null
I2=$(q "select id from public.hosted_invoice_creation_intents where idempotency_key='ci-intent-0000002'")
has "link with an intent for a DIFFERENT invoice is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','$I2',2)")" "STATE 42501 client_invoice_intent_mismatch"
has "link with another studio's id is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SB','$I1',2)")" "STATE 42501 client_invoice_not_found"
has "link with a forged customer id format is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','$I1',2,'cus_x;drop')")" "STATE 22023"
has "link with an unknown intent is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','00000000-0000-0000-0000-00000000dead',2)")" "STATE 42501 client_invoice_intent_mismatch"
has "authenticated cannot call link" "$(au $UO "select public.studio_client_invoice_link_registration('$INV1','$SA','$I1',2)")" "permission denied"
has "authenticated cannot call the creation spec" "$(au $UO "select public.studio_client_invoice_creation_spec('$INV1','$SA')")" "permission denied"
VI2=$(q "select version from public.studio_client_invoices where id='$INV2'")
has "REVIEW P1: an invoice with a live creation intent cannot be edited (begin, then edit, is refused)" "$(aust $UO "$(sv $UO $SA $(NEWKEY) $INV2 $VI2 $CA2 "$LINE")")" "STATE 55000 client_invoice_not_editable"
has "REVIEW P1: link with a stale content version is refused (40001) and changes nothing" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','$I1',1)")" "STATE 40001 client_invoice_version_conflict"
check "...invoice still a draft" "$(q "select status from public.studio_client_invoices where id='$INV1'")" "draft"
has "link without an expected version is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','$I1',null::integer)")" "STATE 22023"
LK=$(try "set role service_role; select public.studio_client_invoice_link_registration('$INV1','$SA','$I1',2,'cus_ABC123')")
check "link: provider_draft_created, version advanced" "$(jf "$LK" outcome)/$(jf "$LK" status)/$(jf "$LK" version)" "linked/provider_draft_created/3"
check "link: registration copied from the ledger, not the caller" "$(q "select stripe_account_id||'/'||stripe_invoice_id||'/'||livemode||'/'||stripe_customer_id||'/'||(registry_id = (select id from public.hosted_invoice_registry where stripe_invoice_id='in_ci1'))::text||'/'||(intent_id='$I1')::text from public.studio_client_invoices where id='$INV1'")" "acct_aaa/in_ci1/false/cus_ABC123/true/true"
check "link is idempotent" "$(q "select (public.studio_client_invoice_link_registration('$INV1','$SA','$I1',2,'cus_ABC123'))->>'outcome'")" "already_linked"
has "link with a different customer id after linking is refused" "$(st "public.studio_client_invoice_link_registration('$INV1','$SA','$I1',2,'cus_OTHER')")" "STATE 55000 client_invoice_already_linked"
check "link audit row has no human actor and carries the intent" "$(q "select actor_user_id is null, intent_id='$I1' from public.studio_client_invoice_audit where invoice_id='$INV1' and action='link_registration'")" "t|t"
has "EDIT AFTER REGISTRATION refused (staff)" "$(aust $UO "$(sv $UO $SA $(NEWKEY) $INV1 3 $CA1 "$LINE")")" "STATE 55000 client_invoice_not_editable"
has "...refused for the admin too" "$(aust $UA "$(sv $UA $SA $(NEWKEY) $INV1 3 $CA1 "$LINE")")" "STATE 55000 client_invoice_not_editable"
has "direct UPDATE after registration refused (owner role + writer flag)" "$(try "begin; select set_config('df.sci_writer','on',true); update public.studio_client_invoices set total_cents=1, version=version+1 where id='$INV1'; commit")" "client_invoice_not_editable"
has "direct line INSERT after registration refused" "$(try "begin; select set_config('df.sci_writer','on',true); insert into public.studio_client_invoice_lines (invoice_id, studio_id, position, description, quantity, unit_price_cents, line_total_cents) values ('$INV1','$SA',9,'x',1,1000,1000); commit")" "client_invoice_not_editable"
has "direct line DELETE after registration refused" "$(try "begin; select set_config('df.sci_writer','on',true); delete from public.studio_client_invoice_lines where invoice_id='$INV1'; commit")" "client_invoice_not_editable"
check "creation spec is NULL once registered (no second provider draft)" "$(q "select coalesce(public.studio_client_invoice_creation_spec('$INV1','$SA')::text,'null')")" "null"
check "the ownership function still answers true after registration (replayed register passes)" "$(own $SA $INV1)" "t"
check "M3-A one-live-intent rule blocks a second invoice for the same object" "$(st "public.d24_intent_begin('$SA','studio_client_invoice','$INV1','ci-intent-second01')" | grep -c 'd24_object_has_live_intent')" "1"
check "nothing here wrote settlement: hosted_invoice_payments and payments untouched" "$(q "select (select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.payments)")" "0/2"
# a draft's invoice row never carries a payment URL / secret fields in the RLS-visible projection
check "RLS-visible columns contain no url/secret/token columns" "$(q "select count(*) from information_schema.columns where table_name='studio_client_invoices' and column_name ~ 'url|secret|token|key_id'")" "0"

# 11. rollback ------------------------------------------------------------------------------------------------------------------------
r=$(docker exec -i "$NAME" psql -U postgres -d d24m3c -v ON_ERROR_STOP=1 -q < "$M_RB" 2>&1 | tr -d '\n' | cut -c1-160)
has "rollback refused while creation intents for the type exist" "$r" "creation intents exist"
check "refused rollback left the schema intact" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name like 'studio_client_invoice%'")" "4"
F="docker exec -i $NAME psql -U postgres -d d24m3fresh -v ON_ERROR_STOP=1 -qAt"
bootstrap d24m3fresh || { echo "fresh bootstrap failed"; exit 2; }
$F < "$M_3C" >/dev/null 2>"$TMPD/fresh.err" || head -c 400 "$TMPD/fresh.err"
check "fresh DB: migration applies and registers the type" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'studio_client_invoice%'")/$($F -c "select count(*) from public.hosted_invoice_business_object_types where business_object_type='studio_client_invoice'")" "4/1"
$F < "$M_RB" >/dev/null 2>&1
check "fresh DB: rollback removes every M3-C object and the registered type" "$($F -c "select (select count(*) from information_schema.tables where table_schema='public' and table_name like 'studio_client_invoice%')||'/'||(select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like '%sci%' or proname like 'studio_client_invoice%' or proname='studio_billing_permission' or proname='d24_owns_studio_client_invoice'))||'/'||(select count(*) from public.hosted_invoice_business_object_types where business_object_type='studio_client_invoice')")" "0/0/0"
$F < "$M_3C" >/dev/null 2>&1
check "fresh DB: migration re-applies after rollback" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'studio_client_invoice%'")" "4"
# evidence present (no intents): refused without the export acknowledgement, allowed with it
$F -c "insert into public.studios values ('$SA','S','acct_aaa'); insert into public.clients (id, studio_id) values ('$CA1','$SA'); update public.studio_client_invoice_limits set min_total_cents=500, max_total_cents=500000; begin; select set_config('df.sci_writer','on',true); insert into public.studio_client_invoices (studio_id, client_id, request_key, total_cents, line_count, created_by, last_edited_by) values ('$SA','$CA1',gen_random_uuid(),1000,1,'$UO','$UO'); insert into public.studio_client_invoice_lines (invoice_id, studio_id, position, description, quantity, unit_price_cents, line_total_cents) select id, studio_id, 1, 'x', 1, 1000, 1000 from public.studio_client_invoices; commit" >/dev/null 2>&1
r=$($F < "$M_RB" 2>&1 | tr -d '\n' | cut -c1-160)
has "fresh DB: rollback refused while invoice evidence exists" "$r" "client invoice evidence exists"
{ echo "set d24.m3c_rollback_exported='yes';"; cat "$M_RB"; } | $F >/dev/null 2>&1
check "fresh DB: rollback with the export acknowledgement removes the tables" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'studio_client_invoice%'")" "0"

echo "SQL RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
