#!/bin/bash
# phase 5: realistic merge order with origin/main c06222b7 extras: 20261231x2 before E1, 202702xx after CF1
source <(sed -n '1,/^if \[ "\$1" = build/p' $QA_RUN/evidence/rb4/rb4.sh | head -n -1)
LOG=$E/run5.log; : > $LOG
MAIN=origin/main
mb() { git -C $REPO show $MAIN:$M/$1; }
PRE=(20270101090000_competition_e1_officials 20270102090000_competition_e2_ballots 20270106090000_competition_o1_day_of 20270110090000_competition_k1_setup_fixes 20270113090000_competition_scoring_registry 20270114090000_competition_f2_results_lifecycle 20270115090000_competition_ns1_heat_no_shows 20270116090000_competition_ss1_round_scoring_lock 20270117090000_competition_cx1_correction_ballot_readers 20270118090000_competition_ss1_advancement_freeze 20270119090000_competition_hl1_heat_guards)
CFF=(20270120085000_competition_cf1_a1_eligibility_helpers 20270120090000_competition_cf1_callback_final_advancement 20270120091000_competition_cf1_a4a_callback_target_guard 20270120092000_competition_cf1_a2_lock_check 20270120093000_competition_cf1_a3_results_integrity 20270120094000_competition_cf1_a5_exclusion_action 20270120095000_competition_cf1_a6_withdrawal 20270120096000_competition_cf1_a7_od13_correction_integrity)
rbq() { blob rollback/${1}_rollback.sql | docker exec -i -e PGPASSWORD=postgres $C psql -U postgres -h localhost -d postgres -q -v ON_ERROR_STOP=1 -1 2>&1 | grep -m1 ERROR; }
ap() { local o; o=$(mb $1.sql | docker exec -i -e PGPASSWORD=postgres $C psql -U postgres -h localhost -d postgres -q -v ON_ERROR_STOP=1 -1 2>&1 | grep -m1 ERROR | cut -c1-250); if [ -n "$o" ]; then log "MAINAPPLY FAIL $1: $o"; return 1; fi; log "main-apply OK $1"; }
apb() { local o; o=$(blob $1.sql | docker exec -i -e PGPASSWORD=postgres $C psql -U postgres -h localhost -d postgres -q -v ON_ERROR_STOP=1 -1 2>&1 | grep -m1 ERROR | cut -c1-250); if [ -n "$o" ]; then log "APPLY FAIL $1: $o"; return 1; fi; log "int3-apply OK $1"; }
# state at start: CF1 applied. fully roll back competition chain
for n in $(printf '%s\n' "${CFF[@]}" | tac) $(printf '%s\n' "${PRE[@]}" | tac); do r=$(rbq $n); [ -n "$r" ] && { log "rollback FAIL $n $r"; exit 5; }; done
fpall > $E/fp_90_rolled_back_for_main.txt; log "rolled back to pre-competition: diff vs fp_00: $(diff $E/fp_00_pre_competition.txt $E/fp_90_rolled_back_for_main.txt | wc -l)"
ap 20261231090000_twilio_platform_admin_aal2 || exit 6
ap 20261231100000_twilio_pilot_spend_hardening || exit 6
for n in "${PRE[@]}" "${CFF[@]}"; do apb $n || exit 7; done
for n in 20270201090000_billing_protected_subscriptions 20270202090000_studio_subscriptions_read_watermark 20270202100000_apply_studio_subscription_state_rpc 20270203090000_organizer_suite_entitlement_integrity 20270203100000_usage_addon_entitlements_least_privilege 20270203110000_d24_hosted_invoice_facts 20270204090000_billing_price_transitions 20270206090000_d24_m2c_drain_recovery 20270207090000_d24_operator_actions; do ap $n; done
snap 95_int3_plus_main; 
# CF1/competition function md5s unchanged by the main files?
node -e '
const fs=require("fs");const E=process.env.QA_RUN+"/evidence/rb4/snaps/";
const ld=f=>new Map(fs.readFileSync(E+f,"utf8").split("\n").filter(Boolean).map(l=>{const p=l.split("\t");return [p[0],p[1]]}));
const a=ld("39_20270120096000.tsv"),b=ld("95_int3_plus_main.tsv");let d=0,comp=0;const out=[];
for(const [k,v] of a){comp++;if(b.get(k)!==v){d++;out.push("CHANGED "+k)}}
console.log("functions present after CF1 (pre-main snapshot): "+comp+"; changed or missing after main extras: "+d);console.log(out.join("\n"));' | tee -a $LOG
