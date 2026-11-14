#!/usr/bin/env bash
# D24 acceptance runner (M2-D, extended by M3-D): disposable Postgres + the real webhook route with offline signed fixtures + the M3 orchestrator
# (when loaded) driven against real Postgres with an OFFLINE fake Stripe. No network, no hosted database, no real Stripe client.
# Usage: bash scripts/qa/d24-acceptance.sh                  # layers come from THIS checkout (the merged tree); M3 layers load only if the tree already has them
#        bash scripts/qa/d24-acceptance.sh --m1-only        # M1 alone
#        bash scripts/qa/d24-acceptance.sh --m2c REF ...    # optional: draft layers from git refs
#        bash scripts/qa/d24-acceptance.sh --m3a REF --m3b REF [--m3c REF]   # M3 draft PR heads, e.g. refs fetched with `git fetch origin pull/394/head:refs/m3/394`
# M2 layers default to the merged tree whenever only M3 refs are given, so "tree + M3 refs" is the usual M3 configuration.
# Uses a unique container name per run (several sessions can run at once). Prints real PASS/FAIL/BLOCKED counts per section and the exact commit of every layer.
# Exit code: 0 only when nothing failed and the suite actually ran; 1 on any FAIL or a crashed/empty run; 3 when the stack did not start.
# BLOCKED never turns the exit code green-by-omission: read the counts (set D24_FAIL_ON_BLOCKED=1 to make BLOCKED fail the run).
set -uo pipefail
cd "$(dirname "$0")/../.."
export D24_QA_CONTAINER=${D24_QA_CONTAINER:-df-d24-qa-$$}
export D24_OVERLAY="$PWD/scripts/qa/d24/.overlay/run-$$"
REPORT=${D24_REPORT:-${TMPDIR:-${TEMP:-/tmp}}/d24-acceptance-report-$$.json}
rm -f "$REPORT"; rm -rf "$D24_OVERLAY"; mkdir -p "$D24_OVERLAY"
# when only M3 refs are given, the M2 layers still come from the merged tree
args=("$@"); has_m2=0; has_m3=0
for a in "$@"; do case "$a" in --m2a|--m2b|--m2c|--m1-only) has_m2=1 ;; --m3a|--m3b|--m3c) has_m3=1 ;; esac; done
[ $has_m3 = 1 ] && [ $has_m2 = 0 ] && args=(--m2a TREE --m2c TREE --m2b TREE "$@")
trap 'bash scripts/qa/d24-stack.sh down; rm -rf "$PWD/scripts/qa/d24/.overlay/run-$$"; rmdir "$PWD/scripts/qa/d24/.overlay" 2>/dev/null' EXIT
bash scripts/qa/d24-stack.sh up "${args[@]}" || { echo "BLOCKED: stack did not start"; exit 3; }
echo "D24 layers: $(bash scripts/qa/d24-stack.sh layers)"
echo "D24 shas:   $(bash scripts/qa/d24-stack.sh shas)"
npx vitest run --config scripts/qa/d24/vitest.config.mts --reporter=default --reporter=json --outputFile.json="$REPORT"
vrc=$?
node scripts/qa/d24/summarize.mjs "$REPORT"
src=$?
echo "D24 layers: $(bash scripts/qa/d24-stack.sh layers)"
echo "D24 shas:   $(bash scripts/qa/d24-stack.sh shas)"
for l in m3a m3b m3c; do bash scripts/qa/d24-stack.sh layers | grep -qw $l || echo "D24 NOTE: layer $l is NOT loaded - its scenarios are BLOCKED, exit code 0 does not mean they ran"; done
[ $vrc -ne 0 ] && exit $vrc
exit $src
