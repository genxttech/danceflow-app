#!/bin/bash
# phase 2: apply 2027 competition chain one file at a time with snapshots; HL1; rollback; reapply
source <(sed -n '1,/^if \[ "\$1" = build/p' $QA_RUN/evidence/rb4/rb4.sh | head -n -1)
LOG=$E/run2.log; : > $LOG
PRE="20270101090000_competition_e1_officials 20270102090000_competition_e2_ballots 20270106090000_competition_o1_day_of 20270110090000_competition_k1_setup_fixes 20270113090000_competition_scoring_registry 20270114090000_competition_f2_results_lifecycle 20270115090000_competition_ns1_heat_no_shows 20270116090000_competition_ss1_round_scoring_lock 20270117090000_competition_cx1_correction_ballot_readers 20270118090000_competition_ss1_advancement_freeze 20270119090000_competition_hl1_heat_guards"
CF="20270120085000_competition_cf1_a1_eligibility_helpers 20270120090000_competition_cf1_callback_final_advancement 20270120091000_competition_cf1_a4a_callback_target_guard 20270120092000_competition_cf1_a2_lock_check 20270120093000_competition_cf1_a3_results_integrity 20270120094000_competition_cf1_a5_exclusion_action 20270120095000_competition_cf1_a6_withdrawal 20270120096000_competition_cf1_a7_od13_correction_integrity"
: > $E/migration_files.tsv; echo -e "migration\tblob_sha1\tblob_md5\tbytes\tcr_bytes" >> $E/migration_files.tsv
mf() { local n=$1; local t=$(blob "$M/$n" 2>/dev/null); }
fileinfo() { # path
  local tmp=$E/tmp_blob.sql; git -C $REPO show $REF:$M/$1 > $tmp; printf "%s\t%s\t%s\t%s\t%s\n" "$1" "$(git -C $REPO rev-parse $REF:$M/$1)" "$(md5sum < $tmp | cut -d' ' -f1)" "$(wc -c < $tmp)" "$(tr -cd '\r' < $tmp | wc -c)" >> $E/migration_files.tsv; rm -f $tmp; }
i=1
for n in $PRE $CF; do
  fileinfo ${n}.sql; fileinfo rollback/${n}_rollback.sql
  [ "$n" = "20270120085000_competition_cf1_a1_eligibility_helpers" ] && { fpall > $E/fp_10_post_hl1_pre_cf1.txt; snap 10_post_hl1_pre_cf1; log "baseline post-HL1 (pre-CF1) fp: $(wc -l < $E/fp_10_post_hl1_pre_cf1.txt) lines"; }
  applyf fwd ${n}.sql postgres && { log "APPLY OK  $n"; } || { log "APPLY FAIL $n"; exit 5; }
  tag=$(printf "%02d_%s" $((20+i)) ${n:0:14}); snap $tag; i=$((i+1))
done
fpall > $E/fp_30_post_cf1.txt; log "post-CF1 fp: $(wc -l < $E/fp_30_post_cf1.txt) lines"
