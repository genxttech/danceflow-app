#!/bin/bash
# CF1 RB3R two-session concurrency checks. LOCAL disposable Postgres container only (committed fixtures; the audit table is append-only, so throw the container away).
#   CONTAINER=<container with R2 + CF1 chain + RB3 + RB3R> DBUSER=postgres bash test_T_competition_cf1_rb3r_concurrency.sh
# Checks (each prints PASS / FAIL):
#   C1 two sessions send the SAME request id for the same request: exactly one audit row, the loser is a replay (blocked on the per-entry lock until the winner commits)
#   C2 two different managers co-sign the SAME request concurrently: exactly one release_cosigned row, the other session is refused (CF1_RB3_DECISION_COMPLETED)
#   C3 request vs. request with different request ids on the same entry, concurrently: both rows exist, only the newer one can be co-signed (the older is stale)
# No Stripe call; no provider / payment / refund row is written after the fixtures.
export MSYS_NO_PATHCONV=1
C=${CONTAINER:?CONTAINER required}; U=${DBUSER:-postgres}
P() { sed 's/\r$//' | docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$U" -h localhost -d postgres -X -q -At "$@"; }
TT=${TMPDIR:-/tmp}; pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS  $*"; }
bad() { fail=$((fail+1)); echo "FAIL  $*"; }
X=00000000-0000-0000-0000-cf1b31
id() { echo "${X}$1"; }

# --- committed fixtures (replica mode for the ledger rows; idempotent per container)
P <<SQL
set session_replication_role = replica;
insert into auth.users (id, email) values ('$(id 000001)','t-rb3rc-a@example.test'),('$(id 000002)','t-rb3rc-b@example.test'),('$(id 000003)','t-rb3rc-c@example.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) select id, email, 'RB3RC' from auth.users where id::text like '00000000-0000-0000-0000-cf1b31%' on conflict do nothing;
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-cf1b31%' on conflict do nothing;
insert into public.studios (id, name, slug) values ('$(id 00a001)','RB3RC Studio','t-rb3rc-studio') on conflict do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('$(id 000001)','$(id 00a001)','studio_owner',true),('$(id 000002)','$(id 00a001)','studio_owner',true),('$(id 000003)','$(id 00a001)','studio_owner',true) on conflict do nothing;
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$(id 00e001)','$(id 00a001)','RB3RC Comp','t-rb3rc-e1','competition', current_date + 30, current_date + 30,'published','public',true) on conflict do nothing;
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
  values ('$(id 001001)','$(id 00e001)','$(id 00a001)','P','country','relative','skating','configured','none') on conflict do nothing;
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
  values ('$(id 002001)','$(id 00e001)','$(id 001001)','C','single_dance','pro_am','open') on conflict do nothing;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values ('$(id 003001)','$(id 00e001)','$(id 001001)','$(id 002001)','D1','open') on conflict do nothing;
SQL
for n in 1 2 3; do
P <<SQL
set session_replication_role = replica;
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values ('$(id 0a000$n)','$(id 00e001)','$(id 00a001)','B','b$n@example.test','partially_refunded') on conflict do nothing;
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email)
  values ('$(id 0b000$n)','$(id 00a001)','$(id 00e001)','$(id 0a000$n)','confirmed','partial','G','C$n','g$n@example.test') on conflict do nothing;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id, order_id)
  values ('$(id 08000$n)','$(id 00e001)','$(id 001001)','$(id 003001)','c$n','confirmed','eligible','x$n','$(id 0b000$n)','$(id 0a000$n)') on conflict do nothing;
insert into public.event_order_items (id, order_id, event_id, item_type, description, quantity, unit_price, total_price)
  values ('$(id 0d000$n)','$(id 0a000$n)','$(id 00e001)','competition_entry','item',1,100,100) on conflict do nothing;
insert into public.event_order_refunds (id, event_id, order_id, registration_id, refund_request_id, stripe_refund_id, stripe_account_id, stripe_payment_intent_id, amount_cents, currency, status, source, succeeded_at)
  values ('$(id 0f000$n)','$(id 00e001)','$(id 0a000$n)','$(id 0b000$n)','$(id 0e000$n)','FIXTURE_re_c$n','acct_FIXTURE','FIXTURE_pi_c$n',3000,'usd','succeeded','staff',now()) on conflict do nothing;
insert into public.event_order_refund_allocations (refund_id, event_id, order_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry, participation_outcome)
  select '$(id 0f000$n)','$(id 00e001)','$(id 0a000$n)','$(id 0d000$n)','$(id 08000$n)','entry',3000,false,'not_requested'
  where not exists (select 1 from public.event_order_refund_allocations where refund_id = '$(id 0f000$n)');
-- INT5: the legacy cash row (refund 30) goes in AFTER the ledger row that proves it, so the R2 refund write gate (when installed) accepts it.
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, refund_amount) select '$(id 0b000$n)',100,'USD','cash','paid','manual',30
  where not exists (select 1 from public.event_payments where registration_id = '$(id 0b000$n)');
SQL
done

# run SQL as an authenticated user inside one transaction, holding it open for $3 seconds after the statement
as() { # user statement hold_seconds
  cat <<SQL | P 2>&1
begin;
select set_config('request.jwt.claims', '{"sub":"$(id 00000$1)","role":"authenticated"}', true);
set local role authenticated;
$2
select pg_sleep($3);
commit;
SQL
}
REASON="'Staff confirm the entry continues to compete despite the partial refund.'"
cnt() { echo "select count(*) from public.competition_cf1_rb3_reconciliations where $1;" | P; }

# C1 same request id from two sessions
rid=$(id 0c0001); e=$(id 080001)
( as 1 "select 'RES1 ' || ((public.request_cf1_refund_evidence_release('$e', $REASON, '$rid')) ->> 'replayed');" 3 > $TT/rb3rc_c1a.out ) &
sleep 1
as 1 "select 'RES2 ' || ((public.request_cf1_refund_evidence_release('$e', $REASON, '$rid')) ->> 'replayed');" 0 > $TT/rb3rc_c1b.out
wait
a=$(grep -o 'RES1 .*' $TT/rb3rc_c1a.out); b=$(grep -o 'RES2 .*' $TT/rb3rc_c1b.out)
n=$(cnt "request_id = '$rid'")
if [ "$n" = 1 ] && [ "$a" = "RES1 false" ] && [ "$b" = "RES2 true" ]; then ok "C1 same request id from two sessions: one row, the second session is a replay ($a / $b)"; else bad "C1 rows=$n a='$a' b='$b' ($(cat $TT/rb3rc_c1a.out $TT/rb3rc_c1b.out | grep -i error | head -2 | tr '\n' ' '))"; fi

# C2 two managers co-sign the same request concurrently
rid2=$(id 0c0002); e2=$(id 080002)
as 1 "select public.request_cf1_refund_evidence_release('$e2', $REASON, '$rid2');" 0 >/dev/null
dec=$(echo "select id from public.competition_cf1_rb3_reconciliations where request_id = '$rid2'" | P)
( as 2 "select 'COS2 ' || ((public.cosign_cf1_refund_evidence_release('$dec', '$(id 0c0003)')) ->> 'kind');" 3 > $TT/rb3rc_c2a.out 2>&1 ) &
sleep 1
as 3 "select 'COS3 ' || ((public.cosign_cf1_refund_evidence_release('$dec', '$(id 0c0004)')) ->> 'kind');" 0 > $TT/rb3rc_c2b.out 2>&1
wait
n=$(cnt "decision_id = '$dec' and kind = 'release_cosigned'")
okc=$(cat $TT/rb3rc_c2a.out | grep -c 'COS2 release_cosigned'); lose=$(cat $TT/rb3rc_c2b.out | grep -c 'CF1_RB3_DECISION_COMPLETED')
if [ "$n" = 1 ] && [ "$okc" = 1 ] && [ "$lose" = 1 ]; then ok "C2 two managers co-sign concurrently: exactly one release_cosigned row, the other refused DECISION_COMPLETED"; else bad "C2 cosigned_rows=$n winner=$okc loser_refused=$lose ($(cat $TT/rb3rc_c2a.out $TT/rb3rc_c2b.out | head -4 | tr '\n' ' '))"; fi
st=$(echo "select public._cf1_entry_unavailable_reason('$e2')" | P)
[ -z "$st" ] && ok "C2b entry released after the single co-sign (effective reason null)" || bad "C2b entry reason '$st'"

# C3 two different requests on the same entry, concurrently: both recorded, only the newer is co-signable
e3=$(id 080003); rA=$(id 0c0005); rB=$(id 0c0006)
( as 1 "select 'RA ' || ((public.request_cf1_refund_evidence_release('$e3', $REASON, '$rA')) ->> 'kind');" 3 > $TT/rb3rc_c3a.out 2>&1 ) &
sleep 1
as 2 "select 'RB ' || ((public.request_cf1_refund_evidence_release('$e3', $REASON, '$rB')) ->> 'kind');" 0 > $TT/rb3rc_c3b.out 2>&1
wait
n=$(cnt "entry_id = '$e3' and kind = 'release_requested'")
decA=$(echo "select id from public.competition_cf1_rb3_reconciliations where request_id = '$rA'" | P)
out=$(as 3 "select public.cosign_cf1_refund_evidence_release('$decA', '$(id 0c0007)');" 0 2>&1)
if [ "$n" = 2 ] && echo "$out" | grep -q 'CF1_RB3_REQUEST_STALE'; then ok "C3 concurrent distinct requests: both recorded (serialised), the older one is stale at co-sign"; else bad "C3 requests=$n stale_out='$(echo "$out" | head -1)'"; fi

echo "RB3R CONCURRENCY TALLY: $pass passed, $fail failed"
[ $fail = 0 ]
