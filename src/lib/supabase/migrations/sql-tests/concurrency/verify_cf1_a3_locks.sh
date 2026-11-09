#!/bin/bash
# CF1 A3 lock probe verdict (gate U61). Runs run_cf1_a3_locks.sh UNMODIFIED against <container> and judges the nine expected RESULT lines from its
# own stdout (not from kept per-session files, which also hold intermediate notices).
# Output (last line): "CONC A3: PASS (9/9 probe values)" | "CONC A3: FAIL (<n> differ)" | "CONC A3: NOT VERIFIED (<n> missing)".
# INT5 note: the composed runner used to patch the probe script with sed; once the probe's retry loop became a single psql session that patch removed the
# CREATE DATABASE step ("cannot create a3probe") and every probe value was missing. The probe is now run as shipped.
# Usage: bash verify_cf1_a3_locks.sh <container> [stdout-file]
set -u
export MSYS_NO_PATHCONV=1
C=${1:?container}; OUT=${2:-/tmp/a3_probe_$$.out}
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTAINER=$C timeout 600 bash "$HERE/run_cf1_a3_locks.sh" > "$OUT" 2>&1
R=$(grep -o "^RESULT [a-z0-9_]*=[A-Z_ 0-9a-zA-Z]*" "$OUT" | sort -u); MISS=0; MISM=0
for e in "p1_entry_for_key_share=NOT_BLOCKED" "p1_entry_for_update_other_round=NOT_BLOCKED" "p1_entry_for_update_ranking_set=BLOCKED" "p1_round_for_update=BLOCKED" "p2_entry_for_key_share=NOT_BLOCKED" "p2_entry_for_update_ranking_set=BLOCKED" "p2_heat_for_update_certified=BLOCKED" "p2_round_for_update=BLOCKED" "p3_calc=ERROR P0001 COMP_ROSTER_ENTRY_UNAVAILABLE"; do
  k=${e%%=*}
  if echo "$R" | grep -qxF "RESULT $e"; then :; elif echo "$R" | grep -q "^RESULT $k="; then MISM=$((MISM+1)); else MISS=$((MISS+1)); fi
done
N=$(echo "$R" | grep -c .)
if [ $MISM -gt 0 ]; then echo "CONC A3: FAIL ($MISM differ)"; elif [ $MISS -gt 0 ] || [ "$N" != 9 ]; then echo "CONC A3: NOT VERIFIED ($MISS missing, $N distinct result lines)"; else echo "CONC A3: PASS (9/9 probe values)"; fi
