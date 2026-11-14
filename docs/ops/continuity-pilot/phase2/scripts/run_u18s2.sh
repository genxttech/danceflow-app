#!/bin/bash
# usage: run_u18s2.sh <name> <apply: none|u18|u18s|both> <out>
# NOTE: this runner pins itself (sha256 in the policy template) but NOT its inputs: SQL comes from the df-u18s and df-u18 worktrees as checked out. Record `git rev-parse HEAD` of both in the evidence. KEEP=1 disables the container-removal trap: remove the container yourself.
export MSYS_NO_PATHCONV=1
C=$1; AP=$2; OUT=$3; M=/c/Dev/df-u18s/src/lib/supabase/migrations; T=$M/sql-tests; U18=/c/Dev/df-u18/src/lib/supabase/migrations; : > $OUT
log() { echo "$*" | tee -a $OUT; }
[ "$KEEP" = 1 ] || trap 'docker rm -f -v $C >/dev/null 2>&1' EXIT
ap() { u=$1; shift; for f in "$@"; do o=$(sed 's/\r$//' "$f" | docker exec -i -e PGPASSWORD=postgres $C psql -U $u -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1); if echo "$o" | grep -qE "ERROR|FATAL|psql:"; then log "APPLY FAIL ($u) $(basename $f): $(echo "$o"|grep -m2 -E 'ERROR|FATAL'|tr '\n' ' '|cut -c1-300)"; return 1; fi; done; }
run() { n=$1; s=$2; fx=${3:-}; if [ -n "$fx" ]; then src=$(cat "$T/fixtures/competition_round_ready.sql" "$T/$s"); else src=$(cat "$T/$s"); fi
  raw=$(echo "$src" | sed 's/\r$//' | docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -X -q 2>&1); v=$(echo "$raw" | grep -E 'SUITE (PASS|FAIL)' | head -1 | sed 's/^ERROR:  //' | cut -c1-400)
  [ -z "$v" ] && v="NO VERDICT: $(echo "$raw" | grep -m2 -E '^ERROR' | tr '\n' ' ' | cut -c1-200)"; log "SUITE $n: $v"; }
docker rm -f -v $C >/dev/null 2>&1
docker run -d --name $C -e POSTGRES_PASSWORD=postgres ${IMG:-ns1-base:snap} >/dev/null
for i in $(seq 1 120); do docker exec $C pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 3; done
cd $M
ap postgres 20270110* 20270115* 20270116* 20270117* 20270118* 20270119* 20270120085000_* || exit 4
ap supabase_admin 20270120090000_* 20270120091000_* 20270120092000_* 20270120093000_* 20270120094000_* 20270120095000_* 20270120095500_* 20270120101000_* || exit 4
ap postgres 20270120102000_* || exit 4
ap supabase_admin 20270120103000_* || exit 4
ap postgres 20270120104000_* || exit 4
ap supabase_admin 20270120105000_* 20270122090000_* || exit 4
log "CHAIN OK apply=$AP"
case $AP in u18|both) ap supabase_admin $U18/20270215093000_competition_u18_heat_entry_status_guard.sql || exit 5; log "U18 APPLIED";; esac
case $AP in u18s|both) ap supabase_admin 20270215094000_competition_u18s_heat_entry_scratch_audit.sql || exit 5; log "U18S APPLIED";; esac
[ "$SUITES" = none ] && { log "CHAIN ONLY"; exit 0; }
case $AP in u18|both) run U18 ../../../../../../df-u18/src/lib/supabase/migrations/sql-tests/test_T_competition_u18_heat_entry_status_guard.sql;; esac
case $AP in u18s|both) run U18S test_T_competition_u18s_heat_entry_scratch_audit.sql;; esac
for x in "ns1 test_T_competition_ns1_no_show.sql fx" "r2gate test_T_competition_r2_refund_write_gate.sql" "k1 test_T_competition_k1_setup_fixes.sql" "cx1 test_T_competition_cx1_correction_readers.sql" "ss1adv test_T_competition_ss1_advancement_freeze.sql" "registry test_T_competition_scoring_registry.sql" "10d test_T_phase10d_floor_schedule.sql" "10d1 test_T_phase10d1_heat_entry_eligibility.sql" "hl1 test_T_competition_hl1_heat_guards.sql" "e2 test_T_competition_e2_ballots.sql" "e2p1 test_T_competition_e2_p1fix.sql" "f2 test_T_competition_f2_results.sql" "o1 test_T_competition_o1_day_of.sql fx" "a6 test_T_competition_cf1_a6_withdrawal.sql" "a5 test_T_competition_cf1_a5_exclusion.sql" "od17 test_T_competition_cf1_od17_enforcement.sql" "a4 test_T_competition_cf1_a4_minimum_integration.sql" "a4a test_T_competition_cf1_a4a_target_guard.sql" "a5u38 test_T_competition_cf1_a5_u38_composed.sql" "a0tie test_T_competition_cf1_a0_tie_policy.sql" "ss1lock test_T_competition_ss1_round_lock.sql" "a1 test_T_competition_cf1_a1_helpers.sql" "a0 test_T_competition_cf1_callback_final_advancement.sql" "a2 test_T_competition_cf1_a2_lock.sql" "a3 test_T_competition_cf1_a3_results.sql" "a7 test_T_competition_cf1_a7_od13.sql" "u66 test_T_competition_cf1_u66_recovery.sql" "f3 test_T_competition_cf1_f3_publication.sql"; do set -- $x; run "$1" "$2" "${3:-}"; done
log "RUN DONE"
