#!/bin/sh
# Runs the O1 SQL suite with the shared fixture helper loaded first (pg_temp functions must exist before the suite's `begin;`).
#   CONTAINER=o1-db sh run_o1_suite.sh [suite.sql]       (default: test_T_competition_o1_day_of.sql)
# Local disposable Postgres only. Prints the suite's PASS/FAIL line; exit 0 = PASS.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
C="${CONTAINER:-o1-db}"
SUITE="${1:-$D/test_T_competition_o1_day_of.sql}"
OUT=$(cat "$D/fixtures/competition_round_ready.sql" "$SUITE" | docker exec -i "$C" psql -U postgres -h localhost -X -q 2>&1)
echo "$OUT" | grep -E "SUITE (PASS|FAIL)|ERROR" | head -5
echo "$OUT" | grep -q "SQL SUITE PASS" && exit 0
exit 1
