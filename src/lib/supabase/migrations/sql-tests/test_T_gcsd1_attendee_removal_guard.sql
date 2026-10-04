-- GC-S1D-1 -- attendee removal terminal-attendance guard, live-Postgres regression suite for
-- 20261020090000_gcsd1_attendee_removal_terminal_attendance_guard.sql.
--
-- Proves, as real tenant roles:
--   * a booked dancer without terminal attendance can be removed through cancel_class_attendee (owner, front desk, the
--     assigned instructor), and a checked-in or merely registered dancer still can (those are not terminal);
--   * a dancer with attended or no_show attendance cannot be removed: through the RPC for every role, through a direct
--     table UPDATE by broad staff, and even for the migration owner (the guard is unconditional);
--   * another studio's staff cannot affect the attendee; another instructor cannot manage the class's roster;
--   * the refusal never touches attendance, usage or the attendee row; re-removal is a no-op;
--   * a dancer's attendance in another class, or another dancer's attendance in the same class, never blocks a removal;
--   * whole-class cancellation (cancel_group_class_appointment) still works and still refuses a class with terminal
--     attendance with the S1C-2 code;
--   * posture: guard function trigger-only, RPC authenticated-only and definer.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV AFTER the migration.
-- UUID block ...000000f1....

begin;

create table public.t_gcsd1_log (n serial, msg text);
grant all on public.t_gcsd1_log to public;
grant usage on sequence public.t_gcsd1_log_n_seq to public;
create function public.t_gcsd1_pass(p text) returns void language sql as $$ insert into public.t_gcsd1_log (msg) values (p) $$;
grant execute on function public.t_gcsd1_pass(text) to public;

create function public.t_gcsd1_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsd1_pass(p_label);
end;
$$;
grant execute on function public.t_gcsd1_assert(text, text, text) to public;

create function public.t_gcsd1_uid(p_who text) returns uuid language sql immutable as $x$
  select case p_who
    when 'OWN' then '00000000-0000-0000-0000-000000f11001'
    when 'FD'  then '00000000-0000-0000-0000-000000f11002'
    when 'INS' then '00000000-0000-0000-0000-000000f11003'
    when 'INS2' then '00000000-0000-0000-0000-000000f11004'
    when 'OWB' then '00000000-0000-0000-0000-000000f11005'
  end::uuid
$x$;
grant execute on function public.t_gcsd1_uid(text) to public;

-- run the removal RPC as a user; returns null on success or the error text
create function public.t_gcsd1_cancel(p_who text, p_attendee uuid) returns text language plpgsql as $$
declare v_err text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd1_uid(p_who))::text, true);
  set local role authenticated;
  begin
    perform public.cancel_class_attendee(p_attendee);
  exception when others then
    v_err := sqlerrm;
  end;
  reset role;
  return v_err;
end $$;
grant execute on function public.t_gcsd1_cancel(text, uuid) to public;

create function public.t_gcsd1_status(p_attendee uuid) returns text language sql volatile security definer set search_path = 'public' as $x$
  select status from public.appointment_attendees where id = p_attendee
$x$;
grant execute on function public.t_gcsd1_status(uuid) to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000f10001', 'GC-S1D-1 Harness Studio A', 't-gcsd1-a', 'America/New_York'),
  ('00000000-0000-0000-0000-000000f10002', 'GC-S1D-1 Harness Studio B', 't-gcsd1-b', 'America/New_York');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f11001', 't-gcsd1-owner@example.test'),
  ('00000000-0000-0000-0000-000000f11002', 't-gcsd1-frontdesk@example.test'),
  ('00000000-0000-0000-0000-000000f11003', 't-gcsd1-instructor@example.test'),
  ('00000000-0000-0000-0000-000000f11004', 't-gcsd1-instructor2@example.test'),
  ('00000000-0000-0000-0000-000000f11005', 't-gcsd1-owner-b@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000f11001', 't-gcsd1-owner@example.test', null),
  ('00000000-0000-0000-0000-000000f11002', 't-gcsd1-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-000000f11003', 't-gcsd1-instructor@example.test', null),
  ('00000000-0000-0000-0000-000000f11004', 't-gcsd1-instructor2@example.test', null),
  ('00000000-0000-0000-0000-000000f11005', 't-gcsd1-owner-b@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000f11001', '00000000-0000-0000-0000-000000f10001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000f11002', '00000000-0000-0000-0000-000000f10001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000f11003', '00000000-0000-0000-0000-000000f10001', 'instructor', true),
  ('00000000-0000-0000-0000-000000f11004', '00000000-0000-0000-0000-000000f10001', 'instructor', true),
  ('00000000-0000-0000-0000-000000f11005', '00000000-0000-0000-0000-000000f10002', 'studio_owner', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000f12001', '00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f11003', 'Assigned', 'Instructor', true, true),
  ('00000000-0000-0000-0000-000000f12002', '00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f11004', 'Other', 'Instructor', true, true);
alter table public.instructors enable trigger user;

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor)
select ('00000000-0000-0000-0000-000000f13' || lpad(n::text, 3, '0'))::uuid,
       case when n = 20 then '00000000-0000-0000-0000-000000f10002' else '00000000-0000-0000-0000-000000f10001' end::uuid,
       'C', 'N' || n, 'active', false
from generate_series(1, 20) n;

-- K1: past class of the assigned instructor; K2: past class of the OTHER instructor; K3: studio B; K4: future class; K5: past class with terminal attendance
insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000f14001', '00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f12001', 'group_class', 'scheduled', now() - interval '3 hours', now() - interval '2 hours', 'K1'),
  ('00000000-0000-0000-0000-000000f14002', '00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f12002', 'group_class', 'scheduled', now() - interval '3 hours', now() - interval '2 hours', 'K2'),
  ('00000000-0000-0000-0000-000000f14003', '00000000-0000-0000-0000-000000f10002', null, 'group_class', 'scheduled', now() - interval '3 hours', now() - interval '2 hours', 'K3'),
  ('00000000-0000-0000-0000-000000f14004', '00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f12001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', 'K4'),
  ('00000000-0000-0000-0000-000000f14005', '00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f12001', 'group_class', 'scheduled', now() - interval '3 hours', now() - interval '2 hours', 'K5');

-- attendee ids: f15 + class digit + dancer number
create function public.t_gcsd1_att(p_class integer, p_client integer) returns uuid language sql immutable as $x$
  select ('00000000-0000-0000-0000-000000f15' || p_class::text || lpad(p_client::text, 2, '0'))::uuid
$x$;
grant execute on function public.t_gcsd1_att(integer, integer) to public;
create function public.t_gcsd1_cl(p_client integer) returns uuid language sql immutable as $x$
  select ('00000000-0000-0000-0000-000000f13' || lpad(p_client::text, 3, '0'))::uuid
$x$;
grant execute on function public.t_gcsd1_cl(integer) to public;
create function public.t_gcsd1_class(p_class integer) returns uuid language sql immutable as $x$
  select ('00000000-0000-0000-0000-000000f1400' || p_class::text)::uuid
$x$;
grant execute on function public.t_gcsd1_class(integer) to public;

create function public.t_gcsd1_book(p_class integer, p_client integer) returns void language sql as $x$
  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type)
  values (public.t_gcsd1_att(p_class, p_client),
          (select studio_id from public.appointments where id = public.t_gcsd1_class(p_class)),
          public.t_gcsd1_class(p_class), public.t_gcsd1_cl(p_client), 'booked', 'staff', 'free_comped')
$x$;
create function public.t_gcsd1_attend(p_class integer, p_client integer, p_status text) returns void language sql as $x$
  insert into public.attendance_records (studio_id, appointment_id, client_id, status)
  values ((select studio_id from public.appointments where id = public.t_gcsd1_class(p_class)), public.t_gcsd1_class(p_class), public.t_gcsd1_cl(p_client), p_status)
$x$;

-- K1: c1 booked (no attendance) | c2 attended | c3 no_show | c4 checked_in | c5 registered record | c11 booked (front desk) | c12 booked (instructor)
select public.t_gcsd1_book(1, n) from unnest(array[1, 2, 3, 4, 5, 11, 12, 13]) n;
select public.t_gcsd1_attend(1, 2, 'attended');
select public.t_gcsd1_attend(1, 3, 'no_show');
select public.t_gcsd1_attend(1, 4, 'checked_in');
select public.t_gcsd1_attend(1, 5, 'registered');
-- K2: c6 booked (other instructor's class)
select public.t_gcsd1_book(2, 6);
-- K3 (studio B): c20 booked; attended
select public.t_gcsd1_book(3, 20);
select public.t_gcsd1_attend(3, 20, 'attended');
-- K4 (future): c2 (attended elsewhere) booked, c8 booked
select public.t_gcsd1_book(4, 2);
select public.t_gcsd1_book(4, 8);
-- K5 (terminal attendance in the class): c9 attended, c10 booked
select public.t_gcsd1_book(5, 9);
select public.t_gcsd1_book(5, 10);
select public.t_gcsd1_attend(5, 9, 'attended');

create temp table t_gcsd1_base as
select (select md5(coalesce(string_agg(ar::text, '|' order by ar.id), '')) from public.attendance_records ar where ar.studio_id in ('00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f10002')) as attendance,
       (select count(*) from public.client_membership_usage) as usage_rows;

-- ============================================================================
-- 1. Posture
-- ============================================================================
select public.t_gcsd1_assert('T-gcsd1-guard-function-trigger-only-and-definer',
  (select (p.prosecdef and p.proconfig = array['search_path=public']
      and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute'))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'enforce_attendee_cancel_no_terminal_attendance'), 'true');
select public.t_gcsd1_assert('T-gcsd1-rpc-authenticated-only-and-definer',
  (select (p.prosecdef and p.proconfig = array['search_path=public']
      and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute'))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cancel_class_attendee'), 'true');
select public.t_gcsd1_assert('T-gcsd1-trigger-enabled-first-and-only-for-booked-to-cancelled',
  (select (t.tgenabled = 'O' and pg_get_triggerdef(t.oid) ilike '%before update of status%' and pg_get_triggerdef(t.oid) ilike '%old.status = ''booked''%' and pg_get_triggerdef(t.oid) ilike '%new.status = ''cancelled''%')::text
   from pg_trigger t where t.tgrelid = 'public.appointment_attendees'::regclass and t.tgname = 'appointment_attendees_00_guard_cancel_terminal_attendance'), 'true');
select public.t_gcsd1_assert('T-gcsd1-guard-fires-before-the-other-attendee-triggers',
  (select (min(tgname) = 'appointment_attendees_00_guard_cancel_terminal_attendance')::text from pg_trigger where tgrelid = 'public.appointment_attendees'::regclass and not tgisinternal), 'true');

-- ============================================================================
-- 2. Removal that must still work
-- ============================================================================
select public.t_gcsd1_assert('T-gcsd1-owner-removes-a-booked-dancer-without-attendance',
  coalesce(public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(1, 1)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 1)), 'ok/cancelled');
select public.t_gcsd1_assert('T-gcsd1-removal-records-who-and-when',
  (select (cancelled_by = public.t_gcsd1_uid('OWN') and cancelled_at is not null)::text from public.appointment_attendees where id = public.t_gcsd1_att(1, 1)), 'true');
select public.t_gcsd1_assert('T-gcsd1-checked-in-dancer-can-still-be-removed-not-terminal',
  coalesce(public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(1, 4)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 4)), 'ok/cancelled');
select public.t_gcsd1_assert('T-gcsd1-registered-dancer-can-still-be-removed-not-terminal',
  coalesce(public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(1, 5)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 5)), 'ok/cancelled');
select public.t_gcsd1_assert('T-gcsd1-front-desk-removes-a-booked-dancer',
  coalesce(public.t_gcsd1_cancel('FD', public.t_gcsd1_att(1, 11)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 11)), 'ok/cancelled');
select public.t_gcsd1_assert('T-gcsd1-assigned-instructor-removes-a-booked-dancer-from-their-own-class',
  coalesce(public.t_gcsd1_cancel('INS', public.t_gcsd1_att(1, 12)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 12)), 'ok/cancelled');
select public.t_gcsd1_assert('T-gcsd1-removing-an-already-removed-dancer-is-a-no-op',
  (select coalesce(public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(1, 1)), 'ok') || '/' || (cancelled_at = (select cancelled_at from public.appointment_attendees where id = public.t_gcsd1_att(1, 1)))::text from public.appointment_attendees where id = public.t_gcsd1_att(1, 1)), 'ok/true');

-- ============================================================================
-- 3. Terminal attendance blocks removal everywhere
-- ============================================================================
select public.t_gcsd1_assert('T-gcsd1-owner-cannot-remove-an-attended-dancer',
  (select case when e like 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED%' then 'refused' else coalesce(e, 'ok') end from (select public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(1, 2)) e) x) || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 2)), 'refused/booked');
select public.t_gcsd1_assert('T-gcsd1-owner-cannot-remove-a-no-show-dancer',
  (select case when e like 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED%' then 'refused' else coalesce(e, 'ok') end from (select public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(1, 3)) e) x) || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 3)), 'refused/booked');
select public.t_gcsd1_assert('T-gcsd1-front-desk-cannot-remove-an-attended-dancer',
  (select case when e like 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED%' then 'refused' else coalesce(e, 'ok') end from (select public.t_gcsd1_cancel('FD', public.t_gcsd1_att(1, 2)) e) x), 'refused');
select public.t_gcsd1_assert('T-gcsd1-assigned-instructor-cannot-remove-an-attended-dancer',
  (select case when e like 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED%' then 'refused' else coalesce(e, 'ok') end from (select public.t_gcsd1_cancel('INS', public.t_gcsd1_att(1, 3)) e) x), 'refused');
select public.t_gcsd1_assert('T-gcsd1-refusal-message-is-the-stable-code-with-fixed-text',
  (select e from (select public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(1, 2)) e) x),
  'GCSD1_ATTENDEE_ATTENDANCE_RECORDED: This dancer already has attendance recorded for this class. Correct the attendance record before removing them from the class.');

-- direct table paths
do $$
declare v_err text; v_rows integer;
begin
  -- broad staff direct UPDATE (the table's UPDATE policy allows it): the guard still refuses
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd1_uid('OWN'))::text, true);
  set local role authenticated;
  begin
    update public.appointment_attendees set status = 'cancelled', cancelled_at = now() where id = public.t_gcsd1_att(1, 2);
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  perform public.t_gcsd1_assert('T-gcsd1-direct-table-update-by-broad-staff-is-refused', coalesce(left(v_err, 34), 'no error'), 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED');

  -- the migration owner is not exempt (unconditional, like the S1C-2 class guard)
  v_err := null;
  begin
    update public.appointment_attendees set status = 'cancelled', cancelled_at = now() where id = public.t_gcsd1_att(1, 3);
  exception when others then v_err := sqlerrm;
  end;
  perform public.t_gcsd1_assert('T-gcsd1-guard-is-unconditional-even-for-the-migration-owner', coalesce(left(v_err, 34), 'no error'), 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED');

  -- a direct UPDATE of another field of the attended attendee is untouched by the guard
  update public.appointment_attendees set billing_type = 'free_comped' where id = public.t_gcsd1_att(1, 2);
  get diagnostics v_rows = row_count;
  perform public.t_gcsd1_assert('T-gcsd1-non-cancellation-updates-are-not-affected', v_rows::text, '1');
end $$;

-- ============================================================================
-- 4. Studio isolation and existing authority
-- ============================================================================
do $$
declare v_err text; v_rows integer;
begin
  -- B's owner against A's BOOKED, non-terminal attendee (K1 c13): refused by authority, row untouched
  perform public.t_gcsd1_assert('T-gcsd1-other-studio-owner-refused-by-authority',
    coalesce(public.t_gcsd1_cancel('OWB', public.t_gcsd1_att(1, 13)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 13)),
    'Not authorized to manage this class''s roster./booked');
  -- and a direct UPDATE as B's owner sees no row at all (RLS): zero rows, nothing changes
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd1_uid('OWB'))::text, true);
  set local role authenticated;
  update public.appointment_attendees set status = 'cancelled', cancelled_at = now() where id = public.t_gcsd1_att(1, 13);
  get diagnostics v_rows = row_count;
  reset role;
  perform public.t_gcsd1_assert('T-gcsd1-other-studio-direct-update-affects-nothing', v_rows::text || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 13)), '0/booked');
end $$;
select public.t_gcsd1_assert('T-gcsd1-another-instructor-cannot-manage-this-roster',
  coalesce(public.t_gcsd1_cancel('INS2', public.t_gcsd1_att(1, 13)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(1, 13)),
  'Not authorized to manage this class''s roster./booked');
select public.t_gcsd1_assert('T-gcsd1-assigned-instructor-still-cannot-touch-another-instructors-class',
  coalesce(public.t_gcsd1_cancel('INS', public.t_gcsd1_att(2, 6)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(2, 6)),
  'Not authorized to manage this class''s roster./booked');
select public.t_gcsd1_assert('T-gcsd1-unknown-enrollment-is-not-found',
  public.t_gcsd1_cancel('OWN', '00000000-0000-0000-0000-000000f1ffff'), 'Enrollment not found.');
do $$
declare v_err text;
begin
  set local role anon;
  begin
    perform public.cancel_class_attendee(public.t_gcsd1_att(1, 13));
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  perform public.t_gcsd1_assert('T-gcsd1-anon-cannot-execute-the-rpc', (position('permission denied' in lower(coalesce(v_err, ''))) > 0)::text, 'true');
end $$;

-- ============================================================================
-- 5. The rule is per dancer per class
-- ============================================================================
select public.t_gcsd1_assert('T-gcsd1-attendance-in-another-class-does-not-block-removal-here',
  coalesce(public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(4, 2)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(4, 2)), 'ok/cancelled');
select public.t_gcsd1_assert('T-gcsd1-another-dancers-attendance-does-not-block-removal',
  coalesce(public.t_gcsd1_cancel('OWN', public.t_gcsd1_att(5, 10)), 'ok') || '/' || public.t_gcsd1_status(public.t_gcsd1_att(5, 10)), 'ok/cancelled');

-- ============================================================================
-- 6. Whole-class cancellation is unchanged
-- ============================================================================
do $$
declare v_ids uuid[]; v_err text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd1_uid('OWN'))::text, true);
  set local role authenticated;
  v_ids := public.cancel_group_class_appointment(public.t_gcsd1_class(4));
  reset role;
  perform public.t_gcsd1_assert('T-gcsd1-whole-class-cancellation-still-works', coalesce(cardinality(v_ids), 0)::text || '/' || (select status::text from public.appointments where id = public.t_gcsd1_class(4)) || '/' || public.t_gcsd1_status(public.t_gcsd1_att(4, 8)), '1/cancelled/cancelled');

  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd1_uid('OWN'))::text, true);
  set local role authenticated;
  begin
    perform public.cancel_group_class_appointment(public.t_gcsd1_class(5));
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  perform public.t_gcsd1_assert('T-gcsd1-whole-class-cancellation-still-refuses-terminal-attendance-with-the-s1c2-code', coalesce(left(v_err, 25), 'no error'), 'GCSC2_ATTENDANCE_RECORDED');
end $$;

-- ============================================================================
-- 7. Nothing else moved
-- ============================================================================
select public.t_gcsd1_assert('T-gcsd1-attendance-and-usage-never-changed-by-any-removal-or-refusal',
  (select (md5(coalesce(string_agg(ar::text, '|' order by ar.id), '')) = b.attendance and (select count(*) from public.client_membership_usage) = b.usage_rows)::text
   from public.attendance_records ar, t_gcsd1_base b where ar.studio_id in ('00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f10002') group by b.attendance, b.usage_rows), 'true');
select public.t_gcsd1_assert('T-gcsd1-refused-dancers-still-booked-with-their-attendance',
  (select string_agg(public.t_gcsd1_status(public.t_gcsd1_att(1, n)), ',' order by n) from unnest(array[2, 3]) n), 'booked,booked');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsd1_log;

rollback;
