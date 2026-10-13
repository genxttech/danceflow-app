#!/usr/bin/env bash
# Marketing M-0 -- stage-1 precondition tests (run against an ISOLATED QA database only, starting from the pre-M-0 state).
#
# Usage: PSQL="docker exec -i supabase_db_danceflow-e2e-qa psql -U postgres -qAt" \
#        bash src/lib/supabase/migrations/sql-tests/m0_precondition_tests.sh
#
# Proves the stage-1 migration refuses (changing nothing) when the database is not in a state it knows, so it can never
# broaden recipient / unsubscribe visibility or overwrite an unexpected dispatcher function on PROD:
#   1. an unknown extra policy on the recipient table;
#   2. a known policy name with a different (broader) definition;
#   3. the recipient visibility policy missing (creating one would grant new access);
#   4. claim_outbound_deliveries not the PAY-WH-1 version.
# Each tamper is reverted afterwards and the pre-M-0 fingerprint must be unchanged at the end.
set -uo pipefail
: "${PSQL:?set PSQL to a psql command for the isolated QA database}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$DIR/../20261117090000_m0_marketing_send_integrity.sql"
FP="$DIR/m0_marketing_fingerprint.sql"

q() { $PSQL -c "$1"; }
fp() { $PSQL < "$FP" | grep '^TOTAL'; }
pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi
}

guard=$(q "select count(*) from auth.users where email not like '%@e2e.test' and email not like '%@example.%'")
if [ "$guard" != "0" ]; then echo "refusing: database contains non-test accounts"; exit 2; fi
if [ "$(q "select to_regproc('public.marketing_send_frozen') is null")" != "t" ]; then
  echo "refusing: start from the pre-M-0 state (roll stage 2 and stage 1 back first)"; exit 2
fi

PRE=$(fp)
apply_expect_refusal() { # name
  local out
  out=$($PSQL -v ON_ERROR_STOP=1 < "$MIG" 2>&1)
  if echo "$out" | grep -q "M-0 precondition failed"; then check "$1: stage 1 refused" "refused" "refused"; else check "$1: stage 1 refused" "applied" "refused"; fi
  check "$1: nothing was created" "$(q "select to_regproc('public.marketing_send_frozen') is null")" "t"
}

# 1. unknown extra policy
q "create policy \"tamper extra read\" on public.marketing_campaign_recipients for select using (true);" >/dev/null
apply_expect_refusal "unknown policy"
q "drop policy \"tamper extra read\" on public.marketing_campaign_recipients;" >/dev/null

# 2. known name, broader definition
q "alter policy \"studio members can view marketing unsubscribes\" on public.marketing_unsubscribes using (true);" >/dev/null
apply_expect_refusal "altered policy"
q "alter policy \"studio members can view marketing unsubscribes\" on public.marketing_unsubscribes using (public.user_has_studio_access(studio_id));" >/dev/null

# 3. visibility policy missing
q "drop policy \"studio members can view marketing campaign recipients\" on public.marketing_campaign_recipients;" >/dev/null
apply_expect_refusal "missing visibility policy"
q "create policy \"studio members can view marketing campaign recipients\" on public.marketing_campaign_recipients for select using (public.user_has_studio_access(studio_id));" >/dev/null

# 4. unexpected dispatcher claim function (a comment changes the body)
ORIG=$(q "select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc where oid = 'public.claim_outbound_deliveries(uuid,integer,integer)'::regprocedure")
q "do \$\$ declare v text; begin select pg_get_functiondef('public.claim_outbound_deliveries(uuid,integer,integer)'::regprocedure) into v; execute replace(v, 'begin', E'begin\n  -- tamper'); end \$\$;" >/dev/null
check "tamper changed the claim function" "$( [ "$(q "select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc where oid = 'public.claim_outbound_deliveries(uuid,integer,integer)'::regprocedure")" != "$ORIG" ] && echo yes || echo no)" "yes"
apply_expect_refusal "unexpected claim function"
q "do \$\$ declare v text; begin select pg_get_functiondef('public.claim_outbound_deliveries(uuid,integer,integer)'::regprocedure) into v; execute replace(v, E'begin\n  -- tamper', 'begin'); end \$\$;" >/dev/null
check "claim function restored" "$(q "select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc where oid = 'public.claim_outbound_deliveries(uuid,integer,integer)'::regprocedure")" "$ORIG"

check "pre-M-0 fingerprint unchanged after all tampering" "$(fp)" "$PRE"

# Control: the untampered state applies.
out=$($PSQL -v ON_ERROR_STOP=1 < "$MIG" 2>&1)
check "control: untampered pre-M-0 state applies" "$(q "select to_regproc('public.marketing_send_frozen') is not null")" "t"
check "control: lands frozen" "$(q "select frozen from public.marketing_send_controls")" "t"

echo "M-0 PRECONDITIONS: $pass passed, $fail failed"
[ "$fail" = "0" ]
