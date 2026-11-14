#!/bin/bash
source <(sed -n '1,/^if \[ "\$1" = build/p' $QA_RUN/evidence/rb4/rb4.sh | head -n -1)
LOG=$E/run3.log; : > $LOG
T=$INT3_WT/src/lib/supabase/migrations/sql-tests
PRE="20270101090000_competition_e1_officials 20270102090000_competition_e2_ballots 20270106090000_competition_o1_day_of 20270110090000_competition_k1_setup_fixes 20270113090000_competition_scoring_registry 20270114090000_competition_f2_results_lifecycle 20270115090000_competition_ns1_heat_no_shows 20270116090000_competition_ss1_round_scoring_lock 20270117090000_competition_cx1_correction_ballot_readers 20270118090000_competition_ss1_advancement_freeze 20270119090000_competition_hl1_heat_guards"
CFR="20270120096000_competition_cf1_a7_od13_correction_integrity 20270120095000_competition_cf1_a6_withdrawal 20270120094000_competition_cf1_a5_exclusion_action 20270120093000_competition_cf1_a3_results_integrity 20270120092000_competition_cf1_a2_lock_check 20270120091000_competition_cf1_a4a_callback_target_guard 20270120090000_competition_cf1_callback_final_advancement 20270120085000_competition_cf1_a1_eligibility_helpers"
CFF="20270120085000_competition_cf1_a1_eligibility_helpers 20270120090000_competition_cf1_callback_final_advancement 20270120091000_competition_cf1_a4a_callback_target_guard 20270120092000_competition_cf1_a2_lock_check 20270120093000_competition_cf1_a3_results_integrity 20270120094000_competition_cf1_a5_exclusion_action 20270120095000_competition_cf1_a6_withdrawal 20270120096000_competition_cf1_a7_od13_correction_integrity"
rbk() { applyf rb rollback/${1}_rollback.sql postgres && log "ROLLBACK OK $1" || { log "ROLLBACK FAIL $1"; return 1; }; }
hl1() { # label
  local f=$E/hl1_$1.out; sed 's/\r$//' $T/test_T_competition_hl1_heat_guards.sql | docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -X -q > $f 2>&1; log "HL1 suite [$1]: $(grep -E 'SUITE (PASS|FAIL)' $f | head -1 | cut -c1-500)"; }
cmpfp() { local d; d=$(diff $E/$1 $E/$2 | wc -l); log "FP DIFF $1 vs $2: $d lines $([ $d = 0 ] && echo PASS || echo FAIL)"; diff $E/$1 $E/$2 > $E/diff_${1%.txt}__${2%.txt}.txt; }
fpall > $E/fp_31_post_cf1_again.txt; cmpfp fp_30_post_cf1.txt fp_31_post_cf1_again.txt
hl1 post_cf1
for n in $CFR; do rbk $n || exit 5; done
fpall > $E/fp_40_after_cf1_rollback.txt; snap 40_after_cf1_rollback
cmpfp fp_10_post_hl1_pre_cf1.txt fp_40_after_cf1_rollback.txt
hl1 post_hl1_only_no_cf1
for n in $CFF; do applyf fwd ${n}.sql postgres && log "REAPPLY OK $n" || { log "REAPPLY FAIL $n"; exit 5; }; done
fpall > $E/fp_50_reapplied_cf1.txt; snap 50_reapplied_cf1
cmpfp fp_30_post_cf1.txt fp_50_reapplied_cf1.txt
cp $E/snaps/50_reapplied_cf1.tsv /dev/null
# bonus: full competition chain rollback (CF1 then HL1 .. E1), compare with the pre-competition baseline
for n in $CFR; do rbk $n || exit 5; done
for n in $(echo $PRE | tr ' ' '\n' | tac); do rbk $n || { log "BONUS rollback stopped at $n"; break; }; done
fpall > $E/fp_60_after_full_competition_rollback.txt
cmpfp fp_00_pre_competition.txt fp_60_after_full_competition_rollback.txt
for n in $PRE $CFF; do applyf fwd ${n}.sql postgres && log "REAPPLY2 OK $n" || { log "REAPPLY2 FAIL $n"; exit 5; }; done
fpall > $E/fp_70_reapplied_all.txt; snap 70_reapplied_all
cmpfp fp_30_post_cf1.txt fp_70_reapplied_all.txt
hl1 post_reapply_all
log "DONE phase3"
