#!/usr/bin/env bash
# D24 M2-B: run the real M1 + M2-B migrations (and the M2-B rollback) against a DISPOSABLE Postgres container.
# Container df-d24-m2b-pg: no published ports, no volumes, removed on exit. It never touches any other database.
# auth.uid()/auth.jwt() are stubbed exactly the way Supabase defines them (from the request.jwt.claims setting); profiles / user_studio_roles are minimal stand-ins.
# Usage: bash scripts/qa/d24-m2b-sql.sh
set -uo pipefail

NAME=df-d24-m2b-pg
M_CLAIM="src/lib/supabase/migrations/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="src/lib/supabase/migrations/20270203110000_d24_hosted_invoice_facts.sql"
M_OP="src/lib/supabase/migrations/20270207090000_d24_operator_actions.sql"
M_RB="src/lib/supabase/migrations/rollback/20270207090000_d24_operator_actions_rollback.sql"
cd "$(dirname "$0")/../.."
M_C2C="src/lib/supabase/migrations/20270206090000_d24_m2c_drain_recovery.sql"
TMPD=$(mktemp -d)
# M2-C owns the requeue table, guard and drain; until its PR (#386) is merged, take it from its branch
[ -f "$M_C2C" ] || { git show origin/claude/d24-m2c-drain-59d43a:"$M_C2C" > "$TMPD/m2c.sql" 2>/dev/null && M_C2C="$TMPD/m2c.sql"; }
for f in "$M_CLAIM" "$M_D24" "$M_C2C" "$M_OP" "$M_RB"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap 'rm -rf "$TMPD"; cleanup' EXIT
cleanup

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=d24-local-only postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2

P="docker exec -i $NAME psql -U postgres -v ON_ERROR_STOP=1 -qAt"
q() { $P -c "$1"; }
# run as an authenticated end user: asu USER_UUID AAL SQL  (AAL = aal1|aal2|none ; none = no JWT at all)
asu() {
  local claims
  local exp; exp=$(( $(date +%s) + 3600 ))
  case "$2" in
    none) claims='{}' ;;
    expired) claims="{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"aal2\",\"exp\":$((exp - 7200))}" ;;
    noexp) claims="{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"aal2\"}" ;;
    anonrole) claims="{\"sub\":\"$1\",\"role\":\"anon\",\"aal\":\"aal2\",\"exp\":$exp}" ;;
    *) claims="{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"$2\",\"exp\":$exp}" ;;
  esac
  docker exec -i "$NAME" psql -U postgres -qAt -c "set role authenticated; select set_config('request.jwt.claims', '$claims', false) is not null; $3" </dev/null 2>&1 \
    | tr '\n' ' ' | sed -E 's/^SET t //; s/ERROR:  /ERR /' | sed -E 's/ +$//' | cut -c1-600
}
asr() { docker exec -i "$NAME" psql -U postgres -qAt -c "set role $1; $2" </dev/null 2>&1 | tr '\n' ' ' | sed -E 's/^SET //; s/ERROR:  /ERR /' | sed -E 's/ +$//' | cut -c1-600; }

$P <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;
create schema auth; grant usage on schema auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
create table public.studios (id uuid primary key default gen_random_uuid(), name text);
create table public.studio_invoices (id uuid primary key default gen_random_uuid(), stripe_invoice_id text, studio_id uuid);
create table public.profiles (id uuid primary key, platform_role text);
create table public.user_studio_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, studio_id uuid not null, role text not null, active boolean not null default true);
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text,
  created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_CLAIM" >/dev/null
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_D24" >/dev/null
# precondition failure test: applying M2-B must have worked on the real base
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_C2C" >/dev/null || { echo "FAIL M2-C migration did not apply"; exit 1; }
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_OP" >/dev/null || { echo "FAIL M2-B migration did not apply"; exit 1; }
# rollback works on a clean install, leaves M1/M2-C intact, and the migration re-applies (no duplicate objects)
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_RB" >/dev/null 2>&1; RB1=$?
RBLEFT=$(docker exec -i "$NAME" psql -U postgres -qAt -c "select (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'd24\_op\_%' or proname like '\_d24\_op\_%')||'/'||(to_regclass('public.hosted_invoice_dismissals') is null)||'/'||(to_regprocedure('public.d24_requeue_deferred_event(text,uuid,text)') is not null)||'/'||has_function_privilege('service_role','public.d24_requeue_deferred_event(text,uuid,text)','execute')")
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_OP" >/dev/null 2>&1; RB2=$?

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi; }
has() { if echo "$2" | grep -q -- "$3"; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected to contain '$3', got '$2')"; fi; }

SA=00000000-0000-0000-0000-00000000005a   # studio A
SB=00000000-0000-0000-0000-00000000005b   # studio B
PLAT=00000000-0000-0000-0000-0000000000c1 # platform admin
OWA=00000000-0000-0000-0000-0000000000a1  # studio A owner
ADA=00000000-0000-0000-0000-0000000000a2  # studio A admin
OWB=00000000-0000-0000-0000-0000000000b1  # studio B owner
FDA=00000000-0000-0000-0000-0000000000a3  # studio A front_desk (no authority)
OLD=00000000-0000-0000-0000-0000000000a4  # studio A owner, role deactivated
NOB=00000000-0000-0000-0000-0000000000f0  # nobody
q "insert into public.studios (id,name) values ('$SA','A'),('$SB','B')" >/dev/null
q "insert into public.profiles (id, platform_role) values ('$PLAT','platform_admin'),('$OWA',null),('$NOB',null)" >/dev/null
q "insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$OWA','$SA','studio_owner',true),('$ADA','$SA','studio_admin',true),('$OWB','$SB','studio_owner',true),('$FDA','$SA','front_desk',true),('$OLD','$SA','studio_owner',false)" >/dev/null
H=hash1; O1=00000000-0000-0000-0000-0000000000e1
claim() { q "select (public.claim_payment_provider_event('stripe','$1','x','$H','$O1'))->>'outcome'" >/dev/null; }
ap() { local acct="null"; [ "$5" != "null" ] && acct="'$5'"; q "select public.d24_apply_event('$1','$O1','$3',$4,$acct,false,'$H','$2','$6'::jsonb)::text" >/dev/null; }
inv() { echo "{\"invoice_id\":\"$1\",\"status\":\"$2\",\"total\":$3,\"amount_due\":$6,\"amount_paid\":$4,\"amount_remaining\":$5,\"currency\":\"usd\"}"; }
rid() { q "select id from public.hosted_invoices where stripe_invoice_id='$1' and coalesce(stripe_account_id,'')='${2:-}'"; }

# fixtures --------------------------------------------------------------------------------------------------------------
# U1: unmatched void (no registry). RA: registered to A with unverified_void_origin + metadata_mismatch. RB: registered to B, unverified_void_origin.
claim evt_u1; ap evt_u1 invoice invoice.voided 1000 null "$(inv in_u1 void 1000 0 1000 1000)"
q "select public.d24_register_invoice('$SA',null,'in_ra',false,'event_fee','bo-ra')" >/dev/null
q "select public.d24_register_invoice('$SB',null,'in_rb',false,'event_fee','bo-rb')" >/dev/null
claim evt_ra; ap evt_ra invoice invoice.voided 1100 null "{\"invoice_id\":\"in_ra\",\"status\":\"void\",\"total\":500,\"amount_due\":500,\"amount_paid\":0,\"amount_remaining\":500,\"currency\":\"usd\",\"metadata_studio\":\"$SB\"}"
claim evt_rb; ap evt_rb invoice invoice.voided 1200 null "$(inv in_rb void 700 0 700 700)"
U1=$(rid in_u1); RA=$(rid in_ra); RB=$(rid in_rb)
check "fixture: U1 unmatched" "$(q "select reconciliation_state from public.hosted_invoices where id='$U1'")" "unmatched"
check "fixture: RA anomalous with both codes" "$(q "select reconciliation_state||':'||array_to_string(anomaly_codes,',') from public.hosted_invoices where id='$RA'")" "anomalous:metadata_mismatch,unverified_void_origin"
# a rejected deferred event, produced through the legal path (pending -> rejected by the writer)
claim evt_d1; q "select public.d24_defer_event('evt_d1','$O1','invoice.voided',1300,null,false,'$H','invoice','$(inv in_d1 void 100 0 100 100)'::jsonb)" >/dev/null
q "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set state='rejected', settled_at=now(), attempts=5, last_error='boom' where provider_event_id='evt_d1'" >/dev/null
claim evt_d2; q "select public.d24_defer_event('evt_d2','$O1','invoice.voided',1301,null,false,'$H','invoice','$(inv in_d2 void 100 0 100 100)'::jsonb)" >/dev/null

# 1. grants ---------------------------------------------------------------------------------------------------------------
OPF="d24_op_acknowledge_anomalies(uuid,text[],text) d24_op_dismiss_unmatched(uuid,text) d24_op_requeue_deferred(text,text) d24_op_list_invoices(text,uuid,boolean,integer,integer) d24_op_get_invoice(uuid) d24_op_list_deferred(text,integer,integer)"
for f in $OPF; do
  check "authenticated can execute $f" "$(q "select has_function_privilege('authenticated','public.$f','execute')")" "t"
  check "anon cannot execute $f" "$(q "select has_function_privilege('anon','public.$f','execute')")" "f"
  check "service_role cannot execute $f" "$(q "select has_function_privilege('service_role','public.$f','execute')")" "f"
done
for r in anon authenticated service_role; do
  check "$r cannot execute the p_actor ack function" "$(q "select has_function_privilege('$r','public.d24_acknowledge_anomalies(uuid,text[],uuid,text)','execute')")" "f"
done
for f in "_d24_op_caller()" "_d24_op_is_platform_admin(uuid)" "_d24_op_is_studio_operator(uuid,uuid)" "_d24_op_reason(text)" "_d24_op_studio_ackable(text)"; do
  check "no API role can call internal $f" "$(q "select has_function_privilege('authenticated','public.$f','execute') or has_function_privilege('service_role','public.$f','execute') or has_function_privilege('anon','public.$f','execute')")" "f"
done
check "no function has an actor parameter" "$(q "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'd24\\_op\\_%' and (pg_get_function_arguments(p.oid) ilike '%actor%' or pg_get_function_arguments(p.oid) ilike '%user%')")" "0"
check "every operator function is SECURITY DEFINER with a pinned search_path" "$(q "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'd24\\_op\\_%' and p.proname not like '\\_%' and p.prosecdef and p.proconfig::text like '%search_path%'")" "6"
check "new evidence tables: RLS on, no policies" "$(q "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('hosted_invoice_dismissals','hosted_invoice_deferred_requeues') and c.relrowsecurity")" "2"
check "authenticated has no table privilege on the new tables" "$(q "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated','public') and table_name in ('hosted_invoice_dismissals','hosted_invoice_deferred_requeues')")" "0"
has "authenticated cannot read dismissals directly" "$(asu $PLAT aal2 'select count(*) from public.hosted_invoice_dismissals')" "permission denied"

# 2. authentication / assurance ---------------------------------------------------------------------------------------------
has "service_role (no end-user JWT) is refused" "$(asr service_role "select public.d24_op_list_invoices()")" "execute\|permission denied"
has "authenticated with no JWT claims is refused" "$(asu $PLAT none "select public.d24_op_list_invoices()")" "d24_op_authentication_required"
has "platform admin on aal1 is refused (list)" "$(asu $PLAT aal1 "select public.d24_op_list_invoices()")" "d24_op_aal2_required"
has "platform admin on aal1 cannot dismiss" "$(asu $PLAT aal1 "select public.d24_op_dismiss_unmatched('$U1','a long enough reason')")" "d24_op_aal2_required"
has "platform admin on aal1 cannot requeue" "$(asu $PLAT aal1 "select public.d24_op_requeue_deferred('evt_d1','a long enough reason')")" "d24_op_aal2_required"
has "studio owner on aal1 cannot acknowledge" "$(asu $OWA aal1 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'a long enough reason')")" "d24_op_aal2_required"
has "aal claim must equal exactly aal2 (empty is refused)" "$(asu $PLAT '' "select public.d24_op_list_invoices()")" "d24_op_aal2_required"
check "refused calls wrote nothing" "$(q "select count(*) from public.hosted_invoice_dismissals")/$(q "select count(*) from public.hosted_invoice_deferred_requeues")" "0/0"
has "an expired session (aal2, exp in the past) is refused" "$(asu $PLAT expired "select public.d24_op_list_invoices()")" "d24_op_session_expired"
has "a token with no exp claim is refused" "$(asu $PLAT noexp "select public.d24_op_dismiss_unmatched('$U1','a long enough reason')")" "d24_op_session_expired"
has "a token whose role claim is not authenticated is refused" "$(asu $PLAT anonrole "select public.d24_op_list_invoices()")" "d24_op_authentication_required"
has "expired studio owner cannot acknowledge" "$(asu $OWA expired "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'a long enough reason')")" "d24_op_session_expired"
has "expired platform admin cannot requeue" "$(asu $PLAT expired "select public.d24_op_requeue_deferred('evt_d1','a long enough reason')")" "d24_op_session_expired"
check "rollback applied on a clean install" "$RB1" "0"
check "rollback removed every M2-B function and table but kept M2-C requeue function and restored its pre-M2-B service_role grant" "$RBLEFT" "0/true/true/true"
check "M2-B re-applies after rollback" "$RB2" "0"
check "every SECURITY DEFINER function in the D24 family pins search_path" "$(q "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like '%d24%') and p.prosecdef and not coalesce(p.proconfig::text like '%search_path%', false)")" "0"
check "no D24 function is executable by PUBLIC" "$(q "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like '%d24%' and has_function_privilege('public', p.oid, 'execute')")" "0"

# 3. acknowledge: authority + tenant scope -----------------------------------------------------------------------------------
R="a long enough reason"
has "front_desk role cannot acknowledge (not found, no oracle)" "$(asu $FDA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'$R')")" "d24_invoice_not_found"
has "deactivated owner cannot acknowledge" "$(asu $OLD aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'$R')")" "d24_invoice_not_found"
has "user with no role cannot acknowledge" "$(asu $NOB aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'$R')")" "d24_invoice_not_found"
has "studio B owner cannot acknowledge studio A's invoice" "$(asu $OWB aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'$R')")" "d24_invoice_not_found"
has "cross-tenant miss and a real miss are indistinguishable" "$(asu $OWB aal2 "select public.d24_op_acknowledge_anomalies('00000000-0000-0000-0000-000000000000',array['unverified_void_origin'],'$R')")" "d24_invoice_not_found"
has "studio owner cannot acknowledge a platform-only code" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['metadata_mismatch'],'$R')")" "d24_op_code_requires_platform_admin"
has "mixed list with one platform-only code is refused whole" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin','metadata_mismatch'],'$R')")" "d24_op_code_requires_platform_admin"
check "...and nothing was acknowledged" "$(q "select coalesce(array_to_string(acknowledged_codes,','),'') from public.hosted_invoices where id='$RA'")" ""
has "reason is mandatory (empty)" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'')")" "d24_op_reason_required"
has "reason is mandatory (whitespace)" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'            ')")" "d24_op_reason_required"
has "reason is mandatory (too short)" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'ok')")" "d24_op_reason_required"
has "reason is mandatory (null)" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],null)")" "d24_op_reason_required"
has "unknown code refused" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['not_a_code'],'$R')")" "d24_unknown_anomaly_code"
has "empty code list refused" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA','{}','$R')")" "codes are required"
has "unmatched invoice cannot be acknowledged (platform admin)" "$(asu $PLAT aal2 "select public.d24_op_acknowledge_anomalies('$U1',array['unverified_void_origin'],'$R')")" "d24_unmatched_invoice_cannot_be_acknowledged"
out=$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'  reviewed the Stripe dashboard  ')")
has "studio owner acknowledges an unverified-origin code on own invoice" "$out" '"outcome": "acknowledged"'
check "state stays anomalous (metadata_mismatch still open)" "$(q "select reconciliation_state from public.hosted_invoices where id='$RA'")" "anomalous"
check "actor is auth.uid() and reason is trimmed in the audit row" "$(q "select actor_user_id||'|'||reason from public.hosted_invoice_recon_audit where invoice_row_id='$RA' and trigger_kind='acknowledgement'")" "$OWA|reviewed the Stripe dashboard"
out=$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'$R')")
has "re-acknowledge is an idempotent no-op" "$out" '"outcome": "already_acknowledged"'
check "...and wrote no second audit row" "$(q "select count(*) from public.hosted_invoice_recon_audit where invoice_row_id='$RA' and trigger_kind='acknowledgement'")" "1"
out=$(asu $PLAT aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['metadata_mismatch'],'platform review of forged metadata')")
has "platform admin acknowledges a platform-only code" "$out" '"outcome": "acknowledged"'
check "state resolved once every code is acknowledged" "$(q "select reconciliation_state from public.hosted_invoices where id='$RA'")" "resolved"
check "codes are never erased" "$(q "select array_to_string(anomaly_codes,',') from public.hosted_invoices where id='$RA'")" "metadata_mismatch,unverified_void_origin"
check "audit actor is the platform admin, never a parameter" "$(q "select count(*) from public.hosted_invoice_recon_audit where invoice_row_id='$RA' and actor_user_id='$PLAT'")" "1"
out=$(asu $ADA aal2 "select public.d24_op_acknowledge_anomalies('$RB',array['unverified_void_origin'],'$R')")
has "studio A admin cannot touch studio B (tenant isolation)" "$out" "d24_invoice_not_found"
out=$(asu $OWB aal2 "select public.d24_op_acknowledge_anomalies('$RB',array['unverified_void_origin'],'$R')")
has "studio B owner acknowledges own invoice" "$out" '"outcome": "acknowledged"'
# the p_actor-style forgery: a caller cannot pass an actor
has "an extra actor argument does not exist (4-arg call fails)" "$(asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_void_origin'],'$R','$PLAT'::uuid)")" "does not exist"
has "the old p_actor function is closed even to service_role" "$(asr service_role "select public.d24_acknowledge_anomalies('$RA',array['metadata_mismatch'],'$PLAT','$R')")" "permission denied"
has "the old p_actor function is closed to authenticated" "$(asu $PLAT aal2 "select public.d24_acknowledge_anomalies('$RA',array['metadata_mismatch'],'$PLAT','$R')")" "permission denied"

# 4. dismissal ---------------------------------------------------------------------------------------------------------------
has "studio owner cannot dismiss" "$(asu $OWA aal2 "select public.d24_op_dismiss_unmatched('$U1','$R')")" "d24_op_platform_admin_required"
has "dismiss needs a reason" "$(asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('$U1','x')")" "d24_op_reason_required"
has "a registered invoice cannot be dismissed" "$(asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('$RA','$R')")" "d24_op_not_dismissable"
has "unknown invoice" "$(asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('00000000-0000-0000-0000-000000000000','$R')")" "d24_invoice_not_found"
has "dismiss succeeds for platform admin" "$(asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('$U1','duplicate of a test invoice, verified in Stripe')")" '"outcome": "dismissed"'
has "dismiss replay is idempotent" "$(asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('$U1','duplicate of a test invoice, verified in Stripe')")" '"outcome": "already_dismissed"'
check "exactly one dismissal row and one audit row" "$(q "select count(*) from public.hosted_invoice_dismissals where invoice_row_id='$U1'")/$(q "select count(*) from public.hosted_invoice_recon_audit where invoice_row_id='$U1' and trigger_kind='dismissal'")" "1/1"
check "dismissal records the actor from the JWT" "$(q "select actor_user_id from public.hosted_invoice_dismissals where invoice_row_id='$U1'")" "$PLAT"
check "the invoice and its evidence are all still there" "$(q "select (select count(*) from public.hosted_invoices where id='$U1')||'/'||(select count(*) from public.hosted_invoice_source_events where invoice_row_id='$U1')||'/'||(select reconciliation_state from public.hosted_invoices where id='$U1')")" "1/1/unmatched"
has "dismissed invoice is hidden from the default review list" "$(asu $PLAT aal2 "select (public.d24_op_list_invoices('unmatched'))->>'total'")" "0"
has "...but visible with include_dismissed" "$(asu $PLAT aal2 "select (public.d24_op_list_invoices('unmatched',null,true))->>'total'")" "1"
claim evt_u1b; ap evt_u1b invoice invoice.marked_uncollectible 1500 null "$(inv in_u1 uncollectible 1000 0 1000 1000)"
has "a new event makes the dismissal stale: the invoice resurfaces" "$(asu $PLAT aal2 "select (public.d24_op_list_invoices('unmatched'))->>'total'")" "1"
has "...and can be dismissed again (new events_seen)" "$(asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('$U1','still unmatched after the second event')")" '"outcome": "dismissed"'
check "history keeps both dismissals" "$(q "select count(*) from public.hosted_invoice_dismissals where invoice_row_id='$U1'")" "2"
# a dismissed invoice is still attributed correctly when the registry later matches
q "select public.d24_register_invoice('$SA',null,'in_u1',false,'event_fee','bo-u1')" >/dev/null
check "registry adoption still attributes a previously dismissed invoice" "$(q "select studio_id from public.hosted_invoices where id='$U1'")" "$SA"
has "after adoption it is no longer dismissable" "$(asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('$U1','$R')")" "d24_op_not_dismissable"

# 5. requeue ----------------------------------------------------------------------------------------------------------------
has "studio owner cannot requeue" "$(asu $OWA aal2 "select public.d24_op_requeue_deferred('evt_d1','$R')")" "d24_op_platform_admin_required"
has "requeue needs a reason" "$(asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_d1','no')")" "d24_op_reason_required"
has "unknown event" "$(asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_zzz','$R')")" "d24_deferred_event_not_found"
has "a pending event reports already_pending and is not audited" "$(asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_d2','$R')")" '"outcome": "already_pending"'
check "...no requeue row for the pending event" "$(q "select count(*) from public.hosted_invoice_deferred_requeues where provider_event_id='evt_d2'")" "0"
out=$(asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_d1','transient lock failure fixed in the 10-31 hotfix')")
has "rejected event is requeued" "$out" '"outcome": "requeued"'
check "state back to pending, settled_at cleared, attempts and error kept" "$(q "select state||'/'||(settled_at is null)||'/'||attempts||'/'||coalesce(last_error,'') from public.hosted_invoice_deferred_events where provider_event_id='evt_d1'")" "pending/true/5/"
check "requeue evidence row has actor, reason, prior state" "$(q "select actor_user_id||'|'||prior_attempts||'|'||prior_error from public.hosted_invoice_deferred_requeues where provider_event_id='evt_d1'")" "$PLAT|5|boom"
has "replay of the requeue is a no-op" "$(asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_d1','transient lock failure fixed in the 10-31 hotfix')")" '"outcome": "already_pending"'
check "...still one requeue row" "$(q "select count(*) from public.hosted_invoice_deferred_requeues where provider_event_id='evt_d1'")" "1"
out=$(q "select public.d24_drain_deferred(10)::text")
has "drain applies the requeued event" "$out" '"applied": 2'
check "snapshot evidence unchanged and the event is applied" "$(q "select state||'/'||(object_snapshot->>'invoice_id') from public.hosted_invoice_deferred_events where provider_event_id='evt_d1'")" "applied/in_d1"
has "an applied event is not recoverable" "$(asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_d1','$R')")" "d24_op_not_recoverable"
# requeue cap
claim evt_d3; q "select public.d24_defer_event('evt_d3','$O1','invoice.voided',1302,null,false,'$H','invoice','$(inv in_d3 void 100 0 100 100)'::jsonb)" >/dev/null
rej() { q "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set state='rejected', settled_at=now() where provider_event_id='$1'" >/dev/null; }
for n in 1 2 3 4 5; do rej evt_d3; asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_d3','requeue number $n of the same event')" >/dev/null; done
check "five requeues recorded" "$(q "select count(*) from public.hosted_invoice_deferred_requeues where provider_event_id='evt_d3'")" "5"
rej evt_d3
has "the sixth requeue is refused" "$(asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_d3','requeue number 6 of the same event')")" "d24_requeue_limit_reached"

# 6. guards cannot be bypassed ---------------------------------------------------------------------------------------------
has "direct rejected->pending without the requeue flag is refused" "$(q "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set state='pending', settled_at=null where provider_event_id='evt_d3'" 2>&1 | tr '\n' ' ')" "cannot change state"
has "applied->pending is refused even with the requeue flag" "$(q "select set_config('d24.writer','on',false), set_config('d24.requeue','on',false); update public.hosted_invoice_deferred_events set state='pending', settled_at=null where provider_event_id='evt_d1'" 2>&1 | tr '\n' ' ')" "cannot change state"
has "dismissal rows cannot be updated" "$(q "select set_config('d24.writer','on',false); update public.hosted_invoice_dismissals set reason='tampered tampered' where invoice_row_id='$U1'" 2>&1 | tr '\n' ' ')" "append-only"
has "dismissal rows cannot be deleted" "$(q "select set_config('d24.writer','on',false); delete from public.hosted_invoice_dismissals" 2>&1 | tr '\n' ' ')" "append-only"
has "requeue rows cannot be deleted" "$(q "select set_config('d24.writer','on',false); delete from public.hosted_invoice_deferred_requeues" 2>&1 | tr '\n' ' ')" "append-only"
has "requeue rows cannot be inserted outside the functions" "$(q "insert into public.hosted_invoice_deferred_requeues (provider_event_id,actor_user_id,reason,requeue_number,prior_attempts) values ('evt_d3','$PLAT','a long enough reason',99,0)" 2>&1 | tr '\n' ' ')" "only allowed through"
has "dismissal rows cannot be inserted outside the functions" "$(q "insert into public.hosted_invoice_dismissals (invoice_row_id,actor_user_id,reason,events_seen) values ('$RB','$PLAT','a long enough reason',9)" 2>&1 | tr '\n' ' ')" "only allowed through"
has "deferred events still cannot be deleted" "$(q "delete from public.hosted_invoice_deferred_events" 2>&1 | tr '\n' ' ')" "permanent evidence\|only allowed"
has "audit trigger kind is constrained" "$(q "select set_config('d24.writer','on',false); insert into public.hosted_invoice_recon_audit (invoice_row_id,trigger_kind,to_state) values ('$RB','bogus','clear')" 2>&1 | tr '\n' ' ')" "trigger_chk"
has "a dismissal audit row without actor/reason is refused" "$(q "select set_config('d24.writer','on',false); insert into public.hosted_invoice_recon_audit (invoice_row_id,trigger_kind,to_state) values ('$RB','dismissal','unmatched')" 2>&1 | tr '\n' ' ')" "ack_chk"

# 7. review reads ----------------------------------------------------------------------------------------------------------
claim evt_u3; ap evt_u3 invoice invoice.voided 1450 null "$(inv in_u3 void 100 0 100 100)"; U3=$(rid in_u3)
has "studio owner cannot list (acknowledge-only policy)" "$(asu $OWA aal2 "select public.d24_op_list_invoices()")" "d24_op_platform_admin_required"
has "studio admin cannot list" "$(asu $ADA aal2 "select public.d24_op_list_invoices()")" "d24_op_platform_admin_required"
has "user without any role cannot list" "$(asu $NOB aal2 "select public.d24_op_list_invoices()")" "d24_op_platform_admin_required"
has "front desk cannot list" "$(asu $FDA aal2 "select public.d24_op_list_invoices()")" "d24_op_platform_admin_required"
has "studio owner cannot get_invoice (own invoice)" "$(asu $OWA aal2 "select public.d24_op_get_invoice('$RA')")" "d24_op_platform_admin_required"
has "studio owner cannot get_invoice (other studio)" "$(asu $OWB aal2 "select public.d24_op_get_invoice('$RA')")" "d24_op_platform_admin_required"
has "studio owner cannot get_invoice (unmatched)" "$(asu $OWA aal2 "select public.d24_op_get_invoice('$U3')")" "d24_op_platform_admin_required"
has "platform admin sees all invoices" "$(asu $PLAT aal2 "select (public.d24_op_list_invoices(null,null,true))->>'total'")" "$(q "select count(*) from public.hosted_invoices")"
has "state filter validated" "$(asu $PLAT aal2 "select public.d24_op_list_invoices('bogus')")" "unknown state"
has "platform view includes source-event snapshots" "$(asu $PLAT aal2 "select (public.d24_op_get_invoice('$RA'))->'source_events'->0 ? 'object_snapshot'")" "t"
has "audit trail visible to platform admin with the actor and reason" "$(asu $PLAT aal2 "select jsonb_array_length((public.d24_op_get_invoice('$RA'))->'audit')")" "[3-9]"
has "list_deferred: studio owner refused" "$(asu $OWA aal2 "select public.d24_op_list_deferred()")" "d24_op_platform_admin_required"
has "list_deferred: counts and requeue count" "$(asu $PLAT aal2 "select ((public.d24_op_list_deferred('rejected'))->'counts'->>'rejected')||'/'||(select (r->>'requeue_count') from jsonb_array_elements((public.d24_op_list_deferred('rejected'))->'rows') r where r->>'provider_event_id'='evt_d3')")" "1/5"
has "list_deferred: bad state refused" "$(asu $PLAT aal2 "select public.d24_op_list_deferred('bogus')")" "unknown state"

# 8. concurrency ----------------------------------------------------------------------------------------------------------
claim evt_c1; q "select public.d24_defer_event('evt_c1','$O1','invoice.voided',1400,null,false,'$H','invoice','$(inv in_c1 void 100 0 100 100)'::jsonb)" >/dev/null
rej evt_c1
for i in 1 2 3 4 5 6; do asu $PLAT aal2 "select public.d24_op_requeue_deferred('evt_c1','concurrent requeue attempt $i')" > $TMPD/d24_rq_$i.out & done; wait
check "6 concurrent requeues -> exactly one requeue row" "$(q "select count(*) from public.hosted_invoice_deferred_requeues where provider_event_id='evt_c1'")" "1"
check "...exactly one 'requeued' outcome, the rest already_pending" "$(cat $TMPD/d24_rq_*.out | grep -c '"outcome": "requeued"')/$(cat $TMPD/d24_rq_*.out | grep -c 'already_pending')" "1/5"
claim evt_u2; ap evt_u2 invoice invoice.voided 1500 null "$(inv in_u2 void 100 0 100 100)"; U2=$(rid in_u2)
for i in 1 2 3 4 5 6; do asu $PLAT aal2 "select public.d24_op_dismiss_unmatched('$U2','concurrent dismissal attempt $i')" > $TMPD/d24_ds_$i.out & done; wait
check "6 concurrent dismissals -> exactly one dismissal and one audit row" "$(q "select count(*) from public.hosted_invoice_dismissals where invoice_row_id='$U2'")/$(q "select count(*) from public.hosted_invoice_recon_audit where invoice_row_id='$U2' and trigger_kind='dismissal'")" "1/1"
claim evt_ra2; ap evt_ra2 invoice invoice.marked_uncollectible 1600 null "$(inv in_ra uncollectible 500 0 500 500)"
for i in 1 2 3 4 5 6; do asu $OWA aal2 "select public.d24_op_acknowledge_anomalies('$RA',array['unverified_uncollectible_origin'],'concurrent acknowledgement $i')" > $TMPD/d24_ak_$i.out & done; wait
check "6 concurrent acknowledgements -> exactly one audit row for the new code" "$(q "select count(*) from public.hosted_invoice_recon_audit where invoice_row_id='$RA' and trigger_kind='acknowledgement' and anomaly_codes @> array['unverified_uncollectible_origin']")" "1"
rm -f $TMPD/d24_rq_*.out $TMPD/d24_ds_*.out $TMPD/d24_ak_*.out
# acknowledge racing a new occurrence of the same code never hides the new occurrence (reopen wins or loses cleanly; the invariant ack subset-of anomalies holds)
check "invariant: acknowledged_codes is always a subset of anomaly_codes" "$(q "select count(*) from public.hosted_invoices where not (acknowledged_codes <@ anomaly_codes)")" "0"

# 9. rollback ---------------------------------------------------------------------------------------------------------------
r=$(docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_RB" 2>&1 | tr '\n' ' ')
has "rollback refuses while operator evidence exists" "$r" "rollback refused"
check "...and the functions are still there" "$(q "select to_regprocedure('public.d24_op_dismiss_unmatched(uuid,text)') is not null")" "t"

echo; echo "d24-m2b-sql: PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
