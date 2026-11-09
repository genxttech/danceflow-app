#!/bin/bash
# CF1 RB4 on integration-5 (LOCAL, disposable container, no hosted access).
# Usage: bash rb4_int5.sh <container> <image> <evidence-dir>
#   Phase A  apply R2 + every CF1 migration in order, function snapshot (public functions: signature + 4 md5 kinds) after each step
#   Phase B  reverse rollback of every CF1 migration, snapshot after each, compare with the snapshot taken BEFORE that migration was applied; reapply; compare with the first composed snapshot
#   Phase C  pin coverage: every 32-hex literal in the CF1 migrations / rollbacks / suites against the applied snapshots (pins_int5.mjs)
#   Phase E  pre-CF1 function surface (signature, owner, ACL of every base function survives the CF1 chain)
#   Phase D  data-present rollback: seed committed CF1 data with the concurrency scripts, then attempt every rollback in reverse order;
#            record refusal / success; after each attempt compare the full fingerprint and the exact content hash of EVERY public table
export MSYS_NO_PATHCONV=1
C=${1:?container}; IMG=${2:?image}; E=${3:?evidence dir}
HERE="$(cd "$(dirname "$0")" && pwd)"; M="$(cd "$HERE/../../../src/lib/supabase/migrations" && pwd)"; T=$M/sql-tests; Q=/c/Dev/cf1c-qa-run
mkdir -p "$E/snaps"; LOG=$E/rb4_int5.log; : > $LOG
log() { echo "$*" | tee -a $LOG; }
ap() { u=$1; shift; for f in "$@"; do o=$(sed 's/\r$//' "$f" | docker exec -i -e PGPASSWORD=postgres $C psql -U $u -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1); if echo "$o" | grep -q ERROR; then echo "$o" | grep -m1 ERROR | cut -c1-300; return 1; fi; done; return 0; }
admin() { docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -Atq "$@"; }
snap() { admin < $HERE/fn_md5.sql > $E/snaps/$1.tsv; }
fp() { { admin < $Q/fp.sql; admin < $HERE/fp_ext.sql; } | sort; }
tblmd5() { admin < $HERE/tbl_md5.sql | sort; }
ORDER="20270120085000 20270120090000 20270120091000 20270120092000 20270120093000 20270120094000 20270120095000 20270120095500 20270120101000 20270120102000 20270120103000 20270120104000 20270120105000 20270122090000"
mf() { ls $M/${1}_*.sql; }
rf() { ls $M/rollback/${1}_*_rollback.sql; }
docker rm -f -v $C >/dev/null 2>&1
docker run -d --name $C --memory 1500m --cpus 2 -e POSTGRES_PASSWORD=postgres $IMG postgres -D /etc/postgresql -c supautils.hint_roles= >/dev/null
ok=0; for i in $(seq 1 120); do if docker exec $C psql -U postgres -d postgres -At -c 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); [ $ok -ge 3 ] && break; sleep 4; else ok=0; sleep 3; fi; done
[ $ok -ge 3 ] || { log "CONTAINER NOT READY"; exit 4; }
log "RB4-INT5 head=$(git -C $M rev-parse --short HEAD) image=$IMG $(date -u +%FT%TZ)"
snap 00_base; fp > $E/fp_00_base.txt
git -C ${R2_REPO:-C:/Dev/studioapp} show ${R2_REF:-competition-r2-entry-refunds}:src/lib/supabase/migrations/20270103090000_competition_r2_entry_refunds.sql > $E/r2.sql
o=$(ap postgres $E/r2.sql) && log "A R2 20270103090000 applied: PASS" || { log "A R2 APPLY FAIL: $o"; exit 4; }
snap 01_r2; fp > $E/fp_01_r2.txt
i=1; PREV=01_r2
# Optional R2 cutover write gate (CF1_R2_GATE_FILE), applied right after R2 so every CF1 step is measured from the post-gate state.
if [ -n "${CF1_R2_GATE_FILE:-}" ]; then
  o=$(ap postgres "$CF1_R2_GATE_FILE") && log "A R2 gate $(basename $CF1_R2_GATE_FILE) applied: PASS" || { log "A R2 GATE APPLY FAIL: $o"; exit 4; }
  snap 01b_gate; fp > $E/fp_01b_gate.txt; PREV=01b_gate
fi
for n in $ORDER; do
  i=$((i+1)); tag=$(printf "%02d_%s" $i $n)
  o=$(ap postgres $(mf $n)) || { log "A APPLY FAIL $n: $o"; exit 4; }
  snap $tag; fp > $E/fp_$tag.txt; eval "P_$n=$PREV"; PREV=$tag
  log "A apply $n: PASS ($(wc -l < $E/snaps/$tag.tsv) functions)"
done
FINAL=$PREV; cp $E/fp_$FINAL.txt $E/fp_composed.txt
# ---- Phase B
for n in $(echo $ORDER | tr ' ' '\n' | tac); do
  o=$(ap postgres $(rf $n)) || { log "B ROLLBACK FAIL $n: $o"; exit 5; }
  eval "pre=\$P_$n"; snap rb_$n; d=$(diff <(sort $E/snaps/$pre.tsv) <(sort $E/snaps/rb_$n.tsv) | wc -l); fp > $E/fp_rb_$n.txt; df=$(diff $E/fp_$pre.txt $E/fp_rb_$n.txt | wc -l)
  log "B rollback $n restores the state before it: function snapshot diff $d lines, full fingerprint diff $df lines $([ $d = 0 ] && [ $df = 0 ] && echo PASS || echo FAIL)"
done
for n in $ORDER; do o=$(ap postgres $(mf $n)) || { log "B REAPPLY FAIL $n: $o"; exit 4; }; done
snap reapplied; fp > $E/fp_reapplied.txt; d=$(diff $E/fp_composed.txt $E/fp_reapplied.txt | wc -l); ds=$(diff <(sort $E/snaps/$FINAL.tsv) <(sort $E/snaps/reapplied.tsv) | wc -l)
log "B reapply equals first composed apply: fingerprint diff $d lines, function snapshot diff $ds lines $([ $d = 0 ] && [ $ds = 0 ] && echo PASS || echo FAIL)"
# ---- Phase C
(cd $HERE && E=$(cygpath -m $E) M=$(cygpath -m $M) node pins_int5.mjs | tee -a $LOG)
# ---- Phase E
grep '^F ' $E/fp_00_base.txt | awk '{print $2}' | sort > $E/base_sigs.txt
miss=0; chg=0; : > $E/surface_diff.txt
while read -r sig; do
  b=$(grep -F "F $sig " $E/fp_00_base.txt | head -1 | awk '{ $3=""; print }'); a=$(grep -F "F $sig " $E/fp_composed.txt | head -1 | awk '{ $3=""; print }')
  if [ -z "$a" ]; then miss=$((miss+1)); echo "MISSING $sig" >> $E/surface_diff.txt; elif [ "$a" != "$b" ]; then chg=$((chg+1)); echo "OWNER_OR_ACL_CHANGED $sig | $b | $a" >> $E/surface_diff.txt; fi
done < $E/base_sigs.txt
log "E pre-CF1 function surface through the CF1 chain: $(wc -l < $E/base_sigs.txt) functions, $miss missing, $chg with changed owner/ACL $([ $miss = 0 ] && [ $chg = 0 ] && echo PASS || echo 'see surface_diff.txt')"
# ---- Phase D
cd $T
cc() { n=$1; shift; r=$(timeout 600 "$@" 2>&1 | tail -3 | tr '\n' '|' | cut -c1-200); log "D seed $n: $r"; }
cc A0 env CONTAINER=$C sh test_T_competition_cf1_concurrency.sh
cc A6 env CONTAINER=$C sh test_T_competition_cf1_a6_concurrency.sh
cc A5 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a5_concurrency.sh
cc A7 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a7_concurrency.sh
cc A4 env CONTAINER=$C bash test_T_competition_cf1_a4_concurrency.sh
cc A0tie env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_a0_tie_concurrency.sh
cc F3 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_f3_concurrency.sh
cc U66 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_u66_concurrency.sh
cc RB3R env CONTAINER=$C DBUSER=postgres bash test_T_competition_cf1_rb3r_concurrency.sh
cc OD17 env CONTAINER=$C DBUSER=supabase_admin bash test_T_competition_cf1_od17_concurrency.sh
admin -c "update public.competition_cf1_od17_enforcement set enabled = false" >/dev/null
tblmd5 > $E/tbl_seeded.txt; fp > $E/fp_seeded.txt
log "D seeded: $(wc -l < $E/tbl_seeded.txt) public tables hashed; row counts of CF1 evidence tables: $(grep -E '^(event_competition_round_exclusions|event_competition_round_advancements|event_competition_final_withdrawals|event_competition_correction_causes|event_competition_result_publications|competition_cf1_od17_[a-z_]*|competition_cf1_rb3[a-z_]*)\|' $E/tbl_seeded.txt | awk -F'|' '{s=s" "$1"="$2} END{print s}')"
log "D business/financial tables hashed (rows): $(grep -E '^(event_orders|event_order_refunds|event_order_refund_allocations|event_registrations|event_competition_entries|payments|event_order_items)\|' $E/tbl_seeded.txt | awk -F'|' '{s=s" "$1"="$2} END{print s}')"
cd $M; PRE_T=$E/tbl_seeded.txt; PRE_F=$E/fp_seeded.txt
for n in $(echo $ORDER | tr ' ' '\n' | tac); do
  o=$(ap postgres $(rf $n)); rc=$?
  tblmd5 > $E/tbl_after_$n.txt; fp > $E/fp_after_$n.txt
  chg=$(join -t'|' -j1 <(sort -t'|' -k1,1 $PRE_T) <(sort -t'|' -k1,1 $E/tbl_after_$n.txt) | awk -F'|' '$3!=$5 || $2!=$4 {print $1}' | tr '\n' ' ')
  gone=$(comm -23 <(cut -d'|' -f1 $PRE_T | sort) <(cut -d'|' -f1 $E/tbl_after_$n.txt | sort) | tr '\n' ' ')
  gonerows=""; for t in $gone; do gonerows="$gonerows $t=$(grep "^$t|" $PRE_T | cut -d'|' -f2)"; done
  fd=$(diff $PRE_F $E/fp_after_$n.txt | wc -l)
  if [ $rc = 0 ]; then st="APPLIED"; else st="REFUSED ($(echo "$o" | cut -c1-120))"; fi
  log "D rollback $n with data present: $st | tables with changed content: [${chg:-none}] | tables dropped: [${gone:-none}${gonerows:+ rows:$gonerows}] | fingerprint diff lines $fd"
  [ $rc = 0 ] && { PRE_T=$E/tbl_after_$n.txt; PRE_F=$E/fp_after_$n.txt; }
done
log "RB4-INT5 DONE $(date -u +%FT%TZ)"
docker rm -f -v $C >/dev/null 2>&1
