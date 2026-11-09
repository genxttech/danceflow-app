-- Competition CF1 RB3R -- fail-closed refund evidence + authorized reconciliation (20270120104000_competition_cf1_rb3_evidence_reconciliation.sql).
-- Requires R2 (20270103090000) applied, RB3 (20270120102000) applied, then RB3R. Run as a SUPERUSER (fixtures use session_replication_role = replica).
-- EVERY REFUND ROW IS A FIXTURE (stripe ids FIXTURE_*): not Stripe settlement evidence; no Stripe call exists here.
-- One transaction; the final block always raises: COMPETITION CF1 RB3R SQL SUITE PASS (<n> checks, <b> blocked) or FAIL: <failures>.

begin;

-- R2 refund write gate (20270103091000, when installed): the legacy states below (a payment row whose refund amount the ledger does not prove) are exactly what the gate now prevents from
-- being created. This suite simulates pre-gate history, so it disables the two gate triggers inside this rolled-back transaction (DDL is transactional; nothing outlives the transaction).
do $g$ begin
  if to_regclass('public.event_payments') is not null and exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_payments'::regclass and t.tgname = 'r2g_guard_event_payment_refund_ins') then
    alter table public.event_payments disable trigger r2g_guard_event_payment_refund_ins;
    alter table public.event_payments disable trigger r2g_guard_event_payment_refund_upd;
  end if;
end $g$;

create temp table t_results (name text, ok boolean, detail text, status text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'), case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end);
end $$;
create or replace function pg_temp.blocked(p_name text, p_why text) returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, true, p_why, 'BLOCKED');
end $$;
-- The statement must fail with a message containing p_fragment (case-insensitive); p_state, when given, must equal the SQLSTATE.
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text, p_state text default null) returns void
language plpgsql as $$
declare v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      perform pg_temp.chk(p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state), sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    perform pg_temp.chk(p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-cf1b30' || p_suffix)::uuid $$;
create or replace function pg_temp.us(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('0000' || lpad(p_n::text, 2, '0')) $$;
-- ids per case number n: order, registration, entry, item, refund, refund request, decision request
create or replace function pg_temp.o(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('0a' || lpad(to_hex(p_n), 4, '0')) $$;
create or replace function pg_temp.r(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('0b' || lpad(to_hex(p_n), 4, '0')) $$;
create or replace function pg_temp.en(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('08' || lpad(to_hex(p_n), 4, '0')) $$;
create or replace function pg_temp.it(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('0d' || lpad(to_hex(p_n), 4, '0')) $$;
create or replace function pg_temp.rf(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('0f' || lpad(to_hex(p_n), 4, '0')) $$;
create or replace function pg_temp.rq(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('0e' || lpad(to_hex(p_n), 4, '0')) $$;
create or replace function pg_temp.dq(p_n int) returns uuid language sql immutable as $$ select pg_temp.u('0c' || lpad(to_hex(p_n), 4, '0')) $$;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- Runs p_sql (returning jsonb) as p_user; returns the result; always resets the role.
create or replace function pg_temp.do_as(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  execute p_sql into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  raise;
end $$;
-- The SQLSTATE + message of the error p_sql raises as p_user (null when it succeeds).
create or replace function pg_temp.err_as(p_user uuid, p_sql text) returns text language plpgsql as $$
begin
  perform pg_temp.do_as(p_user, p_sql);
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;

-- action wrappers (SQL text for do_as)
create or replace function pg_temp.q_req(p_entry int, p_dq int, p_reason text default 'Staff confirm the entry continues to compete despite the partial refund.') returns text language sql immutable as $$
  select format('select public.request_cf1_refund_evidence_release(%L, %L, %L)', pg_temp.en(p_entry), p_reason, pg_temp.dq(p_dq)) $$;
create or replace function pg_temp.q_cos(p_decision uuid, p_dq int) returns text language sql immutable as $$
  select format('select public.cosign_cf1_refund_evidence_release(%L, %L)', p_decision, pg_temp.dq(p_dq)) $$;
create or replace function pg_temp.q_rev(p_entry int, p_dq int, p_reason text default 'Revoked: the competitor will not continue in this division.') returns text language sql immutable as $$
  select format('select public.revoke_cf1_refund_evidence_release(%L, %L, %L)', pg_temp.en(p_entry), p_reason, pg_temp.dq(p_dq)) $$;
create or replace function pg_temp.decision_of(p_entry int, p_kind text) returns uuid language sql stable as $$
  select id from public.competition_cf1_rb3_reconciliations where entry_id = pg_temp.en(p_entry) and kind = p_kind order by seq desc limit 1 $$;
create or replace function pg_temp.nrows(p_entry int) returns bigint language sql stable as $$
  select count(*) from public.competition_cf1_rb3_reconciliations where entry_id = pg_temp.en(p_entry) $$;

-- fixture helpers (call under session_replication_role = replica)
create or replace function pg_temp.mk(p_n int, p_ostatus text default 'paid', p_rstatus text default 'paid', p_noorder boolean default false) returns void language plpgsql as $$
begin
  insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status)
  values (pg_temp.o(p_n), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b' || p_n || '@example.test', p_ostatus);
  insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email)
  values (pg_temp.r(p_n), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.o(p_n), 'confirmed', p_rstatus, 'G', 'C' || p_n, 'g' || p_n || '@example.test');
  insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id, order_id)
  values (pg_temp.en(p_n), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'c' || p_n, 'confirmed', 'eligible', 'x' || p_n, pg_temp.r(p_n),
          case when p_noorder then null else pg_temp.o(p_n) end);
end $$;
-- an extra entry (case p_m) on the order and registration of case p_n
create or replace function pg_temp.mk2(p_n int, p_m int) returns void language plpgsql as $$
begin
  insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id, order_id)
  values (pg_temp.en(p_m), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'c' || p_m, 'confirmed', 'eligible', 'x' || p_m, pg_temp.r(p_n), pg_temp.o(p_n));
end $$;
create or replace function pg_temp.item(p_n int, p_order int, p_type text default 'competition_entry', p_price numeric default 100) returns void language plpgsql as $$
begin
  insert into public.event_order_items (id, order_id, event_id, item_type, description, quantity, unit_price, total_price)
  values (pg_temp.it(p_n), pg_temp.o(p_order), pg_temp.u('00e001'), p_type, 'item ' || p_n, 1, p_price, p_price);
end $$;
create or replace function pg_temp.refund(p_n int, p_order int, p_status text, p_source text, p_cents bigint, p_with_reg boolean default true) returns void language plpgsql as $$
begin
  insert into public.event_order_refunds (id, event_id, order_id, registration_id, refund_request_id, stripe_refund_id, stripe_account_id, stripe_payment_intent_id,
                                          amount_cents, currency, status, source, succeeded_at)
  values (pg_temp.rf(p_n), pg_temp.u('00e001'), pg_temp.o(p_order), case when p_with_reg then pg_temp.r(p_order) else null end,
          case when p_source = 'staff' then pg_temp.rq(p_n) else null end,
          case when p_status = 'requested' then null else 'FIXTURE_re_' || p_n end, 'acct_FIXTURE', 'FIXTURE_pi_' || p_order,
          p_cents, 'usd', p_status, p_source, case when p_status = 'succeeded' then now() else null end);
end $$;
create or replace function pg_temp.alloc(p_refund int, p_order int, p_item int, p_entry int, p_kind text, p_cents bigint, p_wd boolean, p_outcome text) returns void language plpgsql as $$
begin
  insert into public.event_order_refund_allocations (refund_id, event_id, order_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry, participation_outcome)
  values (pg_temp.rf(p_refund), pg_temp.u('00e001'), pg_temp.o(p_order), pg_temp.it(p_item), case when p_entry is null then null else pg_temp.en(p_entry) end, p_kind, p_cents, p_wd, p_outcome);
end $$;
create or replace function pg_temp.pay(p_n int, p_amount numeric, p_refund numeric, p_status text default 'paid') returns void language plpgsql as $$
begin
  insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, refund_amount)
  values (pg_temp.r(p_n), p_amount, 'USD', 'cash', p_status, 'manual', p_refund);
end $$;
create or replace function pg_temp.reason(p_n int) returns text language sql stable as $$ select public._cf1_entry_unavailable_reason(pg_temp.en(p_n)) $$;
create or replace function pg_temp.raw(p_n int) returns text language sql stable as $$ select (public._cf1_rb3_raw(pg_temp.en(p_n))).reason $$;
create or replace function pg_temp.rel(p_n int) returns boolean language sql stable as $$ select (public._cf1_rb3_raw(pg_temp.en(p_n))).releasable $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures
-- ============================================================================
do $$
declare r record;
begin
  for r in select t.tgname, t.tgrelid::regclass as rel from pg_trigger t
           where not t.tgisinternal and t.tgname like 'cf1_%'
             and t.tgrelid in ('public.event_competition_heats'::regclass, 'public.event_competition_heat_entries'::regclass,
                               'public.event_competition_rounds'::regclass, 'public.event_competition_entries'::regclass) loop
    execute format('alter table %s disable trigger %I', r.rel, r.tgname);
  end loop;
end $$;

-- users: 1,2 managers (verified), 3 manager WITHOUT verified email, 4 manager of ANOTHER studio, 5 no role (verified)
insert into auth.users (id, email) values
  (pg_temp.us(1), 't-rb3r-a@example.test'), (pg_temp.us(2), 't-rb3r-b@example.test'), (pg_temp.us(3), 't-rb3r-c@example.test'),
  (pg_temp.us(4), 't-rb3r-d@example.test'), (pg_temp.us(5), 't-rb3r-e@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'RB3R ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-cf1b30%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-cf1b30%' and id <> pg_temp.us(3);
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'RB3R Studio A', 't-rb3r-studio-a'), (pg_temp.u('00b001'), 'RB3R Studio B', 't-rb3r-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.us(1), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.us(2), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.us(3), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.us(4), pg_temp.u('00b001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'RB3R Comp', 't-rb3r-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D1', 'open');

set session_replication_role = replica;
-- 1 releasable: partial staff refund 3000, fully allocated, withdraw false; order partially_refunded; payment refund 30.00 = ledger
select pg_temp.mk(1, 'partially_refunded', 'partial'); select pg_temp.item(1, 1); select pg_temp.pay(1, 100, 30);
select pg_temp.refund(1, 1, 'succeeded', 'staff', 3000); select pg_temp.alloc(1, 1, 1, 1, 'entry', 3000, false, 'not_requested');
-- 2 withdraw_entry = true, outcome withdrawn on a still-confirmed entry (recorded, NOT releasable)
select pg_temp.mk(2, 'partially_refunded', 'partial'); select pg_temp.item(2, 2); select pg_temp.pay(2, 100, 100);
select pg_temp.refund(2, 2, 'succeeded', 'staff', 10000); select pg_temp.alloc(2, 2, 2, 2, 'entry', 10000, true, 'withdrawn');
-- 3 withdrawal blocked (exception_open)
select pg_temp.mk(3, 'partially_refunded', 'partial'); select pg_temp.item(3, 3); select pg_temp.pay(3, 100, 100);
select pg_temp.refund(3, 3, 'succeeded', 'staff', 10000); select pg_temp.alloc(3, 3, 3, 3, 'entry', 10000, true, 'exception_open');
-- 4 pending staff refund, fully allocated to the entry
select pg_temp.mk(4); select pg_temp.item(4, 4); select pg_temp.refund(4, 4, 'pending', 'staff', 3000); select pg_temp.alloc(4, 4, 4, 4, 'entry', 3000, false, null);
-- 5 dashboard succeeded refund, no allocation at all (RB3 G5)
select pg_temp.mk(5, 'partially_refunded', 'partial'); select pg_temp.pay(5, 100, 25); select pg_temp.refund(5, 5, 'succeeded', 'stripe_dashboard', 2500, false);
-- 6, 7 PARTIALLY attributed: succeeded staff refund 5000, allocation 3000 on entry 6 only; second entry 7 on the same order
select pg_temp.mk(6, 'partially_refunded', 'partial'); select pg_temp.mk2(6, 7); select pg_temp.item(6, 6); select pg_temp.item(7, 6); select pg_temp.pay(6, 200, 50);
select pg_temp.refund(6, 6, 'succeeded', 'staff', 5000); select pg_temp.alloc(6, 6, 6, 6, 'entry', 3000, false, 'not_requested');
-- 8, 9 OVER-attributed: refund 3000, allocations 2500 (entry 8) + 1500 (fee); second entry 9 on the order without allocation
select pg_temp.mk(8, 'partially_refunded', 'partial'); select pg_temp.mk2(8, 9); select pg_temp.item(8, 8); select pg_temp.item(9, 8, 'add_on', 15); select pg_temp.pay(8, 200, 30);
select pg_temp.refund(8, 8, 'succeeded', 'staff', 3000); select pg_temp.alloc(8, 8, 8, 8, 'entry', 2500, false, 'not_requested'); select pg_temp.alloc(8, 8, 9, null, 'fee', 1500, false, 'not_applicable');
-- 10 STAFF-sourced succeeded refund without any allocation
select pg_temp.mk(10, 'partially_refunded', 'partial'); select pg_temp.pay(10, 100, 40); select pg_temp.refund(10, 10, 'succeeded', 'staff', 4000);
select pg_temp.item(99, 10, 'add_on', 40);
-- 11 requested staff refund without allocation
select pg_temp.mk(11); select pg_temp.refund(11, 11, 'requested', 'staff', 4000);
-- 12 pending dashboard refund, no allocation
select pg_temp.mk(12); select pg_temp.refund(12, 12, 'pending', 'stripe_dashboard', 1000, false);
-- 13 order says partially_refunded, ledger has NO refund
select pg_temp.mk(13, 'partially_refunded', 'paid');
-- 14 desk (cash) refund recorded on the payment only
select pg_temp.mk(14); select pg_temp.pay(14, 100, 20);
-- 15 payment marked refunded, no ledger refund, refund_amount 0
select pg_temp.mk(15); select pg_temp.pay(15, 100, 0, 'refunded');
-- 16 entry has NO order; its registration's order has an unattributed succeeded refund (matched by registration_id)
select pg_temp.mk(16, 'paid', 'paid', true); select pg_temp.refund(16, 16, 'succeeded', 'stripe_dashboard', 2500, true);
-- 17 failed and canceled refunds only (reversal): clean
select pg_temp.mk(17); select pg_temp.refund(17, 17, 'failed', 'stripe_dashboard', 1000, false); select pg_temp.refund(18, 17, 'canceled', 'staff', 1000);
-- 19 clean order
select pg_temp.mk(19);
-- 20, 21: refund fully attributed to entry 21; entry 20 shares the order and stays available
select pg_temp.mk(21, 'partially_refunded', 'partial'); select pg_temp.mk2(21, 20); select pg_temp.item(21, 21); select pg_temp.item(22, 21); select pg_temp.pay(21, 200, 30);
select pg_temp.refund(21, 21, 'succeeded', 'staff', 3000); select pg_temp.alloc(21, 21, 21, 21, 'entry', 3000, false, 'not_requested');
-- 23, 24, 25, 26: more releasable entries (stale / evidence-change / no-longer-releasable / forged-row flows)
select pg_temp.mk(23, 'partially_refunded', 'partial'); select pg_temp.item(23, 23); select pg_temp.pay(23, 100, 30);
select pg_temp.refund(23, 23, 'succeeded', 'staff', 3000); select pg_temp.alloc(23, 23, 23, 23, 'entry', 3000, false, 'not_requested');
select pg_temp.mk(24, 'partially_refunded', 'partial'); select pg_temp.item(24, 24); select pg_temp.pay(24, 100, 30);
select pg_temp.refund(24, 24, 'succeeded', 'staff', 3000); select pg_temp.alloc(24, 24, 24, 24, 'entry', 3000, false, 'not_requested');
-- 25 payments refund SMALLER than the ledger (ledger ahead): not a hidden refund
select pg_temp.mk(25, 'partially_refunded', 'partial'); select pg_temp.item(25, 25); select pg_temp.pay(25, 100, 0);
select pg_temp.refund(25, 25, 'succeeded', 'staff', 3000); select pg_temp.alloc(25, 25, 25, 25, 'entry', 3000, false, 'not_requested');
select pg_temp.mk(26, 'partially_refunded', 'partial'); select pg_temp.item(26, 26); select pg_temp.pay(26, 100, 30);
select pg_temp.refund(26, 26, 'succeeded', 'staff', 3000); select pg_temp.alloc(26, 26, 26, 26, 'entry', 3000, false, 'not_requested');
set session_replication_role = origin;

-- ============================================================================
-- 1. Fail-closed classification (each hole closed; each has a test)
-- ============================================================================
select pg_temp.chk('RB3R mode is r2_ledger', public._cf1_refund_evidence_mode() = 'r2_ledger');
select pg_temp.chk('RB3R gate passes in r2_ledger mode', public._cf1_od17_refund_gate() = 'r2_ledger');
select pg_temp.chk('RB3R F1 partial succeeded refund fully allocated, withdraw false -> entry_refund_recorded, releasable', pg_temp.reason(1) = 'entry_refund_recorded' and pg_temp.rel(1));
select pg_temp.chk('RB3R F2 withdraw_entry = true, outcome withdrawn, entry still confirmed -> recorded, NOT releasable', pg_temp.reason(2) = 'entry_refund_recorded' and not pg_temp.rel(2));
select pg_temp.chk('RB3R F3 withdrawal blocked -> entry_refund_withdrawal_blocked, NOT releasable', pg_temp.reason(3) = 'entry_refund_withdrawal_blocked' and not pg_temp.rel(3));
select pg_temp.chk('RB3R F4 pending refund naming the entry -> entry_refund_pending, NOT releasable', pg_temp.reason(4) = 'entry_refund_pending' and not pg_temp.rel(4));
select pg_temp.chk('RB3R F5 dashboard succeeded refund without allocation -> entry_refund_unattributed_order, NOT releasable', pg_temp.reason(5) = 'entry_refund_unattributed_order' and not pg_temp.rel(5));
select pg_temp.chk('RB3R F6a partially attributed refund (3000 of 5000): the named entry stays recorded but is NOT releasable (the rest is unattributed)',
  pg_temp.reason(6) = 'entry_refund_recorded' and not pg_temp.rel(6));
select pg_temp.chk('RB3R F6b partially attributed refund: ANOTHER entry of the order -> entry_refund_unattributed_order (was a false negative)',
  pg_temp.reason(7) = 'entry_refund_unattributed_order' and not pg_temp.rel(7));
select pg_temp.chk('RB3R F7a over-attributed refund (allocations 4000 > 3000): the named entry stays recorded and NOT releasable', pg_temp.reason(8) = 'entry_refund_recorded' and not pg_temp.rel(8));
select pg_temp.chk('RB3R F7b over-attributed refund: another entry of the order -> entry_refund_evidence_contradictory', pg_temp.reason(9) = 'entry_refund_evidence_contradictory' and not pg_temp.rel(9));
select pg_temp.chk('RB3R F8 STAFF-sourced succeeded refund without allocation -> entry_refund_unattributed_order (was a false negative)', pg_temp.reason(10) = 'entry_refund_unattributed_order');
select pg_temp.chk('RB3R F9 requested staff refund without allocation -> entry_refund_pending (was a false negative)', pg_temp.reason(11) = 'entry_refund_pending');
select pg_temp.chk('RB3R F10 pending dashboard refund without allocation -> entry_refund_pending', pg_temp.reason(12) = 'entry_refund_pending');
select pg_temp.chk('RB3R F11 order partially_refunded with no succeeded ledger refund -> entry_refund_evidence_missing (was a false negative)', pg_temp.reason(13) = 'entry_refund_evidence_missing' and not pg_temp.rel(13));
select pg_temp.chk('RB3R F12 desk refund recorded on event_payments only (20.00, ledger 0) -> entry_refund_evidence_missing', pg_temp.reason(14) = 'entry_refund_evidence_missing' and not pg_temp.rel(14));
select pg_temp.chk('RB3R F13 payment marked refunded, no ledger refund -> entry_refund_evidence_missing', pg_temp.reason(15) = 'entry_refund_evidence_missing');
select pg_temp.chk('RB3R F14 entry without an order: refund matched by registration_id -> entry_refund_unattributed_order', pg_temp.reason(16) = 'entry_refund_unattributed_order');
select pg_temp.chk('RB3R F15 failed / canceled refunds only (reversed) -> available', pg_temp.reason(17) is null);
select pg_temp.chk('RB3R F16 clean order -> available, raw null', pg_temp.reason(19) is null and pg_temp.raw(19) is null);
select pg_temp.chk('RB3R F17 refund fully attributed to ANOTHER entry of the order, ledger = payment = order status -> this entry stays available', pg_temp.reason(20) is null);
select pg_temp.chk('RB3R F18 the attributed entry of that refund is recorded', pg_temp.reason(21) = 'entry_refund_recorded');
select pg_temp.chk('RB3R F19 payments refund SMALLER than the ledger (ledger ahead) is not a hidden refund: still recorded + releasable', pg_temp.reason(25) = 'entry_refund_recorded' and pg_temp.rel(25));
select pg_temp.chk('RB3R F20 random entry: no reason, not releasable', public._cf1_entry_refund_evidence_reason(gen_random_uuid()) is null and not (public._cf1_rb3_raw(gen_random_uuid())).releasable);
select pg_temp.chk('RB3R F21 null entry id: no reason', public._cf1_entry_refund_evidence_reason(null) is null);

-- transitions over the real A1 predicate
set session_replication_role = replica;
update public.event_order_refunds set status = 'failed', succeeded_at = null where id = pg_temp.rf(10);
set session_replication_role = origin;
select pg_temp.chk('RB3R T1 refund reported failed (reversed) but the order and payment still show the refund -> contradictory: entry_refund_evidence_missing (fail closed)', pg_temp.reason(10) = 'entry_refund_evidence_missing');
set session_replication_role = replica;
update public.event_orders set payment_status = 'paid' where id = pg_temp.o(10);
update public.event_payments set refund_amount = 0 where registration_id = pg_temp.r(10);
set session_replication_role = origin;
select pg_temp.chk('RB3R T1b order and payment recomputed from the ledger (as R2 does) -> entry available again', pg_temp.reason(10) is null);
set session_replication_role = replica;
update public.event_order_refunds set status = 'succeeded', succeeded_at = now() where id = pg_temp.rf(10);
update public.event_orders set payment_status = 'partially_refunded' where id = pg_temp.o(10);
update public.event_payments set refund_amount = 40 where registration_id = pg_temp.r(10);
set session_replication_role = origin;
select pg_temp.chk('RB3R T2 back to succeeded (recomputed) -> unavailable again', pg_temp.reason(10) = 'entry_refund_unattributed_order');
set session_replication_role = replica;
select pg_temp.alloc(10, 10, 99, null, 'fee', 4000, false, 'not_applicable');
set session_replication_role = origin;
select pg_temp.chk('RB3R T3 refund then attributed in full to a fee line -> entry available again (attribution, not assertion, clears it)', pg_temp.reason(10) is null);

-- ============================================================================
-- 2. Reconciliation: authorization, validation, refusals
-- ============================================================================
create temp table t_digest on commit drop as
select
  md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_order_refunds x where x.id = pg_temp.rf(1)), '')) as refunds,
  md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_order_refund_allocations x where x.refund_id = pg_temp.rf(1)), '')) as allocs,
  md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_payments x where x.registration_id = pg_temp.r(1)), '')) as payments,
  md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_orders x where x.id = pg_temp.o(1)), '')) as orders;

select pg_temp.chk('RB3R A1 outsider manager of another studio cannot request', pg_temp.err_as(pg_temp.us(4), pg_temp.q_req(1, 1)) like '42501 COMP_FORBIDDEN%');
select pg_temp.chk('RB3R A2 user without a role cannot request', pg_temp.err_as(pg_temp.us(5), pg_temp.q_req(1, 1)) like '42501 COMP_FORBIDDEN%');
select pg_temp.chk('RB3R A3 manager without a verified email cannot request', pg_temp.err_as(pg_temp.us(3), pg_temp.q_req(1, 1)) like '42501 COMP_VERIFIED_EMAIL_REQUIRED%');
select pg_temp.chk('RB3R A4 request without a request id is refused',
  pg_temp.err_as(pg_temp.us(1), format('select public.request_cf1_refund_evidence_release(%L, %L, null)', pg_temp.en(1), 'Staff confirm the entry continues to compete.')) like '%COMP_REQUEST_ID_REQUIRED%');
select pg_temp.chk('RB3R A5 request without a written reason (too short) is refused', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(1, 1, 'too short')) like '%CF1_RB3_REASON_REQUIRED%');
select pg_temp.chk('RB3R A6 request with a blank reason is refused', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(1, 1, repeat(' ', 40))) like '%CF1_RB3_REASON_REQUIRED%');
select pg_temp.chk('RB3R A7 request for an unknown entry is refused as forbidden',
  pg_temp.err_as(pg_temp.us(1), format('select public.request_cf1_refund_evidence_release(%L, %L, %L)', gen_random_uuid(), 'Staff confirm the entry continues to compete.', pg_temp.dq(1))) like '42501%');
select pg_temp.chk('RB3R A8 anon and service_role have no execute on the four actions; authenticated has',
  not has_function_privilege('anon', 'public.request_cf1_refund_evidence_release(uuid,text,uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.request_cf1_refund_evidence_release(uuid,text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.cosign_cf1_refund_evidence_release(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.cosign_cf1_refund_evidence_release(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.revoke_cf1_refund_evidence_release(uuid,text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.cf1_refund_evidence_state(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.request_cf1_refund_evidence_release(uuid,text,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.cosign_cf1_refund_evidence_release(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.revoke_cf1_refund_evidence_release(uuid,text,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.cf1_refund_evidence_state(uuid)', 'execute'));
select pg_temp.chk('RB3R A9 internal helpers are not executable by any API role',
  not exists (select 1 from unnest(array['public._cf1_rb3_raw(uuid)', 'public._cf1_rb3_snapshot(uuid)', 'public._cf1_rb3_release_valid(uuid)',
                                         'public._cf1_rb3r_guard(uuid,uuid,text,boolean)', 'public._cf1_entry_refund_evidence_reason(uuid)']) f(sig),
              unnest(array['anon', 'authenticated', 'service_role']) r(role) where has_function_privilege(r.role, f.sig, 'execute')));
select pg_temp.chk('RB3R A10 no API role has any privilege on the audit table',
  not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                          unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p(priv)
              where has_table_privilege(r.role, 'public.competition_cf1_rb3_reconciliations', p.priv)));
select pg_temp.chk('RB3R A11 authenticated cannot read the audit table directly',
  pg_temp.err_as(pg_temp.us(1), 'select to_jsonb(count(*)) from public.competition_cf1_rb3_reconciliations') like '42501%');

-- cases that must NOT be releasable (stay unavailable; an owner decision / R2 ledger path is needed)
select pg_temp.chk('RB3R N1 withdraw_entry = true recorded refund is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(2, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_recorded%');
select pg_temp.chk('RB3R N2 blocked withdrawal is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(3, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_withdrawal_blocked%');
select pg_temp.chk('RB3R N3 pending refund is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(4, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_pending%');
select pg_temp.chk('RB3R N4 unattributed refund is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(5, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_unattributed_order%');
select pg_temp.chk('RB3R N5 recorded refund with the rest of the refund unattributed is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(6, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_recorded%');
select pg_temp.chk('RB3R N6 contradictory (over-attributed) evidence is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(9, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_evidence_contradictory%');
select pg_temp.chk('RB3R N7 over-attributed recorded refund is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(8, 1)) like '%CF1_RB3_NOT_RELEASABLE%');
select pg_temp.chk('RB3R N8 evidence outside the ledger (order partially_refunded, no ledger refund) is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(13, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_evidence_missing%');
select pg_temp.chk('RB3R N9 desk refund outside the ledger is not releasable', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(14, 1)) like '%CF1_RB3_NOT_RELEASABLE: entry_refund_evidence_missing%');
select pg_temp.chk('RB3R N10 a clean entry has nothing to release', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(19, 1)) like '%CF1_RB3_NOTHING_TO_RELEASE%');
select pg_temp.chk('RB3R N11 an entry without an order cannot be reconciled', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(16, 1)) like '%CF1_RB3_NO_ORDER%');
select pg_temp.chk('RB3R N12 none of the refused requests left a row', (select count(*) from public.competition_cf1_rb3_reconciliations) = 0);

-- ============================================================================
-- 3. Reconciliation: request -> replay -> cosign -> release -> revoke (entry 1)
-- ============================================================================
select pg_temp.chk('RB3R R1 manager A requests the release of entry 1', (pg_temp.do_as(pg_temp.us(1), pg_temp.q_req(1, 1)) ->> 'kind') = 'release_requested');
select pg_temp.chk('RB3R R2 a request alone does not release: entry 1 is still entry_refund_recorded', pg_temp.reason(1) = 'entry_refund_recorded');
select pg_temp.chk('RB3R R3 the request row links order, entry and refund and carries a server-built fingerprint',
  exists (select 1 from public.competition_cf1_rb3_reconciliations c
          where c.entry_id = pg_temp.en(1) and c.order_id = pg_temp.o(1) and c.kind = 'release_requested' and c.refund_ids = array[pg_temp.rf(1)]
            and c.evidence_fingerprint = md5(c.evidence::text) and c.actor = pg_temp.us(1) and c.basis_reason = 'entry_refund_recorded' and length(c.reason) >= 20
            and c.evidence -> 'refunds' -> 0 ->> 'id' = pg_temp.rf(1)::text));
select pg_temp.chk('RB3R R4 replay of the same request id is idempotent (replayed = true, no second row)',
  (pg_temp.do_as(pg_temp.us(1), pg_temp.q_req(1, 1)) ->> 'replayed') = 'true' and pg_temp.nrows(1) = 1);
select pg_temp.chk('RB3R R5 the same request id for another entry is refused', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(23, 1)) like '%COMP_REQUEST_REUSED%');
select pg_temp.chk('RB3R R6 the same request id by another person is refused', pg_temp.err_as(pg_temp.us(2), pg_temp.q_req(1, 1)) like '%COMP_REQUEST_REUSED%');
select pg_temp.chk('RB3R R7 the requester cannot co-sign their own request',
  pg_temp.err_as(pg_temp.us(1), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 2)) like '%CF1_RB3_COSIGN_SAME_PERSON%');
select pg_temp.chk('RB3R R8 an outsider cannot co-sign', pg_temp.err_as(pg_temp.us(4), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 2)) like '42501 COMP_FORBIDDEN%');
select pg_temp.chk('RB3R R9 a manager without a verified email cannot co-sign', pg_temp.err_as(pg_temp.us(3), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 2)) like '%COMP_VERIFIED_EMAIL_REQUIRED%');
select pg_temp.chk('RB3R R10 co-sign of an unknown decision is refused as forbidden', pg_temp.err_as(pg_temp.us(2), pg_temp.q_cos(gen_random_uuid(), 2)) like '42501%');
create temp table t_act (k text, v jsonb) on commit drop;
grant all on t_act to authenticated, anon, service_role;
insert into t_act values ('r11', pg_temp.do_as(pg_temp.us(2), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 2)));
select pg_temp.chk('RB3R R11 a second manager co-signs: kind release_cosigned, decision linked, same fingerprint',
  (select v ->> 'kind' from t_act where k = 'r11') = 'release_cosigned'
  and (select c.decision_id = pg_temp.decision_of(1, 'release_requested') and c.evidence_fingerprint = r.evidence_fingerprint and c.actor = pg_temp.us(2)
       from public.competition_cf1_rb3_reconciliations c, public.competition_cf1_rb3_reconciliations r
       where c.kind = 'release_cosigned' and c.entry_id = pg_temp.en(1) and r.kind = 'release_requested' and r.entry_id = pg_temp.en(1)));
select pg_temp.chk('RB3R R12 after the co-sign the entry is released: effective reason null, entry available through the A1 predicate',
  pg_temp.reason(1) is null and not public._cf1_entry_unavailable(pg_temp.en(1)));
select pg_temp.chk('RB3R R13 the raw classification is unchanged by the release (evidence still says recorded)', pg_temp.raw(1) = 'entry_refund_recorded');
select pg_temp.chk('RB3R R14 replay of the co-sign is idempotent', (pg_temp.do_as(pg_temp.us(2), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 2)) ->> 'replayed') = 'true' and pg_temp.nrows(1) = 2);
select pg_temp.chk('RB3R R15 a second co-sign of the same request is refused', pg_temp.err_as(pg_temp.us(1), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 3)) like '%CF1_RB3_COSIGN_SAME_PERSON%'
  or pg_temp.err_as(pg_temp.us(2), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 3)) like '%CF1_RB3_DECISION_COMPLETED%');
select pg_temp.chk('RB3R R16 a new request while a release covers the current evidence is refused', pg_temp.err_as(pg_temp.us(1), pg_temp.q_req(1, 4)) like '%CF1_RB3_ALREADY_RELEASED%');
select pg_temp.chk('RB3R R17 co-signing a co-sign row is refused (not a release request)',
  pg_temp.err_as(pg_temp.us(1), pg_temp.q_cos(pg_temp.decision_of(1, 'release_cosigned'), 5)) like '%CF1_RB3_DECISION_KIND%');
select pg_temp.chk('RB3R R18 state read (manager) shows effective reason null, raw recorded, three-step history',
  (select (s ->> 'effective_reason') is null and s ->> 'raw_reason' = 'entry_refund_recorded' and (s ->> 'releasable')::boolean and jsonb_array_length(s -> 'decisions') = 2
   from (select pg_temp.do_as(pg_temp.us(1), format('select public.cf1_refund_evidence_state(%L)', pg_temp.en(1))) as s) x));
select pg_temp.chk('RB3R R19 state read refused for an outsider and for a manager without a verified email',
  pg_temp.err_as(pg_temp.us(4), format('select public.cf1_refund_evidence_state(%L)', pg_temp.en(1))) like '42501%'
  and pg_temp.err_as(pg_temp.us(3), format('select public.cf1_refund_evidence_state(%L)', pg_temp.en(1))) like '%COMP_VERIFIED_EMAIL_REQUIRED%');
-- revoke
select pg_temp.chk('RB3R V1 revoke needs a written reason', pg_temp.err_as(pg_temp.us(2), pg_temp.q_rev(1, 6, 'no')) like '%CF1_RB3_REASON_REQUIRED%');
select pg_temp.chk('RB3R V2 an outsider cannot revoke', pg_temp.err_as(pg_temp.us(4), pg_temp.q_rev(1, 6)) like '42501%');
insert into t_act values ('v3', pg_temp.do_as(pg_temp.us(2), pg_temp.q_rev(1, 6)));
select pg_temp.chk('RB3R V3 one manager can revoke: kind release_revoked linked to the co-signed decision',
  (select v ->> 'kind' from t_act where k = 'v3') = 'release_revoked'
  and (select decision_id = pg_temp.decision_of(1, 'release_cosigned') from public.competition_cf1_rb3_reconciliations where kind = 'release_revoked' and entry_id = pg_temp.en(1)));
select pg_temp.chk('RB3R V4 after the revocation the entry is unavailable again (entry_refund_recorded)', pg_temp.reason(1) = 'entry_refund_recorded');
select pg_temp.chk('RB3R V5 revoke replay is idempotent', (pg_temp.do_as(pg_temp.us(2), pg_temp.q_rev(1, 6)) ->> 'replayed') = 'true' and pg_temp.nrows(1) = 3);
select pg_temp.chk('RB3R V6 a second revoke has nothing to revoke', pg_temp.err_as(pg_temp.us(2), pg_temp.q_rev(1, 7)) like '%CF1_RB3_NOTHING_TO_REVOKE%');
select pg_temp.chk('RB3R V7 the old co-sign does not release again after the revocation (still unavailable)', pg_temp.reason(1) = 'entry_refund_recorded');
select pg_temp.chk('RB3R P1 provider, payment, refund and order rows are untouched by request / cosign / replay / revoke',
  (select d.refunds = md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_order_refunds x where x.id = pg_temp.rf(1)), ''))
      and d.allocs = md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_order_refund_allocations x where x.refund_id = pg_temp.rf(1)), ''))
      and d.payments = md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_payments x where x.registration_id = pg_temp.r(1)), ''))
      and d.orders = md5(coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from public.event_orders x where x.id = pg_temp.o(1)), ''))
   from t_digest d));

-- append-only
select pg_temp.expect_msg('RB3R P2 audit rows cannot be updated', $q$update public.competition_cf1_rb3_reconciliations set reason = 'rewritten rewritten rewritten'$q$, 'append-only');
select pg_temp.expect_msg('RB3R P3 audit rows cannot be deleted', $q$delete from public.competition_cf1_rb3_reconciliations$q$, 'append-only');
select pg_temp.expect_msg('RB3R P4 audit table cannot be truncated', $q$truncate public.competition_cf1_rb3_reconciliations$q$, 'append-only');

-- ============================================================================
-- 4. Release only while the evidence is the evidence that was decided (fingerprint binding)
-- ============================================================================
select pg_temp.do_as(pg_temp.us(1), pg_temp.q_req(1, 10));
select pg_temp.do_as(pg_temp.us(2), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 11));
select pg_temp.chk('RB3E 1 new request + co-sign after a revocation releases entry 1 again', pg_temp.reason(1) is null);
set session_replication_role = replica;
select pg_temp.refund(40, 1, 'requested', 'staff', 1000);
set session_replication_role = origin;
select pg_temp.chk('RB3E 2 a new requested refund on the order withdraws the release (recorded + a refund not attributed)', pg_temp.reason(1) = 'entry_refund_recorded' and not pg_temp.rel(1));
set session_replication_role = replica;
update public.event_order_refunds set status = 'failed' where id = pg_temp.rf(40);
set session_replication_role = origin;
select pg_temp.chk('RB3E 3 once that refund fails the evidence is releasable again but the OLD decision no longer matches: still unavailable',
  pg_temp.rel(1) and pg_temp.reason(1) = 'entry_refund_recorded');
select pg_temp.do_as(pg_temp.us(2), pg_temp.q_req(1, 12));
select pg_temp.do_as(pg_temp.us(1), pg_temp.q_cos(pg_temp.decision_of(1, 'release_requested'), 13));
select pg_temp.chk('RB3E 4 a fresh request + co-sign on the new evidence releases again', pg_temp.reason(1) is null);
set session_replication_role = replica;
update public.event_orders set payment_status = 'paid' where id = pg_temp.o(1);
set session_replication_role = origin;
select pg_temp.chk('RB3E 5 any change of the evidence (order status) lapses the release by itself', pg_temp.reason(1) = 'entry_refund_recorded');
set session_replication_role = replica;
update public.event_orders set payment_status = 'partially_refunded' where id = pg_temp.o(1);
set session_replication_role = origin;
select pg_temp.chk('RB3E 6 restoring the identical evidence restores the identical fingerprint (release valid again)', pg_temp.reason(1) is null);

-- stale request: a later request supersedes
select pg_temp.do_as(pg_temp.us(1), pg_temp.q_req(23, 20));
select pg_temp.do_as(pg_temp.us(2), pg_temp.q_req(23, 21));
select pg_temp.chk('RB3E 7 co-signing an older request while a newer one exists is refused (stale)',
  pg_temp.err_as(pg_temp.us(2), pg_temp.q_cos((select id from public.competition_cf1_rb3_reconciliations where request_id = pg_temp.dq(20)), 22)) like '%CF1_RB3_REQUEST_STALE%');
insert into t_act values ('e8', pg_temp.do_as(pg_temp.us(1), pg_temp.q_cos((select id from public.competition_cf1_rb3_reconciliations where request_id = pg_temp.dq(21)), 23)));
select pg_temp.chk('RB3E 8 the newer request can be co-signed by a different person and releases entry 23',
  (select v ->> 'kind' from t_act where k = 'e8') = 'release_cosigned' and pg_temp.reason(23) is null);

-- evidence changed between request and co-sign
select pg_temp.do_as(pg_temp.us(1), pg_temp.q_req(24, 30));
set session_replication_role = replica;
select pg_temp.refund(41, 24, 'failed', 'stripe_dashboard', 700, false);
set session_replication_role = origin;
select pg_temp.chk('RB3E 9 evidence changed after the request (a new refund row appears): co-sign refused',
  pg_temp.err_as(pg_temp.us(2), pg_temp.q_cos(pg_temp.decision_of(24, 'release_requested'), 31)) like '%CF1_RB3_EVIDENCE_CHANGED%' and pg_temp.reason(24) = 'entry_refund_recorded');

-- no longer releasable at co-sign
select pg_temp.do_as(pg_temp.us(1), pg_temp.q_req(25, 40));
set session_replication_role = replica;
update public.event_order_refunds set status = 'pending', succeeded_at = null where id = pg_temp.rf(25);
set session_replication_role = origin;
select pg_temp.chk('RB3E 10 refund turned pending after the request: co-sign refused (no longer releasable)',
  pg_temp.err_as(pg_temp.us(2), pg_temp.q_cos(pg_temp.decision_of(25, 'release_requested'), 41)) like '%CF1_RB3_NOT_RELEASABLE%' and pg_temp.reason(25) = 'entry_refund_pending');

-- never by assertion alone: forged audit rows (written directly, as a superuser) cannot release a non-releasable case
do $$
declare
  v_req uuid := gen_random_uuid();
  v_fp text := md5(public._cf1_rb3_snapshot(pg_temp.en(2))::text);
  v_snap jsonb := public._cf1_rb3_snapshot(pg_temp.en(2));
begin
  insert into public.competition_cf1_rb3_reconciliations (id, event_id, entry_id, order_id, kind, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
  values (v_req, pg_temp.u('00e001'), pg_temp.en(2), pg_temp.o(2), 'release_requested', pg_temp.dq(50), pg_temp.us(1), 'manager', 'forged request forged request', 'entry_refund_recorded', array[pg_temp.rf(2)], v_snap, v_fp);
  insert into public.competition_cf1_rb3_reconciliations (event_id, entry_id, order_id, kind, decision_id, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
  values (pg_temp.u('00e001'), pg_temp.en(2), pg_temp.o(2), 'release_cosigned', v_req, pg_temp.dq(51), pg_temp.us(2), 'manager', 'forged request forged request', 'entry_refund_recorded', array[pg_temp.rf(2)], v_snap, v_fp);
end $$;
select pg_temp.chk('RB3E 11 a co-signed row with a matching fingerprint does NOT release a withdraw_entry = true case (the evidence rules, not the assertion)', pg_temp.reason(2) = 'entry_refund_recorded');
do $$
declare
  v_req uuid := gen_random_uuid();
  v_snap jsonb := public._cf1_rb3_snapshot(pg_temp.en(5));
begin
  insert into public.competition_cf1_rb3_reconciliations (id, event_id, entry_id, order_id, kind, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
  values (v_req, pg_temp.u('00e001'), pg_temp.en(5), pg_temp.o(5), 'release_requested', pg_temp.dq(52), pg_temp.us(1), 'manager', 'forged request forged request', 'entry_refund_recorded', array[pg_temp.rf(5)], v_snap, md5(v_snap::text));
  insert into public.competition_cf1_rb3_reconciliations (event_id, entry_id, order_id, kind, decision_id, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
  values (pg_temp.u('00e001'), pg_temp.en(5), pg_temp.o(5), 'release_cosigned', v_req, pg_temp.dq(53), pg_temp.us(2), 'manager', 'forged request forged request', 'entry_refund_recorded', array[pg_temp.rf(5)], v_snap, md5(v_snap::text));
end $$;
select pg_temp.chk('RB3E 12 a co-signed row does NOT release an unattributed refund (entry_refund_unattributed_order stays)', pg_temp.reason(5) = 'entry_refund_unattributed_order');
select pg_temp.expect_msg('RB3E 13 the table refuses a basis other than entry_refund_recorded',
  format($q$insert into public.competition_cf1_rb3_reconciliations (event_id, entry_id, order_id, kind, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
            values (%L, %L, %L, 'release_requested', %L, %L, 'manager', 'valid reason valid reason', 'entry_refund_pending', '{}', '{}', %L)$q$,
         pg_temp.u('00e001'), pg_temp.en(3), pg_temp.o(3), gen_random_uuid(), pg_temp.us(1), repeat('a', 32)), 'basis_reason');
select pg_temp.expect_msg('RB3E 14 the table refuses a cosign row without a decision',
  format($q$insert into public.competition_cf1_rb3_reconciliations (event_id, entry_id, order_id, kind, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
            values (%L, %L, %L, 'release_cosigned', %L, %L, 'manager', 'valid reason valid reason', 'entry_refund_recorded', '{}', '{}', %L)$q$,
         pg_temp.u('00e001'), pg_temp.en(3), pg_temp.o(3), gen_random_uuid(), pg_temp.us(1), repeat('a', 32)), 'decision_shape');

-- the RB3 override table / gate are untouched by this migration
select pg_temp.chk('RB3R G1 RB3 gate and override table still present and unchanged in behaviour', public._cf1_od17_refund_gate() = 'r2_ledger' and to_regclass('public.competition_cf1_rb3_gate_overrides') is not null);

select pg_temp.blocked('RB3R real R2 write path (request_competition_order_refund / observe_competition_stripe_refund / attribute_competition_refund)', 'needs Stripe test mode + app + auth sessions; ledger rows here are fixtures, NOT Stripe settlement');
select pg_temp.blocked('RB3R two-session concurrency (parallel request replay, parallel co-sign)', 'cannot be shown inside one transaction: run sql-tests/test_T_competition_cf1_rb3r_concurrency.sh');
select pg_temp.blocked('RB3R rollback / re-apply fingerprints, negative preflights', 'run by sql-tests/run_cf1_rb3.sh (separate transactions)');

do $$
declare
  v_total int;
  v_blocked int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select count(*) into v_blocked from t_results where status = 'BLOCKED';
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where status = 'FAIL';
  if v_failures is null then
    raise exception 'COMPETITION CF1 RB3R SQL SUITE PASS (% checks, % blocked)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION CF1 RB3R SQL SUITE FAIL: %', v_failures;
end $$;
