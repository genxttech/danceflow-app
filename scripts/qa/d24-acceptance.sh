#!/usr/bin/env bash
# D24 M2-D acceptance runner: disposable Postgres + the real webhook route with offline signed fixtures.
# Usage: bash scripts/qa/d24-acceptance.sh [--m2a REF] [--m2b REF] [--m2c REF]   (REF = git branch with that sibling's draft)
# Uses a unique container name per run (several sessions can run at once). Prints real PASS/FAIL/BLOCKED counts per section.
# Exit code: 0 only when nothing failed and the suite actually ran; 1 on any FAIL or a crashed/empty run; 3 when the stack did not start.
# BLOCKED never turns the exit code green-by-omission: read the counts (set D24_FAIL_ON_BLOCKED=1 to make BLOCKED fail the run).
set -uo pipefail
cd "$(dirname "$0")/../.."
export D24_QA_CONTAINER=${D24_QA_CONTAINER:-df-d24-qa-$$}
REPORT=${D24_REPORT:-${TMPDIR:-${TEMP:-/tmp}}/d24-acceptance-report-$$.json}
rm -f "$REPORT"
trap 'bash scripts/qa/d24-stack.sh down' EXIT
bash scripts/qa/d24-stack.sh up "$@" || { echo "BLOCKED: stack did not start"; exit 3; }
npx vitest run --config scripts/qa/d24/vitest.config.mts --reporter=default --reporter=json --outputFile.json="$REPORT"
vrc=$?
node scripts/qa/d24/summarize.mjs "$REPORT"
src=$?
[ $vrc -ne 0 ] && exit $vrc
exit $src
