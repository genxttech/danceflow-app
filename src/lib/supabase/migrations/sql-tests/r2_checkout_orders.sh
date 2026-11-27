#!/usr/bin/env bash
# R2 on orders built by the REAL competition checkout RPCs (finalize_competition_registration), not hand-set fixtures.
# Assembles the first 710 lines of the 10C suite (fixtures + START/PREPARE/ATTACH/FINALIZE/RELEASE) with r2_checkout_orders_tail.sql.
# Rolls back (the tail ends in RAISE). Needs 10C and R2 applied, on an ISOLATED database.
# Usage: PSQL="docker exec -i supabase_db_int-qa psql -U postgres -d postgres -qAt" bash src/lib/supabase/migrations/sql-tests/r2_checkout_orders.sh
set -euo pipefail
: "${PSQL:?set PSQL to a psql command for the isolated QA database}"
HERE="$(cd "$(dirname "$0")" && pwd)"
out=$({ sed -n '1,710p' "$HERE/test_T_phase10c_competitor_registration.sql"; cat "$HERE/r2_checkout_orders_tail.sql"; } | $PSQL 2>&1 || true)
echo "$out" | grep -E "SUITE (PASS|FAIL)" || true
echo "$out" | grep -q "R2 CHECKOUT ORDERS SUITE PASS" || { echo "FAILED or no verdict"; exit 1; }
