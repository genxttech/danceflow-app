#!/usr/bin/env bash
# D7 core release: disposable-Postgres rehearsal of the two migrations, their rollbacks and the pre/post-flight scripts.
# LOCAL QA ONLY. Never point this at a hosted database. Usage: bash scripts/release/d7_core_sql_dryrun.sh
# It proves: preflight passes on a PROD-shaped pre-state; both migrations apply (idempotently); postflight passes;
# preflight then FAILS (so the detector really detects); existing grants survive and keep the approved boundary;
# rollback refuses while audit evidence exists; a clean reverse-order rollback restores the pre-state; re-apply works.
set -euo pipefail
export MSYS_NO_PATHCONV=1
C=df-d7core-pg
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
MIG="$ROOT/src/lib/supabase/migrations"
SCR="$ROOT/scripts/release"
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$C" -e POSTGRES_PASSWORD=pw postgres:17 >/dev/null
for i in $(seq 1 40); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P() { docker exec -i "$C" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -X -q "${@:2}"; }
put() { docker cp "$1" "$C:/tmp/$(basename "$1")"; }
flight_overall() { P "$1" -At -F'|' -f "/tmp/$2" | awk -F'|' '$1=="99"{print $3}'; }
flight_failures() { P "$1" -At -F'|' -f "/tmp/$2" | awk -F'|' '$3=="f" && $1!="99"'; }

P postgres -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" -c "create database t" -c "create database t2"
for f in d7_core_stub_prod_shape.sql d7_core_preflight.sql d7_core_postflight.sql; do put "$SCR/$f"; done
for f in 20270203090000_organizer_suite_entitlement_integrity.sql 20270203100000_usage_addon_entitlements_least_privilege.sql \
         rollback/20270203090000_organizer_suite_entitlement_integrity_rollback.sql rollback/20270203100000_usage_addon_entitlements_least_privilege_rollback.sql; do put "$MIG/$f"; done
for db in t t2; do P $db -c "grant usage on schema public to anon, authenticated, service_role"; P $db -f /tmp/d7_core_stub_prod_shape.sql; done
M1=/tmp/20270203090000_organizer_suite_entitlement_integrity.sql
M2=/tmp/20270203100000_usage_addon_entitlements_least_privilege.sql
R1=/tmp/20270203090000_organizer_suite_entitlement_integrity_rollback.sql
R2=/tmp/20270203100000_usage_addon_entitlements_least_privilege_rollback.sql

echo "=== 1. preflight on the PROD-shaped pre-state must pass"
[ "$(flight_overall t d7_core_preflight.sql)" = "t" ] || { echo "FAIL: preflight did not pass"; flight_failures t d7_core_preflight.sql; exit 1; }
echo "PASS preflight"

echo "=== 2. apply migration 1 then 2 (migration 1 twice: idempotent)"
P t -f $M1 >/dev/null; P t -f $M2 >/dev/null; P t -f $M1 >/dev/null
echo "PASS applied"

echo "=== 3. postflight must pass"
[ "$(flight_overall t d7_core_postflight.sql)" = "t" ] || { echo "FAIL: postflight did not pass"; flight_failures t d7_core_postflight.sql; exit 1; }
echo "PASS postflight"

echo "=== 3b. the postflight must detect tampering (blind spots found in the G2 review): each tamper must flip it to FAIL, then be undone"
put "$SCR/d7_core_recheck.sql"
tamper() { # name, sql-to-break, sql-to-fix
  P t -c "$2" >/dev/null
  if [ "$(flight_overall t d7_core_postflight.sql)" = "t" ]; then echo "FAIL: postflight did not detect: $1"; exit 1; fi
  P t -c "$3" >/dev/null
  [ "$(flight_overall t d7_core_postflight.sql)" = "t" ] || { echo "FAIL: postflight not clean after undoing: $1"; flight_failures t d7_core_postflight.sql; exit 1; }
  echo "PASS detected: $1"
}
tamper "audit trigger disabled" "alter table public.usage_addon_entitlements disable trigger usage_addon_entitlements_audit_trg" "alter table public.usage_addon_entitlements enable trigger usage_addon_entitlements_audit_trg"
tamper "anon granted TRIGGER on the entitlements table" "grant trigger on public.usage_addon_entitlements to anon" "revoke trigger on public.usage_addon_entitlements from anon"
tamper "anon granted REFERENCES on the entitlements table" "grant references on public.usage_addon_entitlements to anon" "revoke references on public.usage_addon_entitlements from anon"
tamper "service_role granted DELETE" "grant delete on public.usage_addon_entitlements to service_role" "revoke delete on public.usage_addon_entitlements from service_role"
tamper "anon may execute a helper function" "grant execute on function public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz) to anon" "revoke execute on function public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz) from anon"
tamper "authenticated lost a helper function grant" "revoke execute on function public.usage_addon_entitlement_end_instant(date,text) from authenticated" "grant execute on function public.usage_addon_entitlement_end_instant(date,text) to authenticated"
tamper "authenticated may execute the expiry function" "grant execute on function public.expire_due_usage_addon_entitlements(timestamptz,text) to authenticated" "revoke execute on function public.expire_due_usage_addon_entitlements(timestamptz,text) from authenticated"
tamper "an audit-table privilege widened" "grant update on public.usage_addon_entitlement_events to service_role" "revoke update on public.usage_addon_entitlement_events from service_role"

echo "=== 3c. postflight on an UNAPPLIED target reports failing rows instead of erroring (and the recheck script runs on a clean target)"
[ "$(flight_overall t2 d7_core_postflight.sql)" = "f" ] || { echo "FAIL: postflight on an unapplied database should report false (no error)"; exit 1; }
[ "$(flight_overall t2 d7_core_recheck.sql)" = "t" ] || { echo "FAIL: recheck script did not pass on an idle disposable database"; flight_failures t2 d7_core_recheck.sql; exit 1; }
echo "PASS postflight fails cleanly on an unapplied target; recheck passes on an idle database"

echo "=== 4. preflight must now FAIL (it detects an already-applied or drifted target)"
[ "$(flight_overall t d7_core_preflight.sql)" = "f" ] || { echo "FAIL: preflight still passes after apply"; exit 1; }
echo "PASS preflight flags the applied state ($(flight_failures t d7_core_preflight.sql | wc -l) checks flagged)"

echo "=== 5. existing complimentary grants survive unchanged and stay current"
N=$(P t -At -c "select count(*) from public.usage_addon_entitlements where source='manual_grant' and status='active' and period_end is null")
[ "$N" = "2" ] || { echo "FAIL: grants changed ($N)"; exit 1; }
CUR=$(P t -At -c "select count(*) from public.usage_addon_entitlements e join public.studios s on s.id=e.studio_id where public.usage_addon_entitlement_is_current(e.status, e.period_start, e.period_end, s.timezone, now())")
[ "$CUR" = "2" ] || { echo "FAIL: grants not current ($CUR)"; exit 1; }
echo "PASS both complimentary grants remain active and current"

echo "=== 6. approved boundary: period_end 2027-07-09 in America/New_York ends exactly at 2027-07-09T04:00:00Z"
B=$(P t -At -c "select public.usage_addon_entitlement_end_instant('2027-07-09'::date, 'America/New_York') at time zone 'UTC'")
[ "$B" = "2027-07-09 04:00:00" ] || { echo "FAIL: boundary $B"; exit 1; }
echo "PASS boundary $B"

echo "=== 7. an audited change writes exactly one event; rollback of migration 1 refuses while events exist"
P t -c "update public.usage_addon_entitlements set period_end='2027-07-09' where id='00000000-0000-0000-0000-0000000000b1'" >/dev/null
E=$(P t -At -c "select count(*) from public.usage_addon_entitlement_events")
[ "$E" = "1" ] || { echo "FAIL: expected 1 audit event, got $E"; exit 1; }
if P t -f $R1 >/dev/null 2>&1; then echo "FAIL: rollback 1 ran with audit events"; exit 1; fi
echo "PASS rollback refuses while audit evidence exists"

echo "=== 8. clean reverse-order rollback restores the PROD pre-state, then re-apply works"
P t2 -f $M1 >/dev/null; P t2 -f $M2 >/dev/null
P t2 -f $R2 >/dev/null; P t2 -f $R1 >/dev/null
[ "$(flight_overall t2 d7_core_preflight.sql)" = "t" ] || { echo "FAIL: preflight does not pass after a full rollback"; flight_failures t2 d7_core_preflight.sql; exit 1; }
echo "PASS reverse-order rollback restores the exact pre-state"
P t2 -f $M1 >/dev/null; P t2 -f $M2 >/dev/null
[ "$(flight_overall t2 d7_core_postflight.sql)" = "t" ] || { echo "FAIL: postflight after re-apply"; exit 1; }
echo "PASS re-apply after rollback"
echo "=== 9. production webhook upsert target: ON CONFLICT (studio_id, feature_key) has no matching unique constraint (latent PROD defect); the item id target works"
P t2 -c "insert into public.studios(id) values ('00000000-0000-0000-0000-0000000000a9')" >/dev/null
OUT=$(P t2 -At -c "insert into public.usage_addon_entitlements(studio_id, workspace_type, feature_key, source, stripe_subscription_item_id) values ('00000000-0000-0000-0000-0000000000a9','studio','organizer_suite','stripe_subscription_item','si_x') on conflict (studio_id, feature_key) do update set status='active'" 2>&1 || true)
echo "$OUT" | grep -q "no unique or exclusion constraint matching" || { echo "FAIL: expected 42P10 for the studio_id,feature_key target, got: $OUT"; exit 1; }
echo "PASS the (studio_id, feature_key) conflict target is rejected by Postgres (as it is against the PROD table shape)"
P t2 -c "insert into public.usage_addon_entitlements(studio_id, workspace_type, feature_key, source, stripe_subscription_item_id) values ('00000000-0000-0000-0000-0000000000a9','studio','organizer_suite','stripe_subscription_item','si_x') on conflict (stripe_subscription_item_id) do update set status='active'" >/dev/null
P t2 -c "insert into public.usage_addon_entitlements(studio_id, workspace_type, feature_key, source, stripe_subscription_item_id) values ('00000000-0000-0000-0000-0000000000a9','studio','organizer_suite','stripe_subscription_item','si_x') on conflict (stripe_subscription_item_id) do update set status='canceled'" >/dev/null
[ "$(P t2 -At -c "select count(*)||'/'||min(status) from public.usage_addon_entitlements where stripe_subscription_item_id='si_x'")" = "1/canceled" ] || { echo "FAIL: item-id upsert did not update in place"; exit 1; }
echo "PASS the stripe_subscription_item_id target upserts in place, coexisting with the manual grant rows (post-migration indexes present)"
echo "ALL D7 CORE SQL REHEARSAL CHECKS PASSED"
