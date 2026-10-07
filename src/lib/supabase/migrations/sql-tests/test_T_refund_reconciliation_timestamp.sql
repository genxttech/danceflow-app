-- REFUND-RECON-2 -- refund timestamp / accounting integrity, live-Postgres regression suite.
--
-- Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261028090000_refund_reconciliation_timestamp_integrity.sql. One transaction, rolled back;
-- synthetic rows only. The RPC is called as service_role (its only grantee).
--
-- Inside one transaction now() is constant, so "unchanged" assertions plant a sentinel
-- refunded_at first and prove the RPC did not touch it. "Today" (current_date) is the
-- refund period; payments are dated in earlier periods via paid_at.
--
-- Deterministic UUID block: 00000000-0000-0000-0000-00000361XXXX

begin;

create temp table t_results (n serial primary key, label text not null);
grant all on t_results to service_role;
grant all on sequence t_results_n_seq to service_role;

create function pg_temp.t_pass(p_label text) returns void language plpgsql as $$
begin
  insert into t_results (label) values (p_label);
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.t_ok(p_label text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL % (%)', p_label, coalesce(p_detail, 'condition false'); end if;
  perform pg_temp.t_pass(p_label);
end $$;

create function pg_temp.t_refund(p_payment uuid, p_status text, p_amount numeric, p_refund_id text, p_event text) returns text
language plpgsql as $$
declare r record; v text;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  begin
    select * into r from public._apply_payment_refund_and_reevaluate(p_payment, p_status, p_amount, p_refund_id, p_event, 'charge.refunded');
    v := r.applied::text || '/' || r.package_deactivated::text || '/' || r.conflict_recorded::text;
  exception when others then
    v := 'ERR:' || sqlstate || ':' || sqlerrm;
  end;
  reset role;
  return v;
end $$;

-- the payment's active (or locked) refund accounting entry: 'entry_date|refund_amount|status|locked'
create function pg_temp.t_refund_entry(p_payment uuid) returns text language sql as $$
  select string_agg(e.entry_date::text || '|' || e.refund_amount || '|' || e.entry_status || '|' || (e.locked_at is not null)::text, ';' order by e.category)
  from public.accounting_entries e
  where e.source_table = 'payments' and e.source_id = p_payment and e.entry_type = 'refund'
    and (e.entry_status = 'active' or e.locked_at is not null);
$$;

create function pg_temp.t_revenue_entry(p_payment uuid) returns text language sql as $$
  select string_agg(e.entry_date::text || '|' || e.gross_amount || '|' || e.entry_status || '|' || (e.locked_at is not null)::text, ';' order by e.category)
  from public.accounting_entries e
  where e.source_table = 'payments' and e.source_id = p_payment and e.entry_type = 'revenue'
    and (e.entry_status = 'active' or e.locked_at is not null);
$$;

-- ============================================================================
-- O/P: catalog posture (RPC security unchanged; accounting trigger/functions untouched)
-- ============================================================================
do $$
declare r record;
begin
  select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) as ret,
         (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) as acl,
         (select count(*) from pg_proc q where q.proname = p.proname) as overloads,
         md5(replace(p.prosrc, E'\r', '')) as body
    into r from pg_proc p where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure;
  perform pg_temp.t_ok('O RPC owner/secdef/search_path/return/ACL/overloads preserved; body is REFUND-RECON-2',
    r.owner = 'postgres' and r.prosecdef and r.proconfig = array['search_path=public']
    and r.ret = 'TABLE(applied boolean, package_deactivated boolean, conflict_recorded boolean)'
    and r.acl = 'postgres=X/postgres,service_role=X/postgres' and r.overloads = 1
    and r.body = '6867f57dca8ae457c04cf557c21420e7', row_to_json(r)::text);
  perform pg_temp.t_ok('P accounting sync, ledger helpers, GC helper and package/conflict helpers unchanged',
    (select string_agg(md5(replace(p.prosrc, E'\r', '')), ',' order by p.oid::regprocedure::text) from pg_proc p where p.oid in (
      'public.sync_payment_accounting_entry()'::regprocedure, 'public.sync_payment_accounting_entry_row(uuid)'::regprocedure,
      'public.accounting_mark_source_voided(text,uuid,text)'::regprocedure, 'public.accounting_assert_entry_mutable()'::regprocedure,
      'public._sync_group_class_purchase_refund(uuid,uuid,boolean)'::regprocedure,
      'public._reevaluate_and_deactivate_package_if_unsettled(uuid,text)'::regprocedure,
      'public._record_payment_settlement_conflict(uuid,uuid,uuid,text,text,text,text)'::regprocedure))
    = (select string_agg(m, ',' order by s) from (values
      ('_record_payment_settlement_conflict(uuid,uuid,uuid,text,text,text,text)', '045835d65560af7677a698f52e5501f9'),
      ('_reevaluate_and_deactivate_package_if_unsettled(uuid,text)', '6fec069baaa30cbed1b57eb7825b021a'),
      ('_sync_group_class_purchase_refund(uuid,uuid,boolean)', 'bd861352a8e8d2c4cfe727ac1b4b8f89'),
      ('accounting_assert_entry_mutable()', 'f94269788e32046f52c56a641234620b'),
      ('accounting_mark_source_voided(text,uuid,text)', '883ff6fb8c8b3c1aa00564f570ee3d8e'),
      ('sync_payment_accounting_entry()', '732032d8149b52844c636185cb6aa202'),
      ('sync_payment_accounting_entry_row(uuid)', 'd52d31d97d4504793af20b018490cb38')) v(s, m))
    and (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.accounting_upsert_entry(uuid,uuid,date,text,text,text,numeric,numeric,numeric,numeric,text,text,text,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb,uuid)'::regprocedure) = 'a2779c25219dc8fd50a781985e6909db');
  perform pg_temp.t_ok('P payment accounting trigger definition unchanged (re-syncs on refunded_at)',
    (select md5(pg_get_triggerdef(t.oid)) || '/' || t.tgenabled::text from pg_trigger t where t.tgrelid = 'public.payments'::regclass and t.tgname = 'trg_sync_payment_accounting_entry')
    = 'e5466ad577cabf01dac2557af87483cb/O');
end $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-000003610001', 'RR2 Studio', 't-rr2');

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-000003612001', '00000000-0000-0000-0000-000003610001', 'Prior', 'Period', 'active'),
  ('00000000-0000-0000-0000-000003612002', '00000000-0000-0000-0000-000003610001', 'Pkg', 'Owner', 'active'),
  ('00000000-0000-0000-0000-000003612003', '00000000-0000-0000-0000-000003610001', 'Gc', 'Full', 'active'),
  ('00000000-0000-0000-0000-000003612004', '00000000-0000-0000-0000-000003610001', 'Gc', 'Partial', 'active'),
  ('00000000-0000-0000-0000-000003612005', '00000000-0000-0000-0000-000003610001', 'Gc', 'Attended', 'active');

insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, price_snapshot) values
  ('00000000-0000-0000-0000-000003613001', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612002', 'RR2 Pack Full', true, 50),
  ('00000000-0000-0000-0000-000003613002', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612002', 'RR2 Pack Partial', true, 50);

insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at, roster_capacity) values
  ('00000000-0000-0000-0000-000003616001', '00000000-0000-0000-0000-000003610001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', 3),
  ('00000000-0000-0000-0000-000003616002', '00000000-0000-0000-0000-000003610001', 'group_class', 'scheduled', now() - interval '2 hours', now() - interval '1 hour', 3);

insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, can_manage_bookings, is_primary) values
  ('00000000-0000-0000-0000-000003617003', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612003', null, 'unclaimed', 'self', true, false),
  ('00000000-0000-0000-0000-000003617004', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612004', null, 'unclaimed', 'self', true, false),
  ('00000000-0000-0000-0000-000003617005', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612005', null, 'unclaimed', 'self', true, false);

insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type, payment_status) values
  ('00000000-0000-0000-0000-000003615003', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616001', '00000000-0000-0000-0000-000003612003', 'booked', 'self_service', 'pay_as_you_go', 'paid'),
  ('00000000-0000-0000-0000-000003615004', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616001', '00000000-0000-0000-0000-000003612004', 'booked', 'self_service', 'pay_as_you_go', 'paid'),
  ('00000000-0000-0000-0000-000003615005', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616002', '00000000-0000-0000-0000-000003612005', 'booked', 'self_service', 'pay_as_you_go', 'paid');

insert into public.attendance_records (studio_id, appointment_id, client_id, status) values
  ('00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616002', '00000000-0000-0000-0000-000003612005', 'attended');

-- Payments: paid_at places each payment's revenue in an EARLIER period than the refund (today).
insert into public.payments (id, studio_id, client_id, client_package_id, appointment_id, amount, payment_method, status, paid_at, source, payment_channel, payment_type,
                             stripe_account_id, stripe_payment_intent_id, stripe_checkout_session_id, external_reference, guest_name, accounting_category) values
  ('00000000-0000-0000-0000-000003618001', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612001', null, null, 50, 'card', 'paid', '2026-08-10 15:00+00', 'stripe', 'online', 'other', 'acct_rr2', 'pi_rr2_prior', 'cs_rr2_prior', null, null, null),
  ('00000000-0000-0000-0000-000003618002', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612002', '00000000-0000-0000-0000-000003613001', null, 50, 'card', 'paid', '2026-08-11 15:00+00', 'stripe', 'online', 'package', 'acct_rr2', 'pi_rr2_pkg_full', null, null, null, 'package_revenue'),
  ('00000000-0000-0000-0000-000003618003', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612002', '00000000-0000-0000-0000-000003613002', null, 50, 'card', 'paid', '2026-08-12 15:00+00', 'stripe', 'online', 'package', 'acct_rr2', 'pi_rr2_pkg_part', null, null, null, 'package_revenue'),
  ('00000000-0000-0000-0000-000003618004', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612003', null, '00000000-0000-0000-0000-000003616001', 25, 'card', 'paid', '2026-09-01 15:00+00', 'stripe', 'online', 'group_class_direct_payment', 'acct_rr2', 'pi_rr2_gc_full', 'cs_rr2_gc_full', '00000000-0000-0000-0000-000003615003', null, 'group_class_revenue'),
  ('00000000-0000-0000-0000-000003618005', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612004', null, '00000000-0000-0000-0000-000003616001', 25, 'card', 'paid', '2026-09-02 15:00+00', 'stripe', 'online', 'group_class_direct_payment', 'acct_rr2', 'pi_rr2_gc_part', 'cs_rr2_gc_part', '00000000-0000-0000-0000-000003615004', null, 'group_class_revenue'),
  ('00000000-0000-0000-0000-000003618006', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612005', null, '00000000-0000-0000-0000-000003616002', 25, 'card', 'paid', '2026-09-03 15:00+00', 'stripe', 'online', 'group_class_direct_payment', 'acct_rr2', 'pi_rr2_gc_att', 'cs_rr2_gc_att', '00000000-0000-0000-0000-000003615005', null, 'group_class_revenue'),
  -- clientless GC-3.5 checkout-conflict payment
  ('00000000-0000-0000-0000-000003618007', '00000000-0000-0000-0000-000003610001', null, null, '00000000-0000-0000-0000-000003616001', 25, 'card', 'paid', '2026-09-04 15:00+00', 'stripe', 'online', 'group_class_direct_payment', 'acct_rr2', 'pi_rr2_conflict', 'cs_rr2_conflict', null, 'Late Payer', 'group_class_revenue'),
  -- closed-period cases
  ('00000000-0000-0000-0000-000003618008', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612001', null, null, 50, 'card', 'paid', '2026-06-15 15:00+00', 'stripe', 'online', 'other', 'acct_rr2', 'pi_rr2_locked_rev', null, null, null, null),
  ('00000000-0000-0000-0000-000003618009', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003612001', null, null, 50, 'card', 'paid', '2026-07-05 15:00+00', 'stripe', 'online', 'other', 'acct_rr2', 'pi_rr2_locked_ref', null, null, null, null);

insert into public.group_class_enrollment_holds
  (id, studio_id, appointment_id, purchaser_user_id, purchaser_email, dancer_first_name, dancer_last_name, status, amount_cents, expires_at,
   stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id, attempt_count, client_id, link_id, attendee_id, payment_id, conflict_reason) values
  ('00000000-0000-0000-0000-000003619004', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616001', gen_random_uuid(), 'a@example.test', 'Gc', 'Full', 'converted', 2500, now(),
   'acct_rr2', 'cs_rr2_gc_full', 'pi_rr2_gc_full', 1, '00000000-0000-0000-0000-000003612003', '00000000-0000-0000-0000-000003617003', '00000000-0000-0000-0000-000003615003', '00000000-0000-0000-0000-000003618004', null),
  ('00000000-0000-0000-0000-000003619005', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616001', gen_random_uuid(), 'b@example.test', 'Gc', 'Partial', 'converted', 2500, now(),
   'acct_rr2', 'cs_rr2_gc_part', 'pi_rr2_gc_part', 1, '00000000-0000-0000-0000-000003612004', '00000000-0000-0000-0000-000003617004', '00000000-0000-0000-0000-000003615004', '00000000-0000-0000-0000-000003618005', null),
  ('00000000-0000-0000-0000-000003619006', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616002', gen_random_uuid(), 'c@example.test', 'Gc', 'Attended', 'converted', 2500, now(),
   'acct_rr2', 'cs_rr2_gc_att', 'pi_rr2_gc_att', 1, '00000000-0000-0000-0000-000003612005', '00000000-0000-0000-0000-000003617005', '00000000-0000-0000-0000-000003615005', '00000000-0000-0000-0000-000003618006', null),
  ('00000000-0000-0000-0000-000003619007', '00000000-0000-0000-0000-000003610001', '00000000-0000-0000-0000-000003616001', gen_random_uuid(), 'd@example.test', 'Late', 'Payer', 'conflict', 2500, now(),
   'acct_rr2', 'cs_rr2_conflict', 'pi_rr2_conflict', 1, null, null, null, '00000000-0000-0000-0000-000003618007', 'hold_released');

select pg_temp.t_ok('fixture: revenue is booked in the payment''s own (earlier) period',
  pg_temp.t_revenue_entry('00000000-0000-0000-0000-000003618001') = '2026-08-10|50.00|active|false'
  and pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618001') is null);

-- ============================================================================
-- A/B/H: partial refund in a later period -> refunded_at set, refund entry in the REFUND period
-- ============================================================================
select pg_temp.t_ok('B partial refund applies', pg_temp.t_refund('00000000-0000-0000-0000-000003618001', 'paid', 10, 're_rr2_1', 'evt_rr2_1') = 'true/false/false');
select pg_temp.t_ok('B refunded_at is set to the time the refund progress was applied',
  (select refunded_at = now() and status = 'paid' and refund_amount = 10 from public.payments where id = '00000000-0000-0000-0000-000003618001'));
select pg_temp.t_ok('A/H refund accounting entry belongs to the refund period, not the 2026-08-10 payment period',
  pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618001') = current_date::text || '|10.00|active|false',
  pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618001'));
select pg_temp.t_ok('A revenue entry stays in its own period',
  pg_temp.t_revenue_entry('00000000-0000-0000-0000-000003618001') = '2026-08-10|50.00|active|false');

-- ============================================================================
-- D/E: exact replay and stale lower cumulative events never touch refunded_at
-- ============================================================================
update public.payments set refunded_at = '2026-09-20 12:00+00' where id = '00000000-0000-0000-0000-000003618001';
select pg_temp.t_ok('D exact replay is a no-op', pg_temp.t_refund('00000000-0000-0000-0000-000003618001', 'paid', 10, 're_rr2_1', 'evt_rr2_1b') = 'false/false/false');
select pg_temp.t_ok('D exact replay leaves refunded_at unchanged',
  (select refunded_at = '2026-09-20 12:00+00' and refund_amount = 10 from public.payments where id = '00000000-0000-0000-0000-000003618001'));
select pg_temp.t_ok('E stale lower cumulative event is a no-op', pg_temp.t_refund('00000000-0000-0000-0000-000003618001', 'paid', 5, 're_rr2_0', 'evt_rr2_0') = 'false/false/false');
select pg_temp.t_ok('E stale event leaves amount and refunded_at unchanged',
  (select refunded_at = '2026-09-20 12:00+00' and refund_amount = 10 from public.payments where id = '00000000-0000-0000-0000-000003618001'));

-- ============================================================================
-- F/G: additional refund -> most recent refund progress; partial -> full
-- ============================================================================
select pg_temp.t_ok('F second partial refund applies', pg_temp.t_refund('00000000-0000-0000-0000-000003618001', 'paid', 30, 're_rr2_2', 'evt_rr2_2') = 'true/false/false');
select pg_temp.t_ok('F refunded_at moves to the most recent refund progress',
  (select refunded_at = now() and refund_amount = 30 from public.payments where id = '00000000-0000-0000-0000-000003618001'));
select pg_temp.t_ok('F the one cumulative refund entry carries the cumulative amount on the latest refund date',
  pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618001') = current_date::text || '|30.00|active|false');
update public.payments set refunded_at = now() + interval '1 day' where id = '00000000-0000-0000-0000-000003618001';
select pg_temp.t_ok('G partial -> full applies', pg_temp.t_refund('00000000-0000-0000-0000-000003618001', 'refunded', 50, 're_rr2_3', 'evt_rr2_3') = 'true/false/false');
select pg_temp.t_ok('G/C full refund: refunded, cumulative 50, refunded_at valid and never moved backwards',
  (select status = 'refunded' and refund_amount = 50 and refunded_at = now() + interval '1 day' from public.payments where id = '00000000-0000-0000-0000-000003618001'));
update public.payments set refunded_at = now() where id = '00000000-0000-0000-0000-000003618001';
select pg_temp.t_ok('G stale partial after the full refund leaves refunded_at and the entry alone',
  pg_temp.t_refund('00000000-0000-0000-0000-000003618001', 'paid', 30, 're_rr2_2', 'evt_rr2_2late') = 'false/false/false'
  and pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618001') = current_date::text || '|50.00|active|false');
select pg_temp.t_ok('N Stripe identity unchanged by refund reconciliation',
  (select stripe_account_id = 'acct_rr2' and stripe_payment_intent_id = 'pi_rr2_prior' and stripe_checkout_session_id = 'cs_rr2_prior' and stripe_refund_id = 're_rr2_3'
   from public.payments where id = '00000000-0000-0000-0000-000003618001'));

-- ============================================================================
-- I: package behavior unchanged
-- ============================================================================
select pg_temp.t_ok('I package full refund still deactivates the package', pg_temp.t_refund('00000000-0000-0000-0000-000003618002', 'refunded', 50, 're_rr2_p1', 'evt_rr2_p1') = 'true/true/false');
select pg_temp.t_ok('I package full refund [state]: inactive, refunded_at set, refund entry in refund period',
  (select active from public.client_packages where id = '00000000-0000-0000-0000-000003613001') = false
  and (select refunded_at = now() from public.payments where id = '00000000-0000-0000-0000-000003618002')
  and pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618002') = current_date::text || '|50.00|active|false');
select pg_temp.t_ok('I package partial refund keeps the existing net-settlement rule', pg_temp.t_refund('00000000-0000-0000-0000-000003618003', 'paid', 10, 're_rr2_p2', 'evt_rr2_p2') = 'true/true/false');

-- ============================================================================
-- J/K/L/M: Group Class effects unchanged; clientless conflict gets refunded_at
-- ============================================================================
select pg_temp.t_ok('J GC full refund before attendance', pg_temp.t_refund('00000000-0000-0000-0000-000003618004', 'refunded', 25, 're_rr2_g1', 'evt_rr2_g1') = 'true/false/false');
select pg_temp.t_ok('J GC full refund [state]: attendee cancelled + refunded; payment dated',
  (select status = 'cancelled' and payment_status = 'refunded' and cancelled_at is not null from public.appointment_attendees where id = '00000000-0000-0000-0000-000003615003')
  and (select refunded_at = now() from public.payments where id = '00000000-0000-0000-0000-000003618004'));
select pg_temp.t_ok('K GC partial refund', pg_temp.t_refund('00000000-0000-0000-0000-000003618005', 'paid', 10, 're_rr2_g2', 'evt_rr2_g2') = 'true/false/false');
select pg_temp.t_ok('K GC partial refund [state]: still booked, partial',
  (select status = 'booked' and payment_status = 'partial' from public.appointment_attendees where id = '00000000-0000-0000-0000-000003615004'));
select pg_temp.t_ok('L GC full refund after attendance', pg_temp.t_refund('00000000-0000-0000-0000-000003618006', 'refunded', 25, 're_rr2_g3', 'evt_rr2_g3') = 'true/false/false');
select pg_temp.t_ok('L GC post-attendance [state]: booking + attendance history kept, payment_status refunded',
  (select status = 'booked' and payment_status = 'refunded' and cancelled_at is null from public.appointment_attendees where id = '00000000-0000-0000-0000-000003615005')
  and exists (select 1 from public.attendance_records where appointment_id = '00000000-0000-0000-0000-000003616002' and client_id = '00000000-0000-0000-0000-000003612005' and status = 'attended'));
select pg_temp.t_ok('M clientless conflict refund', pg_temp.t_refund('00000000-0000-0000-0000-000003618007', 'refunded', 25, 're_rr2_c', 'evt_rr2_c') = 'true/false/false');
select pg_temp.t_ok('M clientless conflict [state]: refunded with a valid refunded_at, refund entry in refund period, still clientless',
  (select status = 'refunded' and refunded_at = now() and client_id is null from public.payments where id = '00000000-0000-0000-0000-000003618007')
  and pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618007') = current_date::text || '|25.00|active|false');

-- ============================================================================
-- Q: period locks preserved (per-entry locked_at)
-- ============================================================================
-- closed revenue period: the refund lands in the open refund period; the locked revenue entry is untouched
update public.accounting_entries set locked_at = now()
  where source_table = 'payments' and source_id = '00000000-0000-0000-0000-000003618008' and entry_type = 'revenue';
select pg_temp.t_ok('Q refund of a payment whose revenue period is locked applies', pg_temp.t_refund('00000000-0000-0000-0000-000003618008', 'refunded', 50, 're_rr2_l1', 'evt_rr2_l1') = 'true/false/false');
select pg_temp.t_ok('Q locked revenue entry untouched; refund entry created in the refund period',
  pg_temp.t_revenue_entry('00000000-0000-0000-0000-000003618008') = '2026-06-15|50.00|active|true'
  and pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618008') = current_date::text || '|50.00|active|false');
-- locked refund entry: a later refund never rewrites it (existing lock semantics, unchanged)
select pg_temp.t_ok('Q first partial on the second payment', pg_temp.t_refund('00000000-0000-0000-0000-000003618009', 'paid', 10, 're_rr2_l2', 'evt_rr2_l2') = 'true/false/false');
update public.accounting_entries set locked_at = now()
  where source_table = 'payments' and source_id = '00000000-0000-0000-0000-000003618009' and entry_type = 'refund';
select pg_temp.t_ok('Q a later refund still reconciles the payment without error', pg_temp.t_refund('00000000-0000-0000-0000-000003618009', 'paid', 20, 're_rr2_l3', 'evt_rr2_l3') = 'true/false/false');
select pg_temp.t_ok('Q the locked refund entry keeps its amount and date (lock enforcement not weakened)',
  pg_temp.t_refund_entry('00000000-0000-0000-0000-000003618009') = current_date::text || '|10.00|active|true'
  and (select refund_amount = 20 from public.payments where id = '00000000-0000-0000-0000-000003618009'));

select 'REFUND_RECON_2_SUITE' as suite, count(*) as passed, 'ALL_PASS' as result from t_results;

rollback;
