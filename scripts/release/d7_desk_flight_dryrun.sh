#!/usr/bin/env bash
# D7 pre-expiry release: disposable-Postgres rehearsal of the desk-guard migration WITH the pre/post-flight scripts.
# LOCAL QA ONLY. Never point this at a hosted database. Usage: bash scripts/release/d7_desk_flight_dryrun.sh
# Proves: preflight passes on the repo's 20261116094000 definition; the migration applies; postflight passes; the postflight detects
# tampering; the preflight then FAILS (so it detects an applied/drifted target); a drifted function body is detected by the preflight;
# the rollback restores a state the preflight accepts again; re-apply works.
set -uo pipefail
export MSYS_NO_PATHCONV=1
C=df-deskflight-pg
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
flight() { P t -At -F'|' -f "/tmp/$1" 2>&1; }
overall() { flight "$1" | awk -F'|' '$1=="99"{print $3}'; }

for f in "$SCR/qa/d7_desk_gate_stub.sql" "$SCR/release/d7_desk_preflight.sql" "$SCR/release/d7_desk_postflight.sql" "$SCR/release/d7_desk_recheck.sql" \
         "$MIG/20270203090000_organizer_suite_entitlement_integrity.sql" "$MIG/20270205100000_competition_desk_suite_gate.sql" \
         "$MIG/rollback/20270205100000_competition_desk_suite_gate_rollback.sql"; do put "$f"; done
sed -n '/^create or replace function public.record_competition_checkin_payment(/,/^grant execute on function public.record_competition_checkin_payment/p' \
  "$MIG/20261116094000_paywh1a_remediation.sql" > "$ROOT/.old_fn.tmp.sql"
put "$ROOT/.old_fn.tmp.sql"; rm -f "$ROOT/.old_fn.tmp.sql"

P postgres -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" -c "create database t" >/dev/null
P t -c "grant usage on schema public to anon, authenticated, service_role" -f /tmp/d7_desk_gate_stub.sql >/dev/null
P t -f /tmp/20270203090000_organizer_suite_entitlement_integrity.sql >/dev/null 2>&1
P t -f /tmp/.old_fn.tmp.sql >/dev/null

echo "=== 1. preflight and recheck pass on the repository's 20261116094000 definition"
[ "$(overall d7_desk_preflight.sql)" = "t" ] && ok "preflight" || { bad "preflight"; flight d7_desk_preflight.sql | awk -F'|' '$3=="f"'; }
[ "$(overall d7_desk_recheck.sql)" = "t" ] && ok "recheck" || { bad "recheck"; flight d7_desk_recheck.sql | awk -F'|' '$3=="f"'; }
[ "$(overall d7_desk_postflight.sql)" = "f" ] && ok "postflight fails cleanly (no error) on the unapplied target" || bad "postflight on the unapplied target"

echo "=== 2. a drifted function body is detected by the preflight"
P t -c "create or replace function public.record_competition_checkin_payment(p_event_id uuid, p_session_id uuid, p_amount numeric, p_payment_method text, p_notes text default null) returns jsonb language plpgsql security definer set search_path = public, pg_temp as \$f\$ begin return '{}'::jsonb; end \$f\$" >/dev/null
[ "$(overall d7_desk_preflight.sql)" = "f" ] && ok "drift detected" || bad "drift NOT detected"
P t -f /tmp/.old_fn.tmp.sql >/dev/null
[ "$(overall d7_desk_preflight.sql)" = "t" ] && ok "preflight passes again after restoring the repo definition" || bad "preflight after restore"

echo "=== 3. apply the migration, postflight passes, preflight now fails"
P t -f /tmp/20270205100000_competition_desk_suite_gate.sql >/dev/null 2>&1 && ok "migration applied" || bad "migration apply"
[ "$(overall d7_desk_postflight.sql)" = "t" ] && ok "postflight" || { bad "postflight"; flight d7_desk_postflight.sql | awk -F'|' '$3=="f"'; }
[ "$(overall d7_desk_preflight.sql)" = "f" ] && ok "preflight flags the applied state" || bad "preflight still passes after apply"

echo "=== 4. the postflight detects tampering"
tamper() { P t -c "$2" >/dev/null; if [ "$(overall d7_desk_postflight.sql)" = "t" ]; then bad "not detected: $1"; else ok "detected: $1"; fi; P t -c "$3" >/dev/null; [ "$(overall d7_desk_postflight.sql)" = "t" ] || bad "postflight not clean after undoing: $1"; }
tamper "anon may execute the RPC" "grant execute on function public.record_competition_checkin_payment(uuid,uuid,numeric,text,text) to anon" "revoke execute on function public.record_competition_checkin_payment(uuid,uuid,numeric,text,text) from anon"
tamper "authenticated lost the RPC grant" "revoke execute on function public.record_competition_checkin_payment(uuid,uuid,numeric,text,text) from authenticated" "grant execute on function public.record_competition_checkin_payment(uuid,uuid,numeric,text,text) to authenticated"
tamper "the guard helper is executable by authenticated" "grant execute on function public._d7_competition_desk_suite_allows(uuid,timestamptz) to authenticated" "revoke execute on function public._d7_competition_desk_suite_allows(uuid,timestamptz) from authenticated"
tamper "PUBLIC may execute the RPC" "grant execute on function public.record_competition_checkin_payment(uuid,uuid,numeric,text,text) to public" "revoke execute on function public.record_competition_checkin_payment(uuid,uuid,numeric,text,text) from public"

echo "=== 5. rollback restores a state the preflight accepts; re-apply works"
P t -f /tmp/20270205100000_competition_desk_suite_gate_rollback.sql >/dev/null 2>&1 && ok "rollback ran" || bad "rollback"
[ "$(overall d7_desk_preflight.sql)" = "t" ] && ok "preflight passes after rollback (exact pre-state)" || { bad "preflight after rollback"; flight d7_desk_preflight.sql | awk -F'|' '$3=="f"'; }
P t -f /tmp/20270205100000_competition_desk_suite_gate.sql >/dev/null 2>&1 && [ "$(overall d7_desk_postflight.sql)" = "t" ] && ok "re-apply, postflight passes" || bad "re-apply"

[ "$fails" = 0 ] && echo "ALL D7 DESK FLIGHT REHEARSAL CHECKS PASSED" || { echo "FAILED CHECKS: $fails"; exit 1; }
