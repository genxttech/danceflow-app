#!/usr/bin/env bash
# D7 core release: verify the ARTIFACTS to be applied/promoted are exactly the reviewed ones (no database access).
#   bash scripts/release/d7_core_artifact_check.sh [migrations-dir]
# Fails (non-zero) if any migration/rollback file differs from the reviewed bytes, or if release/pricing-p1 moved.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HERE/../../src/lib/supabase/migrations}"
EXPECTED_RELEASE_BASE="4bc938c6e3788bf9e34f8cd83b92f1036ec33562"

# sha256 of the reviewed files (LF endings), identical in PR #397 (release candidate) and PR #398 (this runbook)
declare -A SHA=(
  ["20270203090000_organizer_suite_entitlement_integrity.sql"]="86dc11a9"
  ["20270203100000_usage_addon_entitlements_least_privilege.sql"]="dedfeddc"
  ["rollback/20270203090000_organizer_suite_entitlement_integrity_rollback.sql"]="fe02caf8"
  ["rollback/20270203100000_usage_addon_entitlements_least_privilege_rollback.sql"]="037eaf8e"
)
bad=0
for f in "${!SHA[@]}"; do
  actual="$(sha256sum "$DIR/$f" | cut -d' ' -f1)"
  if [[ "$actual" == "${SHA[$f]}"* ]]; then echo "OK   $f ${actual:0:16}"; else echo "FAIL $f expected ${SHA[$f]}... got ${actual:0:16}"; bad=1; fi
done
if grep -q $'\r' "$DIR/20270203090000_organizer_suite_entitlement_integrity.sql"; then echo "FAIL migration 1 contains CRLF line endings"; bad=1; fi

remote="$(git ls-remote origin refs/heads/release/pricing-p1 2>/dev/null | cut -f1)"
if [ "$remote" = "$EXPECTED_RELEASE_BASE" ]; then echo "OK   release/pricing-p1 is still ${remote:0:8}"; else echo "FAIL release/pricing-p1 is '${remote:-unknown}', reviewed base was ${EXPECTED_RELEASE_BASE:0:8}"; bad=1; fi
[ "$bad" = 0 ] && echo "ARTIFACTS MATCH THE REVIEWED SET" || { echo "STOP: artifacts differ from the reviewed set"; exit 1; }
