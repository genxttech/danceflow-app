-- GC-S1C-3 -- canonical group-class database authority backstops, live-Postgres
-- regression suite for 20261017090000_gcsc3_group_class_db_authority.sql.
--
-- Proves, as real tenant roles (authenticated owner and assigned instructor):
--   * direct UPDATE of a group class to 'cancelled' is refused (GCSC3_CANCEL_VIA_RPC_ONLY) for the
--     assigned instructor and for broad staff, the RPC still cancels, non-cancellation edits
--     (including the instructor's own single-occurrence edits) still work, other appointment types
--     and the S1C-2 attendance-first ordering are unchanged;
--   * a booked enrollment into a cancelled class is refused (GCSC3_CLASS_CANCELLED) through the
--     enrollment RPC, a raw attendee insert and a re-book, while a scheduled class still enrolls and a
--     full class still reports no seats;
--   * the capacity floor refuses lowering below the booked count (GCSC3_CAPACITY_BELOW_BOOKED) and
--     allows increases, the booked count itself, clearing, and edits that leave capacity alone;
--   * a tenant cannot delete a series occurrence even when no enrollment-policy row would stop it,
--     while standalone and non-class appointments delete as before;
--   * pending class reminders die with the cancelled class and nothing else is touched;
--   * posture: trigger-only functions, no EXECUTE for any tenant role, triggers enabled.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV
-- AFTER 20261017090000 (this migration) is applied. Deterministic UUID block ...000000ea....

begin;

create table public.t_gcsc3_log (n serial, msg text);
grant all on public.t_gcsc3_log to public;
grant usage on sequence public.t_gcsc3_log_n_seq to public;
create function public.t_gcsc3_pass(p text) returns void language sql as $$ insert into public.t_gcsc3_log (msg) values (p) $$;
grant execute on function public.t_gcsc3_pass(text) to public;

create function public.t_gcsc3_expect(p_sql text, p_like text, p_label text)
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
  perform public.t_gcsc3_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc3_expect(text, text, text) to anon, authenticated, service_role;

create function public.t_gcsc3_ok(p_sql text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise exception 'FAIL %: expected success, got [%]', p_label, sqlerrm;
  end;
  perform public.t_gcsc3_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc3_ok(text, text) to anon, authenticated, service_role;

create function public.t_gcsc3_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsc3_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc3_assert(text, text, text) to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000ea0001', 'GC-S1C-3 Harness Studio', 't-gcsc3-studio', 'America/New_York');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000ea1001', 't-gcsc3-owner@example.test'),
  ('00000000-0000-0000-0000-000000ea1002', 't-gcsc3-instructor@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000ea1001', 't-gcsc3-owner@example.test', null),
  ('00000000-0000-0000-0000-000000ea1002', 't-gcsc3-instructor@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000ea1001', '00000000-0000-0000-0000-000000ea0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000ea1002', '00000000-0000-0000-0000-000000ea0001', 'instructor', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000ea2001', '00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea1002', 'Harness', 'Instructor', true, true);
alter table public.instructors enable trigger user;
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-000000ea3001', '00000000-0000-0000-0000-000000ea0001', 'C', 'One', 'active', false),
  ('00000000-0000-0000-0000-000000ea3002', '00000000-0000-0000-0000-000000ea0001', 'C', 'Two', 'active', false),
  ('00000000-0000-0000-0000-000000ea3003', '00000000-0000-0000-0000-000000ea0001', 'C', 'Three', 'active', false),
  ('00000000-0000-0000-0000-000000ea3004', '00000000-0000-0000-0000-000000ea0001', 'C', 'Four', 'active', false),
  ('00000000-0000-0000-0000-000000ea3005', '00000000-0000-0000-0000-000000ea0001', 'C', 'Five', 'active', false),
  ('00000000-0000-0000-0000-000000ea3006', '00000000-0000-0000-0000-000000ea0001', 'C', 'Six', 'active', false);

-- Classes (all assigned to the harness instructor unless noted):
--   A1 ea4001 cap 3, c1+c2 booked     A2 ea4002 no cap, none booked   A3 ea4003 to be cancelled via RPC (c3 booked)
--   P  ea4004 private lesson          B1 ea4005 standalone, no instructor (delete)
--   ATT ea4006 past class with an attended record (c5)
--   FULL ea4007 cap 2, c1+c2 booked   R  ea4008 class with pending reminders (c1)   R2 ea4009 other class with a pending reminder
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title, roster_capacity) values
  ('00000000-0000-0000-0000-000000ea4001', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', 'A1', 3),
  ('00000000-0000-0000-0000-000000ea4002', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled', now() + interval '6 days', now() + interval '6 days 1 hour', 'A2', null),
  ('00000000-0000-0000-0000-000000ea4003', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled', now() + interval '7 days', now() + interval '7 days 1 hour', 'A3', null),
  ('00000000-0000-0000-0000-000000ea4004', '00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea3004', '00000000-0000-0000-0000-000000ea2001', 'private_lesson', 'scheduled', now() + interval '8 days', now() + interval '8 days 1 hour', 'P', null),
  ('00000000-0000-0000-0000-000000ea4005', '00000000-0000-0000-0000-000000ea0001', null, null, 'group_class', 'scheduled', now() + interval '9 days', now() + interval '9 days 1 hour', 'B1', null),
  ('00000000-0000-0000-0000-000000ea4006', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled', now() - interval '5 days', now() - interval '5 days' + interval '1 hour', 'ATT', null),
  ('00000000-0000-0000-0000-000000ea4007', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour', 'FULL', 2),
  ('00000000-0000-0000-0000-000000ea4008', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled', now() + interval '11 days', now() + interval '11 days 1 hour', 'R', null),
  ('00000000-0000-0000-0000-000000ea4009', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled', now() + interval '12 days', now() + interval '12 days 1 hour', 'R2', null);
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type) values
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4001', '00000000-0000-0000-0000-000000ea3001', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4001', '00000000-0000-0000-0000-000000ea3002', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4003', '00000000-0000-0000-0000-000000ea3003', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4006', '00000000-0000-0000-0000-000000ea3005', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4007', '00000000-0000-0000-0000-000000ea3001', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4007', '00000000-0000-0000-0000-000000ea3002', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4008', '00000000-0000-0000-0000-000000ea3001', 'booked', 'staff', 'free_comped');
insert into public.attendance_records (studio_id, appointment_id, client_id, status) values
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4006', '00000000-0000-0000-0000-000000ea3005', 'attended');

-- pending / sent reminders
insert into public.notification_deliveries (studio_id, client_id, delivery_type, channel, status, related_appointment_id, related_date, subject, body, scheduled_for) values
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea3001', 'student_lesson_reminder_24h', 'email', 'pending', '00000000-0000-0000-0000-000000ea4008', current_date + 10, 'r24', 'b', now()),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea3001', 'student_lesson_reminder_2h',  'email', 'pending', '00000000-0000-0000-0000-000000ea4008', current_date + 10, 'r2',  'b', now()),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea3002', 'student_lesson_reminder_24h', 'email', 'sent',    '00000000-0000-0000-0000-000000ea4008', current_date + 10, 'rs',  'b', now()),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea3001', 'student_lesson_reminder_24h', 'email', 'pending', '00000000-0000-0000-0000-000000ea4009', current_date + 11, 'other class', 'b', now()),
  ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea3004', 'student_lesson_reminder_24h', 'email', 'pending', '00000000-0000-0000-0000-000000ea4004', current_date + 7, 'private lesson', 'b', now());

-- A real series (B1 RPC as the owner): 3 occurrences, capacity 5; occurrence 1 gets a booked attendee.
do $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000ea0001',
    p_client_request_id => '00000000-0000-0000-0000-000000ea7001',
    p_title => 'S1C3 Series', p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000ea2001', p_room_id => null, p_location_name => null, p_roster_capacity => 5,
    p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => 3,
    p_local_start_time => time '18:30', p_duration_minutes => 60);
  reset role;
  perform set_config('t.series', v_res ->> 'series_id', true);
end $$;
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type)
select '00000000-0000-0000-0000-000000ea0001', a.id, '00000000-0000-0000-0000-000000ea3001', 'booked', 'staff', 'free_comped'
from public.appointments a where a.group_class_series_id = current_setting('t.series')::uuid and a.series_occurrence_index = 1;
-- a series occurrence with NO enrollment-policy row (so only the new guard, not the policy FK, can stop a delete)
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title,
                                 group_class_series_id, series_occurrence_index, occurrence_original_start)
values ('00000000-0000-0000-0000-000000ea4010', '00000000-0000-0000-0000-000000ea0001', null, '00000000-0000-0000-0000-000000ea2001', 'group_class', 'scheduled',
        now() + interval '40 days', now() + interval '40 days 1 hour', 'SX no-policy occurrence',
        current_setting('t.series')::uuid, 99, now() + interval '40 days');

-- ============================================================================
-- 1. Posture
-- ============================================================================
select public.t_gcsc3_assert('T-gcsc3-new-functions-trigger-only-no-tenant-execute',
  (select (count(*) = 5 and bool_and(
      not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0)))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('enforce_group_class_capacity_floor', '_gcsc3_guard_group_class_cancel_authority', '_gcsc3_guard_series_occurrence_delete',
                       '_gcsc3_cancel_pending_class_reminders', 'enforce_group_class_roster_capacity')), 'true');
select public.t_gcsc3_assert('T-gcsc3-definer-functions-fixed-search-path',
  (select (count(*) = 3 and bool_and(p.prosecdef and p.proconfig = array['search_path=public']))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('enforce_group_class_capacity_floor', '_gcsc3_cancel_pending_class_reminders', 'enforce_group_class_roster_capacity')), 'true');
select public.t_gcsc3_assert('T-gcsc3-invoker-guards-decide-on-current-user',
  (select (count(*) = 2 and bool_and(not p.prosecdef and p.proconfig = array['search_path=public']))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('_gcsc3_guard_group_class_cancel_authority', '_gcsc3_guard_series_occurrence_delete')), 'true');
select public.t_gcsc3_assert('T-gcsc3-four-new-appointments-triggers-enabled',
  (select count(*)::text from pg_trigger t where not t.tgisinternal and t.tgrelid = 'public.appointments'::regclass and t.tgenabled = 'O'
     and t.tgname in ('appointments_03_guard_group_class_cancel_authority', 'appointments_04_guard_group_class_capacity_floor',
                      'appointments_guard_series_occurrence_delete', 'appointments_gcsc3_cancel_pending_reminders')), '4');
select public.t_gcsc3_assert('T-gcsc3-s1c2-guards-and-roster-trigger-still-installed',
  (select count(*)::text from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O'
     and t.tgname in ('appointments_02_guard_cancel_terminal_attendance', 'attendance_records_00_guard_cancelled_class', 'appointment_attendees_enforce_roster_capacity')), '3');

-- ============================================================================
-- 2. Direct cancellation authority (D5)
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1002')::text, true);
  set local role authenticated;
  perform public.t_gcsc3_expect($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'GCSC3_CANCEL_VIA_RPC_ONLY', 'T-gcsc3-assigned-instructor-direct-cancel-refused');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  perform public.t_gcsc3_expect($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'GCSC3_CANCEL_VIA_RPC_ONLY', 'T-gcsc3-owner-direct-cancel-refused');
  perform public.t_gcsc3_expect($q$update public.appointments set status = 'cancelled', cancelled_at = now() where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'GCSC3_CANCEL_VIA_RPC_ONLY', 'T-gcsc3-direct-cancel-with-cancelled-at-refused');
  perform public.t_gcsc3_expect(format($q$update public.appointments set status = 'cancelled' where group_class_series_id = %L and series_occurrence_index = 2$q$, current_setting('t.series')), 'GCSC3_CANCEL_VIA_RPC_ONLY', 'T-gcsc3-direct-cancel-of-series-occurrence-refused');
  -- a class with recorded attendance still hears the S1C-2 refusal first, even from the instructor
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1002')::text, true);
  perform public.t_gcsc3_expect($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ea4006'$q$, 'GCSC2_ATTENDANCE_RECORDED', 'T-gcsc3-attended-class-still-gets-gcsc2-refusal-first');
  reset role;
end $$;
select public.t_gcsc3_assert('T-gcsc3-refused-direct-cancels-changed-nothing',
  (select (count(*) filter (where a.status = 'cancelled') = 0 and count(aa.*) filter (where aa.status = 'booked') = 2)::text
   from public.appointments a left join public.appointment_attendees aa on aa.appointment_id = a.id
   where a.id = '00000000-0000-0000-0000-000000ea4001'), 'true');

-- the canonical RPC still cancels (S1C-2 behavior): attendees cancelled, recipients returned, replay is a no-op
do $$
declare v_ids uuid[];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  set local role authenticated;
  v_ids := public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ea4003');
  perform public.t_gcsc3_assert('T-gcsc3-rpc-still-cancels-and-returns-booked-attendee',
    (select string_agg(x::text, ',') from unnest(v_ids) x), '00000000-0000-0000-0000-000000ea3003');
  v_ids := public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ea4003');
  perform public.t_gcsc3_assert('T-gcsc3-rpc-replay-still-noop', cardinality(v_ids)::text, '0');
  reset role;
end $$;
select public.t_gcsc3_assert('T-gcsc3-rpc-cancel-left-class-cancelled-and-attendee-cancelled',
  (select a.status::text || '/' || (select aa.status from public.appointment_attendees aa where aa.appointment_id = a.id)
   from public.appointments a where a.id = '00000000-0000-0000-0000-000000ea4003'), 'cancelled/cancelled');

-- legitimate non-cancellation edits still work, including the assigned instructor's own single-occurrence edit
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1002')::text, true);
  set local role authenticated;
  perform public.t_gcsc3_ok($q$update public.appointments set title = 'A1 retitled', notes = 'n', location_name = 'Studio B' where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-instructor-edit-title-notes-location-allowed');
  perform public.t_gcsc3_ok($q$update public.appointments set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-instructor-edit-time-allowed');
  perform public.t_gcsc3_ok($q$update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-non-cancel-status-change-unaffected');
  perform public.t_gcsc3_ok($q$update public.appointments set status = 'scheduled' where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-status-back-to-scheduled-unaffected');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  perform public.t_gcsc3_ok($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ea4003'$q$, 'T-gcsc3-cancelled-to-cancelled-is-not-a-transition');
  perform public.t_gcsc3_ok($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ea4004'$q$, 'T-gcsc3-private-lesson-direct-cancel-unchanged');
  reset role;
end $$;
-- service_role (server-side only) and the migration owner are not tenant roles
do $$
begin
  set local role service_role;
  perform public.t_gcsc3_ok($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ea4002'$q$, 'T-gcsc3-service-role-not-a-tenant-role-unaffected');
  reset role;
end $$;
update public.appointments set status = 'scheduled' where id = '00000000-0000-0000-0000-000000ea4002';
-- the private lesson that was cancelled directly above never touches class-reminder invalidation
select public.t_gcsc3_assert('T-gcsc3-private-lesson-cancel-leaves-its-reminder-pending',
  (select status from public.notification_deliveries where subject = 'private lesson'), 'pending');

-- ============================================================================
-- 3. Booked enrollment into a cancelled class
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  set local role authenticated;
  perform public.t_gcsc3_expect($q$select public.enroll_class_attendee('00000000-0000-0000-0000-000000ea4003', '00000000-0000-0000-0000-000000ea3006', 'free_comped')$q$, 'GCSC3_CLASS_CANCELLED', 'T-gcsc3-enroll-rpc-into-cancelled-class-refused');
  perform public.t_gcsc3_ok($q$select public.enroll_class_attendee('00000000-0000-0000-0000-000000ea4002', '00000000-0000-0000-0000-000000ea3006', 'free_comped')$q$, 'T-gcsc3-enroll-rpc-into-scheduled-class-still-works');
  perform public.t_gcsc3_expect($q$select public.enroll_class_attendee('00000000-0000-0000-0000-000000ea4007', '00000000-0000-0000-0000-000000ea3003', 'free_comped')$q$, 'no available seats', 'T-gcsc3-full-class-still-reports-no-seats');
  reset role;
end $$;
select public.t_gcsc3_assert('T-gcsc3-no-booked-attendee-on-the-cancelled-class',
  (select count(*)::text from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-000000ea4003' and status = 'booked'), '0');
do $$
begin
  -- raw writers (any role) go through the same trigger: a fresh booked row and a re-book of the cancelled attendee
  perform public.t_gcsc3_expect($q$insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type) values ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4003', '00000000-0000-0000-0000-000000ea3004', 'booked', 'staff', 'free_comped')$q$, 'GCSC3_CLASS_CANCELLED', 'T-gcsc3-raw-booked-insert-into-cancelled-class-refused');
  perform public.t_gcsc3_expect($q$update public.appointment_attendees set status = 'booked' where appointment_id = '00000000-0000-0000-0000-000000ea4003' and client_id = '00000000-0000-0000-0000-000000ea3003'$q$, 'GCSC3_CLASS_CANCELLED', 'T-gcsc3-rebook-cancelled-attendee-on-cancelled-class-refused');
  perform public.t_gcsc3_ok($q$insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type, cancelled_at) values ('00000000-0000-0000-0000-000000ea0001', '00000000-0000-0000-0000-000000ea4003', '00000000-0000-0000-0000-000000ea3004', 'cancelled', 'staff', 'free_comped', now())$q$, 'T-gcsc3-non-booked-history-row-on-cancelled-class-unaffected');
end $$;

-- ============================================================================
-- 4. Capacity floor
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1002')::text, true);
  set local role authenticated;
  -- A1: capacity 3, two booked
  perform public.t_gcsc3_expect($q$update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'GCSC3_CAPACITY_BELOW_BOOKED', 'T-gcsc3-instructor-capacity-below-booked-refused');
  perform public.t_gcsc3_expect($q$update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000ea4001'$q$, '2 students already booked', 'T-gcsc3-capacity-refusal-names-the-booked-count');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  perform public.t_gcsc3_expect($q$update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'GCSC3_CAPACITY_BELOW_BOOKED', 'T-gcsc3-owner-capacity-below-booked-refused');
  perform public.t_gcsc3_ok($q$update public.appointments set roster_capacity = 2 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-capacity-equal-to-booked-allowed');
  perform public.t_gcsc3_ok($q$update public.appointments set roster_capacity = 12 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-capacity-increase-allowed');
  perform public.t_gcsc3_ok($q$update public.appointments set roster_capacity = null where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-clearing-capacity-allowed');
  perform public.t_gcsc3_expect($q$update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'GCSC3_CAPACITY_BELOW_BOOKED', 'T-gcsc3-no-limit-to-limit-below-booked-refused');
  perform public.t_gcsc3_ok($q$update public.appointments set roster_capacity = 2 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-no-limit-to-limit-at-booked-allowed');
  perform public.t_gcsc3_ok($q$update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000ea4002'$q$, 'T-gcsc3-limit-on-class-with-no-bookings-allowed');
  perform public.t_gcsc3_ok($q$update public.appointments set title = 'A1 again', roster_capacity = 2 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-update-leaving-capacity-unchanged-allowed');
  -- series occurrence 1: capacity 5, one booked
  perform public.t_gcsc3_expect(format($q$update public.appointments set roster_capacity = 0 where group_class_series_id = %L and series_occurrence_index = 1$q$, current_setting('t.series')), 'GCSC3_CAPACITY_BELOW_BOOKED', 'T-gcsc3-series-occurrence-capacity-below-booked-refused');
  perform public.t_gcsc3_ok(format($q$update public.appointments set roster_capacity = 1 where group_class_series_id = %L and series_occurrence_index = 1$q$, current_setting('t.series')), 'T-gcsc3-series-occurrence-capacity-down-to-booked-allowed');
  reset role;
end $$;
select public.t_gcsc3_assert('T-gcsc3-capacity-refusals-left-capacity-and-roster-intact',
  (select a.roster_capacity::text || '/' || (select count(*) from public.appointment_attendees aa where aa.appointment_id = a.id and aa.status = 'booked')
   from public.appointments a where a.id = '00000000-0000-0000-0000-000000ea4001'), '2/2');

-- a class that is ALREADY over capacity (legacy state, created with the guard paused) can still be edited otherwise
alter table public.appointments disable trigger appointments_04_guard_group_class_capacity_floor;
update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000ea4001';
alter table public.appointments enable trigger appointments_04_guard_group_class_capacity_floor;
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1002')::text, true);
  set local role authenticated;
  perform public.t_gcsc3_ok($q$update public.appointments set title = 'over-capacity edit' where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-edit-of-already-over-capacity-class-still-allowed');
  perform public.t_gcsc3_ok($q$update public.appointments set roster_capacity = 1 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'T-gcsc3-resubmitting-unchanged-over-capacity-value-allowed');
  perform public.t_gcsc3_expect($q$update public.appointments set roster_capacity = 0 where id = '00000000-0000-0000-0000-000000ea4001'$q$, 'GCSC3_CAPACITY_BELOW_BOOKED', 'T-gcsc3-lowering-an-over-capacity-class-further-refused');
  reset role;
end $$;

-- ============================================================================
-- 5. Series-occurrence delete authority
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  set local role authenticated;
  -- no enrollment-policy row exists for this occurrence, so only the new guard can refuse
  perform public.t_gcsc3_expect($q$delete from public.appointments where id = '00000000-0000-0000-0000-000000ea4010'$q$, 'GCSC3_SERIES_OCCURRENCE_DELETE', 'T-gcsc3-owner-delete-of-series-occurrence-without-policy-row-refused');
  perform public.t_gcsc3_expect(format($q$delete from public.appointments where group_class_series_id = %L and series_occurrence_index = 2$q$, current_setting('t.series')), 'GCSC3_SERIES_OCCURRENCE_DELETE', 'T-gcsc3-owner-delete-of-materialized-occurrence-refused-by-guard-not-fk');
  perform public.t_gcsc3_ok($q$delete from public.appointments where id = '00000000-0000-0000-0000-000000ea4005'$q$, 'T-gcsc3-standalone-class-delete-unchanged');
  perform public.t_gcsc3_ok($q$delete from public.appointments where id = '00000000-0000-0000-0000-000000ea4004'$q$, 'T-gcsc3-private-lesson-delete-unchanged');
  reset role;
end $$;
select public.t_gcsc3_assert('T-gcsc3-series-occurrences-all-still-present',
  (select count(*)::text from public.appointments where group_class_series_id = current_setting('t.series')::uuid), '4');
select public.t_gcsc3_assert('T-gcsc3-standalone-and-private-actually-deleted',
  (select count(*)::text from public.appointments where id in ('00000000-0000-0000-0000-000000ea4005', '00000000-0000-0000-0000-000000ea4004')), '0');
-- the migration owner (maintenance, test cleanup) is not a tenant role and can still delete
delete from public.appointments where id = '00000000-0000-0000-0000-000000ea4010';
select public.t_gcsc3_assert('T-gcsc3-non-tenant-maintenance-delete-not-blocked',
  (select count(*)::text from public.appointments where id = '00000000-0000-0000-0000-000000ea4010'), '0');

-- ============================================================================
-- 6. Queued class reminders die with the cancelled class (D11)
-- ============================================================================
select public.t_gcsc3_assert('T-gcsc3-reminders-pending-before-cancel',
  (select count(*)::text from public.notification_deliveries where related_appointment_id = '00000000-0000-0000-0000-000000ea4008' and status = 'pending'), '2');
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  set local role authenticated;
  perform public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ea4008');
  reset role;
end $$;
select public.t_gcsc3_assert('T-gcsc3-pending-class-reminders-cancelled-with-the-class',
  (select string_agg(status || ':' || coalesce(failure_reason, '-'), ',' order by delivery_type) from public.notification_deliveries
   where related_appointment_id = '00000000-0000-0000-0000-000000ea4008' and status = 'cancelled'), 'cancelled:class_cancelled,cancelled:class_cancelled');
select public.t_gcsc3_assert('T-gcsc3-already-sent-reminder-untouched',
  (select status from public.notification_deliveries where related_appointment_id = '00000000-0000-0000-0000-000000ea4008' and subject = 'rs'), 'sent');
select public.t_gcsc3_assert('T-gcsc3-other-class-reminder-untouched',
  (select count(*)::text from public.notification_deliveries where subject = 'other class' and status = 'pending'), '1');
-- a no-op replay of the cancellation does not disturb anything further
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ea1001')::text, true);
  set local role authenticated;
  perform public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ea4008');
  reset role;
end $$;
select public.t_gcsc3_assert('T-gcsc3-cancellation-replay-leaves-reminders-as-they-were',
  (select count(*)::text from public.notification_deliveries where related_appointment_id = '00000000-0000-0000-0000-000000ea4008' and status = 'cancelled'), '2');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsc3_log;

rollback;
