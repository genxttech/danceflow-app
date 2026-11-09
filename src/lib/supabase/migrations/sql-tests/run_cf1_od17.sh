#!/bin/bash
# CF1 OD-17 enforcement verification runner. LOCAL disposable Postgres container only (never hosted); no Stripe, no Vercel.
#   bash run_cf1_od17.sh <container-name> <r2|nor2> <image> [report-file]
# <image> is a clean full chain through HL1 (July prod dump + every migration before CF1, uniformly postgres-owned; see C:\Dev\cf1c-qa-run\REPRODUCE.md).
# r2: R2 (20270103090000, taken from branch competition-r2-entry-refunds) is applied first, so the RB3 gate returns r2_ledger.
# nor2: R2 is NOT applied; the RB3 gate needs a recorded owner override (the suites record one).
# Steps (one line each, PASS / FAIL, never lumped): composed apply WITHOUT the OD-17 slot -> OD-17 apply, additive-only fingerprint diff, rollback
# exactness (fingerprint equals the pre-OD-17 one), re-apply -> F3 -> full reverse rollback + re-apply fingerprints -> every suite WITH OD-17 and WITHOUT
# it (verdicts must be identical = OFF identity) -> OD-17 suite -> concurrency scripts -> rollback refusal while ON / while audit rows exist.
export MSYS_NO_PATHCONV=1
C=${1:?container}; MODE=${2:?r2|nor2}; IMG=${3:?image}; OUT=${4:-/c/Dev/cf1od17-run/report_$MODE.txt}
M=$(cd "$(dirname "$0")/.." && pwd); T=$M/sql-tests; Q=/c/Dev/cf1c-qa-run; RUNS=/c/Dev/cf1od17-run/runs_$MODE
: > $OUT; mkdir -p $RUNS
log() { echo "$*" | tee -a $OUT; }
cleanup() { docker rm -f -v $C >/dev/null 2>&1; }
trap cleanup EXIT
docker rm -f -v $C >/dev/null 2>&1
docker run -d --name $C --memory 1500m --cpus 2 -e POSTGRES_PASSWORD=postgres $IMG postgres -D /etc/postgresql -c supautils.hint_roles= >/dev/null
ok=0; for i in $(seq 1 120); do if docker exec $C psql -U postgres -d postgres -At -c 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); [ $ok -ge 3 ] && break; sleep 4; else ok=0; sleep 3; fi; done
[ $ok -ge 3 ] || { log "CONTAINER NOT READY"; exit 4; }
ap() { u=$1; shift; for f in "$@"; do o=$(sed 's/\r$//' "$f" | docker exec -i -e PGPASSWORD=postgres $C psql -U $u -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1); if echo "$o" | grep -q ERROR; then log "APPLY FAIL ($u) $(basename $f): $(echo "$o" | grep -m2 ERROR | tr '\n' ' ' | cut -c1-300)"; return 1; fi; done; }
apx() { u=$1; shift; for f in "$@"; do o=$(sed 's/\r$//' "$f" | docker exec -i -e PGPASSWORD=postgres $C psql -U $u -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1); if echo "$o" | grep -q ERROR; then echo "$o" | grep -m1 ERROR | cut -c1-300; return 1; fi; done; return 0; }
fp() { docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -Atq < $Q/fp.sql | sort; }
ps_() { docker exec -i -e PGPASSWORD=postgres $C psql -U "$1" -h localhost -d postgres -X -At -q -c "$2" 2>&1; }
cd $M
ROLL() { ap postgres rollback/${1}_*_rollback.sql; }
MID="20270120090000 20270120091000 20270120092000 20270120093000 20270120094000 20270120095000 20270120095500 20270120101000 20270120102000 20270120103000 20270120104000"
APPLY_MID() { for n in $MID; do ap postgres ${n}_*.sql || return 1; done; }
log "OD-17 runner mode=$MODE image=$IMG head=$(git rev-parse --short HEAD) $(date -u +%FT%TZ)"
# CF1_TEST_SKIP_R2=1 is a negative-test hook only: the R2 migration is not applied although the run requires it, so the expected-mode precheck below must refuse (exit 6).
if [ "$MODE" = r2 ] && [ "${CF1_TEST_SKIP_R2:-}" != 1 ]; then
  git -C ${R2_REPO:-C:/Dev/studioapp} show ${R2_REF:-competition-r2-entry-refunds}:src/lib/supabase/migrations/20270103090000_competition_r2_entry_refunds.sql > $RUNS/r2.sql
  [ -s $RUNS/r2.sql ] || { log "R2 SQL EMPTY (git show failed)"; exit 4; }
  ap postgres $RUNS/r2.sql && log "R2 20270103090000 applied (branch competition-r2-entry-refunds): PASS" || { log "R2 APPLY FAIL"; exit 4; }
  # CF1_R2_GATE_FILE: optional R2 cutover write gate (20270103091000, branch cf1/r2-readiness-prep), applied right after R2 so the CF1 suites run in the final intended order.
  if [ -n "${CF1_R2_GATE_FILE:-}" ]; then ap postgres "$CF1_R2_GATE_FILE" && log "R2 refund write gate $(basename $CF1_R2_GATE_FILE) applied: PASS" || { log "R2 GATE APPLY FAIL"; exit 4; }; fi
fi
log "R2 ledger tables present before CF1: $(ps_ postgres "select to_regclass('public.event_order_refunds') is not null and to_regclass('public.event_order_refund_allocations') is not null and to_regclass('public.event_competition_refund_exception_scopes') is not null")"
fp > $RUNS/fp_pre.txt
ap postgres 20270120085000_*.sql || exit 4
APPLY_MID || { log "COMPOSED APPLY (without OD-17): FAIL"; exit 4; }
log "COMPOSED APPLY without OD-17 (A1..RB3R): PASS"
fp > $RUNS/fp_b1.txt
# --- OD-17 apply + additive-only + exactness
ap postgres 20270120105000_*.sql || { log "OD-17 APPLY: FAIL"; exit 4; }
log "OD-17 20270120105000 apply (preflight + postflight inside): PASS"
fp > $RUNS/fp_b2.txt
rem=$(diff $RUNS/fp_b1.txt $RUNS/fp_b2.txt | grep -c '^<'); add=$(diff $RUNS/fp_b1.txt $RUNS/fp_b2.txt | grep -c '^>')
log "OD-17 additive-only: $rem existing fingerprint lines removed/changed, $add lines added $([ $rem = 0 ] && echo PASS || echo FAIL)"
o=$(apx postgres 20270120105000_*.sql); echo "$o" | grep -q "already exists" && log "OD-17 second apply refused ($o): PASS" || log "OD-17 second apply NOT refused ($o): FAIL"
ROLL 20270120105000 || { log "OD-17 ROLLBACK: FAIL"; exit 5; }
fp > $RUNS/fp_b3.txt; d=$(diff $RUNS/fp_b1.txt $RUNS/fp_b3.txt | wc -l); log "OD-17 rollback exactness (fingerprint equals pre-OD-17): $d diff lines $([ $d = 0 ] && echo PASS || echo FAIL)"
ap postgres 20270120105000_*.sql || { log "OD-17 RE-APPLY: FAIL"; exit 4; }
fp > $RUNS/fp_b4.txt; d=$(diff $RUNS/fp_b2.txt $RUNS/fp_b4.txt | wc -l); log "OD-17 re-apply fingerprint equals first apply: $d diff lines $([ $d = 0 ] && echo PASS || echo FAIL)"
ap postgres 20270122090000_*.sql || { log "F3 APPLY: FAIL"; exit 4; }
log "F3 20270122090000 applied: PASS"
fp > $RUNS/fp_comp.txt
# --- full reverse rollback and re-apply
for n in 20270122090000 20270120105000 20270120104000 20270120103000 20270120102000 20270120101000 20270120095500 20270120095000 20270120094000 20270120093000 20270120092000 20270120091000 20270120090000; do ROLL $n || { log "ROLLBACK FAIL $n"; exit 5; }; done
ap postgres rollback/20270120085000_*_rollback.sql || { log "ROLLBACK FAIL A1"; exit 5; }
fp > $RUNS/fp_rb.txt; d=$(diff $RUNS/fp_pre.txt $RUNS/fp_rb.txt | wc -l); log "REVERSE ROLLBACK (F3, OD-17, RB3R..A0, A1) fingerprint diff vs pre-CF1: $d lines $([ $d = 0 ] && echo PASS || echo FAIL)"
ap postgres 20270120085000_*.sql && APPLY_MID && ap postgres 20270120105000_*.sql 20270122090000_*.sql || { log "RE-APPLY: FAIL"; exit 4; }
fp > $RUNS/fp_re.txt; d=$(diff $RUNS/fp_comp.txt $RUNS/fp_re.txt | wc -l); log "RE-APPLY (sorted order) fingerprint diff vs first composed apply: $d lines $([ $d = 0 ] && echo PASS || echo FAIL)"
# --- suites
# INT5-SECFIX-3 (P2-b): the mode the chain MUST be in is an input of the run (r2 -> r2_ledger, nor2 -> absent), checked here against the catalog AND the code under test, and handed to every suite as :expected_mode.
EXPMODE=$([ "$MODE" = r2 ] && echo r2_ledger || echo absent)
CATLEDGER=$(ps_ supabase_admin "select (to_regclass('public.event_order_refunds') is not null and to_regclass('public.event_order_refund_allocations') is not null and to_regclass('public.event_competition_refund_exception_scopes') is not null and to_regprocedure('public._cf1_entry_refund_evidence_reason(uuid)') is not null)")
CODEMODE=$(ps_ supabase_admin "select public._cf1_refund_evidence_mode()")
if { [ "$EXPMODE" = r2_ledger ] && [ "$CATLEDGER" = t ] && [ "$CODEMODE" = r2_ledger ]; } || { [ "$EXPMODE" = absent ] && [ "$CATLEDGER" = f ] && [ "$CODEMODE" = absent ]; }; then log "EXPECTED MODE ($EXPMODE): catalog ledger=$CATLEDGER, _cf1_refund_evidence_mode()=$CODEMODE PASS"; else log "EXPECTED MODE ($EXPMODE): catalog ledger=$CATLEDGER, _cf1_refund_evidence_mode()=$CODEMODE FAIL -- the chain is not in the mode this run requires; no suite verdict is valid"; exit 6; fi
NOV=0; SF=0; SP=0; NA=0
. "$T/run_cf1_od17_lib.sh"
# INT5 (no-R2 classification): RB3 / RB3R need the R2 ledger by design (their gate refuses mode absent). They are NOT APPLICABLE only when the precheck above proved the chain is
# legitimately without R2 (expected absent AND catalog false AND code absent). Their original output is kept and logged. On an R2-required chain (expected r2_ledger) the same
# result stays a FAIL / NO VERDICT, and any other suite is never reclassified.
run() { n=$1; s=$2; fx=${3:-}; out=$4; if [ "$fx" != "-" ]; then src=$(cat $T/fixtures/competition_round_ready.sql "$T/$s"); else src=$(cat "$T/$s"); fi
  echo "$src" | sed 's/\r$//' | docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -X -q -v expected_mode=$EXPMODE > $RUNS/$n.$out.out 2>&1
  v=$(grep -E 'SUITE (PASS|FAIL)' $RUNS/$n.$out.out | head -1 | sed 's/^ERROR:  //' | cut -c1-400); [ -z "$v" ] && v="NO VERDICT (see $RUNS/$n.$out.out)"; echo "$n: $v"; }
SUITES=("hl1 test_T_competition_hl1_heat_guards.sql" "e2 test_T_competition_e2_ballots.sql" "e2p1 test_T_competition_e2_p1fix.sql" "f2 test_T_competition_f2_results.sql" "o1 test_T_competition_o1_day_of.sql fx" "ss1adv test_T_competition_ss1_advancement_freeze.sql" "ss1lock test_T_competition_ss1_round_lock.sql" "ns1 test_T_competition_ns1_no_show.sql fx" "cx1 test_T_competition_cx1_correction_readers.sql fx" "k1 test_T_competition_k1_setup_fixes.sql" "reg test_T_competition_scoring_registry.sql" "p10d test_T_phase10d_floor_schedule.sql" "p10d1 test_T_phase10d1_heat_entry_eligibility.sql" "a1 test_T_competition_cf1_a1_helpers.sql" "a0 test_T_competition_cf1_callback_final_advancement.sql" "a2 test_T_competition_cf1_a2_lock.sql" "a3 test_T_competition_cf1_a3_results.sql" "a4a test_T_competition_cf1_a4a_target_guard.sql" "a5 test_T_competition_cf1_a5_exclusion.sql" "a6 test_T_competition_cf1_a6_withdrawal.sql" "a7 test_T_competition_cf1_a7_od13.sql" "a4 test_T_competition_cf1_a4_minimum_integration.sql" "a0tie test_T_competition_cf1_a0_tie_policy.sql" "a5u38 test_T_competition_cf1_a5_u38_composed.sql" "rb3 test_T_competition_cf1_rb3_refund_evidence.sql" "rb3r test_T_competition_cf1_rb3r_reconciliation.sql" "f3 test_T_competition_cf1_f3_publication.sql" "u66 test_T_competition_cf1_u66_recovery.sql")
runall() { tag=$1; : > $RUNS/verdicts_$tag.txt; for x in "${SUITES[@]}"; do set -- $x; run $1 $2 "${3:--}" $tag >> $RUNS/verdicts_$tag.txt; done; }
runall with
cat $RUNS/verdicts_with.txt | while read -r l; do log "SUITE (with OD-17) $l"; done
# OFF identity: the same suites on the same database with ONLY the OD-17 objects removed must give identical verdicts
ROLL 20270120105000 || { log "OD-17 ROLLBACK (identity run): FAIL"; exit 5; }
runall without
ap postgres 20270120105000_*.sql || { log "OD-17 RE-APPLY (identity run): FAIL"; exit 4; }
d=$(diff <(sed 's/[0-9]* checks/N checks/' $RUNS/verdicts_with.txt) <(sed 's/[0-9]* checks/N checks/' $RUNS/verdicts_without.txt) | wc -l)
d2=$(diff <(sed 's#.with.out#.X.out#' $RUNS/verdicts_with.txt) <(sed 's#.without.out#.X.out#' $RUNS/verdicts_without.txt) | wc -l)
log "OFF IDENTITY: verdicts of the existing suites with vs without the OD-17 objects: $d2 differing lines (check counts included) $([ $d2 = 0 ] && echo PASS || echo FAIL)"
for x in "${SUITES[@]}"; do set -- $x; v=$(grep "^$1: " $RUNS/verdicts_with.txt); if r2na $1 && ! echo "$v" | grep -q 'SUITE PASS'; then NA=$((NA+1)); log "NOT APPLICABLE (requires the R2 ledger; chain has none): $v"; continue; fi; case "$v" in *'SUITE PASS'*) SP=$((SP+1));; *'SUITE FAIL'*) SF=$((SF+1)); log "BASELINE-OR-REAL FAIL (same with and without OD-17 if OFF IDENTITY passed): $v";; *) NOV=$((NOV+1)); log "NO VERDICT: $v";; esac; done
v=$(run od17 test_T_competition_cf1_od17_enforcement.sql - with); log "SUITE od17: $v"
case "$v" in *'SUITE PASS'*) SP=$((SP+1));; *'SUITE FAIL'*) SF=$((SF+1));; *) NOV=$((NOV+1));; esac
# --- concurrency (commits fixtures)
CONCPASS=0; CONCFAIL=0; CONCNOV=0; NOTVER=0
cc() { n=$1; shift; r=$(timeout 600 "$@" 2>&1 | grep -E "^(PASS|FAIL)|CONCURRENCY (PASS|FAIL)|PASS \(|done:|TALLY" | tail -8 | tr '\n' '|' | cut -c1-600); log "CONC $n: $r"; if r2na $n && { [ -z "$r" ] || echo "$r" | grep -qE "(^|[|])FAIL |CONCURRENCY FAIL|done: [1-9][0-9]* failure"; }; then NA=$((NA+1)); log "CONC $n: NOT APPLICABLE (requires the R2 ledger; chain has none; original output above kept)"; elif [ -z "$r" ]; then CONCNOV=$((CONCNOV+1)); elif echo "$r" | grep -qE "(^|[|])FAIL |CONCURRENCY FAIL|done: [1-9][0-9]* failure"; then CONCFAIL=$((CONCFAIL+1)); else CONCPASS=$((CONCPASS+1)); fi; }
cd $T
V=$(bash concurrency/verify_cf1_a3_locks.sh $C $RUNS/a3_conc.out | tail -1); log "$V"
case "$V" in *": PASS"*) CONCPASS=$((CONCPASS+1));; *": FAIL"*) CONCFAIL=$((CONCFAIL+1));; *) NOTVER=$((NOTVER+1));; esac
cc A0 env CONTAINER=$C sh test_T_competition_cf1_concurrency.sh
cc A6 env CONTAINER=$C sh test_T_competition_cf1_a6_concurrency.sh
cc A2 bash concurrency/run_cf1_a2_lock_vs_lifecycle.sh $C
cc A5 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a5_concurrency.sh
cc A7 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a7_concurrency.sh
cc A4 env CONTAINER=$C bash test_T_competition_cf1_a4_concurrency.sh
cc A0tie env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a0_tie_concurrency.sh
cc F3 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_f3_concurrency.sh
cc U66 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_u66_concurrency.sh
cc RB3R env CONTAINER=$C DBUSER=postgres bash test_T_competition_cf1_rb3r_concurrency.sh
cc OD17 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_od17_concurrency.sh
cd $M
# --- rollback refusal while an event is ON, then while audit rows exist; each refused attempt must change nothing
fp > $RUNS/fp_before_refuse.txt
log "events with the switch ON after the concurrency probes: $(ps_ postgres "select count(*) from public.competition_cf1_od17_enforcement where enabled")"
o=$(apx postgres rollback/20270120105000_*_rollback.sql); echo "$o" | grep -q "ON; disable it first" && log "OD-17 rollback refused while an event is ON ($o): PASS" || log "OD-17 rollback NOT refused while ON ($o): FAIL"
fp > $RUNS/fp_after_refuse1.txt; d=$(diff $RUNS/fp_before_refuse.txt $RUNS/fp_after_refuse1.txt | wc -l); log "refused rollback (ON) changed nothing: $d diff lines $([ $d = 0 ] && echo PASS || echo FAIL)"
ps_ supabase_admin "update public.competition_cf1_od17_enforcement set enabled = false" >/dev/null
o=$(apx postgres rollback/20270120105000_*_rollback.sql); echo "$o" | grep -q "audit rows exist" && log "OD-17 rollback refused while audit rows exist ($o): PASS" || log "OD-17 rollback NOT refused with audit rows ($o): FAIL"
fp > $RUNS/fp_after_refuse2.txt; d=$(diff $RUNS/fp_before_refuse.txt $RUNS/fp_after_refuse2.txt | wc -l); log "refused rollback (audit) changed nothing: $d diff lines $([ $d = 0 ] && echo PASS || echo FAIL)"
PASSN=$((SP+CONCPASS)); FAILN=$((SF+CONCFAIL)); NOVN=$((NOV+CONCNOV))
log "SUITE SUMMARY ($MODE): PASS $PASSN (suites $SP, concurrency $CONCPASS) | FAIL $FAILN (suites $SF, concurrency $CONCFAIL) | NO VERDICT $NOVN (suites $NOV, concurrency $CONCNOV) | NOT APPLICABLE $NA | NOT VERIFIED $NOTVER"
log "DONE $(date -u +%FT%TZ)"
[ "$SF" = 0 ] || exit 6; [ "$CONCFAIL" = 0 ] || exit 8; [ "$NOVN" = 0 ] || exit 7; [ "$NOTVER" = 0 ] || exit 9; exit 0
