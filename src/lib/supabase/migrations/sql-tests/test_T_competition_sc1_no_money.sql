-- SC1 -- "a scratch moves no money" regression suite (design: a scratch writes fee_handling 'retain' and calls no payment code).
--
-- Covers 20270108090000_competition_sc1_scratch.sql against a REAL paid order. A money signature is taken over every
-- table a refund, a cap reservation or a posting could touch (orders, items, registrations, payments, accounting entries,
-- and the R2 refund ledger / allocations / exception scopes when R2 is installed). It must be byte-identical after every scratch path:
-- normal, official locked-heat, policy-exception "Refund", policy default "Refund", policy changes, and a scratch of every entry of one order.
-- One transaction; the final block ALWAYS raises: "SC1 NO-MONEY SUITE PASS (<n> checks)" or "... FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-00005d' || p_suffix)::uuid $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.scratch(p_entry text, p_request text, p_reason text default null, p_resolution text default null) returns text
language sql as $$
  select format('select public.scratch_competition_entry(%L, %L, %L, %L)', pg_temp.u(p_entry), pg_temp.u(p_request), p_reason, p_resolution);
$$;
-- The money signature: every row of every money-bearing table of this event's orders, as JSON, hashed. Tables that do not exist (R2) are skipped.
create or replace function pg_temp.money_sig() returns text
language plpgsql as $$
declare
  v_parts text[] := '{}';
  v_t text;
  v_sig text;
begin
  foreach v_t in array array['event_orders', 'event_order_items', 'event_registrations', 'event_payments', 'accounting_entries',
                             'event_order_refunds', 'event_order_refund_allocations', 'event_order_settlement_exceptions',
                             'event_competition_refund_exception_scopes', 'payments'] loop
    if to_regclass('public.' || v_t) is not null then
      execute format('select coalesce(md5(string_agg(to_jsonb(t)::text, ''|'' order by to_jsonb(t)::text)), ''empty'') from public.%I t', v_t) into v_sig;
      v_parts := v_parts || (v_t || '=' || v_sig);
    end if;
  end loop;
  return array_to_string(v_parts, ';');
end $$;
create or replace function pg_temp.money_rows() returns bigint
language plpgsql as $$
declare v_n bigint := 0; v_c bigint; v_t text;
begin
  foreach v_t in array array['event_order_refunds', 'event_order_refund_allocations', 'event_competition_refund_exception_scopes'] loop
    if to_regclass('public.' || v_t) is not null then
      execute format('select count(*) from public.%I', v_t) into v_c; v_n := v_n + v_c;
    end if;
  end loop;
  select v_n + count(*) into v_n from public.accounting_entries where category ilike '%refund%';
  return v_n;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres): a paid order of six entries; a refund policy program; heats open and locked.
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-sc1nm-owner@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-sc1nm-owner@example.test', 'Owner');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'SC1 NM Studio', 't-sc1nm-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.u('00e001'), pg_temp.u('00a001'), 'SC1 NM Comp', 't-sc1nm-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze Couples', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number)
values (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, name) values
  (pg_temp.u('009001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, 'Open heat'),
  (pg_temp.u('009002'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 2, 'Locked heat');

insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, discount_amount, total_amount, currency, status, payment_status,
  settlement_state, paid_at, stripe_payment_intent_id, stripe_checkout_session_id, metadata)
values (pg_temp.u('00b001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer', 't-sc1nm-buyer@example.test', 150, 0, 150, 'USD', 'confirmed', 'paid', 'paid', now(),
        'pi_sc1nm', 'cs_sc1nm', '{}');
insert into public.event_registrations (id, order_id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email, status, payment_status, total_price, currency)
values (pg_temp.u('00f001'), pg_temp.u('00b001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Buyer', 'One', 't-sc1nm-buyer@example.test', 'confirmed', 'paid', 150, 'USD');
insert into public.event_order_items (id, order_id, event_id, item_type, description, quantity, unit_price, total_price, currency, metadata)
select pg_temp.u('00c10' || n), pg_temp.u('00b001'), pg_temp.u('00e001'), 'competition_entry', 'Entry ' || n, 1, 25, 25, 'USD',
       jsonb_build_object('revenue_class', 'competition_entry', 'contest_id', pg_temp.u('002001'))
from generate_series(1, 6) n;
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, stripe_payment_intent_id, stripe_checkout_session_id, stripe_account_id)
values (pg_temp.u('00f001'), 150, 'USD', 'card', 'paid', 'stripe', 'pi_sc1nm', 'cs_sc1nm', 'acct_sc1nm');

insert into public.event_competition_entries (id, event_id, program_id, division_id, registration_id, order_id, order_item_id, display_name, status, eligibility_status)
select pg_temp.u('00800' || n), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('00f001'), pg_temp.u('00b001'), pg_temp.u('00c10' || n),
       'Entry ' || n, 'confirmed', 'eligible'
from generate_series(1, 6) n;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, status)
select pg_temp.u('00e001'), pg_temp.u('003001'), case when n = 2 then pg_temp.u('009002') else pg_temp.u('009001') end, pg_temp.u('00800' || n), 'scheduled'
from generate_series(1, 6) n;
set constraints all immediate;
set constraints all deferred;
select pg_temp.as_user(pg_temp.u('000001'));
select public.set_competition_heat_lock_state(pg_temp.u('009002'), 'locked', 'Check-in done');
reset role;

create temp table t_sig (k text primary key, v text, n bigint) on commit drop;
insert into t_sig select 'base', pg_temp.money_sig(), pg_temp.money_rows();
select pg_temp.chk('fixture: a paid order with six entries and a captured payment',
  (select payment_status from public.event_orders where id = pg_temp.u('00b001')) = 'paid'
  and (select count(*) from public.event_competition_entries where order_id = pg_temp.u('00b001')) = 6
  and (select sum(amount) from public.event_payments where stripe_payment_intent_id = 'pi_sc1nm') = 150);
select pg_temp.chk('fixture: the money signature covers the order, items, registration, payment and accounting tables',
  (select v from t_sig where k = 'base') like '%event_orders=%' and (select v from t_sig where k = 'base') like '%event_payments=%'
  and (select v from t_sig where k = 'base') like '%accounting_entries=%' and (select v from t_sig where k = 'base') like '%event_registrations=%');

-- ============================================================================
-- Every scratch path leaves the money signature unchanged
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('normal scratch of an entry of the paid order (open heat)', pg_temp.scratch('008001', 'f00001'));
reset role;
select pg_temp.chk('normal scratch: money signature unchanged', pg_temp.money_sig() = (select v from t_sig where k = 'base'));
select pg_temp.chk('normal scratch: entry scratched, fee handling retain, no refund-ish row anywhere',
  (select status from public.event_competition_entries where id = pg_temp.u('008001')) = 'scratched'
  and exists (select 1 from public.event_competition_entry_changes where entry_id = pg_temp.u('008001') and change_type = 'scratch' and fee_handling = 'retain')
  and pg_temp.money_rows() = (select n from t_sig where k = 'base'));

select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('official locked-heat scratch (S-D2)', pg_temp.scratch('008002', 'f00002', 'Medical withdrawal at the desk'));
reset role;
select pg_temp.chk('official locked-heat scratch: money signature unchanged', pg_temp.money_sig() = (select v from t_sig where k = 'base'));
select pg_temp.chk('official locked-heat scratch: path recorded, heat still locked, no refund rows',
  exists (select 1 from public.event_competition_scratches where entry_id = pg_temp.u('008002') and path = 'official_locked')
  and (select lock_state from public.event_competition_heats where id = pg_temp.u('009002')) = 'locked'
  and pg_temp.money_rows() = (select n from t_sig where k = 'base'));

select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('policy-exception scratch: official chooses "Refund" with a reason (records the choice only)', pg_temp.scratch('008003', 'f00003', 'Family emergency', 'refund'));
reset role;
select pg_temp.chk('"Refund" exception: money signature unchanged', pg_temp.money_sig() = (select v from t_sig where k = 'base'));
select pg_temp.chk('"Refund" exception: recorded as an exception, fee handling still retain, no refund rows',
  exists (select 1 from public.event_competition_scratches where entry_id = pg_temp.u('008003') and requested_resolution = 'refund' and is_exception)
  and not exists (select 1 from public.event_competition_entry_changes where entry_id = pg_temp.u('008003') and fee_handling is distinct from 'retain' and change_type = 'scratch')
  and pg_temp.money_rows() = (select n from t_sig where k = 'base'));

select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the program policy is changed to Refund (with a reason)',
  format($q$select public.set_competition_scratch_policy(%L, 'refund', 'Weather: refund policy')$q$, pg_temp.u('001001')));
reset role;
select pg_temp.chk('policy change: money signature unchanged', pg_temp.money_sig() = (select v from t_sig where k = 'base'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('scratch under the Refund policy default (not an exception)', pg_temp.scratch('008004', 'f00004'));
reset role;
select pg_temp.chk('Refund policy default: money signature unchanged and no refund rows',
  pg_temp.money_sig() = (select v from t_sig where k = 'base') and pg_temp.money_rows() = (select n from t_sig where k = 'base'));

-- Scratching EVERY entry of the order (the registration is left with no live entry) still touches no money.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('scratch the fifth entry', pg_temp.scratch('008005', 'f00005'));
select pg_temp.expect_ok('scratch the sixth (last live) entry', pg_temp.scratch('008006', 'f00006'));
reset role;
select pg_temp.chk('all six entries of the paid order scratched',
  (select count(*) from public.event_competition_entries where order_id = pg_temp.u('00b001') and status = 'scratched') = 6);
select pg_temp.chk('all entries scratched: money signature unchanged (order, registration, payment stay paid; no accounting posted)',
  pg_temp.money_sig() = (select v from t_sig where k = 'base')
  and (select payment_status from public.event_orders where id = pg_temp.u('00b001')) = 'paid'
  and (select payment_status from public.event_registrations where id = pg_temp.u('00f001')) = 'paid'
  and (select status from public.event_payments where stripe_payment_intent_id = 'pi_sc1nm') = 'paid');

-- The scratch RPC reserves no refund cap: when R2 is installed, the full order is still refundable after scratching all its entries.
select pg_temp.chk('R2 (when installed): the refund ledger holds nothing for this order after every scratch',
  to_regclass('public.event_order_refunds') is null
  or (select count(*) from public.event_order_refunds where order_id = pg_temp.u('00b001')) = 0);

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
    raise exception 'SC1 NO-MONEY SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'SC1 NO-MONEY SUITE FAIL: %', v_failures;
end $$;
