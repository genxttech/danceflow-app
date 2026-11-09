#!/bin/bash
# CF1 F3 (publication): rebuild a DISPOSABLE partial chain in its OWN container and run the F3 gates. Local QA Postgres only; never a shared or hosted database.
#   bash run_cf1_f3.sh [container-name]          (default cf1f3-pg; the container is created and removed by this script)
# Partial chain: image ns1-base:snap (E1,E2,O1,REG,F2) + K1,NS1,SS1,CX1,HL1 + CF1 A1,A0,A4a,A2,A3,A5,A6,A7,A0 review fixes,RB3,U66, then F3.
# F2, O1 and CF1 A5 are chain-aware: with F3 absent they use a stand-in publication table (pre-F3 run, PASS required); with F3 present they place a real
# publication row (post-F3 run, PASS required; the table-absent / unknown-shape assertions are dropped there). Every other suite must also pass AFTER F3.
# Counts are never merged; any suite without a PASS verdict makes this script exit non-zero.
export MSYS_NO_PATHCONV=1
C=${1:-cf1f3-pg}; M=$(cd "$(dirname "$0")/.." && pwd); T=$M/sql-tests; OUT=${F3_OUT:-/tmp/cf1_f3_report.txt}; : > "$OUT"
log() { echo "$*" | tee -a "$OUT"; }
cleanup() { docker rm -f -v "$C" >/dev/null 2>&1; }
trap cleanup EXIT
BAD=0
ap() { u=$1; shift; for f in "$@"; do o=$(sed 's/\r$//' "$f" | docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$u" -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1); if echo "$o" | grep -qE "ERROR|FATAL|psql:"; then log "APPLY FAIL ($u) $(basename "$f"): $(echo "$o" | grep -m2 -E 'ERROR|FATAL' | tr '\n' ' ' | cut -c1-400)"; return 1; fi; done; }
run() { n=$1; s=$2; fx=${3:-}; if [ -n "$fx" ]; then src=$(cat "$T/fixtures/competition_round_ready.sql" "$T/$s"); else src=$(cat "$T/$s"); fi
  v=$(echo "$src" | sed 's/\r$//' | docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -h localhost -d postgres -X -q 2>&1 | grep -E 'SUITE (PASS|FAIL)' | head -1 | sed 's/^ERROR:  //' | cut -c1-500)
  [ -z "$v" ] && v="NO VERDICT"
  case "$v" in *"SUITE PASS"*) ;; *) BAD=$((BAD+1)); v="$v  <-- NOT PASS (a suite that did not print SUITE PASS, including N/A, counts as not passed)";; esac
  log "SUITE $n: $v"; }
docker rm -f -v "$C" >/dev/null 2>&1
docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres ns1-base:snap >/dev/null
for i in $(seq 1 120); do docker exec "$C" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 3; done   # crash recovery of the snapshot can take minutes on a busy disk
docker exec "$C" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 || { log "CHAIN: database not ready"; exit 3; }
cd "$M" || exit 3
ap postgres 20270110* 20270115* 20270116* 20270117* 20270118* 20270119* 20270120085000_* || exit 4
ap supabase_admin 20270120090000_* 20270120091000_* 20270120092000_* 20270120093000_* 20270120094000_* 20270120095000_* 20270120095500_* 20270120101000_* || exit 4
ap postgres 20270120102000_* || exit 4   # RB3 is owned by the migration user (postgres), like A1
ap supabase_admin 20270120103000_* || exit 4
log "CHAIN: partial chain through CF1 A7, A0 review fixes, RB3 and U66 applied (container $C, F3 NOT yet applied)"
# pre-F3 suites that assume F3 is absent
for x in "f2 test_T_competition_f2_results.sql" "o1 test_T_competition_o1_day_of.sql fx" "a5 test_T_competition_cf1_a5_exclusion.sql" "u66 test_T_competition_cf1_u66_recovery.sql"; do set -- $x; run "pre-F3 $1" "$2" "${3:-}"; done
ap supabase_admin 20270122090000_competition_f3_publication.sql || exit 5
log "F3 APPLY: PASS"
# rollback and re-apply (empty publication table)
ap supabase_admin rollback/20270122090000_competition_f3_publication_rollback.sql || exit 5
ap supabase_admin 20270122090000_competition_f3_publication.sql || exit 5
log "F3 ROLLBACK + RE-APPLY: PASS"
run "F3" test_T_competition_cf1_f3_publication.sql
for x in "f2 test_T_competition_f2_results.sql" "o1 test_T_competition_o1_day_of.sql fx" "a5 test_T_competition_cf1_a5_exclusion.sql" "hl1 test_T_competition_hl1_heat_guards.sql" "e2 test_T_competition_e2_ballots.sql" "ss1lock test_T_competition_ss1_round_lock.sql" "a1 test_T_competition_cf1_a1_helpers.sql" "a0 test_T_competition_cf1_callback_final_advancement.sql" "a2 test_T_competition_cf1_a2_lock.sql" "a3 test_T_competition_cf1_a3_results.sql" "a6 test_T_competition_cf1_a6_withdrawal.sql" "a7 test_T_competition_cf1_a7_od13.sql" "u66 test_T_competition_cf1_u66_recovery.sql"; do set -- $x; run "post-F3 $1" "$2" "${3:-}"; done
r=$(CONTAINER=$C DBUSER=supabase_admin timeout 900 bash "$T/test_T_competition_cf1_f3_concurrency.sh" 2>&1 | grep -E "^(PASS|FAIL)|CONCURRENCY (PASS|FAIL)" | tr '\n' '|' | cut -c1-3000)
log "CONC F3: ${r:-NO VERDICT}"
r2=$(CONTAINER=$C DBUSER=supabase_admin timeout 900 bash "$T/test_T_competition_cf1_u66_concurrency.sh" 2>&1 | grep -E "^(PASS|FAIL|BLOCKED)|CONCURRENCY (PASS|FAIL)" | tr "
" "|" | cut -c1-3000)
log "CONC U66: ${r2:-NO VERDICT}"
case "$r2" in *"CONCURRENCY PASS"*) ;; *) BAD=$((BAD+1));; esac
log "GATE: $BAD suite(s) without PASS; race script verdicts above"
case "$r" in *"CONCURRENCY PASS"*) ;; *) BAD=$((BAD+1));; esac
[ "$BAD" = 0 ] && log "F3 RUNNER: PASS" || log "F3 RUNNER: FAIL"
exit "$BAD"
