#!/bin/bash
# CF1 integration: rebuild the composed chain from the latest package heads and run every suite + concurrency script. Local QA Postgres only.
#   bash run_all.sh            (fetches, merges heads into the cf1/integration worktree, builds, runs, writes /c/Dev/cf1-a4-qa/report.txt)
# Partial chain: image ns1-base:snap (E1,E2,O1,REG,F2 only) + K1,NS1,SS1,CX1,HL1 applied here. NOT a from-scratch chain (cf1-e1-chain-probe owns that).
export MSYS_NO_PATHCONV=1
W=/c/Dev/studioapp-cf1-int            # cf1/integration worktree
Q=/c/Dev/cf1-a4-qa; OUT=$Q/report.txt; : > $OUT
M=$W/src/lib/supabase/migrations; T=$M/sql-tests; L=/c/Dev/.cf1-db-slot.lock; C=cf1-a4-db
log() { echo "$*" | tee -a $OUT; }
cleanup() { docker rm -f -v $C >/dev/null 2>&1; rm -rf $L; }
trap cleanup EXIT
# --- heads
cd $W && git fetch -q origin
for b in a0-core a1-eligibility-helper a4a-target-guard a2-lock-check a3-results-integrity a5-exclusion-action a6-withdrawal a7-od13 b-app a4-minimum-rule; do
  git merge --no-edit -q origin/cf1/$b >/dev/null 2>&1 || { log "MERGE CONFLICT with origin/cf1/$b"; git merge --abort; exit 2; }
  log "head $b $(git rev-parse --short origin/cf1/$b)"
done
log "integration head $(git rev-parse --short HEAD)"
# --- slot lock
for i in $(seq 1 120); do mkdir $L 2>/dev/null && break; sleep 30; done
[ -d $L ] || { log "no slot lock"; trap - EXIT; exit 3; }
echo "session=cf1-a4 container=$C started=$(date -u +%FT%TZ) purpose=run_all" > $L/owner.txt
ap() { u=$1; shift; for f in "$@"; do o=$(sed 's/\r$//' "$f" | docker exec -i -e PGPASSWORD=postgres $C psql -U $u -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1); if echo "$o" | grep -q ERROR; then log "APPLY FAIL ($u) $(basename $f): $(echo "$o" | grep -m2 ERROR | tr '\n' ' ' | cut -c1-300)"; return 1; fi; done; }
fp() { docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -Atq < $Q/fp.sql | sort; }
docker rm -f -v $C >/dev/null 2>&1
docker run -d --name $C -e POSTGRES_PASSWORD=postgres ns1-base:snap >/dev/null
for i in $(seq 1 40); do docker exec $C pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 3; done
cd $M
ap postgres 20270110* 20270115* 20270116* 20270117* 20270118* 20270119* || exit 4
CF="20270120085000 20270120090000 20270120091000 20270120092000 20270120093000 20270120094000 20270120095000 20270120096000"
fp > $Q/fpA_pre.txt 2>/dev/null
ap postgres 20270120085000_* || exit 4
rb() { ap supabase_admin rollback/${1}_*_rollback.sql; }
# pre-CF1 fingerprint (A1 not applied yet in this run: take it before)
ap supabase_admin 20270120090000_* 20270120091000_* 20270120092000_* 20270120093000_* 20270120094000_* 20270120095000_* 20270120096000_* || { log "COMPOSED APPLY: FAIL"; exit 4; }
log "COMPOSED APPLY (partial chain, snap): PASS"
fp > $Q/fpA_comp.txt
for n in 20270120096000 20270120095000 20270120094000 20270120093000 20270120092000 20270120091000 20270120090000; do rb $n || { log "ROLLBACK FAIL $n"; exit 5; }; done
ap postgres rollback/20270120085000_*_rollback.sql || { log "ROLLBACK FAIL A1"; exit 5; }
fp > $Q/fpA_rb.txt
d=$(diff $Q/fpA_pre.txt $Q/fpA_rb.txt | wc -l); log "REVERSE ROLLBACK fingerprint diff vs pre-CF1: $d lines $([ $d = 0 ] && echo PASS || echo FAIL)"
ap postgres 20270120085000_* && ap supabase_admin 20270120090000_* 20270120091000_* 20270120092000_* 20270120093000_* 20270120094000_* 20270120095000_* 20270120096000_* || exit 4
fp > $Q/fpA_re.txt; d=$(diff $Q/fpA_comp.txt $Q/fpA_re.txt | wc -l); log "RE-APPLY fingerprint diff vs first apply: $d lines $([ $d = 0 ] && echo PASS || echo FAIL)"
# --- suites
run() { n=$1; s=$2; fx=${3:-}; if [ -n "$fx" ]; then src=$(cat $T/fixtures/competition_round_ready.sql "$T/$s"); else src=$(cat "$T/$s"); fi
  echo "$src" | sed 's/\r$//' | docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -X -q > $Q/runs2/$n.out 2>&1
  log "SUITE $n: $(grep -E 'SUITE (PASS|FAIL)' $Q/runs2/$n.out | head -1 | sed 's/^ERROR:  //' | cut -c1-400)"; }
mkdir -p $Q/runs2
for x in "hl1 test_T_competition_hl1_heat_guards.sql" "e2 test_T_competition_e2_ballots.sql" "e2p1 test_T_competition_e2_p1fix.sql" "f2 test_T_competition_f2_results.sql" "o1 test_T_competition_o1_day_of.sql fx" "ss1adv test_T_competition_ss1_advancement_freeze.sql" "ss1lock test_T_competition_ss1_round_lock.sql" "ns1 test_T_competition_ns1_no_show.sql fx" "cx1 test_T_competition_cx1_correction_readers.sql fx" "k1 test_T_competition_k1_setup_fixes.sql" "reg test_T_competition_scoring_registry.sql" "p10d test_T_phase10d_floor_schedule.sql" "p10d1 test_T_phase10d1_heat_entry_eligibility.sql" "a1 test_T_competition_cf1_a1_helpers.sql" "a0 test_T_competition_cf1_callback_final_advancement.sql" "a2 test_T_competition_cf1_a2_lock.sql" "a3 test_T_competition_cf1_a3_results.sql" "a4a test_T_competition_cf1_a4a_target_guard.sql" "a5 test_T_competition_cf1_a5_exclusion.sql" "a6 test_T_competition_cf1_a6_withdrawal.sql" "a7 test_T_competition_cf1_a7_od13.sql" "a4 test_T_competition_cf1_a4_minimum_integration.sql"; do run $x; done
# --- concurrency (commit fixtures; run after the suites; A2 once per database)
cc() { n=$1; shift; r=$(timeout 400 "$@" 2>&1 | grep -E "^(PASS|FAIL)|CONCURRENCY (PASS|FAIL)|PASS \(|done:" | tail -4 | tr '\n' '|' | cut -c1-500); log "CONC $n: $r"; }
cd $T
cc A0 env CONTAINER=$C sh test_T_competition_cf1_concurrency.sh
cc A6 env CONTAINER=$C sh test_T_competition_cf1_a6_concurrency.sh
cc A2 bash concurrency/run_cf1_a2_lock_vs_lifecycle.sh $C
cc A5 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a5_concurrency.sh
cc A7 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a7_concurrency.sh
cc A4 env CONTAINER=$C bash test_T_competition_cf1_a4_concurrency.sh
sed 's#^  PS -d postgres -qAt -c "select pg_terminate_backend.*#  :#; s#^  PS -d postgres -qc "create database a3probe template postgres" 2>/dev/null \&\& break#  PS -d postgres -qAt -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '"'"'postgres'"'"' and pid <> pg_backend_pid()" -c "create database a3probe template postgres" >/dev/null 2>\&1#' concurrency/run_cf1_a3_locks.sh > concurrency/tmp_a3_retry.sh
r=$(CONTAINER=$C timeout 400 bash concurrency/tmp_a3_retry.sh 2>&1 | grep -E "RESULT" | sort -u | tr '\n' ' ' | cut -c1-600); rm -f concurrency/tmp_a3_retry.sh; log "CONC A3 (retry-tolerant copy): $r"
log "DONE $(date -u +%FT%TZ)"
