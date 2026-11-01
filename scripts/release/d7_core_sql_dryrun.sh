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
echo "ALL D7 CORE SQL REHEARSAL CHECKS PASSED"
