-- C1 closeout reads (W5) -- SQL fixture suite for the read-only competition P&L and closeout checklist.
--
-- Runs on a LOCAL throwaway Postgres only (container c1read-db: main schema + R2 20270103 + SC1 20270108); never hosted
-- DEV/PROD. No Stripe call: Stripe-side state is fed to the observe RPC as the webhook would. No migration, no grant,
-- no schema change. One transaction; the final block ALWAYS raises, so nothing persists:
--   "C1 CLOSEOUT READS SQL SUITE PASS (<n> checks)"  or  "... FAIL: <failures>".
--
-- Before the final raise it also writes, from the AUTHENTICATED user's own RLS view (exactly the rows the app loader
-- selects), a JSON snapshot to /tmp/c1_snapshot_a.json and /tmp/c1_snapshot_b.json. A vitest then feeds those rows to
-- the TypeScript read model and asserts the same figures this file computes in plain SQL.
--
-- Fixture (event A, studio A):
--   OA1  E1 60.00 + E2 40.00 + fee 10.00 - unscoped discount 11.00 = 99.00 paid by card (fees 3.17 + platform 1.00)
--        refunds: R1 20.00 on E1 (partial), R2 9.00 on the fee (fee refund), dashboard 5.00 (unattributed),
--                 R4 10.00 on E2 pending (holds cap), R5 7.00 on E2 succeeded then reversed (failed)
--   OA2  E3 10.00 paid at the desk (source competition_checkin)
-- Fixture (event B, studio B): OB1 E4 200.00 paid, refund 50.00 succeeded.

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;
create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c1c10' || p_suffix)::uuid $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  -- the older auth.uid() variant reads only this setting
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;
create or replace function pg_temp.line(p_item text, p_cents bigint) returns jsonb
language sql immutable as $$
  select jsonb_build_object('orderItemId', pg_temp.u(p_item), 'amountCents', p_cents, 'withdrawEntry', false)
$$;
create or replace function pg_temp.request(p_event text, p_order text, p_request text, p_lines jsonb) returns jsonb
language sql as $$
  select public.request_competition_order_refund(pg_temp.u(p_event), pg_temp.u(p_order), pg_temp.u(p_request), p_lines, 'C1 fixture')
$$;
create or replace function pg_temp.observe(p_pi text, p_account text, p_refund text, p_request uuid, p_amount bigint, p_status text)
returns jsonb language sql as $$
  select public.observe_competition_stripe_refund(p_pi, p_account, p_refund, p_request, p_amount, p_status, 'evt_' || coalesce(p_refund, 'none') || '_' || p_status)
$$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-c1-owner-a@example.test'),
  (pg_temp.u('000002'), 't-c1-owner-b@example.test'),
  (pg_temp.u('000003'), 't-c1-nobody@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000001'), 't-c1-owner-a@example.test', 'Owner A'),
  (pg_temp.u('000002'), 't-c1-owner-b@example.test', 'Owner B'),
  (pg_temp.u('000003'), 't-c1-nobody@example.test', 'Nobody');
insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'C1 Studio A', 't-c1-studio-a'),
  (pg_temp.u('00a002'), 'C1 Studio B', 't-c1-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000002'), pg_temp.u('00a002'), 'studio_owner', true),
  (pg_temp.u('000003'), pg_temp.u('00a001'), 'front_desk', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'C1 Comp A', 't-c1-ea', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00a002'), 'C1 Comp B', 't-c1-eb', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00a002'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Couples', 'single_dance', 'couple', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze Couples', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'Bronze Couples', 'open');

insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, discount_amount, total_amount,
  currency, status, payment_status, settlement_state, paid_at, stripe_payment_intent_id, stripe_checkout_session_id, metadata) values
  (pg_temp.u('00b001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer A1', 't-c1-a1@example.test', 110, 11, 99, 'USD', 'confirmed', 'paid', 'paid', now(), 'pi_c1_a1', 'cs_c1_a1', '{}'),
  (pg_temp.u('00b002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer A2', 't-c1-a2@example.test', 10, 0, 10, 'USD', 'confirmed', 'paid', 'paid', now(), null, null, jsonb_build_object('source', 'competition_registration')),
  (pg_temp.u('00b003'), pg_temp.u('00e002'), pg_temp.u('00a002'), 'Buyer B1', 't-c1-b1@example.test', 200, 0, 200, 'USD', 'confirmed', 'paid', 'paid', now(), 'pi_c1_b1', 'cs_c1_b1', '{}');
insert into public.event_registrations (id, order_id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email, status, payment_status, total_price, currency) values
  (pg_temp.u('00f001'), pg_temp.u('00b001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer', 'A1', 't-c1-a1@example.test', 'confirmed', 'paid', 99, 'USD'),
  (pg_temp.u('00f002'), pg_temp.u('00b002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer', 'A2', 't-c1-a2@example.test', 'confirmed', 'paid', 10, 'USD'),
  (pg_temp.u('00f003'), pg_temp.u('00b003'), pg_temp.u('00e002'), pg_temp.u('00a002'), 'Buyer', 'B1', 't-c1-b1@example.test', 'confirmed', 'paid', 200, 'USD');
insert into public.event_order_items (id, order_id, event_id, item_type, description, quantity, unit_price, total_price, currency, metadata) values
  (pg_temp.u('00c101'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'competition_entry', 'Entry E1', 1, 60, 60, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c102'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'competition_entry', 'Entry E2', 1, 40, 40, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c1f1'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'add_on', 'Registration fee', 1, 10, 10, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'line_type', 'fee')),
  (pg_temp.u('00c1d1'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'add_on', 'Early bird', 1, 0, 0, 'USD',
     jsonb_build_object('revenue_class', 'competition_entry', 'line_type', 'discount', 'discount_amount', 11,
                        'price_line', jsonb_build_object('metadata', jsonb_build_object('scope', jsonb_build_object('programId', null, 'contestId', null, 'divisionId', null))))),
  (pg_temp.u('00c201'), pg_temp.u('00b002'), pg_temp.u('00e001'), 'competition_entry', 'Entry E3', 1, 10, 10, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c301'), pg_temp.u('00b003'), pg_temp.u('00e002'), 'competition_entry', 'Entry E4', 1, 200, 200, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002002')));
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, stripe_payment_intent_id, stripe_checkout_session_id, stripe_account_id,
  stripe_processing_fee_amount, platform_fee_amount) values
  (pg_temp.u('00f001'), 99, 'USD', 'card', 'paid', 'stripe', 'pi_c1_a1', 'cs_c1_a1', 'acct_c1testa', 3.17, 1.00),
  (pg_temp.u('00f003'), 200, 'USD', 'card', 'paid', 'stripe', 'pi_c1_b1', 'cs_c1_b1', 'acct_c1testb', 6.10, 2.00);
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source) values
  (pg_temp.u('00f002'), 10, 'USD', 'cash', 'paid', 'competition_checkin');
insert into public.event_competition_entries (id, event_id, program_id, division_id, registration_id, order_id, order_item_id, display_name, status, eligibility_status, sort_order) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('00f001'), pg_temp.u('00b001'), pg_temp.u('00c101'), 'Ana & Ben', 'confirmed', 'eligible', 1),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('00f001'), pg_temp.u('00b001'), pg_temp.u('00c102'), 'Cy & Di', 'confirmed', 'eligible', 2),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('00f002'), pg_temp.u('00b002'), pg_temp.u('00c201'), '=Ed & Flo', 'confirmed', 'eligible', 3),
  (pg_temp.u('008004'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003002'), pg_temp.u('00f003'), pg_temp.u('00b003'), pg_temp.u('00c301'), 'Gus & Hal', 'confirmed', 'eligible', 1);

-- Refund activity (staff requests as the studio owner; Stripe-side state fed as the webhook would).
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.request('00e001', '00b001', '00aa01', jsonb_build_array(pg_temp.line('00c101', 2000)));
select pg_temp.request('00e001', '00b001', '00aa02', jsonb_build_array(pg_temp.line('00c1f1', 900)));
select pg_temp.request('00e001', '00b001', '00aa04', jsonb_build_array(pg_temp.line('00c102', 1000)));
select pg_temp.request('00e001', '00b001', '00aa05', jsonb_build_array(pg_temp.line('00c102', 700)));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.request('00e002', '00b003', '00bb01', jsonb_build_array(pg_temp.line('00c301', 5000)));
select pg_temp.as_service();
select pg_temp.observe('pi_c1_a1', 'acct_c1testa', 're_c1_1', pg_temp.u('00aa01'), 2000, 'succeeded');
select pg_temp.observe('pi_c1_a1', 'acct_c1testa', 're_c1_2', pg_temp.u('00aa02'), 900, 'succeeded');
select pg_temp.observe('pi_c1_a1', 'acct_c1testa', 're_c1_dash', null, 500, 'succeeded');
select pg_temp.observe('pi_c1_a1', 'acct_c1testa', 're_c1_4', pg_temp.u('00aa04'), 1000, 'pending');
select pg_temp.observe('pi_c1_a1', 'acct_c1testa', 're_c1_5', pg_temp.u('00aa05'), 700, 'succeeded');
select pg_temp.observe('pi_c1_a1', 'acct_c1testa', 're_c1_5', null, 700, 'failed');
select pg_temp.observe('pi_c1_b1', 'acct_c1testb', 're_c1_b1', pg_temp.u('00bb01'), 5000, 'succeeded');
reset role;

-- ============================================================================
-- Plain-SQL expectations (independent of the TypeScript read model)
-- ============================================================================
select pg_temp.chk('fixture: ledger has the expected statuses',
  (select jsonb_object_agg(stripe_refund_id, status) from public.event_order_refunds where event_id = pg_temp.u('00e001'))
    = jsonb_build_object('re_c1_1', 'succeeded', 're_c1_2', 'succeeded', 're_c1_dash', 'succeeded', 're_c1_4', 'pending', 're_c1_5', 'failed'),
  (select jsonb_object_agg(stripe_refund_id, status)::text from public.event_order_refunds where event_id = pg_temp.u('00e001')));
select pg_temp.chk('SQL: gross received (paid + refunded payments of the event) = 109.00',
  (select sum(ep.amount) from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
   where er.event_id = pg_temp.u('00e001') and ep.status in ('paid', 'refunded')) = 109.00);
select pg_temp.chk('SQL: desk payments = 10.00 and online = 99.00',
  (select sum(ep.amount) filter (where ep.source = 'competition_checkin') = 10.00 and sum(ep.amount) filter (where ep.source <> 'competition_checkin') = 99.00
   from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id where er.event_id = pg_temp.u('00e001')));
select pg_temp.chk('SQL: succeeded refunds = 34.00 (20 + 9 + 5; the reversed 7.00 and pending 10.00 are not money)',
  (select sum(amount_cents) from public.event_order_refunds where event_id = pg_temp.u('00e001') and status = 'succeeded') = 3400);
select pg_temp.chk('SQL: pending refunds holding cap = 10.00',
  (select sum(amount_cents) from public.event_order_refunds where event_id = pg_temp.u('00e001') and status in ('requested', 'pending', 'requires_action')) = 1000);
select pg_temp.chk('SQL: net = 75.00',
  (select sum(ep.amount) from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
   where er.event_id = pg_temp.u('00e001') and ep.status in ('paid', 'refunded'))
  - (select sum(amount_cents) from public.event_order_refunds where event_id = pg_temp.u('00e001') and status = 'succeeded') / 100.0 = 75.00);
select pg_temp.chk('SQL: event_payments.refund_amount equals the succeeded ledger (34.00)',
  (select sum(ep.refund_amount) from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id where er.event_id = pg_temp.u('00e001')) = 34.00,
  (select sum(ep.refund_amount)::text from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id where er.event_id = pg_temp.u('00e001')));
select pg_temp.chk('SQL: accounting revenue = 109.00 and refund entries net of the reversal = 34.00',
  (select sum(gross_amount) from public.accounting_entries where event_id = pg_temp.u('00e001') and category = 'competition_entry_revenue' and entry_status = 'active') = 109.00
  and (select sum(case when direction = 'credit' then -refund_amount else refund_amount end) from public.accounting_entries
       where event_id = pg_temp.u('00e001') and category = 'competition_entry_refund' and entry_status = 'active') = 34.00,
  (select sum(case when direction = 'credit' then -refund_amount else refund_amount end)::text from public.accounting_entries where event_id = pg_temp.u('00e001') and category = 'competition_entry_refund'));
select pg_temp.chk('SQL: the dashboard refund has no allocation (unattributed) and opened an attribution exception',
  not exists (select 1 from public.event_order_refund_allocations a join public.event_order_refunds r on r.id = a.refund_id where r.stripe_refund_id = 're_c1_dash')
  and (select count(*) from public.event_order_settlement_exceptions where event_id = pg_temp.u('00e001') and kind = 'competition_refund_unattributed' and status = 'open') = 1);
select pg_temp.chk('SQL: the R2 line caps give the discount shares 54 / 36 / 9 for E1 / E2 / fee',
  (select jsonb_object_agg(order_item_id, cap_cents) from public._r2_order_line_caps(pg_temp.u('00b001')))
    = jsonb_build_object(pg_temp.u('00c101'), 5400, pg_temp.u('00c102'), 3600, pg_temp.u('00c1f1'), 900));
select pg_temp.chk('SQL: no refund exceeds the captured amount per order',
  not exists (select 1 from public.event_order_refunds r where r.status = 'succeeded'
              group by r.order_id having sum(r.amount_cents) > (select (total_amount * 100)::bigint from public.event_orders where id = r.order_id)));

-- ============================================================================
-- Tenant isolation through RLS (the app loader uses the caller's own client)
-- ============================================================================
create or replace function pg_temp.counts(p_event text) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'orders', (select count(*) from public.event_orders where event_id = pg_temp.u(p_event)),
    'items', (select count(*) from public.event_order_items where event_id = pg_temp.u(p_event)),
    'entries', (select count(*) from public.event_competition_entries where event_id = pg_temp.u(p_event)),
    'registrations', (select count(*) from public.event_registrations where event_id = pg_temp.u(p_event)),
    'payments', (select count(*) from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id where er.event_id = pg_temp.u(p_event)),
    'refunds', (select count(*) from public.event_order_refunds where event_id = pg_temp.u(p_event)),
    'allocations', (select count(*) from public.event_order_refund_allocations where event_id = pg_temp.u(p_event)),
    'exceptions', (select count(*) from public.event_order_settlement_exceptions where event_id = pg_temp.u(p_event)),
    'scopes', (select count(*) from public.event_competition_refund_exception_scopes where event_id = pg_temp.u(p_event)),
    'accounting', (select count(*) from public.accounting_entries where event_id = pg_temp.u(p_event))
  )
$$;
grant execute on function pg_temp.counts(text) to authenticated, anon;

create temp table t_counts (k text primary key, v jsonb) on commit drop;
grant all on t_counts to authenticated, anon, service_role;

select pg_temp.as_user(pg_temp.u('000001'));
insert into t_counts values ('a_sees_a', pg_temp.counts('00e001')), ('a_sees_b', pg_temp.counts('00e002'));
select pg_temp.as_user(pg_temp.u('000002'));
insert into t_counts values ('b_sees_a', pg_temp.counts('00e001')), ('b_sees_b', pg_temp.counts('00e002'));
select pg_temp.as_user(pg_temp.u('000003'));
insert into t_counts values ('desk_sees_a', pg_temp.counts('00e001'));
reset role;
create or replace function pg_temp.anon_probe() returns jsonb language plpgsql as $f$
begin
  return pg_temp.counts('00e001');
exception when insufficient_privilege then
  return jsonb_build_object('denied', true);
end $f$;
grant execute on function pg_temp.anon_probe() to anon;
set role anon;
insert into t_counts values ('anon_sees_a', pg_temp.anon_probe());
reset role;

select pg_temp.chk('RLS: owner A sees event A money',
  (select (v->>'orders')::int = 2 and (v->>'payments')::int = 2 and (v->>'refunds')::int = 5 and (v->>'allocations')::int = 4 and (v->>'accounting')::int > 0
   from t_counts where k = 'a_sees_a'), (select v::text from t_counts where k = 'a_sees_a'));
select pg_temp.chk('RLS: owner A sees NOTHING of event B (every table)',
  (select (select bool_and(value::int = 0) from jsonb_each_text(v)) from t_counts where k = 'a_sees_b'), (select v::text from t_counts where k = 'a_sees_b'));
select pg_temp.chk('RLS: owner B sees event B money and NOTHING of event A',
  (select (v->>'orders')::int = 1 and (v->>'payments')::int = 1 and (v->>'refunds')::int = 1 from t_counts where k = 'b_sees_b')
  and (select bool_and(value::int = 0) from t_counts, jsonb_each_text(v) where k = 'b_sees_a'),
  (select v::text from t_counts where k = 'b_sees_a'));
-- Observation (pre-existing RLS posture, not changed here): studio staff without manager rights can still read
-- accounting_entries / payments of the studio; the closeout page and export are manager-only at the application layer.
select pg_temp.chk('RLS: a studio user without manager rights sees no refund ledger, allocations or exceptions for event A',
  (select (v->>'refunds')::int = 0 and (v->>'allocations')::int = 0 and (v->>'exceptions')::int = 0 from t_counts where k = 'desk_sees_a'),
  (select v::text from t_counts where k = 'desk_sees_a'));
select pg_temp.chk('RLS: anon sees nothing (or is refused) for event A',
  (select v ? 'denied' from t_counts where k = 'anon_sees_a'), (select v::text from t_counts where k = 'anon_sees_a'));
select pg_temp.chk('Read only: the closeout loader needs no write: authenticated cannot insert into the refund ledger',
  not has_table_privilege('authenticated', 'public.event_order_refunds', 'INSERT')
  and not has_table_privilege('authenticated', 'public.event_order_refunds', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.event_order_refund_allocations', 'INSERT'));

-- ============================================================================
-- JSON snapshots: the exact rows the app loader selects, as each owner sees them
-- ============================================================================
create or replace function pg_temp.snapshot(p_event text, p_studio text) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'eventId', pg_temp.u(p_event), 'studioId', pg_temp.u(p_studio),
    'items', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, order_id, event_id, item_type, description, total_price, metadata from public.event_order_items where event_id = pg_temp.u(p_event) order by id) x),
    'orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, event_id, studio_id, payment_status, total_amount, currency from public.event_orders where event_id = pg_temp.u(p_event) order by id) x),
    'entries', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, event_id, order_item_id, display_name, status, sort_order, program_id, division_id from public.event_competition_entries where event_id = pg_temp.u(p_event) order by id) x),
    'registrations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, order_id, event_id from public.event_registrations where event_id = pg_temp.u(p_event) order by id) x),
    'payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select ep.id, ep.registration_id, ep.amount, ep.status, ep.source, ep.payment_method, ep.refund_amount, ep.stripe_processing_fee_amount, ep.stripe_application_fee_amount, ep.platform_fee_amount, ep.created_at from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id where er.event_id = pg_temp.u(p_event) order by ep.id) x),
    'refunds', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, event_id, order_id, amount_cents, status, source, stripe_refund_id, reason, succeeded_at, reversed_at, created_at from public.event_order_refunds where event_id = pg_temp.u(p_event) order by id) x),
    'allocations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select refund_id, event_id, order_item_id, entry_id, line_kind, amount_cents from public.event_order_refund_allocations where event_id = pg_temp.u(p_event) order by id) x),
    'accounting', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select event_id, category, direction, gross_amount, refund_amount, entry_status from public.accounting_entries where event_id = pg_temp.u(p_event) and category in ('competition_entry_revenue', 'competition_entry_refund') order by id) x),
    'exceptions', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, kind, status, order_id, event_id from public.event_order_settlement_exceptions where event_id = pg_temp.u(p_event) order by id) x),
    'scopes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select id, event_id, kind, resolved_at from public.event_competition_refund_exception_scopes where event_id = pg_temp.u(p_event) order by id) x),
    'scratches', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select entry_id, requested_resolution, performed_at, event_id from public.event_competition_scratches where event_id = pg_temp.u(p_event) order by performed_at) x)
  )
$$;
grant execute on function pg_temp.snapshot(text, text) to authenticated;
create temp table t_snap (k text primary key, v jsonb) on commit drop;
grant all on t_snap to authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_snap values ('a', pg_temp.snapshot('00e001', '00a001'));
select pg_temp.as_user(pg_temp.u('000002'));
insert into t_snap values ('b', pg_temp.snapshot('00e002', '00a002'));
reset role;
\o /tmp/c1_snapshot_a.json
select v from t_snap where k = 'a';
\o /tmp/c1_snapshot_b.json
select v from t_snap where k = 'b';
\o

do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ' order by name) filter (where not ok)
    into v_total, v_failures from t_results;
  if v_failures is null then
    raise exception 'C1 CLOSEOUT READS SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'C1 CLOSEOUT READS SQL SUITE FAIL: %', v_failures;
end $$;
