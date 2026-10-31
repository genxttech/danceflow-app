#!/usr/bin/env bash
# Competition CF1 A4 -- two-session OD-15 races on the COMPOSED chain (throwaway local Postgres container; fixtures COMMIT and are left).
#   CONTAINER=cf1-a4-db bash test_T_competition_cf1_a4_concurrency.sh
# The fixture is the A4 suite's prelude (helpers, fixtures, scenarios 4 and 6 applied with pending withdrawal requests) committed; the helper-only prelude is
# rebuilt for each racing session. R1: two co-signs that together would leave ONE couple on a three-couple Final -> exactly one succeeds, the other is
# COMP_ADVANCEMENT_BELOW_MINIMUM, two couples remain. R2: Final start || a co-sign: either the start is refused (55P03 concurrent change) or it starts with the
# post-withdrawal roster; never a started Final with three couples and a withdrawal row.
set -u
export MSYS_NO_PATHCONV=1
C="${CONTAINER:?set CONTAINER}"
FX="${FIXTURE:-$(cd "$(dirname "$0")" && pwd)/fixtures/cf1_a4_concurrency_fixture.sql}"
PS() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -h localhost -X -q -At "$@"; }
FAILS=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
# helper-only prelude: everything in the fixture before its first fixture insert
N=$(grep -n "^-- Fixtures" "$FX" | head -1 | cut -d: -f1)
HELP=$(mktemp); head -n $((N-1)) "$FX" | grep -v "^create temp table t_results\|^grant all on t_results" > "$HELP"
sed -i '1i create temp table t_results (name text, ok boolean, detail text, status text) on commit drop; grant all on t_results to authenticated, anon, service_role;' "$HELP"
PS -v ON_ERROR_STOP=1 < "$FX" >/dev/null 2>&1 || { echo "BLOCKED: fixture failed"; exit 3; }
adv_n() { PS -c "select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id=he.heat_id where h.round_id=(select id from public.event_competition_rounds where name='$1 Final' limit 1) and h.status<>'cancelled' and he.status<>'scratched'"; }
rid() { PS -c "select md5('cf1a4:rq:$1:0')::uuid"; }
# ---- R1
A=$(mktemp); B=$(mktemp)
{ cat "$HELP"; echo "begin; select pg_temp.cos(2, 41)::text; select pg_sleep(4); commit;"; } > "$A"
{ cat "$HELP"; echo "begin; select pg_temp.cos(2, 42)::text; commit;"; } > "$B"
PS < "$A" > /tmp/a4c_r1a.out 2>&1 &
sleep 1.2
PS < "$B" > /tmp/a4c_r1b.out 2>&1
wait
RA=$(grep -c "COMP_ADVANCEMENT_BELOW_MINIMUM" /tmp/a4c_r1a.out /tmp/a4c_r1b.out | awk -F: '{s+=$2} END{print s}')
if [ "$(adv_n D4)" = "2" ] && [ "$RA" = "1" ]; then ok "R1 two co-signs that would leave one couple: exactly one refused BELOW_MINIMUM, two couples remain (D4)"; else bad "R1 (entries=$(adv_n D4), refused=$RA): $(head -c 300 /tmp/a4c_r1a.out) | $(head -c 300 /tmp/a4c_r1b.out)"; fi
# ---- R2
{ cat "$HELP"; echo "begin; select pg_temp.cos(2, 61)::text; select pg_sleep(4); commit;"; } > "$A"
{ cat "$HELP"; echo "begin; select pg_temp.start(6)::text; commit;"; } > "$B"
PS < "$A" > /tmp/a4c_r2a.out 2>&1 &
sleep 1.2
PS < "$B" > /tmp/a4c_r2b.out 2>&1
wait
ST=$(PS -c "select status from public.event_competition_rounds where name='D6 Final'" | head -1); EN=$(adv_n D6)
WD=$(PS -c "select count(*) from public.event_competition_final_withdrawals w join public.event_competition_rounds r on r.id=w.target_round_id where r.name='D6 Final'")
if [ "$ST" = "active" ] && [ "$EN" = "2" ] && [ "$WD" = "1" ]; then ok "R2 start || co-sign: the Final started with the post-withdrawal roster (2 couples, 1 withdrawal row)";
elif [ "$ST" = "scheduled" ] && grep -q "COMP_ADVANCEMENT_CONCURRENT_CHANGE\|55P03" /tmp/a4c_r2b.out; then ok "R2 start || co-sign: the start was refused as a concurrent change; the round stayed scheduled (entries=$EN, withdrawals=$WD)";
elif [ "$ST" = "scheduled" ]; then ok "R2 start || co-sign: the start was refused ($(grep -o 'COMP_[A-Z_]*' /tmp/a4c_r2b.out | head -1)); the round stayed scheduled"; else bad "R2 (status=$ST entries=$EN withdrawals=$WD): $(head -c 400 /tmp/a4c_r2b.out)"; fi
echo "COMPETITION CF1 A4 CONCURRENCY $([ $FAILS = 0 ] && echo PASS || echo FAIL)"
exit $FAILS
