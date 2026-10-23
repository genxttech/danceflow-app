-- Competition R2 (CI-D) -- competition entry refunds regression suite.
--
-- Covers 20270103090000_competition_r2_entry_refunds.sql (design: docs/competition/r2-entry-refunds.md 4.0, 4.1, 7):
--   A. registration cascade: withdraw + scratch only unplaced/open entries; locked/certified/danced (Q1) entries are
--      never withdrawn automatically and raise E-L / E-C (never silently skipped);
--   B. D1/D2 net caps (same scenario and numbers as src/lib/payments/__tests__/competitionRefundRules.test.ts);
--   C. request_competition_order_refund: D5 authority, cross-event / cross-order refusal, caps, idempotent replay;
--   D. observe_competition_stripe_refund: transitions, idempotency, out-of-order, stored-owner check, participation
--      effects, order / payment / registration state, C1 accounting, reversal;
--   E. exceptions: Q2 scopes (round_id + competitive_effect), K0 publish predicate, gated resolution;
--   F. dashboard (D6) unattributed refund + attribution;
--   G. ledger immutability, grants, RLS; non-competition event accounting unchanged.
--
-- Local Postgres only (isolated QA container); never hosted DEV/PROD; no Stripe call (Stripe-side state is fed to
-- the observe RPC as the server action / webhook would). One transaction; the final block ALWAYS raises, so nothing
-- persists:  "COMPETITION R2 SQL SUITE PASS (<n> checks)"  or  "COMPETITION R2 SQL SUITE FAIL: <failures>".

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

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    set constraints all deferred;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- An unexpected success is rolled back AND recorded.
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
language plpgsql as $$
declare
  v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    set constraints all immediate;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  end if;
  set constraints all deferred;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c1d20' || p_suffix)::uuid $$;
create or replace function pg_temp.id(p_k text) returns uuid
language sql stable as $$ select v from t_ids where k = p_k $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;
create or replace function pg_temp.entry_status(p_entry text) returns text
language sql stable as $$ select status from public.event_competition_entries where id = pg_temp.u(p_entry) $$;
create or replace function pg_temp.placement(p_entry text) returns text
language sql stable as $$
  select string_agg(status, ',' order by status) from public.event_competition_heat_entries where entry_id = pg_temp.u(p_entry)
$$;
-- observe as the server action / webhook would (service role); returns the RPC result
create or replace function pg_temp.observe(p_pi text, p_account text, p_refund text, p_request uuid, p_amount bigint, p_status text)
returns jsonb language sql as $$
  select public.observe_competition_stripe_refund(p_pi, p_account, p_refund, p_request, p_amount, p_status, 'evt_' || coalesce(p_refund, 'none'))
$$;
create or replace function pg_temp.request(p_order text, p_request text, p_lines jsonb) returns jsonb
language sql as $$
  select public.request_competition_order_refund(pg_temp.u('00e001'), pg_temp.u(p_order), pg_temp.u(p_request), p_lines, 'Injury')
$$;
create or replace function pg_temp.line(p_item text, p_cents bigint, p_withdraw boolean) returns jsonb
language sql immutable as $$
  select jsonb_build_object('orderItemId', pg_temp.u(p_item), 'amountCents', p_cents, 'withdrawEntry', p_withdraw)
$$;
create or replace function pg_temp.scopes(p_kind text, p_entry text) returns bigint
language sql stable as $$
  select count(*) from public.event_competition_refund_exception_scopes
  where kind = p_kind and entry_id = pg_temp.u(p_entry)
$$;
create or replace function pg_temp.k0_blocked(p_round text) returns boolean
language sql stable as $$
  select exists (select 1 from public.event_competition_refund_exception_scopes s
                 where s.round_id = pg_temp.u(p_round) and s.competitive_effect and s.resolved_at is null)
$$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-r2-owner@example.test'),
  (pg_temp.u('000002'), 't-r2-nobody@example.test'),
  (pg_temp.u('000003'), 't-r2-other-owner@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000001'), 't-r2-owner@example.test', 'Owner'),
  (pg_temp.u('000002'), 't-r2-nobody@example.test', 'Nobody'),
  (pg_temp.u('000003'), 't-r2-other-owner@example.test', 'Other owner');
insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'R2 Studio', 't-r2-studio'),
  (pg_temp.u('00a002'), 'R2 Other Studio', 't-r2-studio-2');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000003'), pg_temp.u('00a002'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'R2 Comp', 't-r2-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00a001'), 'R2 Other Comp', 't-r2-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze Couples', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Silver Couples', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1);
insert into public.event_competition_dances (id, event_id, program_id, dance_key, name) values
  (pg_temp.u('004001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'two_step', 'Two Step'),
  (pg_temp.u('004002'), pg_temp.u('00e001'), pg_temp.u('001001'), 'waltz', 'Waltz');
insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, sort_order) values
  (pg_temp.u('005011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('004001'), 1),
  (pg_temp.u('005021'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), pg_temp.u('004002'), 1);

-- Orderless registrations (section A) 00f001..00f006.
insert into public.event_registrations (id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email, status, payment_status)
select pg_temp.u('00f00' || n), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Reg', 'N' || n, 't-r2-reg' || n || '@example.test', 'confirmed', 'paid'
from generate_series(1, 6) n;

-- Paid competition orders: O1 (00b001, four entries + fee + discount, captured 100.00), O2 (00b002, one entry,
-- captured 30.00), O3 (00b003, another event).
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, discount_amount, total_amount,
  currency, status, payment_status, settlement_state, paid_at, stripe_payment_intent_id, stripe_checkout_session_id, metadata) values
  (pg_temp.u('00b001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer One', 't-r2-o1@example.test', 110, 10, 100, 'USD', 'confirmed', 'paid', 'paid', now(), 'pi_r2_o1', 'cs_r2_o1', '{}'),
  (pg_temp.u('00b002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer Two', 't-r2-o2@example.test', 30, 0, 30, 'USD', 'confirmed', 'paid', 'paid', now(), 'pi_r2_o2', 'cs_r2_o2', '{}'),
  (pg_temp.u('00b003'), pg_temp.u('00e002'), pg_temp.u('00a001'), 'Buyer Three', 't-r2-o3@example.test', 20, 0, 20, 'USD', 'confirmed', 'paid', 'paid', now(), 'pi_r2_o3', 'cs_r2_o3', '{}');
insert into public.event_registrations (id, order_id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email, status, payment_status, total_price, currency) values
  (pg_temp.u('00f101'), pg_temp.u('00b001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer', 'One', 't-r2-o1@example.test', 'confirmed', 'paid', 100, 'USD'),
  (pg_temp.u('00f102'), pg_temp.u('00b002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer', 'Two', 't-r2-o2@example.test', 'confirmed', 'paid', 30, 'USD'),
  (pg_temp.u('00f103'), pg_temp.u('00b003'), pg_temp.u('00e002'), pg_temp.u('00a001'), 'Buyer', 'Three', 't-r2-o3@example.test', 'confirmed', 'paid', 20, 'USD');
insert into public.event_order_items (id, order_id, event_id, item_type, description, quantity, unit_price, total_price, currency, metadata) values
  (pg_temp.u('00c101'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'competition_entry', 'Entry 1', 1, 25, 25, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c102'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'competition_entry', 'Entry 2', 1, 25, 25, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c103'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'competition_entry', 'Entry 3', 1, 25, 25, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c104'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'competition_entry', 'Entry 4', 1, 25, 25, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c1f1'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'add_on', 'Registration fee', 1, 10, 10, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'line_type', 'fee')),
  (pg_temp.u('00c1d1'), pg_temp.u('00b001'), pg_temp.u('00e001'), 'add_on', 'Early bird', 1, 0, 0, 'USD',
     jsonb_build_object('revenue_class', 'competition_entry', 'line_type', 'discount', 'discount_amount', 10,
                        'price_line', jsonb_build_object('metadata', jsonb_build_object('scope', jsonb_build_object('programId', null, 'contestId', null, 'divisionId', null))))),
  (pg_temp.u('00c201'), pg_temp.u('00b002'), pg_temp.u('00e001'), 'competition_entry', 'Entry 5', 1, 30, 30, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))),
  (pg_temp.u('00c301'), pg_temp.u('00b003'), pg_temp.u('00e002'), 'add_on', 'Other event fee', 1, 20, 20, 'USD', jsonb_build_object('revenue_class', 'competition_entry', 'line_type', 'fee'));
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, stripe_payment_intent_id, stripe_checkout_session_id, stripe_account_id) values
  (pg_temp.u('00f101'), 100, 'USD', 'card', 'paid', 'stripe', 'pi_r2_o1', 'cs_r2_o1', 'acct_r2test1'),
  (pg_temp.u('00f102'), 30, 'USD', 'card', 'paid', 'stripe', 'pi_r2_o2', 'cs_r2_o2', 'acct_r2test1'),
  (pg_temp.u('00f103'), 20, 'USD', 'card', 'paid', 'stripe', 'pi_r2_o3', 'cs_r2_o3', 'acct_r2test1');

-- entry -> (registration, division, order, item, sort)
create temp table t_entries (entry text, reg text, division text, label text, ord text, item text, sort int) on commit drop;
grant all on t_entries to authenticated, anon, service_role;
insert into t_entries values
  ('008001', '00f001', '003001', 'Full refund placed scheduled', null, null, 1),
  ('008002', '00f001', '003001', 'Full refund placed checked in', null, null, 2),
  ('008003', '00f001', '003001', 'Full refund unplaced', null, null, 3),
  ('008004', '00f001', '003001', 'Full refund placed danced', null, null, 4),
  ('008005', '00f002', '003001', 'Cancelled placed', null, null, 1),
  ('008006', '00f003', '003002', 'Locked heat entry', null, null, 1),
  ('008007', '00f003', '003001', 'Locked-reg unlocked entry', null, null, 2),
  ('008008', '00f004', '003001', 'Partial refund placed', null, null, 1),
  ('008009', '00f005', '003001', 'Payment failed placed', null, null, 1),
  ('008010', '00f006', '003001', 'Bystander placed', null, null, 1),
  ('008101', '00f101', '003001', 'O1 unplaced', '00b001', '00c101', 1),
  ('008102', '00f101', '003002', 'O1 locked heat', '00b001', '00c102', 2),
  ('008103', '00f101', '003001', 'O1 danced open heat', '00b001', '00c103', 3),
  ('008104', '00f101', '003002', 'O1 certified heat', '00b001', '00c104', 4),
  ('008105', '00f102', '003001', 'O2 unplaced', '00b002', '00c201', 1);
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via)
select pg_temp.u('007' || right(entry, 3)), pg_temp.u('00e001'), 'Dancer', label, 'staff' from t_entries;
insert into public.event_competition_entries (id, event_id, program_id, division_id, registration_id, order_id, order_item_id, display_name, status, eligibility_status, sort_order)
select pg_temp.u(entry), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u(division), pg_temp.u(reg),
       case when ord is not null then pg_temp.u(ord) end, case when item is not null then pg_temp.u(item) end, label, 'confirmed', 'eligible', sort
from t_entries;
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name)
select pg_temp.u('00e001'), pg_temp.u(entry), pg_temp.u('007' || right(entry, 3)), 'dancer', 'leader', label from t_entries;
insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label)
select pg_temp.u('00e001'), pg_temp.u(entry), case when division = '003001' then pg_temp.u('005011') else pg_temp.u('005021') end, 'offering', 'Offering'
from t_entries;

-- Plan: heat A (Bronze, open) = Bronze entries except the unplaced ones; heat B (Silver, locked) = 008006 + 008102;
-- heat C (Silver heat 2, certified) = 008104.
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('v1', public.create_competition_schedule_version(pg_temp.u('00e001'), 'v1', null));
select pg_temp.expect_ok('fixture: planner places the entries',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), jsonb_build_object('floorHeats', jsonb_build_array(
       jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003001'), 'roundId', pg_temp.u('006001'),
         'heatNumber', 1, 'name', 'Bronze Two Step', 'danceIds', jsonb_build_array(pg_temp.u('004001')),
         'entryIds', (select jsonb_agg(pg_temp.u(entry)) from t_entries where division = '003001' and entry not in ('008003', '008101', '008105'))))),
       jsonb_build_object('number', 2, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003002'), 'roundId', pg_temp.u('006002'),
         'heatNumber', 1, 'name', 'Silver Waltz', 'danceIds', jsonb_build_array(pg_temp.u('004002')),
         'entryIds', jsonb_build_array(pg_temp.u('008006'), pg_temp.u('008102'))))),
       jsonb_build_object('number', 3, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003002'), 'roundId', pg_temp.u('006002'),
         'heatNumber', 2, 'name', 'Silver Waltz 2', 'danceIds', jsonb_build_array(pg_temp.u('004002')),
         'entryIds', jsonb_build_array(pg_temp.u('008104'))))))))$q$);
insert into t_ids select 'heat_a', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003001');
insert into t_ids select 'heat_b', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003002') and heat_number = 1;
insert into t_ids select 'heat_c', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003002') and heat_number = 2;
select pg_temp.expect_ok('fixture: lock heat B',
  $q$select public.set_competition_heat_lock_state(pg_temp.id('heat_b'), 'locked', 'Results in progress')$q$);
select pg_temp.expect_ok('fixture: lock and certify heat C',
  $q$select public.set_competition_heat_lock_state(pg_temp.id('heat_c'), 'locked', 'Results in progress');
     select public.set_competition_heat_lock_state(pg_temp.id('heat_c'), 'certified', 'Certified')$q$);
reset role;
update public.event_competition_heat_entries set status = 'checked_in' where entry_id = pg_temp.u('008002');
update public.event_competition_heat_entries set status = 'danced' where entry_id in (pg_temp.u('008004'), pg_temp.u('008103'));
select pg_temp.chk('fixture: 12 placements, heat B locked, heat C certified',
  (select count(*) from public.event_competition_heat_entries where event_id = pg_temp.u('00e001')) = 12
  and (select lock_state from public.event_competition_heats where id = pg_temp.id('heat_b')) = 'locked'
  and (select lock_state from public.event_competition_heats where id = pg_temp.id('heat_c')) = 'certified',
  (select count(*)::text from public.event_competition_heat_entries where event_id = pg_temp.u('00e001')));

-- ============================================================================
-- A. Registration cascade
-- ============================================================================
select pg_temp.expect_ok('A: full refund of a registration is accepted',
  $q$update public.event_registrations set payment_status = 'refunded', status = 'refunded' where id = pg_temp.u('00f001')$q$);
select pg_temp.chk('A: placed, not-danced entries withdrawn',
  pg_temp.entry_status('008001') = 'withdrawn' and pg_temp.entry_status('008002') = 'withdrawn');
select pg_temp.chk('A: unplaced entry withdrawn', pg_temp.entry_status('008003') = 'withdrawn');
select pg_temp.chk('A: scheduled placement scratched', pg_temp.placement('008001') = 'scratched', pg_temp.placement('008001'));
select pg_temp.chk('A: checked-in placement scratched', pg_temp.placement('008002') = 'scratched', pg_temp.placement('008002'));
select pg_temp.chk('A/Q1: an entry that has danced (unlocked heat) is NOT withdrawn', pg_temp.entry_status('008004') = 'confirmed', pg_temp.entry_status('008004'));
select pg_temp.chk('A/Q1: its danced placement is kept', pg_temp.placement('008004') = 'danced', pg_temp.placement('008004'));
select pg_temp.chk('A/Q1: the danced entry raises E-L scoped to its round (not silent)',
  pg_temp.scopes('competition_refund_entry_locked_heat', '008004') = 1
  and exists (select 1 from public.event_competition_refund_exception_scopes
              where entry_id = pg_temp.u('008004') and round_id = pg_temp.u('006001') and competitive_effect and resolved_at is null));
select pg_temp.chk('A: withdrawal audited with fee handling refund',
  exists (select 1 from public.event_competition_entry_changes
          where entry_id = pg_temp.u('008001') and change_type = 'withdraw' and fee_handling = 'refund'));

select pg_temp.expect_ok('A: cancelling a registration is accepted',
  $q$update public.event_registrations set status = 'cancelled' where id = pg_temp.u('00f002')$q$);
select pg_temp.chk('A: cancel withdraws + scratches', pg_temp.entry_status('008005') = 'withdrawn' and pg_temp.placement('008005') = 'scratched');
select pg_temp.expect_ok('A: payment failure is accepted',
  $q$update public.event_registrations set payment_status = 'failed' where id = pg_temp.u('00f005')$q$);
select pg_temp.chk('A: payment failure withdraws + scratches', pg_temp.entry_status('008009') = 'withdrawn' and pg_temp.placement('008009') = 'scratched');

select pg_temp.expect_ok('A: full refund with an entry in a locked heat is accepted',
  $q$update public.event_registrations set payment_status = 'refunded', status = 'refunded' where id = pg_temp.u('00f003')$q$);
select pg_temp.chk('A: locked-heat entry NOT withdrawn, placement NOT scratched',
  pg_temp.entry_status('008006') = 'confirmed' and pg_temp.placement('008006') = 'scheduled');
select pg_temp.chk('A: locked-heat entry raises one E-L scope for round 006002',
  pg_temp.scopes('competition_refund_entry_locked_heat', '008006') = 1
  and exists (select 1 from public.event_competition_refund_exception_scopes
              where entry_id = pg_temp.u('008006') and heat_id = pg_temp.id('heat_b') and round_id = pg_temp.u('006002') and competitive_effect));
select pg_temp.chk('A: the E-L parent is an operational, alerted settlement exception',
  exists (select 1 from public.event_order_settlement_exceptions x
          join public.event_competition_refund_exception_scopes s on s.exception_id = x.id and s.entry_id = pg_temp.u('008006')
          where x.kind = 'competition_refund_entry_locked_heat' and x.money_state = 'operational' and x.alert_status = 'pending' and x.status = 'open'));
select pg_temp.chk('A: the same registration''s unlocked entry is withdrawn and scratched',
  pg_temp.entry_status('008007') = 'withdrawn' and pg_temp.placement('008007') = 'scratched');
select pg_temp.expect_ok('A: partial registration payment is accepted',
  $q$update public.event_registrations set payment_status = 'partial' where id = pg_temp.u('00f004')$q$);
select pg_temp.chk('A: partial changes no entry', pg_temp.entry_status('008008') = 'confirmed' and pg_temp.placement('008008') = 'scheduled');
select pg_temp.chk('A: bystander untouched', pg_temp.entry_status('008010') = 'confirmed' and pg_temp.placement('008010') = 'scheduled');
select pg_temp.expect_ok('A: re-firing the trigger is accepted',
  $q$update public.event_registrations set notes = 'touch' where id in (pg_temp.u('00f001'), pg_temp.u('00f003'))$q$);
select pg_temp.chk('A: re-fire adds no scope and no second withdrawal',
  pg_temp.scopes('competition_refund_entry_locked_heat', '008004') = 1 and pg_temp.scopes('competition_refund_entry_locked_heat', '008006') = 1
  and (select count(*) from public.event_competition_entry_changes where entry_id = pg_temp.u('008001') and change_type = 'withdraw') = 1);

-- ============================================================================
-- B. D1/D2 net caps (parity with competitionRefundRules.test.ts "R2 SQL parity" case)
-- ============================================================================
select pg_temp.chk('B: caps 2272 / 2273 / 2273 / 2273 / fee 909 sum to the captured 10000',
  (select jsonb_object_agg(order_item_id, cap_cents) from public._r2_order_line_caps(pg_temp.u('00b001')))
    = jsonb_build_object(pg_temp.u('00c101'), 2272, pg_temp.u('00c102'), 2273, pg_temp.u('00c103'), 2273, pg_temp.u('00c104'), 2273, pg_temp.u('00c1f1'), 909),
  (select jsonb_object_agg(order_item_id, cap_cents)::text from public._r2_order_line_caps(pg_temp.u('00b001'))));
select pg_temp.chk('B: the discount line itself is not refundable',
  not exists (select 1 from public._r2_order_line_caps(pg_temp.u('00b001')) where order_item_id = pg_temp.u('00c1d1')));

-- ============================================================================
-- C. request_competition_order_refund
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('C/D5: a user without owner/admin rights is refused',
  $q$select pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c101', 100, false)))$q$, 'COMP_REFUND_NOT_AUTHORIZED');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('C/D5: another studio''s owner is refused',
  $q$select pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c101', 100, false)))$q$, 'COMP_REFUND_NOT_AUTHORIZED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('C: an order of another event is refused (cross-event)',
  $q$select pg_temp.request('00b003', '00aa01', jsonb_build_array(pg_temp.line('00c301', 100, false)))$q$, 'COMP_REFUND_ORDER_NOT_IN_EVENT');
select pg_temp.expect_msg('C: an item of another order is refused (cross-order)',
  $q$select pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c201', 100, false)))$q$, 'COMP_REFUND_ITEM_NOT_IN_ORDER');
select pg_temp.expect_msg('C/D1: above the net line cap is refused (2273 > 2272)',
  $q$select pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c101', 2273, false)))$q$, 'COMP_REFUND_EXCEEDS_LINE_CAP');
select pg_temp.expect_msg('C/D2: a fee line cannot withdraw an entry',
  $q$select pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c1f1', 100, true)))$q$, 'COMP_REFUND_LINE_INVALID');
select pg_temp.expect_msg('C: duplicate lines are refused',
  $q$select pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c101', 1, false), pg_temp.line('00c101', 1, false)))$q$, 'COMP_REFUND_LINE_DUPLICATE');
select pg_temp.expect_msg('C: a reason is required',
  $q$select public.request_competition_order_refund(pg_temp.u('00e001'), pg_temp.u('00b001'), pg_temp.u('00aa01'), jsonb_build_array(pg_temp.line('00c101', 1, false)), ' ')$q$, 'COMP_REFUND_REASON_REQUIRED');
select pg_temp.expect_msg('C: an empty line list is refused',
  $q$select pg_temp.request('00b001', '00aa01', '[]'::jsonb)$q$, 'COMP_REFUND_LINES_REQUIRED');
insert into t_ids values ('ref1', (pg_temp.request('00b001', '00aa01',
  jsonb_build_array(pg_temp.line('00c101', 2272, true), pg_temp.line('00c1f1', 500, false)))->>'refundId')::uuid);
select pg_temp.chk('C: request 1 recorded as requested with two allocations, total 2772',
  (select status = 'requested' and amount_cents = 2772 and stripe_account_id = 'acct_r2test1' and source = 'staff'
   from public.event_order_refunds where id = pg_temp.id('ref1'))
  and (select count(*) from public.event_order_refund_allocations where refund_id = pg_temp.id('ref1')) = 2);
select pg_temp.chk('C: replay of the same request id returns the same refund',
  (pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c1f1', 500, false), pg_temp.line('00c101', 2272, true)))->>'refundId')::uuid = pg_temp.id('ref1')
  and (select count(*) from public.event_order_refunds where order_id = pg_temp.u('00b001')) = 1);
select pg_temp.expect_msg('C: replay with different lines is refused',
  $q$select pg_temp.request('00b001', '00aa01', jsonb_build_array(pg_temp.line('00c101', 2000, true)))$q$, 'COMP_REFUND_REQUEST_REPLAY_MISMATCH');
select pg_temp.expect_msg('C: a requested refund holds its cap (no second refund of the same line)',
  $q$select pg_temp.request('00b001', '00aa02', jsonb_build_array(pg_temp.line('00c101', 1, false)))$q$, 'COMP_REFUND_EXCEEDS_LINE_CAP');
select pg_temp.expect_msg('C: authenticated cannot call the observe RPC',
  $q$select pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', pg_temp.u('00aa01'), 2772, 'succeeded')$q$, 'permission denied');
select pg_temp.expect_msg('C: authenticated cannot write the ledger directly',
  $q$insert into public.event_order_refunds (event_id, order_id, stripe_account_id, stripe_payment_intent_id, amount_cents, currency, status, source, stripe_refund_id)
     values (pg_temp.u('00e001'), pg_temp.u('00b001'), 'acct_r2test1', 'pi_r2_o1', 1, 'USD', 'succeeded', 'stripe_dashboard', 're_forged')$q$, 'permission denied');
select pg_temp.chk('C: the owner reads its refunds (RLS)', (select count(*) from public.event_order_refunds) = 1);
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.chk('C: another studio''s owner reads none (RLS)', (select count(*) from public.event_order_refunds) = 0);
reset role;

-- ============================================================================
-- D. observe_competition_stripe_refund (as the service role)
-- ============================================================================
select pg_temp.as_service();
select pg_temp.chk('D: a non-competition PaymentIntent is not handled',
  (pg_temp.observe('pi_not_ours', 'acct_r2test1', 're_x', null, 100, 'succeeded')->>'handled')::boolean = false);
select pg_temp.chk('D/PAY-DC-2A: a refund event from another account changes nothing',
  pg_temp.observe('pi_r2_o1', 'acct_someoneelse', 're_r2_1', pg_temp.u('00aa01'), 2772, 'succeeded')->>'outcome' = 'account_mismatch'
  and (select status from public.event_order_refunds where id = pg_temp.id('ref1')) = 'requested');
select pg_temp.expect_msg('D: an amount different from the request is refused',
  $q$select pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', pg_temp.u('00aa01'), 2771, 'pending')$q$, 'COMP_REFUND_AMOUNT_MISMATCH');
select pg_temp.chk('D: requested -> pending binds the Stripe refund id',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', pg_temp.u('00aa01'), 2772, 'pending')->>'status' = 'pending'
  and (select stripe_refund_id from public.event_order_refunds where id = pg_temp.id('ref1')) = 're_r2_1');
select pg_temp.chk('D/REFUND-RECON-1: pending is not refunded money',
  (select payment_status from public.event_orders where id = pg_temp.u('00b001')) = 'paid'
  and (select coalesce(refund_amount, 0) from public.event_payments where stripe_payment_intent_id = 'pi_r2_o1') = 0);
select pg_temp.chk('D: pending -> succeeded applies',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', null, 2772, 'succeeded')->>'outcome' = 'applied');
select pg_temp.chk('D/P: the unplaced entry is withdrawn; outcomes withdrawn / not_applicable',
  pg_temp.entry_status('008101') = 'withdrawn'
  and (select participation_outcome from public.event_order_refund_allocations where refund_id = pg_temp.id('ref1') and order_item_id = pg_temp.u('00c101')) = 'withdrawn'
  and (select participation_outcome from public.event_order_refund_allocations where refund_id = pg_temp.id('ref1') and order_item_id = pg_temp.u('00c1f1')) = 'not_applicable');
select pg_temp.chk('D/F: order partially_refunded, payment refund 27.72 still paid, registration partial',
  (select payment_status from public.event_orders where id = pg_temp.u('00b001')) = 'partially_refunded'
  and (select refund_amount = 27.72 and status = 'paid' and stripe_refund_id = 're_r2_1' and refunded_at is not null
       from public.event_payments where stripe_payment_intent_id = 'pi_r2_o1')
  and (select payment_status from public.event_registrations where id = pg_temp.u('00f101')) = 'partial');
select pg_temp.chk('D/C1: one competition_entry_refund debit entry 27.72 dated today, source event_order_refunds',
  (select count(*) from public.accounting_entries where source_table = 'event_order_refunds' and source_id = pg_temp.id('ref1')) = 1
  and (select category = 'competition_entry_refund' and entry_type = 'refund' and direction = 'debit' and refund_amount = 27.72
              and net_amount = 27.72 and entry_date = current_date
       from public.accounting_entries where source_table = 'event_order_refunds' and source_id = pg_temp.id('ref1')));
select pg_temp.chk('D/C1: the competition revenue entry stays gross (net 100, refund 0)',
  (select ae.net_amount = 100 and ae.refund_amount = 0 and ae.category = 'competition_entry_revenue'
   from public.accounting_entries ae join public.event_payments ep on ep.id = ae.source_id
   where ae.source_table = 'event_payments' and ep.stripe_payment_intent_id = 'pi_r2_o1' and ae.entry_type = 'revenue'));
select pg_temp.chk('D: replay of succeeded is a no-op (no second effect or entry)',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', null, 2772, 'succeeded')->>'outcome' = 'no_change'
  and (select count(*) from public.accounting_entries where source_table = 'event_order_refunds' and source_id = pg_temp.id('ref1')) = 1
  and (select count(*) from public.event_competition_entry_changes where entry_id = pg_temp.u('008101') and change_type = 'withdraw') = 1);
select pg_temp.chk('D: out-of-order pending after succeeded is ignored',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', null, 2772, 'pending')->>'outcome' = 'no_change'
  and (select status from public.event_order_refunds where id = pg_temp.id('ref1')) = 'succeeded');

-- Request 2: the locked (008102), danced (008103) and certified (008104) entries, all with withdraw requested.
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('ref2', (pg_temp.request('00b001', '00aa02',
  jsonb_build_array(pg_temp.line('00c102', 2273, true), pg_temp.line('00c103', 2273, true), pg_temp.line('00c104', 2273, true)))->>'refundId')::uuid);
select pg_temp.as_service();
select pg_temp.chk('D: request 2 created by the server action response directly as succeeded',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_2', pg_temp.u('00aa02'), 6819, 'succeeded')->>'outcome' = 'applied');
select pg_temp.chk('D/D7: held entries are not withdrawn; outcomes exception_open',
  pg_temp.entry_status('008102') = 'confirmed' and pg_temp.entry_status('008103') = 'confirmed' and pg_temp.entry_status('008104') = 'confirmed'
  and (select count(*) from public.event_order_refund_allocations where refund_id = pg_temp.id('ref2') and participation_outcome = 'exception_open') = 3);
select pg_temp.chk('D/Q2: E-L scopes for the locked (heat B) and danced (heat A) entries, competitive, with their rounds',
  exists (select 1 from public.event_competition_refund_exception_scopes where kind = 'competition_refund_entry_locked_heat'
          and entry_id = pg_temp.u('008102') and heat_id = pg_temp.id('heat_b') and round_id = pg_temp.u('006002') and competitive_effect)
  and exists (select 1 from public.event_competition_refund_exception_scopes where kind = 'competition_refund_entry_locked_heat'
          and entry_id = pg_temp.u('008103') and heat_id = pg_temp.id('heat_a') and round_id = pg_temp.u('006001') and competitive_effect));
select pg_temp.chk('D/Q2: the certified entry gets an E-C scope on its certified heat only',
  pg_temp.scopes('competition_refund_entry_certified_heat', '008104') = 1
  and exists (select 1 from public.event_competition_refund_exception_scopes where kind = 'competition_refund_entry_certified_heat'
              and entry_id = pg_temp.u('008104') and heat_id = pg_temp.id('heat_c') and round_id = pg_temp.u('006002')));
select pg_temp.chk('D/K0: the publish predicate blocks rounds 006001 and 006002 only',
  pg_temp.k0_blocked('006001') and pg_temp.k0_blocked('006002') and not pg_temp.k0_blocked('00ffff'));

-- Request 3: the rest of the fee (909 - 500 = 409) makes the order fully refunded.
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('ref3', (pg_temp.request('00b001', '00aa03', jsonb_build_array(pg_temp.line('00c1f1', 409, false)))->>'refundId')::uuid);
select pg_temp.expect_msg('D/D2: nothing is left on the fee line',
  $q$select pg_temp.request('00b001', '00aa04', jsonb_build_array(pg_temp.line('00c1f1', 1, false)))$q$, 'COMP_REFUND_EXCEEDS_LINE_CAP');
select pg_temp.as_service();
select pg_temp.chk('D: request 3 succeeded',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_3', pg_temp.u('00aa03'), 409, 'succeeded')->>'outcome' = 'applied');
select pg_temp.chk('D/F: full refund: order refunded, payment refunded 100.00, registration refunded',
  (select payment_status from public.event_orders where id = pg_temp.u('00b001')) = 'refunded'
  and (select refund_amount = 100 and status = 'refunded' from public.event_payments where stripe_payment_intent_id = 'pi_r2_o1')
  and (select payment_status = 'refunded' and status = 'refunded' from public.event_registrations where id = pg_temp.u('00f101')));
select pg_temp.chk('D/C1: a fully refunded competition payment keeps its gross revenue entry (not voided)',
  (select ae.entry_status = 'active' and ae.net_amount = 100
   from public.accounting_entries ae join public.event_payments ep on ep.id = ae.source_id
   where ae.source_table = 'event_payments' and ep.stripe_payment_intent_id = 'pi_r2_o1' and ae.entry_type = 'revenue')
  and (select sum(refund_amount) from public.accounting_entries where category = 'competition_entry_refund'
       and source_table = 'event_order_refunds' and source_id in (pg_temp.id('ref1'), pg_temp.id('ref2'), pg_temp.id('ref3'))) = 100);
select pg_temp.chk('D: the registration trigger on the full refund adds no duplicate scope',
  (select count(*) from public.event_competition_refund_exception_scopes where entry_id in (pg_temp.u('008102'), pg_temp.u('008103'), pg_temp.u('008104'))) = 3);
select pg_temp.expect_msg('D: no refund beyond the captured amount',
  $q$select pg_temp.request('00b001', '00aa05', jsonb_build_array(pg_temp.line('00c102', 1, false)))$q$, 'COMP_REFUND_');

-- Reversal of refund 1 (Stripe reports succeeded -> failed).
select pg_temp.chk('D: succeeded -> failed reversal applies',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', null, 2772, 'failed')->>'outcome' = 'applied');
select pg_temp.chk('D/F: reversal lowers totals: order partially_refunded, payment 72.28 paid, registration partial',
  (select payment_status from public.event_orders where id = pg_temp.u('00b001')) = 'partially_refunded'
  and (select refund_amount = 72.28 and status = 'paid' from public.event_payments where stripe_payment_intent_id = 'pi_r2_o1')
  and (select payment_status from public.event_registrations where id = pg_temp.u('00f101')) = 'partial');
select pg_temp.chk('D/E-R: the withdrawn entry is never re-instated; a financial-only E-R parent is recorded',
  pg_temp.entry_status('008101') = 'withdrawn'
  and exists (select 1 from public.event_order_settlement_exceptions where kind = 'competition_refund_reversed' and order_id = pg_temp.u('00b001') and status = 'open')
  and pg_temp.scopes('competition_refund_reversed', '008101') = 0);
select pg_temp.chk('D/C1: the reversal is a separate credit entry (the original refund entry is untouched)',
  (select direction = 'credit' and refund_amount = 27.72 and category = 'competition_entry_refund'
   from public.accounting_entries where source_table = 'event_order_refund_reversals' and source_id = pg_temp.id('ref1'))
  and (select direction = 'debit' and refund_amount = 27.72 from public.accounting_entries where source_table = 'event_order_refunds' and source_id = pg_temp.id('ref1')));
select pg_temp.chk('D: a failed refund cannot come back',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_1', null, 2772, 'succeeded')->>'outcome' = 'no_change');

-- Review P1-1: a request the server action marked failed locally (no Stripe id) that Stripe later reports as
-- succeeded must be recorded -- money Stripe moved is never lost.
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('ref5', (pg_temp.request('00b001', '00aa05', jsonb_build_array(pg_temp.line('00c1f1', 100, false)))->>'refundId')::uuid);
select pg_temp.as_service();
select pg_temp.chk('D/P1-1: local failure (no Stripe id) releases the cap',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', null, pg_temp.u('00aa05'), 100, 'failed')->>'status' = 'failed');
select pg_temp.chk('D/P1-1: Stripe later reports that request as succeeded: recorded and applied',
  pg_temp.observe('pi_r2_o1', 'acct_r2test1', 're_r2_5', pg_temp.u('00aa05'), 100, 'succeeded')->>'outcome' = 'applied'
  and (select status = 'succeeded' and stripe_refund_id = 're_r2_5' from public.event_order_refunds where id = pg_temp.id('ref5'))
  and (select count(*) from public.accounting_entries where source_table = 'event_order_refunds' and source_id = pg_temp.id('ref5')) = 1);
reset role;

-- ============================================================================
-- E. Resolution (Q2 gate, K0 coupling)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('E: the generic PAY-WH-1A resolver refuses competition refund exceptions',
  $q$select public.resolve_event_order_settlement_exception((select exception_id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008102')), 'done')$q$,
  'COMP_REFUND_EXCEPTION_GATED');
select pg_temp.expect_msg('E: withdrawn_after_unlock is refused while the entry is still confirmed',
  $q$select public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008102')), 'withdrawn_after_unlock', 'x')$q$,
  'COMP_REFUND_SCOPE_GATE');
select pg_temp.expect_msg('E: keep_entry does not apply to a certified heat',
  $q$select public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008104')), 'keep_entry', 'x')$q$,
  'COMP_REFUND_SCOPE_GATE');
select pg_temp.expect_msg('E/K0: k0_correction needs a K0 result event (F2 not present)',
  $q$select public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008104')), 'k0_correction', 'x')$q$,
  'COMP_REFUND_K0_CORRECTION_UNAVAILABLE');
select pg_temp.expect_msg('E: a note is required',
  $q$select public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008104')), 'result_stands', ' ')$q$,
  'COMP_REFUND_REASON_REQUIRED');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('E: another studio cannot resolve',
  $q$select public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008104')), 'result_stands', 'x')$q$,
  'COMP_REFUND_NOT_AUTHORIZED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('E: result_stands resolves the E-C scope and its parent',
  public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008104')), 'result_stands', 'Certified result stands; refund is financial only.')
  and (select x.status from public.event_order_settlement_exceptions x join public.event_competition_refund_exception_scopes s on s.exception_id = x.id
       where s.entry_id = pg_temp.u('008104')) = 'resolved');
select pg_temp.chk('E: the certified entry, heat and placement are unchanged',
  pg_temp.entry_status('008104') = 'confirmed' and pg_temp.placement('008104') = 'scheduled'
  and (select lock_state from public.event_competition_heats where id = pg_temp.id('heat_c')) = 'certified');
select pg_temp.expect_ok('E: audited unlock of heat B, then withdraw the locked entry',
  $q$select public.set_competition_heat_lock_state(pg_temp.id('heat_b'), 'open', 'Refunded entry withdrawal');
     select public.change_competition_entry_lifecycle(pg_temp.u('008102'), 'withdrawn', 'Refunded', 'refund')$q$);
select pg_temp.chk('E: withdrawn_after_unlock now resolves the scope',
  public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008102')), 'withdrawn_after_unlock', 'Withdrawn after unlock.'));
select pg_temp.chk('E: round 006002 is still blocked by 008006 (trigger E-L) and unblocked after it is resolved',
  pg_temp.k0_blocked('006002')
  and public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008006')), 'keep_entry', 'Kept by official decision.')
  and not pg_temp.k0_blocked('006002'));
select pg_temp.chk('E: keep_entry for the danced entries resolves the last E-L scopes and the parent',
  public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008103')), 'keep_entry', 'Danced; kept.')
  and public.resolve_competition_refund_scope((select id from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008004')), 'keep_entry', 'Danced; kept.')
  and not pg_temp.k0_blocked('006001')
  and not exists (select 1 from public.event_order_settlement_exceptions where kind = 'competition_refund_entry_locked_heat' and status <> 'resolved'));
select pg_temp.chk('E: each resolution is audited',
  (select count(*) from public.event_order_settlement_exception_events where action = 'scope_resolved') = 5);
select pg_temp.expect_msg('E: a resolved scope cannot be resolved again',
  $q$update public.event_competition_refund_exception_scopes set resolution_note = 'x' where entry_id = pg_temp.u('008102')$q$, 'permission denied');
reset role;
select pg_temp.expect_msg('E: scopes are append-only even for the owner role',
  $q$update public.event_competition_refund_exception_scopes set resolution_note = 'x' where entry_id = pg_temp.u('008102')$q$, 'COMP_REFUND_SCOPE_IMMUTABLE');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('E: the E-R parent resolves with a note once no scope is open',
  public.resolve_competition_refund_exception((select id from public.event_order_settlement_exceptions where kind = 'competition_refund_reversed' and order_id = pg_temp.u('00b001')), 'Reversal acknowledged; entry stays withdrawn.'));

-- ============================================================================
-- F. Dashboard refunds (D6) on O2
-- ============================================================================
select pg_temp.as_service();
select pg_temp.chk('F: an unknown Stripe refund is recorded as a dashboard refund',
  pg_temp.observe('pi_r2_o2', 'acct_r2test1', 're_r2_d1', null, 1000, 'succeeded')->>'outcome' = 'applied'
  and (select source = 'stripe_dashboard' and amount_cents = 1000 from public.event_order_refunds where stripe_refund_id = 're_r2_d1'));
select pg_temp.chk('F/D6: a partial dashboard refund opens a financial-only unattributed exception; no entry change',
  exists (select 1 from public.event_order_settlement_exceptions where kind = 'competition_refund_unattributed' and order_id = pg_temp.u('00b002') and status = 'open')
  and pg_temp.scopes('competition_refund_unattributed', '008105') = 0
  and pg_temp.entry_status('008105') = 'confirmed'
  and (select payment_status from public.event_orders where id = pg_temp.u('00b002')) = 'partially_refunded');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('F: the unattributed exception cannot be resolved before attribution',
  $q$select public.resolve_competition_refund_exception((select id from public.event_order_settlement_exceptions where kind = 'competition_refund_unattributed' and order_id = pg_temp.u('00b002')), 'x')$q$,
  'COMP_REFUND_SCOPE_GATE');
select pg_temp.expect_msg('F: attribution must equal the refund amount',
  $q$select public.attribute_competition_refund((select id from public.event_order_refunds where stripe_refund_id = 're_r2_d1'), jsonb_build_array(pg_temp.line('00c201', 900, true)))$q$,
  'COMP_REFUND_ATTRIBUTION_MISMATCH');
select pg_temp.chk('F: attribution applies participation and resolves the exception',
  (public.attribute_competition_refund((select id from public.event_order_refunds where stripe_refund_id = 're_r2_d1'),
     jsonb_build_array(pg_temp.line('00c201', 1000, true)))->>'attributed')::boolean
  and pg_temp.entry_status('008105') = 'withdrawn'
  and (select status from public.event_order_settlement_exceptions where kind = 'competition_refund_unattributed' and order_id = pg_temp.u('00b002')) = 'resolved');
select pg_temp.as_service();
select pg_temp.chk('F/D6: a dashboard refund of the remainder fully refunds the order without a new exception',
  pg_temp.observe('pi_r2_o2', 'acct_r2test1', 're_r2_d2', null, 2000, 'succeeded')->>'outcome' = 'applied'
  and (select payment_status from public.event_orders where id = pg_temp.u('00b002')) = 'refunded'
  and (select status from public.event_order_settlement_exceptions where kind = 'competition_refund_unattributed' and order_id = pg_temp.u('00b002')) = 'resolved');
reset role;

-- ============================================================================
-- G. Ledger immutability; non-competition accounting unchanged
-- ============================================================================
select pg_temp.expect_msg('G: a refund amount cannot change',
  $q$update public.event_order_refunds set amount_cents = 1 where id = pg_temp.id('ref2')$q$, 'COMP_REFUND_LEDGER_IMMUTABLE');
select pg_temp.expect_msg('G: a refund cannot be deleted',
  $q$delete from public.event_order_refunds where id = pg_temp.id('ref2')$q$, 'COMP_REFUND_LEDGER_IMMUTABLE');
select pg_temp.expect_msg('G: a participation outcome is written once',
  $q$update public.event_order_refund_allocations set participation_outcome = 'withdrawn' where refund_id = pg_temp.id('ref2') and order_item_id = pg_temp.u('00c104')$q$,
  'COMP_REFUND_LEDGER_IMMUTABLE');
select pg_temp.expect_msg('G: a bound Stripe refund id cannot change',
  $q$update public.event_order_refunds set stripe_refund_id = 're_other' where id = pg_temp.id('ref2')$q$, 'COMP_REFUND_LEDGER_IMMUTABLE');

-- Review P2-5: after an E-L scope was resolved (008103 keep_entry for refund 2), a NEW refund on the same held
-- entry opens a new scope and reopens the parent; a replay of that refund adds nothing.
select pg_temp.chk('G/P2-5: a new refund on a resolved held entry opens a new scope and reopens the parent',
  public._r2_record_refund_exception('competition_refund_entry_locked_heat', pg_temp.u('00b001'), pg_temp.u('00e001'),
    pg_temp.u('00f101'), pg_temp.id('ref3'), pg_temp.u('008103'), 1, 'USD') is not null
  and (select count(*) from public.event_competition_refund_exception_scopes
       where entry_id = pg_temp.u('008103') and kind = 'competition_refund_entry_locked_heat' and resolved_at is null) = 1
  and exists (select 1 from public.event_order_settlement_exceptions x join public.event_competition_refund_exception_scopes s on s.exception_id = x.id
              where s.entry_id = pg_temp.u('008103') and s.refund_id = pg_temp.id('ref3') and x.status = 'open'));
select pg_temp.chk('G/P2-5: replaying that refund adds no scope',
  public._r2_record_refund_exception('competition_refund_entry_locked_heat', pg_temp.u('00b001'), pg_temp.u('00e001'),
    pg_temp.u('00f101'), pg_temp.id('ref3'), pg_temp.u('008103'), 1, 'USD') is null
  and (select count(*) from public.event_competition_refund_exception_scopes where entry_id = pg_temp.u('008103')) = 2);

-- Non-competition (orderless registration 00f006): partial refund nets out of event_ticket_revenue; a refunded
-- payment voids it -- exactly as before R2.
insert into public.event_payments (id, registration_id, amount, currency, payment_method, status, source)
values (pg_temp.u('00d001'), pg_temp.u('00f006'), 20, 'USD', 'cash', 'paid', 'manual');
update public.event_payments set refund_amount = 5 where id = pg_temp.u('00d001');
select pg_temp.chk('G: non-competition partial refund still nets out of event_ticket_revenue',
  (select category = 'event_ticket_revenue' and refund_amount = 5 and net_amount = 15 and entry_status = 'active'
   from public.accounting_entries where source_table = 'event_payments' and source_id = pg_temp.u('00d001') and entry_type = 'revenue'));
update public.event_payments set status = 'refunded', refund_amount = 20 where id = pg_temp.u('00d001');
select pg_temp.chk('G: a refunded non-competition payment is still voided',
  (select entry_status from public.accounting_entries where source_table = 'event_payments' and source_id = pg_temp.u('00d001') and entry_type = 'revenue') = 'voided');
select pg_temp.chk('G: no competition_entry_refund entry for non-competition payments',
  not exists (select 1 from public.accounting_entries where category = 'competition_entry_refund' and source_table = 'event_payments'));

select pg_temp.chk('G: grants: request/attribute/resolve for authenticated; observe service-role only',
  has_function_privilege('authenticated', 'public.request_competition_order_refund(uuid, uuid, uuid, jsonb, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.request_competition_order_refund(uuid, uuid, uuid, jsonb, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._r2_recompute_order(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._r2_withdraw_entry(uuid, text, text)', 'EXECUTE'));

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION R2 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION R2 SQL SUITE FAIL: %', v_failures;
end $$;
