-- REFUND-RECON-1 -- shared Stripe refund reconciliation RPC, live-Postgres regression suite.
--
-- Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261027090000_refund_reconciliation_integrity.sql. One transaction, rolled back;
-- synthetic rows only. The RPC is called as service_role (its only grantee).
-- Test A (the predecessor's SQLSTATE 42804) is proven separately against the
-- pre-migration database (see the migration/test report).
--
-- Deterministic UUID block: 00000000-0000-0000-0000-0000035fXXXX

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

-- Calls the RPC as service_role; returns 'applied/package_deactivated/conflict' or 'ERR:<sqlstate>:<message>'.
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

-- ============================================================================
-- CATALOG POSTURE
-- ============================================================================
do $$
declare r record;
begin
  select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) as ret,
         (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) as acl,
         (select count(*) from pg_proc q where q.proname = p.proname) as overloads
    into r from pg_proc p where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure;
  perform pg_temp.t_ok('posture: owner/secdef/search_path/return/ACL/overloads preserved',
    r.owner = 'postgres' and r.prosecdef and r.proconfig = array['search_path=public']
    and r.ret = 'TABLE(applied boolean, package_deactivated boolean, conflict_recorded boolean)'
    and r.acl = 'postgres=X/postgres,service_role=X/postgres' and r.overloads = 1, row_to_json(r)::text);
  select pg_get_userbyid(p.proowner) as owner, p.prosecdef,
         (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) as acl
    into r from pg_proc p where p.oid = 'public._sync_group_class_purchase_refund(uuid,uuid,boolean)'::regprocedure;
  perform pg_temp.t_ok('posture: GC helper is owner-only (no API role can call it)', r.owner = 'postgres' and r.prosecdef and r.acl = 'postgres=X/postgres', row_to_json(r)::text);
end $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000035f0001', 'RR Studio A', 't-rr-a'),
  ('00000000-0000-0000-0000-0000035f0002', 'RR Studio B', 't-rr-b');

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-0000035f2001', '00000000-0000-0000-0000-0000035f0001', 'Plain', 'Payer', 'active'),
  ('00000000-0000-0000-0000-0000035f2002', '00000000-0000-0000-0000-0000035f0001', 'Pkg', 'Owner', 'active'),
  ('00000000-0000-0000-0000-0000035f2003', '00000000-0000-0000-0000-0000035f0001', 'Gc', 'Full', 'active'),
  ('00000000-0000-0000-0000-0000035f2004', '00000000-0000-0000-0000-0000035f0001', 'Gc', 'Partial', 'active'),
  ('00000000-0000-0000-0000-0000035f2005', '00000000-0000-0000-0000-0000035f0001', 'Gc', 'Attended', 'active'),
  ('00000000-0000-0000-0000-0000035f2006', '00000000-0000-0000-0000-0000035f0001', 'Bystander', 'Dancer', 'active'),
  ('00000000-0000-0000-0000-0000035f2007', '00000000-0000-0000-0000-0000035f0002', 'Other', 'Studio', 'active');

insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, price_snapshot) values
  ('00000000-0000-0000-0000-0000035f3001', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2002', 'RR Pack Full', true, 50),
  ('00000000-0000-0000-0000-0000035f3002', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2002', 'RR Pack Partial', true, 50);

insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at, roster_capacity) values
  ('00000000-0000-0000-0000-0000035f6001', '00000000-0000-0000-0000-0000035f0001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', 3),
  ('00000000-0000-0000-0000-0000035f6002', '00000000-0000-0000-0000-0000035f0001', 'group_class', 'scheduled', now() - interval '2 hours', now() - interval '1 hour', 3),
  ('00000000-0000-0000-0000-0000035f6003', '00000000-0000-0000-0000-0000035f0002', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', 3);

insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, can_manage_bookings, is_primary) values
  ('00000000-0000-0000-0000-0000035f7003', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2003', null, 'unclaimed', 'self', true, false),
  ('00000000-0000-0000-0000-0000035f7004', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2004', null, 'unclaimed', 'self', true, false),
  ('00000000-0000-0000-0000-0000035f7005', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2005', null, 'unclaimed', 'self', true, false);

insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type, payment_status) values
  ('00000000-0000-0000-0000-0000035f5003', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6001', '00000000-0000-0000-0000-0000035f2003', 'booked', 'self_service', 'pay_as_you_go', 'paid'),
  ('00000000-0000-0000-0000-0000035f5004', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6001', '00000000-0000-0000-0000-0000035f2004', 'booked', 'self_service', 'pay_as_you_go', 'paid'),
  ('00000000-0000-0000-0000-0000035f5005', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6002', '00000000-0000-0000-0000-0000035f2005', 'booked', 'self_service', 'pay_as_you_go', 'paid'),
  ('00000000-0000-0000-0000-0000035f5006', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6001', '00000000-0000-0000-0000-0000035f2006', 'booked', 'staff', 'free_comped', 'paid');

insert into public.attendance_records (studio_id, appointment_id, client_id, status) values
  ('00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6002', '00000000-0000-0000-0000-0000035f2005', 'attended');

-- payments (inserted paid; accounting/reward triggers run as for any paid payment)
insert into public.payments (id, studio_id, client_id, client_package_id, appointment_id, amount, payment_method, status, source, payment_channel, payment_type,
                             stripe_account_id, stripe_payment_intent_id, stripe_checkout_session_id, external_reference, guest_name, accounting_category) values
  ('00000000-0000-0000-0000-0000035f8001', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2001', null, null, 50, 'card', 'paid', 'stripe', 'online', 'other', 'acct_rrA', 'pi_rr_plain', 'cs_rr_plain', null, null, null),
  ('00000000-0000-0000-0000-0000035f8002', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2001', null, null, 50, 'card', 'paid', 'stripe', 'online', 'other', 'acct_rrA', 'pi_rr_partial', null, null, null, null),
  ('00000000-0000-0000-0000-0000035f8003', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2002', '00000000-0000-0000-0000-0000035f3001', null, 50, 'card', 'paid', 'stripe', 'online', 'package', 'acct_rrA', 'pi_rr_pkg_full', null, null, null, 'package_revenue'),
  ('00000000-0000-0000-0000-0000035f8004', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2002', '00000000-0000-0000-0000-0000035f3002', null, 50, 'card', 'paid', 'stripe', 'online', 'package', 'acct_rrA', 'pi_rr_pkg_part', null, null, null, 'package_revenue'),
  ('00000000-0000-0000-0000-0000035f8005', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2003', null, '00000000-0000-0000-0000-0000035f6001', 25, 'card', 'paid', 'stripe', 'online', 'group_class_direct_payment', 'acct_rrA', 'pi_rr_gc_full', 'cs_rr_gc_full', '00000000-0000-0000-0000-0000035f5003', null, 'group_class_revenue'),
  ('00000000-0000-0000-0000-0000035f8006', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2004', null, '00000000-0000-0000-0000-0000035f6001', 25, 'card', 'paid', 'stripe', 'online', 'group_class_direct_payment', 'acct_rrA', 'pi_rr_gc_part', 'cs_rr_gc_part', '00000000-0000-0000-0000-0000035f5004', null, 'group_class_revenue'),
  ('00000000-0000-0000-0000-0000035f8007', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2005', null, '00000000-0000-0000-0000-0000035f6002', 25, 'card', 'paid', 'stripe', 'online', 'group_class_direct_payment', 'acct_rrA', 'pi_rr_gc_att', 'cs_rr_gc_att', '00000000-0000-0000-0000-0000035f5005', null, 'group_class_revenue'),
  -- clientless checkout-conflict payment (no attendee)
  ('00000000-0000-0000-0000-0000035f8008', '00000000-0000-0000-0000-0000035f0001', null, null, '00000000-0000-0000-0000-0000035f6001', 25, 'card', 'paid', 'stripe', 'online', 'group_class_direct_payment', 'acct_rrA', 'pi_rr_gc_conflict', 'cs_rr_gc_conflict', null, 'Late Payer', 'group_class_revenue'),
  -- unrelated payment type whose external_reference points at a real attendee
  ('00000000-0000-0000-0000-0000035f8009', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2006', null, '00000000-0000-0000-0000-0000035f6001', 25, 'card', 'paid', 'stripe', 'online', 'pay_as_you_go_lesson', 'acct_rrA', 'pi_rr_unrelated', null, '00000000-0000-0000-0000-0000035f5006', null, null),
  -- group class payment with NO hold linkage, malformed/foreign external_reference
  ('00000000-0000-0000-0000-0000035f800a', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2006', null, '00000000-0000-0000-0000-0000035f6001', 25, 'card', 'paid', 'stripe', 'online', 'group_class_direct_payment', 'acct_rrA', 'pi_rr_nolink', null, '00000000-0000-0000-0000-0000035f5006', null, null),
  -- studio B group class payment that a studio-A hold wrongly names (cross-studio)
  ('00000000-0000-0000-0000-0000035f800b', '00000000-0000-0000-0000-0000035f0002', '00000000-0000-0000-0000-0000035f2007', null, '00000000-0000-0000-0000-0000035f6003', 25, 'card', 'paid', 'stripe', 'online', 'group_class_direct_payment', 'acct_rrB', 'pi_rr_cross', null, null, null, null),
  -- studio B group class payment whose studio-B hold names a studio-A attendee (R2)
  ('00000000-0000-0000-0000-0000035f800d', '00000000-0000-0000-0000-0000035f0002', '00000000-0000-0000-0000-0000035f2007', null, '00000000-0000-0000-0000-0000035f6003', 25, 'card', 'paid', 'stripe', 'online', 'group_class_direct_payment', 'acct_rrB', 'pi_rr_cross2', null, null, null, null),
  -- a voided payment (an unexpected prior state for a refund event)
  ('00000000-0000-0000-0000-0000035f800c', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f2001', null, null, 50, 'card', 'voided', 'stripe', 'online', 'other', 'acct_rrA', 'pi_rr_voided', null, null, null, null);

-- GC-3.5 bindings (converted holds name payment -> attendee; one conflict hold; one cross-studio hold)
insert into public.group_class_enrollment_holds
  (id, studio_id, appointment_id, purchaser_user_id, purchaser_email, dancer_first_name, dancer_last_name, status, amount_cents, expires_at,
   stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id, attempt_count, client_id, link_id, attendee_id, payment_id, conflict_reason) values
  ('00000000-0000-0000-0000-0000035f9005', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6001', gen_random_uuid(), 'a@example.test', 'Gc', 'Full', 'converted', 2500, now(),
   'acct_rrA', 'cs_rr_gc_full', 'pi_rr_gc_full', 1, '00000000-0000-0000-0000-0000035f2003', '00000000-0000-0000-0000-0000035f7003', '00000000-0000-0000-0000-0000035f5003', '00000000-0000-0000-0000-0000035f8005', null),
  ('00000000-0000-0000-0000-0000035f9006', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6001', gen_random_uuid(), 'b@example.test', 'Gc', 'Partial', 'converted', 2500, now(),
   'acct_rrA', 'cs_rr_gc_part', 'pi_rr_gc_part', 1, '00000000-0000-0000-0000-0000035f2004', '00000000-0000-0000-0000-0000035f7004', '00000000-0000-0000-0000-0000035f5004', '00000000-0000-0000-0000-0000035f8006', null),
  ('00000000-0000-0000-0000-0000035f9007', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6002', gen_random_uuid(), 'c@example.test', 'Gc', 'Attended', 'converted', 2500, now(),
   'acct_rrA', 'cs_rr_gc_att', 'pi_rr_gc_att', 1, '00000000-0000-0000-0000-0000035f2005', '00000000-0000-0000-0000-0000035f7005', '00000000-0000-0000-0000-0000035f5005', '00000000-0000-0000-0000-0000035f8007', null),
  ('00000000-0000-0000-0000-0000035f9008', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6001', gen_random_uuid(), 'd@example.test', 'Late', 'Payer', 'conflict', 2500, now(),
   'acct_rrA', 'cs_rr_gc_conflict', 'pi_rr_gc_conflict', 1, null, null, null, '00000000-0000-0000-0000-0000035f8008', 'hold_released'),
  ('00000000-0000-0000-0000-0000035f900b', '00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f6001', gen_random_uuid(), 'e@example.test', 'Cross', 'Studio', 'converted', 2500, now(),
   'acct_rrB', 'cs_rr_cross', 'pi_rr_cross', 1, '00000000-0000-0000-0000-0000035f2006', '00000000-0000-0000-0000-0000035f7003', '00000000-0000-0000-0000-0000035f5006', '00000000-0000-0000-0000-0000035f800b', null),
  ('00000000-0000-0000-0000-0000035f900d', '00000000-0000-0000-0000-0000035f0002', '00000000-0000-0000-0000-0000035f6001', gen_random_uuid(), 'f@example.test', 'Cross', 'Two', 'converted', 2500, now(),
   'acct_rrB', 'cs_rr_cross2', 'pi_rr_cross2', 1, '00000000-0000-0000-0000-0000035f2006', '00000000-0000-0000-0000-0000035f7003', '00000000-0000-0000-0000-0000035f5006', '00000000-0000-0000-0000-0000035f800d', null);

create temp table t_before as
  select (select count(*) from public.appointment_attendees where studio_id in ('00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f0002')) as attendees,
         (select count(*) from public.payments where studio_id in ('00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f0002')) as payments,
         (select count(*) from public.clients where studio_id in ('00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f0002')) as clients,
         (select count(*) from public.reward_events where client_id in (select id from public.clients where studio_id = '00000000-0000-0000-0000-0000035f0001')) as rewards,
         public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035f6001') as reserved_6001,
         public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035f6002') as reserved_6002;

-- ============================================================================
-- B/D/F/S: plain full refund
-- ============================================================================
select pg_temp.t_ok('B/D full refund applies (was 42804)', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8001', 'refunded', 50, 're_rr_1', 'evt_rr_1') = 'true/false/false');
select pg_temp.t_ok('D payment status refunded with cumulative amount and refund id', exists (select 1 from public.payments
  where id = '00000000-0000-0000-0000-0000035f8001' and status = 'refunded' and refund_amount = 50 and stripe_refund_id = 're_rr_1'));
select pg_temp.t_ok('F duplicate full delivery is an idempotent no-op (no conflict)', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8001', 'refunded', 50, 're_rr_1', 'evt_rr_1b') = 'false/false/false');
select pg_temp.t_ok('S Stripe identity unchanged (account, PaymentIntent, session)', exists (select 1 from public.payments
  where id = '00000000-0000-0000-0000-0000035f8001' and stripe_account_id = 'acct_rrA' and stripe_payment_intent_id = 'pi_rr_plain' and stripe_checkout_session_id = 'cs_rr_plain'));
select pg_temp.t_ok('a null refund id never erases the stored one', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8001', 'refunded', 50, null, 'evt_rr_1c') = 'false/false/false');
select pg_temp.t_ok('a null refund id never erases the stored one [state]', (select stripe_refund_id from public.payments where id = '00000000-0000-0000-0000-0000035f8001') = 're_rr_1');

-- ============================================================================
-- C/E/G: partial refunds, cumulative and monotonic
-- ============================================================================
select pg_temp.t_ok('C partial refund applies', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8002', 'paid', 10, 're_rr_2', 'evt_rr_2') = 'true/false/false');
select pg_temp.t_ok('E partial stays paid with cumulative refund_amount', exists (select 1 from public.payments where id = '00000000-0000-0000-0000-0000035f8002' and status = 'paid' and refund_amount = 10));
select pg_temp.t_ok('C second partial raises the cumulative amount', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8002', 'paid', 20, 're_rr_3', 'evt_rr_3') = 'true/false/false');
select pg_temp.t_ok('C second partial raises the cumulative amount [state]', (select refund_amount from public.payments where id = '00000000-0000-0000-0000-0000035f8002') = 20);
select pg_temp.t_ok('F duplicate partial is a no-op', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8002', 'paid', 20, 're_rr_3', 'evt_rr_3b') = 'false/false/false');
select pg_temp.t_ok('G stale lower cumulative partial never lowers the stored refund', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8002', 'paid', 10, 're_rr_2', 'evt_rr_2late') = 'false/false/false');
select pg_temp.t_ok('G stale lower cumulative partial never lowers the stored refund [state]', (select refund_amount from public.payments where id = '00000000-0000-0000-0000-0000035f8002') = 20);
select pg_temp.t_ok('full after partials reaches refunded', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8002', 'refunded', 50, 're_rr_4', 'evt_rr_4') = 'true/false/false');
select pg_temp.t_ok('full after partials reaches refunded [state]', (select status::text || '/' || refund_amount from public.payments where id = '00000000-0000-0000-0000-0000035f8002') = 'refunded/50.00');
select pg_temp.t_ok('G stale partial after the full refund: no regression, no false conflict', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8002', 'paid', 20, 're_rr_3', 'evt_rr_3late') = 'false/false/false');
select pg_temp.t_ok('G stale partial after the full refund: no regression, no false conflict [state]', (select status::text || '/' || refund_amount from public.payments where id = '00000000-0000-0000-0000-0000035f8002') = 'refunded/50.00'
  and not exists (select 1 from public.payment_settlement_conflicts where payment_id = '00000000-0000-0000-0000-0000035f8002'));
select pg_temp.t_ok('invalid status and negative amount are refused, nothing written', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8001', 'voided', 50, 're_x', 'evt_x') like 'ERR:P0001:REFUND_RECON_INVALID_STATUS%'
  and pg_temp.t_refund('00000000-0000-0000-0000-0000035f8001', 'refunded', -1, 're_x', 'evt_x') like 'ERR:P0001:REFUND_RECON_INVALID_AMOUNT%');
select pg_temp.t_ok('a genuinely unexpected prior status (voided) still records a settlement conflict (unchanged)',
  pg_temp.t_refund('00000000-0000-0000-0000-0000035f800c', 'refunded', 50, 're_rr_v', 'evt_rr_voided') = 'false/false/true');
select pg_temp.t_ok('a genuinely unexpected prior status (voided) still records a settlement conflict [state]',
  exists (select 1 from public.payment_settlement_conflicts where payment_id = '00000000-0000-0000-0000-0000035f800c' and stripe_event_id = 'evt_rr_voided')
  and (select status::text from public.payments where id = '00000000-0000-0000-0000-0000035f800c') = 'voided');

-- ============================================================================
-- H/I: package behavior preserved
-- ============================================================================
select pg_temp.t_ok('H package full refund applies and deactivates the package', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8003', 'refunded', 50, 're_rr_p1', 'evt_rr_p1') = 'true/true/false');
select pg_temp.t_ok('H package full refund applies and deactivates the package [state]', (select active from public.client_packages where id = '00000000-0000-0000-0000-0000035f3001') = false);
select pg_temp.t_ok('H replay does not repeat the deactivation side effect', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8003', 'refunded', 50, 're_rr_p1', 'evt_rr_p1b') = 'false/false/false');
select pg_temp.t_ok('I package partial refund keeps the existing settlement rule (paid 50 - refunded 10 < price 50 -> unsettled)',
  pg_temp.t_refund('00000000-0000-0000-0000-0000035f8004', 'paid', 10, 're_rr_p2', 'evt_rr_p2') = 'true/true/false');
select pg_temp.t_ok('I package partial refund [state]',
  (select status::text || '/' || refund_amount from public.payments where id = '00000000-0000-0000-0000-0000035f8004') = 'paid/10.00');

-- ============================================================================
-- J/K/L: Group Class enrollment effects
-- ============================================================================
select pg_temp.t_ok('J GC full refund before attendance applies', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8005', 'refunded', 25, 're_rr_g1', 'evt_rr_g1') = 'true/false/false');
select pg_temp.t_ok('J attendee cancelled + refunded, row kept', exists (select 1 from public.appointment_attendees
  where id = '00000000-0000-0000-0000-0000035f5003' and status = 'cancelled' and payment_status = 'refunded' and cancelled_at is not null));
select pg_temp.t_ok('K GC partial refund applies', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8006', 'paid', 5, 're_rr_g2', 'evt_rr_g2') = 'true/false/false');
select pg_temp.t_ok('K attendee booked with payment_status partial; payment paid with refund_amount', exists (select 1 from public.appointment_attendees
  where id = '00000000-0000-0000-0000-0000035f5004' and status = 'booked' and payment_status = 'partial' and cancelled_at is null)
  and (select status::text || '/' || refund_amount from public.payments where id = '00000000-0000-0000-0000-0000035f8006') = 'paid/5.00');
select pg_temp.t_ok('J/K seat released only by the full refund (reserved 3 -> 2; partial keeps its seat)',
  public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035f6001') = (select reserved_6001 from t_before) - 1);
select pg_temp.t_ok('L GC full refund after recorded attendance applies without error', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8007', 'refunded', 25, 're_rr_g3', 'evt_rr_g3') = 'true/false/false');
select pg_temp.t_ok('L booking and attendance history kept; payment_status refunded', exists (select 1 from public.appointment_attendees
  where id = '00000000-0000-0000-0000-0000035f5005' and status = 'booked' and payment_status = 'refunded' and cancelled_at is null)
  and exists (select 1 from public.attendance_records where appointment_id = '00000000-0000-0000-0000-0000035f6002' and client_id = '00000000-0000-0000-0000-0000035f2005' and status = 'attended')
  and public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035f6002') = (select reserved_6002 from t_before));
select pg_temp.t_ok('GCSD1 guard unchanged', (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.enforce_attendee_cancel_no_terminal_attendance()'::regprocedure) = 'd7e90072acc77b158bd4121306d30db6');
select pg_temp.t_ok('V GC replays converge and change nothing more', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8005', 'refunded', 25, 're_rr_g1', 'evt_rr_g1b') = 'false/false/false'
  and pg_temp.t_refund('00000000-0000-0000-0000-0000035f8006', 'paid', 5, 're_rr_g2', 'evt_rr_g2b') = 'false/false/false'
  and pg_temp.t_refund('00000000-0000-0000-0000-0000035f8007', 'refunded', 25, 're_rr_g3', 'evt_rr_g3b') = 'false/false/false');
select pg_temp.t_ok('V GC replays converge and change nothing more [state]', (select status || '/' || payment_status from public.appointment_attendees where id = '00000000-0000-0000-0000-0000035f5004') = 'booked/partial');
select pg_temp.t_ok('GC partial then full: booked/partial -> cancelled/refunded', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8006', 'refunded', 25, 're_rr_g4', 'evt_rr_g4') = 'true/false/false');
select pg_temp.t_ok('GC partial then full: booked/partial -> cancelled/refunded [state]', (select status || '/' || payment_status from public.appointment_attendees where id = '00000000-0000-0000-0000-0000035f5004') = 'cancelled/refunded');

-- ============================================================================
-- N/O: clientless conflict payment
-- ============================================================================
select pg_temp.t_ok('N clientless conflict payment full refund applies', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8008', 'refunded', 25, 're_rr_c1', 'evt_rr_c1') = 'true/false/false');
select pg_temp.t_ok('N clientless conflict payment full refund applies [state]', exists (select 1 from public.payments where id = '00000000-0000-0000-0000-0000035f8008' and status = 'refunded' and client_id is null));

-- ============================================================================
-- P/Q/R: no attendee is touched without positive, same-studio linkage
-- ============================================================================
select pg_temp.t_ok('P unrelated payment_type (external_reference names an attendee) refunds the payment only', pg_temp.t_refund('00000000-0000-0000-0000-0000035f8009', 'refunded', 25, 're_rr_u', 'evt_rr_u') = 'true/false/false');
select pg_temp.t_ok('P unrelated payment_type (external_reference names an attendee) refunds the payment only [state]', (select status || '/' || payment_status from public.appointment_attendees where id = '00000000-0000-0000-0000-0000035f5006') = 'booked/paid');
select pg_temp.t_ok('Q group class payment without hold linkage (malformed/foreign reference) never touches an attendee', pg_temp.t_refund('00000000-0000-0000-0000-0000035f800a', 'refunded', 25, 're_rr_q', 'evt_rr_q') = 'true/false/false');
select pg_temp.t_ok('Q group class payment without hold linkage (malformed/foreign reference) never touches an attendee [state]', (select status || '/' || payment_status from public.appointment_attendees where id = '00000000-0000-0000-0000-0000035f5006') = 'booked/paid');
select pg_temp.t_ok('R a hold in another studio than the payment cannot update that studio''s attendee', pg_temp.t_refund('00000000-0000-0000-0000-0000035f800b', 'refunded', 25, 're_rr_r', 'evt_rr_r') = 'true/false/false');
select pg_temp.t_ok('R a hold in another studio than the payment cannot update that studio''s attendee [state]', (select status || '/' || payment_status from public.appointment_attendees where id = '00000000-0000-0000-0000-0000035f5006') = 'booked/paid');

select pg_temp.t_ok('R2 a same-studio hold naming another studio''s attendee cannot update it', pg_temp.t_refund('00000000-0000-0000-0000-0000035f800d', 'refunded', 25, 're_rr_r2', 'evt_rr_r2') = 'true/false/false');
select pg_temp.t_ok('R2 [state]', (select status || '/' || payment_status from public.appointment_attendees where id = '00000000-0000-0000-0000-0000035f5006') = 'booked/paid');

-- ============================================================================
-- M/O/T/U: nothing deleted or created; accounting and rewards
-- ============================================================================
select pg_temp.t_ok('M no attendee or payment rows deleted', (select attendees from t_before) = (select count(*) from public.appointment_attendees where studio_id in ('00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f0002'))
  and (select payments from t_before) = (select count(*) from public.payments where studio_id in ('00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f0002')));
select pg_temp.t_ok('O no client created by any refund (including the clientless one)', (select clients from t_before) = (select count(*) from public.clients where studio_id in ('00000000-0000-0000-0000-0000035f0001', '00000000-0000-0000-0000-0000035f0002')));
select pg_temp.t_ok('T accounting: one live revenue entry and one live refund entry per refunded payment (trigger-produced, no duplicates)', not exists (
  select 1 from public.payments p
  where p.id in ('00000000-0000-0000-0000-0000035f8001', '00000000-0000-0000-0000-0000035f8005', '00000000-0000-0000-0000-0000035f8008')
    and ((select count(*) from public.accounting_entries ae where ae.source_table = 'payments' and ae.source_id = p.id and ae.entry_type = 'revenue' and ae.voided_at is null) <> 1
      or (select count(*) from public.accounting_entries ae where ae.source_table = 'payments' and ae.source_id = p.id and ae.entry_type = 'refund' and ae.voided_at is null) <> 1)));
select pg_temp.t_ok('T clientless conflict refund accounting entry has no client', exists (select 1 from public.accounting_entries ae
  where ae.source_table = 'payments' and ae.source_id = '00000000-0000-0000-0000-0000035f8008' and ae.entry_type = 'refund' and ae.client_id is null and ae.voided_at is null));
select pg_temp.t_ok('U rewards: refunds add no reward events', (select rewards from t_before) = (select count(*) from public.reward_events where client_id in (select id from public.clients where studio_id = '00000000-0000-0000-0000-0000035f0001')));

select count(*) as assertions_passed, count(distinct label) as distinct_labels from t_results;

rollback;
