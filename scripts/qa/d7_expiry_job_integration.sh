#!/usr/bin/env bash
# D7 expiry job integration run (local QA only). Requires the disposable stack started with:
#   ISO_QA_BASE_SCHEMA=<prod baseline .sql> MSYS_NO_PATHCONV=1 node scripts/qa/iso-qa.mjs up baseline --no-api --name d7-expiry \
#     --cutoff 20261119092100 --migration claude/d7-suite-entitlements-db:20270203090000
# Never point this at a hosted database.
set -euo pipefail
export MSYS_NO_PATHCONV=1
C=df-isoqa-d7-expiry-db
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
OUT="${1:-./d7-expiry-out}"
mkdir -p "$OUT"
PSQL=(docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X)

echo "=== target container: $C ($(docker exec "$C" psql -U postgres -d postgres -Atc 'select version()'))"
docker cp "$HERE/d7_expiry_job_integration.sql" "$C:/tmp/d7_expiry_job_integration.sql"
"${PSQL[@]}" -f /tmp/d7_expiry_job_integration.sql 2>&1

echo "=== concurrency: two overlapping job calls at 2027-07-09T07:00:00Z (LA local midnight, PDT)"
CALL="set role service_role; select count(*) as expired from public.expire_due_usage_addon_entitlements('2027-07-09T07:00:00Z', 'organizer_suite');"
( "${PSQL[@]}" -Atc "begin; $CALL select pg_sleep(4); commit;" > "$OUT/conc_a.txt" 2>&1 ) &
A=$!
sleep 1.5
"${PSQL[@]}" -Atc "begin; $CALL commit;" > "$OUT/conc_b.txt" 2>&1
wait $A
CA=$(grep -E '^[0-9]+$' "$OUT/conc_a.txt" | head -1)
CB=$(grep -E '^[0-9]+$' "$OUT/conc_b.txt" | head -1)
echo "session A (holding its transaction) expired: $CA; session B (overlapping) expired: $CB"
if [ "$CA" != "1" ] || [ "$CB" != "0" ]; then echo "FAIL concurrency: expected A=1 B=0"; exit 1; fi
"${PSQL[@]}" -Atc "select count(*) from public.usage_addon_entitlement_events where entitlement_id = 'e7e00000-0000-0000-0000-00000000000d' and event_type = 'status_change'" > "$OUT/conc_ev.txt"
EV=$(tr -d '[:space:]' < "$OUT/conc_ev.txt")
if [ "$EV" != "1" ]; then echo "FAIL concurrency: expected exactly 1 status_change event for the LA grant, got $EV"; exit 1; fi
echo "PASS concurrency: total expired 1, exactly 1 audit event"
AGAIN=$("${PSQL[@]}" -Atc "$CALL" | grep -E '^[0-9]+$')
if [ "$AGAIN" != "0" ]; then echo "FAIL: a later call expired $AGAIN"; exit 1; fi
echo "PASS later call after the concurrent pair expires 0"

docker cp "$C:/tmp/d7_dryrun_rows.json" "$OUT/before.json"
docker cp "$C:/tmp/d7_after_rows.json" "$OUT/after.json"
echo "=== shared TS boundary rule over the dumped rows"
npx tsx "$HERE/d7_expiry_ts_boundary_check.ts" "$OUT/before.json" "$OUT/after.json"
echo "=== INTEGRATION PASSED"
