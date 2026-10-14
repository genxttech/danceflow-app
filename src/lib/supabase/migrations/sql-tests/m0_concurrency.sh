#!/usr/bin/env bash
# Marketing M-0 -- multi-session concurrency tests (run against an ISOLATED QA database only).
#
# Usage: PSQL="docker exec -i supabase_db_danceflow-e2e-qa psql -U postgres -v ON_ERROR_STOP=1 -qAt" \
#        bash src/lib/supabase/migrations/sql-tests/m0_concurrency.sh
#
# Fixtures are committed (both sessions must see them) under the UUID block ...0000ae9XXXXX and removed at the end.
# Each race holds a lock in session A (pg_sleep inside its transaction) while session B starts the competing call.
set -euo pipefail
: "${PSQL:?set PSQL to a psql command for the isolated QA database}"

q() { $PSQL -c "$1"; }
pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi
}

guard=$(q "select count(*) from auth.users where email not like '%@e2e.test' and email not like '%@example.%'")
if [ "$guard" != "0" ]; then
  echo "refusing: database contains non-test accounts"
  exit 2
fi

STUDIO=00000000-0000-0000-0000-0000ae900001
ORG=00000000-0000-0000-0000-0000ae900101
CAMP=00000000-0000-0000-0000-0000ae900401
CAMP2=00000000-0000-0000-0000-0000ae900402
OCAMP=00000000-0000-0000-0000-0000ae900404

# Stage 1 lands with marketing sends frozen; the races run unfrozen and the previous freeze state is restored after.
WAS_FROZEN=$(q "select public.marketing_send_frozen()")
cleanup() {
  q "select public.marketing_set_send_freeze($( [ "$WAS_FROZEN" = "t" ] && echo true || echo false ), 'm0_concurrency.sh: restore');" >/dev/null
  q "delete from public.marketing_test_sends where scope_id in ('$STUDIO', '$ORG');
     delete from public.marketing_campaigns where id in ('$CAMP', '$CAMP2');
     delete from public.organizer_marketing_campaigns where id = '$OCAMP';
     delete from public.marketing_unsubscribes where studio_id = '$STUDIO';
     delete from public.organizer_marketing_unsubscribes where organizer_id = '$ORG';
     delete from public.organizer_contacts where organizer_id = '$ORG';
     delete from public.marketing_email_suppressions where email like 'm0conc-%';
     delete from public.organizers where id = '$ORG';
     delete from public.studios where id = '$STUDIO';" >/dev/null
}
trap cleanup EXIT
cleanup
q "select public.marketing_set_send_freeze(false, 'm0_concurrency.sh: run');" >/dev/null

q "insert into public.studios (id, name, slug) values ('$STUDIO', 'M0 Conc', 'm0-conc-studio');
   insert into public.organizers (id, name, slug) values ('$ORG', 'M0 Conc Org', 'm0-conc-org');
   insert into public.marketing_campaigns (id, studio_id, name, subject, body_text, status, audience_type) values
     ('$CAMP', '$STUDIO', 'C', 'S', 'B', 'draft', 'manual'), ('$CAMP2', '$STUDIO', 'C2', 'S', 'B', 'draft', 'manual');
   insert into public.organizer_marketing_campaigns (id, organizer_id, name, subject, body_text, status) values ('$OCAMP', '$ORG', 'O', 'S', 'B', 'draft');" >/dev/null

sync_studio() { # campaign, emails... -> outcome
  local camp=$1; shift
  local arr="["; local first=1
  for e in "$@"; do if [ $first -eq 0 ]; then arr="$arr,"; fi; arr="$arr{\"email\":\"$e\"}"; first=0; done
  arr="$arr]"
  q "select public.marketing_sync_campaign_recipients('studio', '$STUDIO', '$camp', '$arr'::jsonb) ->> 'outcome';"
}
rid() { q "select id from public.marketing_campaign_recipients where campaign_id = '$1' and email = '$2';"; }
tok() { q "select unsubscribe_token from public.marketing_campaign_recipients where campaign_id = '$1' and email = '$2';"; }
claim() { $PSQL -c "select public.marketing_claim_campaign_recipient('studio', '$STUDIO', '$1', '$2', 600) ->> 'outcome';" | tail -1; }

sync_studio "$CAMP" m0conc-1@example.com m0conc-2@example.com m0conc-3@example.com m0conc-4@example.com m0conc-5@example.com >/dev/null
sync_studio "$CAMP2" m0conc-1@example.com m0conc-3@example.com >/dev/null

# ---- 1. Unsubscribe commits first (A holds the email lock), the claim waits and then sees it: never sent.
R1=$(rid "$CAMP" m0conc-1@example.com)
T1=$(tok "$CAMP2" m0conc-1@example.com)
( $PSQL -c "begin; select public.marketing_unsubscribe_by_token('$T1', 'one_click') ->> 'ok'; select pg_sleep(2); commit;" > /tmp/m0_a1.out 2>&1 || true ) &
sleep 0.7
B=$(claim "$CAMP" "$R1")
wait
check "unsubscribe then claim: the claim waited and found the row already unsubscribed" "$B" "not_claimable"
check "unsubscribe then claim: recipient never claimed" "$(q "select status || ':' || attempt_count from public.marketing_campaign_recipients where id = '$R1'")" "unsubscribed:0"

# ---- 2. Claim commits first (A holds the row + email lock), the unsubscribe waits; the in-flight claim stands, every
#         other pending row of that address is suppressed.
R2=$(rid "$CAMP" m0conc-3@example.com)
T2=$(tok "$CAMP" m0conc-3@example.com)
( $PSQL -c "begin; select public.marketing_claim_campaign_recipient('studio', '$STUDIO', '$CAMP', '$R2', 600) ->> 'outcome'; select pg_sleep(2); commit;" > /tmp/m0_a2.out 2>&1 || true ) &
sleep 0.7
U=$($PSQL -c "select public.marketing_unsubscribe_by_token('$T2', 'one_click') ->> 'ok';" | tail -1)
wait
check "claim then unsubscribe: the claim succeeded first" "$(grep -E 'claimed|unsubscribed' /tmp/m0_a2.out | head -1)" "claimed"
check "claim then unsubscribe: unsubscribe recorded after waiting" "$U" "true"
check "claim then unsubscribe: in-flight claim is not rewritten" "$(q "select status from public.marketing_campaign_recipients where id = '$R2'")" "sending"
check "claim then unsubscribe: the other campaign's pending row is suppressed" "$(q "select status from public.marketing_campaign_recipients where campaign_id = '$CAMP2' and email = 'm0conc-3@example.com'")" "unsubscribed"

# ---- 3. Two senders claim the same recipient at once: exactly one claim.
R3=$(rid "$CAMP" m0conc-4@example.com)
( $PSQL -c "begin; select public.marketing_claim_campaign_recipient('studio', '$STUDIO', '$CAMP', '$R3', 600) ->> 'outcome'; select pg_sleep(2); commit;" > /tmp/m0_a3.out 2>&1 || true ) &
sleep 0.7
B3=$(claim "$CAMP" "$R3")
wait
check "double claim: first session claims" "$(grep -E 'claimed|in_flight' /tmp/m0_a3.out | head -1)" "claimed"
check "double claim: second session sees in_flight" "$B3" "in_flight"
check "double claim: one attempt recorded" "$(q "select attempt_count from public.marketing_campaign_recipients where id = '$R3'")" "1"

# ---- 4. Regeneration racing a claim: the claimed row survives, regeneration then refuses while it is in flight.
R5=$(rid "$CAMP" m0conc-5@example.com)
( $PSQL -c "begin; select public.marketing_claim_campaign_recipient('studio', '$STUDIO', '$CAMP', '$R5', 600) ->> 'outcome'; select pg_sleep(2); commit;" > /tmp/m0_a4.out 2>&1 || true ) &
sleep 0.7
S4=$(sync_studio "$CAMP" m0conc-9@example.com | tail -1)
wait
check "sync vs claim: the claimed row is not deleted" "$(q "select count(*) from public.marketing_campaign_recipients where id = '$R5'")" "1"
check "sync vs claim: claimed row still sending" "$(q "select status from public.marketing_campaign_recipients where id = '$R5'")" "sending"
check "sync vs claim: sync either completed around it or refused" "$( [ "$S4" = "synced" ] || [ "$S4" = "delivery_in_progress" ] && echo ok || echo "$S4")" "ok"
check "sync after claim committed: refused while a recipient is in flight" "$(sync_studio "$CAMP" m0conc-9@example.com | tail -1)" "delivery_in_progress"

# ---- 5. Two unsubscribes of the same address at once: one record, both counted.
q "insert into public.organizer_contacts (organizer_id, email, status) values ('$ORG', 'm0conc-o@example.com', 'active');" >/dev/null
q "select public.marketing_sync_campaign_recipients('organizer', '$ORG', '$OCAMP', '[{\"email\":\"m0conc-o@example.com\"}]'::jsonb);" >/dev/null
OT=$(q "select unsubscribe_token from public.organizer_marketing_campaign_recipients where campaign_id = '$OCAMP' and email = 'm0conc-o@example.com'")
( $PSQL -c "begin; select public.marketing_unsubscribe_by_token('$OT', 'one_click') ->> 'ok'; select pg_sleep(2); commit;" > /tmp/m0_a5.out 2>&1 || true ) &
sleep 0.7
B5=$($PSQL -c "select public.marketing_unsubscribe_by_token('$OT', 'page_form') ->> 'ok';" | tail -1)
wait
check "concurrent organizer unsubscribes: both ok" "$(grep -E 'true|false' /tmp/m0_a5.out | head -1)/$B5" "true/true"
check "concurrent organizer unsubscribes: one record, two requests" "$(q "select count(*) || ':' || max(request_count) from public.organizer_marketing_unsubscribes where organizer_id = '$ORG' and email = 'm0conc-o@example.com'")" "1:2"
check "concurrent organizer unsubscribes: contact unsubscribed" "$(q "select status from public.organizer_contacts where organizer_id = '$ORG' and email = 'm0conc-o@example.com'")" "unsubscribed"

# ---- 6. Test-send rate limit under concurrency: exactly the limit is allowed.
q "insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-0000ae900201', 'm0conc-staff@example.com', now()) on conflict (id) do nothing;
   insert into public.profiles (id, email) values ('00000000-0000-0000-0000-0000ae900201', 'm0conc-staff@example.com') on conflict (id) do nothing;
   insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-0000ae900201', '$STUDIO', 'studio_owner', true);" >/dev/null
for i in 1 2 3 4 5 6; do
  ( $PSQL -c "select public.marketing_authorize_test_send('studio', '$STUDIO', '$CAMP', '00000000-0000-0000-0000-0000ae900201', 'm0conc-staff@example.com', 3) ->> 'allowed';" > /tmp/m0_t$i.out 2>&1 || true ) &
done
wait
ALLOWED=$(cat /tmp/m0_t1.out /tmp/m0_t2.out /tmp/m0_t3.out /tmp/m0_t4.out /tmp/m0_t5.out /tmp/m0_t6.out | grep -c '^true$' || true)
check "concurrent test sends: exactly the hourly limit allowed" "$ALLOWED" "3"
check "concurrent test sends: exactly the limit recorded" "$(q "select count(*) from public.marketing_test_sends where scope_id = '$STUDIO'")" "3"
q "delete from public.user_studio_roles where user_id = '00000000-0000-0000-0000-0000ae900201'; delete from public.profiles where id = '00000000-0000-0000-0000-0000ae900201'; delete from auth.users where id = '00000000-0000-0000-0000-0000ae900201';" >/dev/null

# ---- 7. Completion racing a re-claim of an expired lease: only the current claim holder can complete.
R7=$(q "select id from public.marketing_campaign_recipients where campaign_id = '$CAMP2' and status = 'pending' limit 1")
if [ -z "$R7" ]; then sync_studio "$CAMP2" m0conc-7@example.com >/dev/null; R7=$(rid "$CAMP2" m0conc-7@example.com); fi
C1=$(q "select public.marketing_claim_campaign_recipient('studio', '$STUDIO', '$CAMP2', '$R7', 600) ->> 'claim_id';")
q "update public.marketing_campaign_recipients set claim_expires_at = now() - interval '1 second' where id = '$R7';" >/dev/null
C2=$(q "select public.marketing_claim_campaign_recipient('studio', '$STUDIO', '$CAMP2', '$R7', 600) ->> 'claim_id';")
check "stale completion: the old claim cannot complete" "$(q "select public.marketing_complete_campaign_recipient('studio', '$STUDIO', '$R7', '$C1', 'sent', 'old', null) ->> 'outcome';")" "stale"
check "stale completion: the current claim completes" "$(q "select public.marketing_complete_campaign_recipient('studio', '$STUDIO', '$R7', '$C2', 'sent', 'new', null) ->> 'outcome';")" "sent"
check "stale completion: evidence from the current claim" "$(q "select provider_message_id || ':' || attempt_count from public.marketing_campaign_recipients where id = '$R7'")" "new:2"

# ---- 8. Unsubscribe recorded but its transaction has not reached the recipient rows yet (the window between the
# unsubscribe record insert and the pending-row update inside marketing_unsubscribe_by_token). Session A reproduces that
# state exactly: the per-email lock, then the record, then a pause before commit. The claim must wait on the email lock
# and then see the unsubscribe; the recipient row lock alone would not stop it.
R8=$(rid "$CAMP" m0conc-2@example.com)
( $PSQL -c "begin; select public._mkt_lock_email('m0conc-2@example.com'); insert into public.marketing_unsubscribes (studio_id, email, reason) values ('$STUDIO', 'm0conc-2@example.com', 'm0-conc-window'); select pg_sleep(2); commit;" > /tmp/m0_a8.out 2>&1 || true ) &
sleep 0.7
B8=$(claim "$CAMP" "$R8")
wait
check "unsubscribe window: the claim waited for the unsubscribe and refused" "$B8" "unsubscribed"
check "unsubscribe window: recipient never claimed" "$(q "select attempt_count from public.marketing_campaign_recipients where id = '$R8'")" "0"

# ---- 9. Legacy organizer page (pre-M-0 app, service role) and an M-0 one-click unsubscribe for the same address race:
# both are recorded once, with both requests counted; the address's pending rows end unsubscribed.
q "select public.marketing_sync_campaign_recipients('organizer', '$ORG', '$OCAMP', '[{\"email\":\"m0conc-o@example.com\"},{\"email\":\"m0conc-lg@example.com\"}]'::jsonb);" >/dev/null
LG=$(q "select id from public.organizer_marketing_campaign_recipients where campaign_id = '$OCAMP' and email = 'm0conc-lg@example.com'")
LGT=$(q "select unsubscribe_token from public.organizer_marketing_campaign_recipients where id = '$LG'")
( $PSQL -c "begin; set local role service_role; update public.organizer_marketing_campaign_recipients set status = 'unsubscribed', error_message = 'Recipient unsubscribed from organizer marketing' where id = '$LG'; select pg_sleep(2); commit;" > /tmp/m0_a9.out 2>&1 || true ) &
sleep 0.7
B9=$($PSQL -c "select public.marketing_unsubscribe_by_token('$LGT', 'one_click') ->> 'ok';" | tail -1)
wait
check "legacy page vs one-click: both recorded" "$B9/$(grep -c ERROR /tmp/m0_a9.out)" "true/0"
check "legacy page vs one-click: exactly one organizer record, both requests counted" "$(q "select count(*) || ':' || max(request_count) from public.organizer_marketing_unsubscribes where organizer_id = '$ORG' and email = 'm0conc-lg@example.com'")" "1:2"

echo "M-0 CONCURRENCY: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
