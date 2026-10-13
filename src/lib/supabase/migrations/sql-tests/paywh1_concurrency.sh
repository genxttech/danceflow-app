#!/usr/bin/env bash
# PAY-WH-1 -- multi-session concurrency tests (run against an ISOLATED QA database only).
#
# Usage: PSQL="docker exec -i supabase_db_danceflow-e2e-qa psql -U postgres -v ON_ERROR_STOP=1 -qAt" \
#        bash src/lib/supabase/migrations/sql-tests/paywh1_concurrency.sh
#
# Fixtures are committed (both sessions must see them) under studio slug 'paywh1-conc-*' and removed at the end.
# Each race holds a row lock in session A (pg_sleep inside its transaction) while session B starts the competing call.
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

STUDIO=00000000-0000-0000-0000-00c0c0000101
EVENT=00000000-0000-0000-0000-00c0c0000201
TICKET=00000000-0000-0000-0000-00c0c0000301
ACCT=acct_paywh1conc

cleanup() {
  q "delete from public.event_settlement_outbox where studio_id = '$STUDIO';
     delete from public.event_order_settlement_exceptions where studio_id = '$STUDIO';
     delete from public.event_payments where registration_id in (select id from public.event_registrations where event_id = '$EVENT');
     delete from public.notifications where studio_id = '$STUDIO';
     update public.event_registrations set client_id = null where event_id = '$EVENT';
     delete from public.clients where studio_id = '$STUDIO';
     delete from public.event_orders where event_id = '$EVENT';
     delete from public.events where id = '$EVENT';
     delete from public.studios where id = '$STUDIO';
     delete from public.payment_provider_events where provider_event_id like 'evt_paywh1conc_%';" >/dev/null
}
trap cleanup EXIT
cleanup

q "insert into public.studios (id, name, slug, stripe_connected_account_id) values ('$STUDIO', 'PAYWH1 Conc', 'paywh1-conc-studio', '$ACCT');
   insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone)
     values ('$EVENT', '$STUDIO', 'PAYWH1 Conc', 'paywh1-conc-event', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago');
   insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket)
     values ('$TICKET', '$EVENT', 'Capped', 30, 'USD', 1, true, 1);" >/dev/null

mk_order() { # key -> order id (1 ticket, session attempt cs_conc_<key>)
  q "with o as (
       insert into public.event_orders (event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, expires_at, metadata)
       values ('$EVENT', '$STUDIO', 'Conc', 'paywh1-conc-$1@example.com', 30, 30, 'USD', 'pending', 'pending', now() + interval '30 minutes', '{\"source\":\"event_cart_v1\"}')
       returning id),
     r as (
       insert into public.event_registrations (order_id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
       select o.id, '$EVENT', '$TICKET', '$STUDIO', 'pending', 'pending', 1, 30, 30, 'USD', 'public_event_page', 'Conc', '$1', 'paywh1-conc-$1@example.com' from o
       returning id)
     insert into public.event_registration_attendees (registration_id, event_id, ticket_type_id, first_name, last_name, sort_order)
     select r.id, '$EVENT', '$TICKET', 'Conc', '$1', 1 from r
     returning (select id from o);" | head -1
}

# ---- 1. Two deliveries settle the same order at once: exactly one settlement, one payment row, stable paid_at.
O1=$(mk_order s1)
q "select public.record_event_cart_payment_attempt('$O1', '$ACCT', 'checkout_session', 'cs_conc_s1', null, 3000, 'usd', 'web', null);" >/dev/null
( $PSQL -c "begin; select public.settle_event_cart_order('reconcile', null, null, '$ACCT', 'cs_conc_s1', 'pi_conc_s1', 3000, 'usd') ->> 'outcome'; select pg_sleep(2); commit;" > /tmp/paywh1_a.out 2>&1 || true ) &
sleep 0.7
B=$($PSQL -c "select public.settle_event_cart_order('reconcile', null, null, '$ACCT', 'cs_conc_s1', 'pi_conc_s1', 3000, 'usd') ->> 'outcome';" | tail -1)
wait
A=$(grep -E "settled|already" /tmp/paywh1_a.out | head -1)
check "concurrent settle: first session settles" "$A" "settled"
check "concurrent settle: second session waits, then already_settled" "$B" "already_settled"
check "concurrent settle: one payment row" "$(q "select count(*) from public.event_payments p join public.event_registrations r on r.id = p.registration_id where r.order_id = '$O1'")" "1"
check "concurrent settle: one outbox set" "$(q "select count(*) from public.event_settlement_outbox where order_id = '$O1'")" "4"

# ---- 2. Release racing settlement (release holds the lock first): payment still wins, nothing is freed twice.
# capacity is 1 and O1 holds (now: owns) it -> a second buyer's registration is refused by the capacity trigger
O2=$(mk_order r1 2>/dev/null || true)
check "capacity: second buyer refused once the only seat is taken" "$(q "select count(*) from public.event_registrations where event_id = '$EVENT' and attendee_last_name = 'r1'")" "0"
q "update public.event_ticket_types set capacity = 10 where id = '$TICKET';" >/dev/null
O3=$(mk_order r2)
q "select public.record_event_cart_payment_attempt('$O3', '$ACCT', 'checkout_session', 'cs_conc_r2', null, 3000, 'usd', 'web', null);" >/dev/null
( $PSQL -c "begin; select public.begin_event_cart_order_release('$O3', 'race') ->> 'outcome'; select pg_sleep(2); commit;" > /tmp/paywh1_c.out 2>&1 || true ) &
sleep 0.7
S=$($PSQL -c "select public.settle_event_cart_order('reconcile', null, null, '$ACCT', 'cs_conc_r2', 'pi_conc_r2', 3000, 'usd') ->> 'outcome';" | tail -1)
wait
F=$(q "select public.finalize_event_cart_order_release('$O3', (select jsonb_agg(jsonb_build_object('attempt_id', id, 'stripe_state', 'closed')) from public.event_order_payment_attempts where order_id = '$O3')) ->> 'outcome'")
check "release race: settlement after 'releasing' wins" "$S" "settled"
check "release race: finalize sees the payment, frees nothing" "$F" "already_paid"
check "release race: registration stays confirmed" "$(q "select status from public.event_registrations where order_id = '$O3'")" "confirmed"

# ---- 3. Concurrent claims of one webhook event: one owner.
q "select public.claim_payment_provider_event('stripe', 'evt_paywh1conc_1', 't', 'h', gen_random_uuid(), 60) ->> 'outcome'" > /tmp/paywh1_c1.out &
q "select public.claim_payment_provider_event('stripe', 'evt_paywh1conc_1', 't', 'h', gen_random_uuid(), 60) ->> 'outcome'" > /tmp/paywh1_c2.out
wait
CLAIMS=$(cat /tmp/paywh1_c1.out /tmp/paywh1_c2.out | sort | tr '
' ' ' | sed 's/ $//')
OWNERS=$(q "select count(*) from public.payment_provider_events where provider_event_id = 'evt_paywh1conc_1' and status = 'processing' and claim_owner is not null")
check "concurrent claim: exactly one live owner" "$OWNERS" "1"
check "concurrent claim: one claimed, one in_progress" "$CLAIMS" "claimed in_progress"

# ---- 4. Two outbox workers drain at once: disjoint claims.
( $PSQL -c "begin; select count(*) from public.claim_event_settlement_outbox(gen_random_uuid(), 100, 60, '$O1'); select pg_sleep(2); commit;" > /tmp/paywh1_w.out 2>&1 || true ) &
sleep 0.7
W2=$(q "select count(*) from public.claim_event_settlement_outbox(gen_random_uuid(), 100, 60, '$O1')")
wait
W1=$(grep -E '^[0-9]+$' /tmp/paywh1_w.out | head -1)
check "concurrent outbox: first worker claims all due effects" "$W1" "4"
check "concurrent outbox: second worker skips locked rows" "$W2" "0"

# ---- 5. Concurrent lead captures for the same studio + email create one client.
R1=$(q "select id from public.event_registrations where order_id = '$O1'")
q "select public.capture_event_registration_lead('$R1');" >/dev/null &
q "select public.capture_event_registration_lead('$R1');" >/dev/null
wait
check "concurrent lead capture: one client" "$(q "select count(*) from public.clients where studio_id = '$STUDIO'")" "1"
check "concurrent lead capture: one notification" "$(q "select count(*) from public.notifications where studio_id = '$STUDIO'")" "1"

echo "PAY-WH-1 CONCURRENCY: $pass passed, $fail failed"
[ "$fail" = "0" ]
