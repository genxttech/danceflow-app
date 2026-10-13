#!/usr/bin/env bash
# PAY-WH-1A -- multi-session concurrency tests for 20261116094000 (run against an ISOLATED QA database only).
#
# Usage: PSQL="docker exec -i supabase_db_danceflow-e2e-qa psql -U postgres -v ON_ERROR_STOP=1 -qAt" \
#        bash src/lib/supabase/migrations/sql-tests/paywh1a_concurrency.sh
#
# Fixtures are committed (both sessions must see them) under studio slug 'paywh1a-conc-*' and removed at the end.
# Each race holds the contended lock in session A (pg_sleep inside its transaction) while session B starts.
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

STUDIO=00000000-0000-0000-0000-00c0ca000101
EVENT=00000000-0000-0000-0000-00c0ca000201
COMP=00000000-0000-0000-0000-00c0ca000202
CAP1=00000000-0000-0000-0000-00c0ca000301
OPEN=00000000-0000-0000-0000-00c0ca000302
OWNER=00000000-0000-0000-0000-00c0ca000001
SESSION=00000000-0000-0000-0000-00c0ca000501
ACCT=acct_paywh1aconc
TMP=$(mktemp -d)

cleanup() {
  q "delete from public.event_competition_checkin_payment_audit where event_id in ('$EVENT', '$COMP');
     delete from public.event_competition_checkin_sessions where event_id in ('$EVENT', '$COMP');
     delete from public.event_order_settlement_exceptions where studio_id = '$STUDIO';
     delete from public.event_payments where registration_id in (select id from public.event_registrations where event_id in ('$EVENT', '$COMP'));
     delete from public.event_registration_attendees where event_id in ('$EVENT', '$COMP');
     delete from public.event_registrations where event_id in ('$EVENT', '$COMP');
     delete from public.event_orders where event_id in ('$EVENT', '$COMP');
     delete from public.events where id in ('$EVENT', '$COMP');
     delete from public.user_studio_roles where studio_id = '$STUDIO';
     delete from public.studios where id = '$STUDIO';
     delete from public.profiles where id = '$OWNER';
     delete from auth.users where id = '$OWNER';" >/dev/null
}
trap 'cleanup; rm -rf "$TMP"' EXIT
cleanup

q "insert into auth.users (id, email, instance_id, aud, role) values ('$OWNER', 'paywh1a-conc-owner@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
   insert into public.profiles (id, email, full_name) values ('$OWNER', 'paywh1a-conc-owner@e2e.test', 'Conc Owner') on conflict (id) do nothing;
   insert into public.studios (id, name, slug, stripe_connected_account_id) values ('$STUDIO', 'PAYWH1A Conc', 'paywh1a-conc-studio', '$ACCT');
   insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$OWNER', '$STUDIO', 'studio_owner', true);
   insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
     ('$EVENT', '$STUDIO', 'PAYWH1A Conc', 'paywh1a-conc-event', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago'),
     ('$COMP', '$STUDIO', 'PAYWH1A Conc Comp', 'paywh1a-conc-comp', 'competition', 'published', 'public', '2027-06-06', '2027-06-06', 'America/Chicago');
   insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket) values
     ('$CAP1', '$EVENT', 'Cap1', 20, 'USD', 1, true, 1),
     ('$OPEN', '$EVENT', 'Open', 20, 'USD', null, true, 2);" >/dev/null

box_sql() { # key -> insert of an orderless card-reader sale holding the last ticket
  echo "insert into public.event_registrations (event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email, terminal_hold_until)
        values ('$EVENT', '$CAP1', '$STUDIO', 'pending', 'pending', 1, 20, 20, 'USD', 'admin', 'Box', '$1', 'paywh1a-conc-$1@example.com', now() + interval '15 minutes') returning id"
}

# ---- 1. Two card readers sell the last ticket at the same time: exactly one sale holds it.
( $PSQL -c "begin; $(box_sql a); select pg_sleep(2); commit;" > "$TMP/a.out" 2>&1 || true ) &
sleep 0.7
B=$($PSQL -c "$(box_sql b);" 2>&1 || true)
wait
check "concurrent box office: first sale holds the ticket" "$(grep -cE '^[0-9a-f-]{36}$' "$TMP/a.out")" "1"
check "concurrent box office: second sale waits, then is refused" "$(echo "$B" | grep -c 'no longer available')" "1"
check "concurrent box office: one held sale in the database" "$(q "select count(*) from public.event_registrations where ticket_type_id = '$CAP1' and status = 'pending'")" "1"
HELD=$(q "select id from public.event_registrations where ticket_type_id = '$CAP1' and status = 'pending'")

# ---- 2. The terminal webhook and the staff refresh confirm the same charge at once: one confirmation, no exception.
CONFIRM="select public.confirm_terminal_event_registration('$STUDIO', '00000000-0000-0000-0000-00c0ca00a001', '$HELD', 'pi_conc_term', 2000, 'usd', '$ACCT') ->> 'outcome'"
( $PSQL -c "begin; $CONFIRM; select pg_sleep(2); commit;" > "$TMP/c.out" 2>&1 || true ) &
sleep 0.7
D=$($PSQL -c "$CONFIRM;" | tail -1)
wait
check "concurrent terminal confirm: first confirms" "$(grep -cE '^confirmed$' "$TMP/c.out")" "1"
check "concurrent terminal confirm: second is idempotent" "$D" "already_confirmed"
check "concurrent terminal confirm: no exception recorded" "$(q "select count(*) from public.event_order_settlement_exceptions where studio_id = '$STUDIO'")" "0"

# ---- 3. Two desk staff collect the remaining balance at once: the second is refused (no over-collection).
q "with o as (insert into public.event_orders (event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, expires_at, metadata)
              values ('$COMP', '$STUDIO', 'Conc', 'paywh1a-conc-comp@example.com', 100, 100, 'USD', 'pending', 'pending', now() + interval '30 days', '{\"source\":\"competition_registration\"}') returning id),
        r as (insert into public.event_registrations (order_id, event_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
              select o.id, '$COMP', '$STUDIO', 'pending', 'pending', 1, 100, 100, 'USD', 'public_event_page', 'Conc', 'Comp', 'paywh1a-conc-comp@example.com' from o returning id, order_id)
   insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, balance_due, currency)
   select '$SESSION', '$COMP', r.id, r.order_id, 'in_progress', 100, 'USD' from r;" >/dev/null
DESK="set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', true);
      select public.record_competition_checkin_payment('$COMP', '$SESSION', 60, 'cash', null) ->> 'outcome'"
( $PSQL -c "begin; $DESK; select pg_sleep(2); commit;" > "$TMP/d.out" 2>&1 || true ) &
sleep 0.7
E=$($PSQL -c "begin; $DESK; commit;" 2>&1 || true)
wait
check "concurrent desk payments: first is recorded" "$(grep -cE '^recorded$' "$TMP/d.out")" "1"
check "concurrent desk payments: second waits, then is refused" "$(echo "$E" | grep -c 'exceeds the current balance')" "1"
check "concurrent desk payments: total collected never exceeds the order" "$(q "select coalesce(sum(amount), 0)::int from public.event_payments p join public.event_registrations r on r.id = p.registration_id where r.event_id = '$COMP'")" "60"

# ---- 4. Two staff add the last paid-for ticket at the same time: the entitlement is never exceeded.
PAID=$(q "with o as (insert into public.event_orders (event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, paid_at, metadata)
                     values ('$EVENT', '$STUDIO', 'Conc', 'paywh1a-conc-paid@example.com', 20, 20, 'USD', 'confirmed', 'paid', now(), '{\"source\":\"event_cart_v1\"}') returning id)
          insert into public.event_registrations (order_id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
          select o.id, '$EVENT', '$OPEN', '$STUDIO', 'confirmed', 'paid', 1, 20, 20, 'USD', 'public_event_page', 'Conc', 'Paid', 'paywh1a-conc-paid@example.com' from o returning id" | head -1)
q "insert into public.event_registration_attendees (registration_id, event_id, ticket_type_id, first_name, last_name, sort_order) values ('$PAID', '$EVENT', '$OPEN', 'One', 'Guest', 1);" >/dev/null
ATT="set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', true);
     insert into public.event_registration_attendees (registration_id, event_id, ticket_type_id, first_name, last_name, sort_order) values ('$PAID', '$EVENT', '$OPEN', 'Two', 'Guest', 2) returning 'inserted'"
( $PSQL -c "begin; $ATT; select pg_sleep(2); commit;" > "$TMP/e.out" 2>&1 || true ) &
sleep 0.7
F=$($PSQL -c "begin; $ATT; commit;" 2>&1 || true)
wait
check "concurrent attendee add: first is inserted" "$(grep -cE '^inserted$' "$TMP/e.out")" "1"
check "concurrent attendee add: second waits, then is refused" "$(echo "$F" | grep -c 'every ticket it paid for')" "1"
check "concurrent attendee add: tickets == paid entitlement (2)" "$(q "select count(*) from public.event_registration_attendees where registration_id = '$PAID'")" "2"

# ---- 5. Two alert workers drain at once: every due alert is claimed by exactly one of them.
q "select public._paywh1_record_exception(null, 'unknown_payment_reference', null, '$ACCT', 'cs_conc_u' || g, 'pi_conc_u' || g, 100, 'usd', '{}'::jsonb) from generate_series(1, 6) g;" >/dev/null
( $PSQL -c "begin; select count(*) from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00c0ca00c001', 100, 60) c where c.studio_id = '$STUDIO'; select pg_sleep(2); commit;" > "$TMP/f.out" 2>&1 || true ) &
sleep 0.7
G=$($PSQL -c "select count(*) from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00c0ca00c002', 100, 60) c where c.studio_id = '$STUDIO';" | tail -1)
wait
check "concurrent alert workers: first claims all six" "$(grep -E '^[0-9]+$' "$TMP/f.out" | head -1)" "6"
check "concurrent alert workers: second claims none (skip locked)" "$G" "0"
check "concurrent alert workers: each alert has exactly one owner" "$(q "select count(distinct alert_claim_owner) || '/' || count(*) from public.event_order_settlement_exceptions where studio_id = '$STUDIO' and alert_status = 'processing'")" "1/6"

echo "PAY-WH-1A CONCURRENCY: $pass passed, $fail failed"
[ "$fail" = "0" ]
