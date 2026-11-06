#!/usr/bin/env bash
# D7 desk gate: disposable-Postgres rehearsal of 20270205100000_competition_desk_suite_gate.sql, its rollback and the SQL suite.
# LOCAL QA ONLY. Never point this at a hosted database. Usage: bash scripts/qa/d7_desk_gate_sql.sh
# Proves: the repo's 20261116094000 definition is the baseline (fingerprint printed, asserted against the documented value in
# scripts/release/d7_desk_gate_preflight.sql); the migration applies twice (idempotent) and refuses without 20270203090000;
# the SQL suite passes; two simultaneous desk payments stay safe (with and without a lapsed grant); the rollback restores the
# exact old definition + ACL (md5 of pg_get_functiondef) and removes the helper; re-apply works.
set -uo pipefail
export MSYS_NO_PATHCONV=1
C=df-desk-pg
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
MIG="$ROOT/src/lib/supabase/migrations"
SCR="$ROOT/scripts"
fails=0
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$C" -e POSTGRES_PASSWORD=pw postgres:17 >/dev/null
for i in $(seq 1 40); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P() { docker exec -i "$C" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -X -q "${@:2}"; }
put() { docker cp "$1" "$C:/tmp/$(basename "$1")"; }
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

FN='public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)'
fp() { P "$1" -At -c "select md5(pg_get_functiondef('$FN'::regprocedure)) || ' ' || md5((select prosrc from pg_proc where oid = '$FN'::regprocedure)) || ' ' || (select proacl::text from pg_proc where oid = '$FN'::regprocedure) || ' ' || (select pg_get_userbyid(proowner) from pg_proc where oid = '$FN'::regprocedure)"; }

for f in "$SCR/qa/d7_desk_gate_stub.sql" "$MIG/20270203090000_organizer_suite_entitlement_integrity.sql" "$MIG/20270205100000_competition_desk_suite_gate.sql" \
         "$MIG/rollback/20270205100000_competition_desk_suite_gate_rollback.sql" "$MIG/sql-tests/test_D7_competition_desk_suite_gate.sql"; do put "$f"; done
# the OLD definition exactly as committed in 20261116094000 (function + revoke + grant)
sed -n '/^create or replace function public.record_competition_checkin_payment(/,/^grant execute on function public.record_competition_checkin_payment/p' \
  "$MIG/20261116094000_paywh1a_remediation.sql" > "$ROOT/.old_fn.tmp.sql"
put "$ROOT/.old_fn.tmp.sql"; rm -f "$ROOT/.old_fn.tmp.sql"

P postgres -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" -c "create database t" -c "create database t3"
for db in t t3; do P $db -c "grant usage on schema public to anon, authenticated, service_role"; P $db -f /tmp/d7_desk_gate_stub.sql; done

echo "=== 1. baseline: 20270203090000 helpers + the repo's 20261116094000 definition"
P t -f /tmp/20270203090000_organizer_suite_entitlement_integrity.sql >/dev/null
P t -f /tmp/.old_fn.tmp.sql >/dev/null
OLD=$(fp t); echo "OLD fingerprint: $OLD"
OLD_DEF=$(echo "$OLD" | cut -d" " -f1,2)
EXPECTED=$(grep -E '^-- EXPECTED_REPO_FINGERPRINT' "$SCR/release/d7_desk_gate_preflight.sql" | sed 's/^-- EXPECTED_REPO_FINGERPRINT[^:]*: *//')
eq "baseline fingerprint (md5 pg_get_functiondef, md5 prosrc) equals the one documented in d7_desk_gate_preflight.sql" "$OLD_DEF" "$EXPECTED"

echo "=== 2. precondition: migration refuses without 20270203090000"
P t3 -f /tmp/.old_fn.tmp.sql >/dev/null 2>&1 || true
OUT=$(P t3 -f /tmp/20270205100000_competition_desk_suite_gate.sql 2>&1)
case "$OUT" in *"usage_addon_entitlement_is_current is missing"*) ok "refuses without the 20270203090000 helper";; *) bad "precondition message: $OUT";; esac

echo "=== 3. apply twice (idempotent)"
P t -f /tmp/20270205100000_competition_desk_suite_gate.sql >/dev/null && P t -f /tmp/20270205100000_competition_desk_suite_gate.sql >/dev/null && ok "applied twice" || bad "apply"
NEW=$(fp t); echo "NEW fingerprint: $NEW"
[ "$NEW" != "$OLD" ] && ok "definition changed" || bad "definition unchanged"
eq "ACL and owner unchanged by the migration" "$(echo "$NEW" | cut -d' ' -f3-)" "$(echo "$OLD" | cut -d' ' -f3-)"
eq "function body differs only by the guard (line count +12)" "$(P t -At -c "select array_length(string_to_array((select prosrc from pg_proc where oid='$FN'::regprocedure), E'\n'),1)")" \
  "$(( $(P t3 -At -c "select array_length(string_to_array((select prosrc from pg_proc where oid='$FN'::regprocedure), E'\n'),1)") + 12 ))"

echo "=== 4. SQL suite"
SUITE=$(P t -v ON_ERROR_STOP=0 -f /tmp/test_D7_competition_desk_suite_gate.sql 2>&1)
echo "$SUITE" | grep -E "D7 DESK GATE SQL SUITE" | head -3
if echo "$SUITE" | grep -q "D7 DESK GATE SQL SUITE PASS"; then ok "SQL suite"; else bad "SQL suite"; echo "$SUITE" | head -60; fi

echo "=== 5. concurrency (committed fixtures, two simultaneous sessions)"
cat > "$ROOT/.conc_fx.tmp.sql" <<'EOF'
insert into auth.users(id) values ('00000000-0000-0000-0000-00d7de000001');
insert into public.profiles(id) values ('00000000-0000-0000-0000-00d7de000001');
insert into public.subscription_plans(id, code) values ('00000000-0000-0000-0000-00d7c0000001', 'pro');
-- studio A: current open-ended grant; studio B: lapsed grant
insert into public.studios(id, timezone) values ('00000000-0000-0000-0000-00d7c000000a', 'America/New_York'), ('00000000-0000-0000-0000-00d7c000000b', 'America/New_York');
insert into public.studio_subscriptions(studio_id, subscription_plan_id, status) select s, '00000000-0000-0000-0000-00d7c0000001', 'active' from unnest(array['00000000-0000-0000-0000-00d7c000000a','00000000-0000-0000-0000-00d7c000000b']::uuid[]) s;
insert into public.user_studio_roles(studio_id, user_id, role) select s, '00000000-0000-0000-0000-00d7de000001', 'front_desk' from unnest(array['00000000-0000-0000-0000-00d7c000000a','00000000-0000-0000-0000-00d7c000000b']::uuid[]) s;
insert into public.usage_addon_entitlements(studio_id, workspace_type, feature_key, source, period_end) values
  ('00000000-0000-0000-0000-00d7c000000a', 'studio', 'organizer_suite', 'manual_grant', null),
  ('00000000-0000-0000-0000-00d7c000000b', 'studio', 'organizer_suite', 'manual_grant', current_date - 3);
insert into public.organizers(id) values ('00000000-0000-0000-0000-00d7c00000a1'), ('00000000-0000-0000-0000-00d7c00000b1');
insert into public.events(id, studio_id, organizer_id) values
  ('00000000-0000-0000-0000-00d7c00000ae', '00000000-0000-0000-0000-00d7c000000a', '00000000-0000-0000-0000-00d7c00000a1'),
  ('00000000-0000-0000-0000-00d7c00000be', '00000000-0000-0000-0000-00d7c000000b', '00000000-0000-0000-0000-00d7c00000b1');
insert into public.event_orders(id, event_id, status, payment_status, total_amount, currency, metadata) values
  ('00000000-0000-0000-0000-00d7c00000a2', '00000000-0000-0000-0000-00d7c00000ae', 'pending', 'pending', 100, 'USD', '{"source":"competition_registration"}'),
  ('00000000-0000-0000-0000-00d7c00000b2', '00000000-0000-0000-0000-00d7c00000be', 'pending', 'pending', 100, 'USD', '{"source":"competition_registration"}');
insert into public.event_registrations(id, event_id, order_id, status, payment_status, currency) values
  ('00000000-0000-0000-0000-00d7c00000a3', '00000000-0000-0000-0000-00d7c00000ae', '00000000-0000-0000-0000-00d7c00000a2', 'pending', 'pending', 'USD'),
  ('00000000-0000-0000-0000-00d7c00000b3', '00000000-0000-0000-0000-00d7c00000be', '00000000-0000-0000-0000-00d7c00000b2', 'pending', 'pending', 'USD');
insert into public.event_competition_checkin_sessions(id, event_id, registration_id, order_id, status, balance_due) values
  ('00000000-0000-0000-0000-00d7c00000a4', '00000000-0000-0000-0000-00d7c00000ae', '00000000-0000-0000-0000-00d7c00000a3', '00000000-0000-0000-0000-00d7c00000a2', 'in_progress', 100),
  ('00000000-0000-0000-0000-00d7c00000b4', '00000000-0000-0000-0000-00d7c00000be', '00000000-0000-0000-0000-00d7c00000b3', '00000000-0000-0000-0000-00d7c00000b2', 'in_progress', 100);
EOF
put "$ROOT/.conc_fx.tmp.sql"; rm -f "$ROOT/.conc_fx.tmp.sql"
P t -f /tmp/.conc_fx.tmp.sql >/dev/null
race() { # $1 = event, $2 = session ; session A holds its transaction open 3s after the call, session B starts 1s later
  local ev=$1 se=$2
  local call="select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-0000-0000-00d7de000001\"}',true); select public.record_competition_checkin_payment('$ev','$se',100,'cash',null);"
  ( docker exec -i "$C" psql -U postgres -d t -X -At -v ON_ERROR_STOP=0 -c "begin; $call select pg_sleep(3); commit;" > /tmp/raceA.out 2>&1 ) &
  sleep 1
  ( docker exec -i "$C" psql -U postgres -d t -X -At -v ON_ERROR_STOP=0 -c "begin; $call commit;" > /tmp/raceB.out 2>&1 ) &
  wait
}
race 00000000-0000-0000-0000-00d7c00000ae 00000000-0000-0000-0000-00d7c00000a4
eq "race, current grant: exactly one payment row" "$(P t -At -c "select count(*) from public.event_payments where registration_id='00000000-0000-0000-0000-00d7c00000a3'")" "1"
eq "race, current grant: exactly one audit row" "$(P t -At -c "select count(*) from public.event_competition_checkin_payment_audit where checkin_session_id='00000000-0000-0000-0000-00d7c00000a4'")" "1"
eq "race, current grant: order confirmed/paid once" "$(P t -At -c "select status||'/'||payment_status from public.event_orders where id='00000000-0000-0000-0000-00d7c00000a2'")" "confirmed/paid"
RB=$(cat /tmp/raceB.out); case "$RB" in *"exceeds the current balance"*) ok "race, current grant: loser gets the existing balance error";; *) bad "loser output: $RB";; esac
race 00000000-0000-0000-0000-00d7c00000be 00000000-0000-0000-0000-00d7c00000b4
eq "race, lapsed grant: no payment row" "$(P t -At -c "select count(*) from public.event_payments where registration_id='00000000-0000-0000-0000-00d7c00000b3'")" "0"
eq "race, lapsed grant: no audit row" "$(P t -At -c "select count(*) from public.event_competition_checkin_payment_audit where checkin_session_id='00000000-0000-0000-0000-00d7c00000b4'")" "0"
eq "race, lapsed grant: order still pending/pending" "$(P t -At -c "select status||'/'||payment_status from public.event_orders where id='00000000-0000-0000-0000-00d7c00000b2'")" "pending/pending"
RA=$(cat /tmp/raceA.out); RB=$(cat /tmp/raceB.out)
case "$RA$RB" in *"organizer_suite_required"*"organizer_suite_required"*) ok "race, lapsed grant: both sessions refused with the Suite error";; *) bad "lapsed race output: A=$RA B=$RB";; esac
# grant lapses while a payment is queued behind another writer: the late caller is evaluated after the lock, at its own now()
P t -c "update public.event_competition_checkin_sessions set status='in_progress' where id='00000000-0000-0000-0000-00d7c00000b4'" >/dev/null

echo "=== 6. rollback restores the exact old definition"
P t -f /tmp/20270205100000_competition_desk_suite_gate_rollback.sql >/dev/null && P t -f /tmp/20270205100000_competition_desk_suite_gate_rollback.sql >/dev/null && ok "rollback ran twice" || bad "rollback"
BACK=$(fp t)
eq "after rollback: md5(pg_get_functiondef), md5(prosrc), ACL and owner equal the baseline" "$BACK" "$OLD"
eq "after rollback: helper removed" "$(P t -At -c "select to_regprocedure('public._d7_competition_desk_suite_allows(uuid,timestamptz)') is null")" "t"
echo "=== 7. re-apply after rollback"
P t -f /tmp/20270205100000_competition_desk_suite_gate.sql >/dev/null && ok "re-applied" || bad "re-apply"
eq "re-applied definition equals the first application" "$(fp t)" "$NEW"
RESUITE=$(P t -v ON_ERROR_STOP=0 -f /tmp/test_D7_competition_desk_suite_gate.sql 2>&1)
echo "$RESUITE" | grep -E "D7 DESK GATE SQL SUITE" | head -3
if echo "$RESUITE" | grep -q "D7 DESK GATE SQL SUITE PASS"; then ok "SQL suite after re-apply"; else bad "SQL suite after re-apply"; fi

echo
if [ "$fails" -eq 0 ]; then echo "D7 DESK GATE RUNNER: ALL PASS"; else echo "D7 DESK GATE RUNNER: $fails FAILED"; exit 1; fi
