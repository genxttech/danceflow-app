-- GC-S1C-2 -- authoritative group-class cancellation safety, live-Postgres
-- regression suite for the hardened public.cancel_group_class_appointment.
--
-- Proves: broad-staff-only authority with tenant isolation; a scheduled class
-- cancels and only its booked attendees are cancelled and returned; the
-- already-cancelled replay is a pure no-op (no restamp, no recipients, no
-- attendee change); recorded attended / no_show attendance refuses
-- cancellation with a stable code (UI and direct RPC share the guard); a past
-- class with no terminal attendance can still be cancelled; non-terminal
-- attendance (registered / checked_in) does not block; membership usage,
-- package usage and attendance_records are never touched; series identity,
-- occurrence index/original start, overrides and neighboring occurrences are
-- preserved; security mode, search_path and grants; legacy Events untouched.
-- One transaction, rolled back at the end. Run via
-- `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261016090000 (this migration) is applied.
--
-- Deterministic UUID block (...0000-0000-0000-0000-000000eNXXXX):
--   e0 studios, e1 auth.users/profiles, e2 instructors, e3 clients,
--   e4 appointments, e5 membership plan/membership, e6 packages, e7 request ids.

begin;

create table public.t_gcsc2_log (n serial, msg text);
grant all on public.t_gcsc2_log to public;
grant usage on sequence public.t_gcsc2_log_n_seq to public;
create function public.t_gcsc2_pass(p text) returns void language sql as $$ insert into public.t_gcsc2_log (msg) values (p) $$;
grant execute on function public.t_gcsc2_pass(text) to public;

create function public.t_gcsc2_expect(p_sql text, p_like text, p_label text)
returns void language plpgsql as $$
declare v_failed boolean := false; v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_failed := true; v_err := sqlerrm;
  end;
  if not v_failed then
    raise exception 'FAIL %: expected an error containing [%], statement succeeded', p_label, p_like;
  end if;
  if position(lower(p_like) in lower(v_err)) = 0 then
    raise exception 'FAIL %: expected error containing [%], got [%]', p_label, p_like, v_err;
  end if;
  perform public.t_gcsc2_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc2_expect(text, text, text) to anon, authenticated;

create function public.t_gcsc2_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsc2_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc2_assert(text, text, text) to public;

-- RLS-independent snapshots (security definer so role-switched checks can read)
create function public.t_gcsc2_snap(p_appt uuid) returns text language sql stable security definer set search_path = 'public' as $x$
  select
    (select a.status::text || '|' || coalesce(a.cancelled_at::text, '-') from public.appointments a where a.id = p_appt)
    || '#' ||
    coalesce((select string_agg(aa.client_id::text || ':' || aa.status || ':' || coalesce(aa.cancelled_at::text, '-'), ',' order by aa.client_id) from public.appointment_attendees aa where aa.appointment_id = p_appt), '')
$x$;
grant execute on function public.t_gcsc2_snap(uuid) to public;

create function public.t_gcsc2_attendance(p_appt uuid) returns text language sql stable security definer set search_path = 'public' as $x$
  select coalesce(string_agg(ar.client_id::text || ':' || ar.status || ':' || ar.updated_at::text, ',' order by ar.client_id), '')
  from public.attendance_records ar where ar.appointment_id = p_appt
$x$;
grant execute on function public.t_gcsc2_attendance(uuid) to public;

create function public.t_gcsc2_usage() returns text language sql stable security definer set search_path = 'public' as $x$
  select (select count(*) from public.client_membership_usage)::text || '/' ||
         coalesce((select sum(quantity_used)::text from public.client_membership_usage), '0') || '/' ||
         (select count(*) from public.membership_usage_sync_errors)::text || '/' ||
         coalesce((select sum(quantity_used + quantity_remaining)::text from public.client_package_items), '0') || '/' ||
         coalesce((select sum(quantity_used)::text from public.client_package_items), '0')
$x$;
grant execute on function public.t_gcsc2_usage() to public;

-- ============================================================================
-- 0. Pre-flight snapshot
-- ============================================================================
create temp table t_gcsc2_snap0 as
select
  (select count(*) from public.events) as events_n,
  (select count(*) from public.event_sessions) as event_sessions_n,
  (select count(*) from public.event_registrations) as event_regs_n;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000e00001', 'GC-S1C-2 Harness Studio A', 't-gcsc2-studio-a', 'America/New_York'),
  ('00000000-0000-0000-0000-000000e00002', 'GC-S1C-2 Harness Studio B', 't-gcsc2-studio-b', 'America/Los_Angeles');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e10001', 't-gcsc2-owner-a@example.test'),
  ('00000000-0000-0000-0000-000000e10002', 't-gcsc2-admin-a@example.test'),
  ('00000000-0000-0000-0000-000000e10003', 't-gcsc2-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-000000e10004', 't-gcsc2-instructor-a@example.test'),
  ('00000000-0000-0000-0000-000000e10005', 't-gcsc2-unrelated@example.test'),
  ('00000000-0000-0000-0000-000000e10006', 't-gcsc2-owner-b@example.test'),
  ('00000000-0000-0000-0000-000000e10007', 't-gcsc2-platform-admin@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000e10001', 't-gcsc2-owner-a@example.test', null),
  ('00000000-0000-0000-0000-000000e10002', 't-gcsc2-admin-a@example.test', null),
  ('00000000-0000-0000-0000-000000e10003', 't-gcsc2-frontdesk-a@example.test', null),
  ('00000000-0000-0000-0000-000000e10004', 't-gcsc2-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-000000e10005', 't-gcsc2-unrelated@example.test', null),
  ('00000000-0000-0000-0000-000000e10006', 't-gcsc2-owner-b@example.test', null),
  ('00000000-0000-0000-0000-000000e10007', 't-gcsc2-platform-admin@example.test', 'platform_admin');

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000e10001', '00000000-0000-0000-0000-000000e00001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000e10002', '00000000-0000-0000-0000-000000e00001', 'studio_admin', true),
  ('00000000-0000-0000-0000-000000e10003', '00000000-0000-0000-0000-000000e00001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000e10004', '00000000-0000-0000-0000-000000e00001', 'instructor', true),
  ('00000000-0000-0000-0000-000000e10006', '00000000-0000-0000-0000-000000e00002', 'studio_owner', true);

alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000e20001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e10004', 'Cancel', 'Instructor', true, true);
alter table public.instructors enable trigger user;

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-000000e30001', '00000000-0000-0000-0000-000000e00001', 'Member', 'Booked', 'active', false),
  ('00000000-0000-0000-0000-000000e30002', '00000000-0000-0000-0000-000000e00001', 'Comp', 'Booked', 'active', false),
  ('00000000-0000-0000-0000-000000e30003', '00000000-0000-0000-0000-000000e00001', 'Package', 'Booked', 'active', false),
  ('00000000-0000-0000-0000-000000e30004', '00000000-0000-0000-0000-000000e00001', 'Already', 'Cancelled', 'active', false),
  ('00000000-0000-0000-0000-000000e30005', '00000000-0000-0000-0000-000000e00001', 'Comp', 'Attended', 'active', false),
  ('00000000-0000-0000-0000-000000e30006', '00000000-0000-0000-0000-000000e00001', 'Comp', 'NoShow', 'active', false),
  ('00000000-0000-0000-0000-000000e30007', '00000000-0000-0000-0000-000000e00001', 'Comp', 'Registered', 'active', false),
  ('00000000-0000-0000-0000-000000e30008', '00000000-0000-0000-0000-000000e00001', 'Comp', 'CheckedIn', 'active', false);

-- Membership with a group-class benefit (needed for membership-billed attendees)
insert into public.membership_plans (id, studio_id, name) values
  ('00000000-0000-0000-0000-000000e50001', '00000000-0000-0000-0000-000000e00001', 'GC-S1C-2 Plan');
insert into public.membership_plan_benefits (membership_plan_id, benefit_type, quantity, usage_period) values
  ('00000000-0000-0000-0000-000000e50001', 'included_group_classes', 10, 'billing_cycle');
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on, current_period_start, current_period_end,
  auto_renew, cancel_at_period_end, name_snapshot, price_snapshot, billing_interval_snapshot
) values
  ('00000000-0000-0000-0000-000000e51001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30001',
   '00000000-0000-0000-0000-000000e50001', 'active', current_date - 5, current_date - 5, current_date + 25, false, false, 'GC-S1C-2 Membership', 0, 'monthly');

insert into public.client_packages (id, studio_id, client_id, name_snapshot, purchase_date, is_shareable, active) values
  ('00000000-0000-0000-0000-000000e60001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30003', 'GC-S1C-2 Package', current_date, false, true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000e61001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e60001', 'group_class', 5, 0, 5, false);

-- Classes (studio A unless noted). Aliases:
--   OK  e40001 future scheduled standalone: members c1(membership) c2(comp) c3(package) booked, c4 already cancelled
--   PAST e40002 past scheduled, c2 booked, no attendance records at all
--   ATT e40003 attended history (c1 membership + c5 comp)
--   NS  e40004 no_show history (c6)
--   NONT e40005 only registered / checked_in attendance (c7, c8): non-terminal
--   B   e40006 studio B class
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000e40001', '00000000-0000-0000-0000-000000e00001', null, '00000000-0000-0000-0000-000000e20001', 'group_class', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour', 'OK'),
  ('00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e00001', null, '00000000-0000-0000-0000-000000e20001', 'group_class', 'scheduled', now() - interval '10 days', now() - interval '10 days' + interval '1 hour', 'PAST'),
  ('00000000-0000-0000-0000-000000e40003', '00000000-0000-0000-0000-000000e00001', null, '00000000-0000-0000-0000-000000e20001', 'group_class', 'scheduled', now() - interval '5 days', now() - interval '5 days' + interval '1 hour', 'ATT'),
  ('00000000-0000-0000-0000-000000e40004', '00000000-0000-0000-0000-000000e00001', null, '00000000-0000-0000-0000-000000e20001', 'group_class', 'scheduled', now() - interval '4 days', now() - interval '4 days' + interval '1 hour', 'NS'),
  ('00000000-0000-0000-0000-000000e40005', '00000000-0000-0000-0000-000000e00001', null, '00000000-0000-0000-0000-000000e20001', 'group_class', 'scheduled', now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 'NONT');
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title)
select '00000000-0000-0000-0000-000000e40006', '00000000-0000-0000-0000-000000e00002', null, null, 'group_class', 'scheduled', now() + interval '12 days', now() + interval '12 days 1 hour', 'B';
-- a private lesson that must never be touched by the class RPC
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000e40007', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30002', '00000000-0000-0000-0000-000000e20001', 'private_lesson', 'scheduled', now() + interval '11 days', now() + interval '11 days 1 hour', 'PRIVATE');

insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id, client_package_id, cancelled_at) values
  ('00000000-0000-0000-0000-000000e41001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40001', '00000000-0000-0000-0000-000000e30001', 'booked', 'staff', 'membership', '00000000-0000-0000-0000-000000e51001', null, null),
  ('00000000-0000-0000-0000-000000e41002', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40001', '00000000-0000-0000-0000-000000e30002', 'booked', 'staff', 'free_comped', null, null, null),
  ('00000000-0000-0000-0000-000000e41003', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40001', '00000000-0000-0000-0000-000000e30003', 'booked', 'staff', 'package_credit', null, '00000000-0000-0000-0000-000000e60001', null),
  ('00000000-0000-0000-0000-000000e41004', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40001', '00000000-0000-0000-0000-000000e30004', 'cancelled', 'staff', 'free_comped', null, null, '2026-01-01T00:00:00+00'),
  ('00000000-0000-0000-0000-000000e41005', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e30002', 'booked', 'staff', 'free_comped', null, null, null),
  ('00000000-0000-0000-0000-000000e41006', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40003', '00000000-0000-0000-0000-000000e30001', 'booked', 'staff', 'membership', '00000000-0000-0000-0000-000000e51001', null, null),
  ('00000000-0000-0000-0000-000000e41007', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40003', '00000000-0000-0000-0000-000000e30005', 'booked', 'staff', 'free_comped', null, null, null),
  ('00000000-0000-0000-0000-000000e41008', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40004', '00000000-0000-0000-0000-000000e30006', 'booked', 'staff', 'free_comped', null, null, null),
  ('00000000-0000-0000-0000-000000e41009', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40005', '00000000-0000-0000-0000-000000e30007', 'booked', 'staff', 'free_comped', null, null, null),
  ('00000000-0000-0000-0000-000000e4100a', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40005', '00000000-0000-0000-0000-000000e30008', 'booked', 'staff', 'free_comped', null, null, null);

-- Recorded attendance (as migration owner: fires the real consumption triggers,
-- including membership usage for the membership-funded attendee).
insert into public.attendance_records (id, studio_id, appointment_id, client_id, status) values
  ('00000000-0000-0000-0000-000000e42001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40003', '00000000-0000-0000-0000-000000e30001', 'attended'),
  ('00000000-0000-0000-0000-000000e42002', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40003', '00000000-0000-0000-0000-000000e30005', 'attended'),
  ('00000000-0000-0000-0000-000000e42003', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40004', '00000000-0000-0000-0000-000000e30006', 'no_show'),
  ('00000000-0000-0000-0000-000000e42004', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40005', '00000000-0000-0000-0000-000000e30007', 'registered'),
  ('00000000-0000-0000-0000-000000e42005', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40005', '00000000-0000-0000-0000-000000e30008', 'checked_in');

-- A usage row referencing the cancellable class, so "usage unchanged on cancel" is a real check.
insert into public.client_membership_usage (client_membership_id, membership_plan_benefit_id, quantity_used, reference_type, reference_id)
select '00000000-0000-0000-0000-000000e51001', b.id, 1, 'appointment', '00000000-0000-0000-0000-000000e40001'
from public.membership_plan_benefits b where b.membership_plan_id = '00000000-0000-0000-0000-000000e50001' limit 1;

-- A real series (created through the released B1 RPC as the owner) with a booked attendee on occurrence 2.
do $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000e00001',
    p_client_request_id => '00000000-0000-0000-0000-000000e70001',
    p_title => 'Cancel Series', p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000e20001', p_room_id => null, p_location_name => null, p_roster_capacity => 20,
    p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => 4,
    p_local_start_time => time '18:30', p_duration_minutes => 60);
  reset role;
  perform set_config('t.series', v_res ->> 'series_id', true);
end $$;

select public.t_gcsc2_assert('T-gcsc2-fixture-series-has-4-occurrences',
  (select count(*)::text from public.appointments where group_class_series_id = current_setting('t.series')::uuid), '4');

insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type)
select '00000000-0000-0000-0000-000000e41101', '00000000-0000-0000-0000-000000e00001', a.id, '00000000-0000-0000-0000-000000e30002', 'booked', 'staff', 'free_comped'
from public.appointments a where a.group_class_series_id = current_setting('t.series')::uuid and a.series_occurrence_index = 2;

-- Baselines (as owner)
create temp table t_gcsc2_base as
select
  public.t_gcsc2_usage() as usage0,
  public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40003') as att_att,
  public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40004') as att_ns,
  public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40005') as att_nont,
  public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40003') as snap_att,
  public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40004') as snap_ns,
  public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40006') as snap_b,
  public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40007') as snap_priv;

-- ============================================================================
-- 1. Security posture
-- ============================================================================
select public.t_gcsc2_assert('T-gcsc2-rpc-security-definer-fixed-search-path',
  (select (p.prosecdef and p.proconfig = array['search_path=public'])::text from pg_proc p where p.oid = 'public.cancel_group_class_appointment(uuid)'::regprocedure), 'true');
select public.t_gcsc2_assert('T-gcsc2-rpc-signature-and-result-unchanged',
  (select pg_get_function_identity_arguments(p.oid) || '->' || pg_get_function_result(p.oid) from pg_proc p where p.oid = 'public.cancel_group_class_appointment(uuid)'::regprocedure), 'p_appointment_id uuid->uuid[]');
select public.t_gcsc2_assert('T-gcsc2-rpc-grants-authenticated-only',
  (select (has_function_privilege('authenticated', 'public.cancel_group_class_appointment(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.cancel_group_class_appointment(uuid)', 'execute')
     and not has_function_privilege('service_role', 'public.cancel_group_class_appointment(uuid)', 'execute'))::text), 'true');
select public.t_gcsc2_assert('T-gcsc2-rpc-not-executable-by-public',
  (select (not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0))::text from pg_proc p where p.oid = 'public.cancel_group_class_appointment(uuid)'::regprocedure), 'true');

-- ============================================================================
-- 2. Authority + tenant isolation (nothing may change on a refusal)
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10004')::text, true);
  set local role authenticated;
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40001')$q$, 'Not authorized', 'T-gcsc2-instructor-refused');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10006')::text, true);
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40001')$q$, 'Not authorized', 'T-gcsc2-other-studio-owner-refused');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10005')::text, true);
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40001')$q$, 'Not authorized', 'T-gcsc2-unrelated-user-refused');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40006')$q$, 'Not authorized', 'T-gcsc2-owner-a-cannot-cancel-studio-b-class');
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40007')$q$, 'Group class not found', 'T-gcsc2-private-lesson-not-a-group-class');
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ffffff')$q$, 'Group class not found', 'T-gcsc2-missing-class-not-found');
  reset role;
end $$;
select public.t_gcsc2_assert('T-gcsc2-refusals-changed-nothing',
  (select (public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40001') like 'scheduled|-#%'
     and public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40006') = b.snap_b
     and public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40007') = b.snap_priv)::text from t_gcsc2_base b), 'true');

-- anon cannot execute
do $$
begin
  set local role anon;
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40001')$q$, 'permission denied', 'T-gcsc2-anon-cannot-execute');
  reset role;
end $$;

-- ============================================================================
-- 3. Terminal attendance refusals (direct RPC gets the same guard as the UI)
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40003')$q$, 'GCSC2_ATTENDANCE_RECORDED', 'T-gcsc2-attended-history-refuses');
  perform public.t_gcsc2_expect($q$select public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40004')$q$, 'GCSC2_ATTENDANCE_RECORDED', 'T-gcsc2-no-show-history-refuses');
  reset role;
end $$;
select public.t_gcsc2_assert('T-gcsc2-refusal-left-attended-class-intact',
  (select (public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40003') = b.snap_att
     and public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40004') = b.snap_ns
     and public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40003') = b.att_att
     and public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40004') = b.att_ns
     and public.t_gcsc2_usage() = b.usage0)::text from t_gcsc2_base b), 'true');

-- ============================================================================
-- 4. Clean cancellation of a scheduled standalone class (broad staff roles)
-- ============================================================================
do $$
declare v_ids uuid[]; v_snap text; v_usage text; v_att text;
begin
  select usage0 into v_usage from t_gcsc2_base;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10003')::text, true); -- front desk
  set local role authenticated;
  v_ids := public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40001');
  reset role;

  perform public.t_gcsc2_assert('T-gcsc2-front-desk-cancel-returns-only-booked-clients',
    (select string_agg(x::text, ',' order by x::text) from unnest(v_ids) x),
    '00000000-0000-0000-0000-000000e30001,00000000-0000-0000-0000-000000e30002,00000000-0000-0000-0000-000000e30003');
  perform public.t_gcsc2_assert('T-gcsc2-cancel-sets-status-and-cancelled-at',
    (select (a.status = 'cancelled' and a.cancelled_at is not null)::text from public.appointments a where a.id = '00000000-0000-0000-0000-000000e40001'), 'true');
  perform public.t_gcsc2_assert('T-gcsc2-cancel-booked-attendees-become-cancelled',
    (select string_agg(aa.client_id::text || ':' || aa.status, ',' order by aa.client_id) from public.appointment_attendees aa where aa.appointment_id = '00000000-0000-0000-0000-000000e40001'),
    '00000000-0000-0000-0000-000000e30001:cancelled,00000000-0000-0000-0000-000000e30002:cancelled,00000000-0000-0000-0000-000000e30003:cancelled,00000000-0000-0000-0000-000000e30004:cancelled');
  perform public.t_gcsc2_assert('T-gcsc2-cancel-did-not-restamp-previously-cancelled-attendee',
    (select (aa.cancelled_at = '2026-01-01T00:00:00+00')::text from public.appointment_attendees aa where aa.id = '00000000-0000-0000-0000-000000e41004'), 'true');
  perform public.t_gcsc2_assert('T-gcsc2-cancel-membership-package-usage-unchanged', public.t_gcsc2_usage(), v_usage);
  perform public.t_gcsc2_assert('T-gcsc2-cancel-class-usage-row-still-present',
    (select count(*)::text from public.client_membership_usage where reference_type = 'appointment' and reference_id = '00000000-0000-0000-0000-000000e40001'), '1');
  perform public.t_gcsc2_assert('T-gcsc2-cancel-other-classes-and-lesson-untouched',
    (select (public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40006') = b.snap_b and public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40007') = b.snap_priv
       and public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40003') = b.snap_att)::text from t_gcsc2_base b), 'true');
end $$;

-- ============================================================================
-- 5. Idempotent replay: pure no-op
-- ============================================================================
do $$
declare v_before text; v_ids uuid[]; v_usage text;
begin
  v_before := public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40001');
  v_usage := public.t_gcsc2_usage();
  perform pg_sleep(0.05);
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
  v_ids := public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40001');
  reset role;
  perform public.t_gcsc2_assert('T-gcsc2-replay-returns-no-recipients', coalesce(cardinality(v_ids), -1)::text, '0');
  perform public.t_gcsc2_assert('T-gcsc2-replay-no-restamp-and-no-attendee-change', public.t_gcsc2_snap('00000000-0000-0000-0000-000000e40001'), v_before);
  perform public.t_gcsc2_assert('T-gcsc2-replay-usage-unchanged', public.t_gcsc2_usage(), v_usage);
end $$;

-- ============================================================================
-- 6. Past class without terminal attendance may cancel; non-terminal attendance does not block
-- ============================================================================
do $$
declare v_ids uuid[];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10002')::text, true); -- admin
  set local role authenticated;
  v_ids := public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40002');
  perform public.t_gcsc2_assert('T-gcsc2-past-class-no-attendance-cancels',
    (select string_agg(x::text, ',') from unnest(v_ids) x), '00000000-0000-0000-0000-000000e30002');
  v_ids := public.cancel_group_class_appointment('00000000-0000-0000-0000-000000e40005');
  perform public.t_gcsc2_assert('T-gcsc2-registered-and-checked-in-do-not-block',
    (select string_agg(x::text, ',' order by x::text) from unnest(v_ids) x),
    '00000000-0000-0000-0000-000000e30007,00000000-0000-0000-0000-000000e30008');
  reset role;
  perform public.t_gcsc2_assert('T-gcsc2-nonterminal-attendance-records-untouched',
    public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40005'), (select att_nont from t_gcsc2_base));
  perform public.t_gcsc2_assert('T-gcsc2-past-class-status-cancelled',
    (select count(*)::text from public.appointments where id in ('00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e40005') and status = 'cancelled'), '2');
end $$;

-- ============================================================================
-- 6b. Attendance guard: terminal attendance may not be recorded against a cancelled class
--     (sequential past-class case; PAST = e40002 and NONT = e40005 are cancelled above)
-- ============================================================================
select public.t_gcsc2_assert('T-gcsc2-guard-trigger-installed-before-insert-update',
  (select (t.tgenabled = 'O' and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16 and (t.tgtype & 1) = 1)::text
   from pg_trigger t where t.tgrelid = 'public.attendance_records'::regclass and t.tgname = 'attendance_records_00_guard_cancelled_class'), 'true');
select public.t_gcsc2_assert('T-gcsc2-guard-trigger-fires-first-among-before-triggers',
  (select (min(t.tgname order by t.tgname) = 'attendance_records_00_guard_cancelled_class')::text
   from pg_trigger t where t.tgrelid = 'public.attendance_records'::regclass and not t.tgisinternal and (t.tgtype & 2) = 2), 'true');
select public.t_gcsc2_assert('T-gcsc2-guard-function-posture',
  (select (p.prosecdef and p.proconfig = array['search_path=public']
     and not has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('service_role', p.oid, 'execute')
     and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0))::text
   from pg_proc p where p.oid = 'public.enforce_group_class_attendance_not_cancelled()'::regprocedure), 'true');

do $$
declare v_before text;
begin
  v_before := public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40005');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
  -- PAST was cancelled after it started and its attendee cancelled_at > starts_at, so the
  -- pre-existing eligibility rule alone would ALLOW these writes; only the guard refuses them.
  perform public.t_gcsc2_expect($q$insert into public.attendance_records (studio_id, appointment_id, client_id, status) values ('00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e30002', 'attended')$q$, 'GCSC2_CLASS_CANCELLED', 'T-gcsc2-cancelled-past-class-attended-insert-refused');
  perform public.t_gcsc2_expect($q$insert into public.attendance_records (studio_id, appointment_id, client_id, status) values ('00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e30002', 'no_show')$q$, 'GCSC2_CLASS_CANCELLED', 'T-gcsc2-cancelled-past-class-no-show-insert-refused');
  -- UPDATE path on an existing non-terminal record
  perform public.t_gcsc2_expect($q$update public.attendance_records set status = 'attended' where id = '00000000-0000-0000-0000-000000e42004'$q$, 'GCSC2_CLASS_CANCELLED', 'T-gcsc2-cancelled-class-registered-to-attended-refused');
  perform public.t_gcsc2_expect($q$update public.attendance_records set status = 'no_show' where id = '00000000-0000-0000-0000-000000e42005'$q$, 'GCSC2_CLASS_CANCELLED', 'T-gcsc2-cancelled-class-checked-in-to-no-show-refused');
  -- non-terminal statuses stay governed by the existing rules (not by this guard)
  update public.attendance_records set status = 'checked_in' where id = '00000000-0000-0000-0000-000000e42004';
  update public.attendance_records set status = 'registered' where id = '00000000-0000-0000-0000-000000e42005';
  reset role;
  perform public.t_gcsc2_assert('T-gcsc2-cancelled-class-registered-and-checked-in-unaffected',
    (select string_agg(ar.status, ',' order by ar.client_id) from public.attendance_records ar where ar.appointment_id = '00000000-0000-0000-0000-000000e40005'), 'checked_in,registered');
  perform public.t_gcsc2_assert('T-gcsc2-refused-terminal-writes-left-no-terminal-record',
    (select count(*)::text from public.attendance_records ar where ar.appointment_id in ('00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e40005') and ar.status in ('attended', 'no_show')), '0');
  perform public.t_gcsc2_assert('T-gcsc2-refused-writes-left-class-cancelled',
    (select count(*)::text from public.appointments a where a.id in ('00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e40005') and a.status = 'cancelled'), '2');
end $$;

-- unrelated appointment type: terminal attendance on a cancelled private lesson is untouched by the guard
update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000e40007';
do $$
declare v_n int;
begin
  insert into public.attendance_records (studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e40007', '00000000-0000-0000-0000-000000e30002', 'attended');
  perform public.t_gcsc2_assert('T-gcsc2-guard-ignores-non-group-class-appointments',
    (select count(*)::text from public.attendance_records where appointment_id = '00000000-0000-0000-0000-000000e40007' and status = 'attended'), '1');
  -- an unchanged-status update of a recorded terminal row (e.g. notes) is not a new outcome and is not blocked
  update public.attendance_records set notes = 'note' where appointment_id = '00000000-0000-0000-0000-000000e40007';
  get diagnostics v_n = row_count;
  perform public.t_gcsc2_assert('T-gcsc2-guard-skips-unchanged-terminal-update', v_n::text, '1');
end $$;

-- ============================================================================
-- 7. Series occurrence: THIS occurrence only, identity preserved
-- ============================================================================
create temp table t_gcsc2_series_before as
select a.id, a.group_class_series_id, a.series_occurrence_index, a.occurrence_original_start, a.series_overridden_fields::text as overrides,
       a.starts_at, a.ends_at, a.status::text as status, a.cancelled_at, a.title
from public.appointments a where a.group_class_series_id = current_setting('t.series')::uuid;
create temp table t_gcsc2_series_row_before as
select s.* from public.group_class_series s where s.id = current_setting('t.series')::uuid;

do $$
declare v_ids uuid[]; v_occ2 uuid;
begin
  select id into v_occ2 from t_gcsc2_series_before where series_occurrence_index = 2;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
  v_ids := public.cancel_group_class_appointment(v_occ2);
  reset role;
  perform public.t_gcsc2_assert('T-gcsc2-series-occurrence-cancel-returns-its-attendee',
    (select string_agg(x::text, ',') from unnest(v_ids) x), '00000000-0000-0000-0000-000000e30002');
end $$;

select public.t_gcsc2_assert('T-gcsc2-series-occurrence-row-remains-with-identity-preserved',
  (select (count(*) = 1)::text from public.appointments a join t_gcsc2_series_before b on b.id = a.id
    where b.series_occurrence_index = 2 and a.status = 'cancelled' and a.cancelled_at is not null
      and a.group_class_series_id is not distinct from b.group_class_series_id
      and a.series_occurrence_index is not distinct from b.series_occurrence_index
      and a.occurrence_original_start is not distinct from b.occurrence_original_start
      and a.series_overridden_fields::text = b.overrides
      and a.starts_at = b.starts_at and a.ends_at = b.ends_at and a.title is not distinct from b.title), 'true');
select public.t_gcsc2_assert('T-gcsc2-series-neighbors-untouched-and-indices-intact',
  (select (count(*) = 3 and bool_and(a.status::text = b.status and a.cancelled_at is not distinct from b.cancelled_at
      and a.series_occurrence_index = b.series_occurrence_index and a.occurrence_original_start = b.occurrence_original_start
      and a.starts_at = b.starts_at))::text
   from public.appointments a join t_gcsc2_series_before b on b.id = a.id where b.series_occurrence_index <> 2), 'true');
select public.t_gcsc2_assert('T-gcsc2-series-indices-not-renumbered',
  (select string_agg(series_occurrence_index::text, ',' order by series_occurrence_index) from public.appointments where group_class_series_id = current_setting('t.series')::uuid), '1,2,3,4');
select public.t_gcsc2_assert('T-gcsc2-series-row-unchanged',
  (select (to_jsonb(s) = to_jsonb(b))::text from public.group_class_series s, t_gcsc2_series_row_before b where s.id = b.id), 'true');

-- replay on the cancelled occurrence is a no-op too
do $$
declare v_occ2 uuid; v_before text; v_ids uuid[];
begin
  select id into v_occ2 from t_gcsc2_series_before where series_occurrence_index = 2;
  v_before := public.t_gcsc2_snap(v_occ2);
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10007')::text, true); -- platform admin
  set local role authenticated;
  v_ids := public.cancel_group_class_appointment(v_occ2);
  reset role;
  perform public.t_gcsc2_assert('T-gcsc2-platform-admin-authorized-and-series-replay-noop',
    coalesce(cardinality(v_ids), -1)::text || '|' || (public.t_gcsc2_snap(v_occ2) = v_before)::text, '0|true');
end $$;

-- ============================================================================
-- 8. Attendance, usage and legacy Events never touched across the whole suite
-- ============================================================================
select public.t_gcsc2_assert('T-gcsc2-attended-and-no-show-attendance-never-changed',
  (select (public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40003') = b.att_att
       and public.t_gcsc2_attendance('00000000-0000-0000-0000-000000e40004') = b.att_ns
       and public.t_gcsc2_usage() = b.usage0)::text from t_gcsc2_base b), 'true');
do $$
declare s record;
begin
  select * into s from t_gcsc2_snap0;
  perform public.t_gcsc2_assert('T-gcsc2-no-legacy-events-mutation',
    (select count(*) from public.events)::text || '/' || (select count(*) from public.event_sessions)::text || '/' || (select count(*) from public.event_registrations)::text,
    s.events_n::text || '/' || s.event_sessions_n::text || '/' || s.event_regs_n::text);
end $$;

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsc2_log;

rollback;
