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
#   4. claim_outbound_deliveries not the PAY-WH-1 version;
#   4b. drift on any of the seven tables: RLS disabled, RLS forced, an unknown policy on another table, changed policy
#       roles, an unknown policy whose name merely looks like an M-0 policy, and a NARROWER privilege (drift in either
#       direction refuses);
#   5. the stage-1 rollback run while stage 2 is still applied;
#   6. the stage-1 rollback while unfrozen, after M-0 handed a recipient to the provider, with a per-message token, and
#      with the removed override set (no override exists).
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

# 4b. drift on the other affected tables
q "alter table public.organizer_marketing_unsubscribes disable row level security;" >/dev/null
apply_expect_refusal "RLS disabled on organizer unsubscribes"
q "alter table public.organizer_marketing_unsubscribes enable row level security;" >/dev/null
q "alter table public.outbound_deliveries force row level security;" >/dev/null
apply_expect_refusal "RLS forced on outbound_deliveries"
q "alter table public.outbound_deliveries no force row level security;" >/dev/null
q "create policy \"tamper org campaigns\" on public.organizer_marketing_campaigns for select to authenticated using (true);" >/dev/null
apply_expect_refusal "unknown policy on organizer campaigns"
q "drop policy \"tamper org campaigns\" on public.organizer_marketing_campaigns;" >/dev/null
q "alter policy \"outbound_deliveries_insert\" on public.outbound_deliveries to authenticated, anon;" >/dev/null
apply_expect_refusal "changed policy roles on outbound_deliveries"
q "alter policy \"outbound_deliveries_insert\" on public.outbound_deliveries to authenticated;" >/dev/null
q "create policy \"m0 tamper lookalike\" on public.marketing_unsubscribes for select to authenticated using (true);" >/dev/null
apply_expect_refusal "unknown policy with an M-0-like name"
q "drop policy \"m0 tamper lookalike\" on public.marketing_unsubscribes;" >/dev/null
q "revoke select on public.marketing_campaigns from anon;" >/dev/null
apply_expect_refusal "narrower privilege on studio campaigns"
q "grant select on public.marketing_campaigns to anon;" >/dev/null

check "pre-M-0 fingerprint unchanged after all tampering" "$(fp)" "$PRE"

# Control: the untampered state applies.
out=$($PSQL -v ON_ERROR_STOP=1 < "$MIG" 2>&1)
check "control: untampered pre-M-0 state applies" "$(q "select to_regproc('public.marketing_send_frozen') is not null")" "t"
check "control: lands frozen" "$(q "select frozen from public.marketing_send_controls")" "t"

# 5. The stage-1 rollback refuses while stage 2 is applied (stage 2 must be rolled back first), changing nothing.
STAGE2="$DIR/../20261117091000_m0_recipient_write_lockdown.sql"
RB1="$DIR/../rollback/20261117090000_m0_marketing_send_integrity_rollback.sql"
RB2="$DIR/../rollback/20261117091000_m0_recipient_write_lockdown_rollback.sql"
$PSQL -v ON_ERROR_STOP=1 < "$STAGE2" >/dev/null 2>&1
S2FP=$(fp)
out=$($PSQL -v ON_ERROR_STOP=1 < "$RB1" 2>&1)
if echo "$out" | grep -q "roll back 20261117091000 (stage 2) first"; then check "stage-1 rollback refused while stage 2 is applied" "refused" "refused"; else check "stage-1 rollback refused while stage 2 is applied" "ran" "refused"; fi
check "stage-1 rollback refusal changed nothing" "$(fp)" "$S2FP"
$PSQL -v ON_ERROR_STOP=1 < "$RB2" >/dev/null 2>&1

# 6. Stage-1 rollback refuses while anything depends on M-0 (stage 1 is applied and frozen here); there is no override.
rb1_expect() { # name, expected message fragment
  local out before
  before=$(fp)
  out=$($PSQL -v ON_ERROR_STOP=1 < "$RB1" 2>&1)
  if echo "$out" | grep -q "$2"; then check "$1: stage-1 rollback refused" "refused" "refused"; else check "$1: stage-1 rollback refused" "ran: $(echo "$out" | grep -m1 ERROR)" "refused"; fi
  check "$1: refusal changed nothing" "$(fp)" "$before"
}
q "select public.marketing_set_send_freeze(false, 'precondition tests: unfrozen probe');" >/dev/null
rb1_expect "unfrozen" "must be frozen first"
q "select public.marketing_set_send_freeze(true, 'precondition tests: refreeze');" >/dev/null
q "insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-0000ae950001', 'M0 RB Studio', 'm0-rb-studio');
   insert into public.marketing_campaigns (id, studio_id, name, subject, body_text, status, audience_type)
     values ('00000000-0000-0000-0000-0000ae950401', '00000000-0000-0000-0000-0000ae950001', 'RB', 'S', 'B', 'draft', 'manual');
   insert into public.marketing_campaign_recipients (campaign_id, studio_id, email, status, unsubscribe_token, first_attempt_at, attempt_count, sent_at)
     values ('00000000-0000-0000-0000-0000ae950401', '00000000-0000-0000-0000-0000ae950001', 'm0-rb@example.com', 'sent', gen_random_uuid()::text, now(), 1, now());" >/dev/null
rb1_expect "recipient handed to the provider by M-0" "recipients-mailed-by-m0"
out=$( { echo "set m0.allow_data_loss = 'yes';"; cat "$RB1"; } | $PSQL -v ON_ERROR_STOP=1 2>&1 || true)
check "the removed override does not bypass the refusal" "$(echo "$out" | grep -c 'recipients-mailed-by-m0')" "1"
q "delete from public.marketing_campaigns where id = '00000000-0000-0000-0000-0000ae950401';" >/dev/null
q "select public.marketing_issue_message_unsubscribe_token('studio', '00000000-0000-0000-0000-0000ae950001', 'm0-rb@example.com', 'outbound_deliveries', gen_random_uuid());" >/dev/null
rb1_expect "issued per-message token" "message-tokens"
q "delete from public.marketing_message_unsubscribe_tokens where studio_id = '00000000-0000-0000-0000-0000ae950001';
   delete from public.studios where id = '00000000-0000-0000-0000-0000ae950001';" >/dev/null
q "delete from public.marketing_send_control_events where reason like 'precondition tests:%';" >/dev/null

echo "M-0 PRECONDITIONS: $pass passed, $fail failed"
[ "$fail" = "0" ]
