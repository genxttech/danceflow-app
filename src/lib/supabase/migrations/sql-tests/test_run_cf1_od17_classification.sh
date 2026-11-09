#!/bin/bash
# Focused test of the runner's no-R2 classification (INT5). No database needed.
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/run_cf1_od17_lib.sh"
fail=0
t() { exp=$1; shift; EXPMODE=$1 CATLEDGER=$2 CODEMODE=$3 r2na "$4"; got=$?; if [ $got = $exp ]; then echo "PASS  expected=$1 cat=$2 code=$3 suite=$4 -> $([ $got = 0 ] && echo NOT_APPLICABLE || echo KEEPS_VERDICT)"; else echo "FAIL  expected=$1 cat=$2 code=$3 suite=$4 -> rc=$got (wanted $exp)"; fail=$((fail+1)); fi; }
t 0 absent f absent rb3
t 0 absent f absent rb3r
t 0 absent f absent RB3R
t 1 r2_ledger t r2_ledger rb3      # mandatory R2 suite on an R2 chain: a failure stays a failure
t 1 r2_ledger t r2_ledger rb3r
t 1 r2_ledger t r2_ledger RB3R
t 1 r2_ledger f absent rb3         # R2 required but missing: never NOT APPLICABLE
t 1 r2_ledger f absent rb3r
t 1 absent f absent a3             # only the R2-required suites are ever reclassified
t 1 absent f absent f3
t 1 absent t absent rb3            # inconsistent catalog / code: fail closed
t 1 absent f r2_ledger rb3
t 1 absent f absent rb3x
echo "classification test failures: $fail"; [ $fail = 0 ]
