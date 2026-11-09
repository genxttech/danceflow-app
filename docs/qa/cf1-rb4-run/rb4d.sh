#!/bin/bash
# phase 4: dependency matrix. State at start: full chain applied (CF1 applied). Roll CF1 back, then for each CF1 file i apply all others in order and stop at first failure.
source <(sed -n '1,/^if \[ "\$1" = build/p' $QA_RUN/evidence/rb4/rb4.sh | head -n -1)
LOG=$E/run4.log; : > $LOG
CFF=(20270120085000_competition_cf1_a1_eligibility_helpers 20270120090000_competition_cf1_callback_final_advancement 20270120091000_competition_cf1_a4a_callback_target_guard 20270120092000_competition_cf1_a2_lock_check 20270120093000_competition_cf1_a3_results_integrity 20270120094000_competition_cf1_a5_exclusion_action 20270120095000_competition_cf1_a6_withdrawal 20270120096000_competition_cf1_a7_od13_correction_integrity)
rbq() { blob rollback/${1}_rollback.sql | docker exec -i -e PGPASSWORD=postgres $C psql -U postgres -h localhost -d postgres -q -v ON_ERROR_STOP=1 -1 2>&1 | grep -m1 ERROR; }
fpq() { fpall | md5sum | cut -c1-12; }
for n in $(printf '%s\n' "${CFF[@]}" | tac); do r=$(rbq $n); [ -n "$r" ] && { log "baseline rollback FAIL $n $r"; exit 5; }; done
B=$(fpq); log "baseline (post-HL1) fp md5 $B"
echo "- apply order = ascending; one CF1 file omitted per case; first failure recorded" >> $LOG
for i in 0 1 2 3 4 5 6 7; do
  applied=(); res="all remaining applied cleanly"
  for j in 0 1 2 3 4 5 6 7; do [ $j = $i ] && continue
    o=$(blob ${CFF[$j]}.sql | docker exec -i -e PGPASSWORD=postgres $C psql -U postgres -h localhost -d postgres -q -v ON_ERROR_STOP=1 -1 2>&1 | grep -m1 ERROR | cut -c1-230)
    if [ -n "$o" ]; then res="${CFF[$j]:0:14} REFUSED: $o"; break; else applied+=($j); fi
  done
  log "omit ${CFF[$i]:0:14}: $res"
  for ((k=${#applied[@]}-1;k>=0;k--)); do r=$(rbq ${CFF[${applied[$k]}]}); [ -n "$r" ] && log "   rollback of ${CFF[${applied[$k]}]:0:14} refused: $r"; done
  A=$(fpq); log "   state after cleanup rollback: fp md5 $A $([ $A = $B ] && echo '== baseline' || echo 'DIFFERS from baseline')"
  [ $A = $B ] || { log "STOP: state not restored"; break; }
done
# restore full chain
for n in "${CFF[@]}"; do blob $n.sql | docker exec -i -e PGPASSWORD=postgres $C psql -U postgres -h localhost -d postgres -q -v ON_ERROR_STOP=1 -1 >/dev/null 2>&1; done
fpall > $E/fp_80_after_phase4.txt; log "restored: diff vs fp_30: $(diff $E/fp_30_post_cf1.txt $E/fp_80_after_phase4.txt | wc -l) lines"
