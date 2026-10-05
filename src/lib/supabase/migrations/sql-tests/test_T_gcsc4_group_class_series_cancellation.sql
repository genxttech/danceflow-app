-- GC-S1C-4 -- series cancellation + lifecycle authority, live-Postgres regression suite for
-- 20261018090000_gcsc4_series_cancellation_lifecycle.sql.
--
-- Proves, as real tenant roles:
--   * cancel_group_class_series_from ("This and following classes"): broad staff only (owner, admin, front
--     desk; never the assigned instructor or another studio's owner); the client supplies only an occurrence id;
--     from the first and from a middle occurrence; earlier occurrences, past occurrences and occurrences with
--     recorded attendance are preserved; already-cancelled occurrences are idempotent; replays change nothing;
--     identity (series id, index, original start, overrides) and every row survive; attendees are cancelled
--     through the canonical single-class RPC; queued reminders die with the class;
--   * per-client results expose only that client's own classes;
--   * stored series status: 'cancelled' only when nothing upcoming remains, otherwise 'active' (and 'ended' is
--     never stored);
--   * credits, usage and attendance are never rewritten;
--   * a tenant can no longer reopen a cancelled group class (GCSC4_CANCELLED_CLASS_REACTIVATION) while non-group
--     appointments, non-cancel transitions and non-tenant roles are unaffected;
--   * the S1C-2 / S1C-3 behavior is intact and the preview is read-only.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261018090000 (and the earlier S1C migrations) are applied. UUID block ...000000ec....

begin;

create table public.t_gcsc4_log (n serial, msg text);
grant all on public.t_gcsc4_log to public;
grant usage on sequence public.t_gcsc4_log_n_seq to public;
create function public.t_gcsc4_pass(p text) returns void language sql as $$ insert into public.t_gcsc4_log (msg) values (p) $$;
grant execute on function public.t_gcsc4_pass(text) to public;

create function public.t_gcsc4_expect(p_sql text, p_like text, p_label text)
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
  perform public.t_gcsc4_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc4_expect(text, text, text) to anon, authenticated, service_role;

create function public.t_gcsc4_ok(p_sql text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise exception 'FAIL %: expected success, got [%]', p_label, sqlerrm;
  end;
  perform public.t_gcsc4_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc4_ok(text, text) to anon, authenticated, service_role;

create function public.t_gcsc4_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsc4_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc4_assert(text, text, text) to public;

-- series snapshot (identity + status of every occurrence) and a financial / attendance fingerprint
create function public.t_gcsc4_snap(p_series uuid) returns text language sql stable security definer set search_path = 'public' as $x$
  select coalesce(string_agg(a.series_occurrence_index || '|' || a.status::text || '|' || a.occurrence_original_start::text || '|' || a.series_overridden_fields::text || '|' || a.starts_at::text, ';' order by a.series_occurrence_index), '')
  from public.appointments a where a.group_class_series_id = p_series
$x$;
grant execute on function public.t_gcsc4_snap(uuid) to public;
create function public.t_gcsc4_money() returns text language sql stable security definer set search_path = 'public' as $x$
  select (select count(*) from public.client_membership_usage)::text || '/' ||
         coalesce((select sum(quantity_used)::text from public.client_membership_usage), '0') || '/' ||
         coalesce((select sum(quantity_used + quantity_remaining)::text from public.client_package_items), '0') || '/' ||
         coalesce((select sum(quantity_used)::text from public.client_package_items), '0') || '/' ||
         (select md5(coalesce(string_agg(ar::text, '|' order by ar.id), '')) from public.attendance_records ar)
$x$;
grant execute on function public.t_gcsc4_money() to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000ec0001', 'GC-S1C-4 Harness Studio A', 't-gcsc4-a', 'America/New_York'),
  ('00000000-0000-0000-0000-000000ec0002', 'GC-S1C-4 Harness Studio B', 't-gcsc4-b', 'America/New_York');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000ec1001', 't-gcsc4-owner@example.test'),
  ('00000000-0000-0000-0000-000000ec1002', 't-gcsc4-admin@example.test'),
  ('00000000-0000-0000-0000-000000ec1003', 't-gcsc4-frontdesk@example.test'),
  ('00000000-0000-0000-0000-000000ec1004', 't-gcsc4-instructor@example.test'),
  ('00000000-0000-0000-0000-000000ec1005', 't-gcsc4-owner-b@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000ec1001', 't-gcsc4-owner@example.test', null),
  ('00000000-0000-0000-0000-000000ec1002', 't-gcsc4-admin@example.test', null),
  ('00000000-0000-0000-0000-000000ec1003', 't-gcsc4-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-000000ec1004', 't-gcsc4-instructor@example.test', null),
  ('00000000-0000-0000-0000-000000ec1005', 't-gcsc4-owner-b@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000ec1001', '00000000-0000-0000-0000-000000ec0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000ec1002', '00000000-0000-0000-0000-000000ec0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-000000ec1003', '00000000-0000-0000-0000-000000ec0001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000ec1004', '00000000-0000-0000-0000-000000ec0001', 'instructor', true),
  ('00000000-0000-0000-0000-000000ec1005', '00000000-0000-0000-0000-000000ec0002', 'studio_owner', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000ec2001', '00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec1004', 'Series', 'Instructor', true, true);
alter table public.instructors enable trigger user;
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-000000ec3001', '00000000-0000-0000-0000-000000ec0001', 'C', 'One', 'active', false),
  ('00000000-0000-0000-0000-000000ec3002', '00000000-0000-0000-0000-000000ec0001', 'C', 'Two', 'active', false),
  ('00000000-0000-0000-0000-000000ec3003', '00000000-0000-0000-0000-000000ec0001', 'C', 'Three', 'active', false);

-- standalone class and a private lesson
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000ec4001', '00000000-0000-0000-0000-000000ec0001', null, '00000000-0000-0000-0000-000000ec2001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', 'STANDALONE'),
  ('00000000-0000-0000-0000-000000ec4002', '00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec3001', '00000000-0000-0000-0000-000000ec2001', 'private_lesson', 'cancelled', now() + interval '4 days', now() + interval '4 days 1 hour', 'PRIVATE');
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type) values
  ('00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec4001', '00000000-0000-0000-0000-000000ec3003', 'booked', 'staff', 'free_comped');

-- series builder (as the owner through the released B1 RPC); returns the series id
-- (GC-S1E-3: each series gets its own time slot, since the database now refuses a series whose classes conflict with
-- the same instructor's existing classes)
create function public.t_gcsc4_series(p_req text, p_title text, p_count integer, p_capacity integer) returns uuid language plpgsql as $$
declare v_res jsonb; v_slot integer := coalesce(nullif(current_setting('t.gcsc4_slot', true), ''), '0')::integer;
begin
  perform set_config('t.gcsc4_slot', (v_slot + 1)::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1001')::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000ec0001', p_client_request_id => p_req::uuid,
    p_title => p_title, p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000ec2001', p_room_id => null, p_location_name => null, p_roster_capacity => p_capacity,
    p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => p_count,
    p_local_start_time => time '08:00' + v_slot * interval '90 minutes', p_duration_minutes => 60);
  reset role;
  return (v_res ->> 'series_id')::uuid;
end $$;
grant execute on function public.t_gcsc4_series(text, text, integer, integer) to public;
create function public.t_gcsc4_occ(p_series uuid, p_idx integer) returns uuid language sql stable security definer set search_path = 'public' as $x$
  select id from public.appointments where group_class_series_id = p_series and series_occurrence_index = p_idx
$x$;
grant execute on function public.t_gcsc4_occ(uuid, integer) to public;
create function public.t_gcsc4_book(p_series uuid, p_idx integer, p_client text) returns void language sql as $x$
  insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type)
  values ('00000000-0000-0000-0000-000000ec0001', public.t_gcsc4_occ(p_series, p_idx), p_client::uuid, 'booked', 'staff', 'free_comped')
$x$;
create function public.t_gcsc4_past(p_series uuid, p_idx integer) returns void language sql as $x$
  update public.appointments set starts_at = now() - interval '10 days', ends_at = now() - interval '10 days' + interval '1 hour'
  where id = public.t_gcsc4_occ(p_series, p_idx)
$x$;

select set_config('t.T', public.t_gcsc4_series('00000000-0000-0000-0000-000000ec7001', 'SER-T', 3, 5)::text, true);
select set_config('t.S', public.t_gcsc4_series('00000000-0000-0000-0000-000000ec7002', 'SER-S', 6, 5)::text, true);
select set_config('t.U', public.t_gcsc4_series('00000000-0000-0000-0000-000000ec7003', 'SER-U', 3, 5)::text, true);
select set_config('t.V', public.t_gcsc4_series('00000000-0000-0000-0000-000000ec7004', 'SER-V', 2, 5)::text, true);
select set_config('t.W', public.t_gcsc4_series('00000000-0000-0000-0000-000000ec7005', 'SER-W', 3, 5)::text, true);

-- T: c1 on T1 and T2, c2 on T2
select public.t_gcsc4_book(current_setting('t.T')::uuid, 1, '00000000-0000-0000-0000-000000ec3001');
select public.t_gcsc4_book(current_setting('t.T')::uuid, 2, '00000000-0000-0000-0000-000000ec3001');
select public.t_gcsc4_book(current_setting('t.T')::uuid, 2, '00000000-0000-0000-0000-000000ec3002');
-- S: idx1 in the past; idx3 c1+c2; idx4 c1; idx5 with attendance recorded (made past, attended, moved back to the future)
select public.t_gcsc4_past(current_setting('t.S')::uuid, 1);
select public.t_gcsc4_book(current_setting('t.S')::uuid, 3, '00000000-0000-0000-0000-000000ec3001');
select public.t_gcsc4_book(current_setting('t.S')::uuid, 3, '00000000-0000-0000-0000-000000ec3002');
select public.t_gcsc4_book(current_setting('t.S')::uuid, 4, '00000000-0000-0000-0000-000000ec3001');
select public.t_gcsc4_book(current_setting('t.S')::uuid, 5, '00000000-0000-0000-0000-000000ec3003');
select public.t_gcsc4_past(current_setting('t.S')::uuid, 5);
insert into public.attendance_records (studio_id, appointment_id, client_id, status)
values ('00000000-0000-0000-0000-000000ec0001', public.t_gcsc4_occ(current_setting('t.S')::uuid, 5), '00000000-0000-0000-0000-000000ec3003', 'attended');
update public.appointments set starts_at = now() + interval '30 days', ends_at = now() + interval '30 days 1 hour'
  where id = public.t_gcsc4_occ(current_setting('t.S')::uuid, 5);
-- U: idx1 in the past, idx2 c1
select public.t_gcsc4_past(current_setting('t.U')::uuid, 1);
select public.t_gcsc4_book(current_setting('t.U')::uuid, 2, '00000000-0000-0000-0000-000000ec3001');
-- W: c1 on W1, c2 on W2, c1 on W3
select public.t_gcsc4_book(current_setting('t.W')::uuid, 1, '00000000-0000-0000-0000-000000ec3001');
select public.t_gcsc4_book(current_setting('t.W')::uuid, 2, '00000000-0000-0000-0000-000000ec3002');
select public.t_gcsc4_book(current_setting('t.W')::uuid, 3, '00000000-0000-0000-0000-000000ec3001');
-- credits / usage that must never move (a usage row keyed to a series class, and a package item)
insert into public.membership_plans (id, studio_id, name) values ('00000000-0000-0000-0000-000000ec5001', '00000000-0000-0000-0000-000000ec0001', 'S1C4 plan');
insert into public.membership_plan_benefits (membership_plan_id, benefit_type, quantity, usage_period) values ('00000000-0000-0000-0000-000000ec5001', 'included_group_classes', 10, 'billing_cycle');
insert into public.client_memberships (id, studio_id, client_id, membership_plan_id, status, starts_on, current_period_start, current_period_end, auto_renew, cancel_at_period_end, name_snapshot, price_snapshot, billing_interval_snapshot)
values ('00000000-0000-0000-0000-000000ec5101', '00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec3001', '00000000-0000-0000-0000-000000ec5001', 'active', current_date - 5, current_date - 5, current_date + 25, false, false, 'S1C4 membership', 0, 'monthly');
insert into public.client_membership_usage (client_membership_id, membership_plan_benefit_id, quantity_used, reference_type, reference_id)
select '00000000-0000-0000-0000-000000ec5101', b.id, 1, 'appointment', public.t_gcsc4_occ(current_setting('t.T')::uuid, 2)
from public.membership_plan_benefits b where b.membership_plan_id = '00000000-0000-0000-0000-000000ec5001' limit 1;
insert into public.client_packages (id, studio_id, client_id, name_snapshot, purchase_date, is_shareable, active) values ('00000000-0000-0000-0000-000000ec6001', '00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec3002', 'S1C4 package', current_date, false, true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values ('00000000-0000-0000-0000-000000ec6101', '00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec6001', 'group_class', 5, 0, 5, false);
-- pending reminders on T2 (c1) and on W1 (c1: must survive a cancel that starts at W2)
insert into public.notification_deliveries (studio_id, client_id, delivery_type, channel, status, related_appointment_id, related_date, subject, body, scheduled_for) values
  ('00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec3001', 'student_lesson_reminder_24h', 'email', 'pending', public.t_gcsc4_occ(current_setting('t.T')::uuid, 2), current_date + 40, 'T2 reminder', 'b', now()),
  ('00000000-0000-0000-0000-000000ec0001', '00000000-0000-0000-0000-000000ec3001', 'student_lesson_reminder_24h', 'email', 'pending', public.t_gcsc4_occ(current_setting('t.W')::uuid, 1), current_date + 20, 'W1 reminder', 'b', now());

create temp table t_gcsc4_base as
select public.t_gcsc4_money() as money, (select count(*) from public.appointments where group_class_series_id is not null) as occurrences,
       (select count(*) from public.appointment_attendees) as attendee_rows;

-- ============================================================================
-- 1. Posture
-- ============================================================================
select public.t_gcsc4_assert('T-gcsc4-rpcs-authenticated-only-and-definer',
  (select (count(*) = 2 and bool_and(p.prosecdef and p.proconfig = array['search_path=public']
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0)))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('cancel_group_class_series_from', 'preview_group_class_series_cancellation')), 'true');
select public.t_gcsc4_assert('T-gcsc4-internal-helpers-and-guard-trigger-only',
  (select (count(*) = 3 and bool_and(
      not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0)))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('_gcsc4_series_cancel_targets', '_gcsc4_series_remaining_after', '_gcsc4_guard_group_class_reactivation')), 'true');
select public.t_gcsc4_assert('T-gcsc4-reactivation-trigger-enabled-and-invoker-guard',
  (select (t.tgenabled = 'O' and not p.prosecdef)::text from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.appointments'::regclass and t.tgname = 'appointments_05_guard_group_class_reactivation'), 'true');
select public.t_gcsc4_assert('T-gcsc4-s1c2-and-s1c3-triggers-still-installed',
  (select count(*)::text from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O' and t.tgname in
    ('appointments_02_guard_cancel_terminal_attendance', 'appointments_03_guard_group_class_cancel_authority', 'appointments_04_guard_group_class_capacity_floor',
     'appointments_guard_series_occurrence_delete', 'appointments_gcsc3_cancel_pending_reminders', 'attendance_records_00_guard_cancelled_class')), '6');
select public.t_gcsc4_assert('T-gcsc4-fixture-series-shapes',
  (select string_agg(s.title || ':' || (select count(*) from public.appointments a where a.group_class_series_id = s.id)::text || ':' || s.status, ',' order by s.title)
   from public.group_class_series s where s.id in (current_setting('t.T')::uuid, current_setting('t.S')::uuid, current_setting('t.U')::uuid, current_setting('t.V')::uuid, current_setting('t.W')::uuid)),
  'SER-S:6:active,SER-T:3:active,SER-U:3:active,SER-V:2:active,SER-W:3:active');

-- ============================================================================
-- 2. Preview (read-only) and authority
-- ============================================================================
do $$
declare v jsonb; v_snap text;
begin
  v_snap := public.t_gcsc4_snap(current_setting('t.T')::uuid);
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1003')::text, true); -- front desk
  set local role authenticated;
  v := public.preview_group_class_series_cancellation(public.t_gcsc4_occ(current_setting('t.T')::uuid, 1));
  reset role;
  perform public.t_gcsc4_assert('T-gcsc4-preview-from-first-counts',
    (v ->> 'eligible_class_count') || '/' || (v ->> 'enrollments_affected') || '/' || (v ->> 'dancers_affected') || '/' || (v ->> 'series_would_be_cancelled'), '3/3/2/true');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1002')::text, true); -- admin
  set local role authenticated;
  v := public.preview_group_class_series_cancellation(public.t_gcsc4_occ(current_setting('t.W')::uuid, 2));
  reset role;
  perform public.t_gcsc4_assert('T-gcsc4-preview-from-middle-keeps-series-active',
    (v ->> 'eligible_class_count') || '/' || (v ->> 'enrollments_affected') || '/' || (v ->> 'dancers_affected') || '/' || (v ->> 'series_would_be_cancelled'), '2/2/2/false');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1001')::text, true); -- owner
  set local role authenticated;
  v := public.preview_group_class_series_cancellation(public.t_gcsc4_occ(current_setting('t.S')::uuid, 3));
  reset role;
  perform public.t_gcsc4_assert('T-gcsc4-preview-classifies-terminal-attendance-and-keeps-series-active',
    (v ->> 'eligible_class_count') || '/' || (v ->> 'terminal_attendance_count') || '/' || (v ->> 'series_would_be_cancelled'), '3/1/false');
  perform public.t_gcsc4_assert('T-gcsc4-preview-changed-nothing', public.t_gcsc4_snap(current_setting('t.T')::uuid), v_snap);
end $$;

select set_config('t.snapT0', public.t_gcsc4_snap(current_setting('t.T')::uuid), true);
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1004')::text, true); -- assigned instructor
  set local role authenticated;
  perform public.t_gcsc4_expect(format($q$select public.cancel_group_class_series_from(%L)$q$, public.t_gcsc4_occ(current_setting('t.T')::uuid, 1)), 'GCSC4_UNAUTHORIZED', 'T-gcsc4-assigned-instructor-cannot-cancel-series');
  perform public.t_gcsc4_expect(format($q$select public.preview_group_class_series_cancellation(%L)$q$, public.t_gcsc4_occ(current_setting('t.T')::uuid, 1)), 'GCSC4_UNAUTHORIZED', 'T-gcsc4-assigned-instructor-cannot-preview-series');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1005')::text, true); -- another studio's owner
  perform public.t_gcsc4_expect(format($q$select public.cancel_group_class_series_from(%L)$q$, public.t_gcsc4_occ(current_setting('t.T')::uuid, 1)), 'GCSC4_UNAUTHORIZED', 'T-gcsc4-other-studio-owner-cannot-cancel-series');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1001')::text, true);
  perform public.t_gcsc4_expect($q$select public.cancel_group_class_series_from('00000000-0000-0000-0000-000000ec4001')$q$, 'GCSC4_NOT_A_SERIES_OCCURRENCE', 'T-gcsc4-standalone-class-is-not-a-series-occurrence');
  perform public.t_gcsc4_expect($q$select public.cancel_group_class_series_from('00000000-0000-0000-0000-000000ec4002')$q$, 'GCSC4_NOT_FOUND', 'T-gcsc4-private-lesson-not-a-group-class');
  perform public.t_gcsc4_expect($q$select public.cancel_group_class_series_from('00000000-0000-0000-0000-000000ffffff')$q$, 'GCSC4_NOT_FOUND', 'T-gcsc4-missing-class-not-found');
  reset role;
  set local role anon;
  perform public.t_gcsc4_expect($q$select public.cancel_group_class_series_from('00000000-0000-0000-0000-000000ec4001')$q$, 'permission denied', 'T-gcsc4-anon-cannot-execute');
  reset role;
end $$;
select public.t_gcsc4_assert('T-gcsc4-refusals-changed-nothing', public.t_gcsc4_snap(current_setting('t.T')::uuid), current_setting('t.snapT0'));

-- ============================================================================
-- 3. Series T: "This and following" from the FIRST occurrence (front desk): cancels the whole remaining series
-- ============================================================================
create temp table t_gcsc4_T_before as select a.id, a.series_occurrence_index idx, a.occurrence_original_start, a.series_overridden_fields::text ov, a.starts_at
  from public.appointments a where a.group_class_series_id = current_setting('t.T')::uuid;
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1003')::text, true);
  set local role authenticated;
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.T')::uuid, 1));
  reset role;
  perform set_config('t.res_T', v::text, true);
end $$;
select public.t_gcsc4_assert('T-gcsc4-first-occurrence-counts',
  (current_setting('t.res_T')::jsonb ->> 'cancelled_class_count') || '/' || (current_setting('t.res_T')::jsonb ->> 'enrollments_cancelled') || '/' || (current_setting('t.res_T')::jsonb ->> 'already_cancelled_count') || '/' || (current_setting('t.res_T')::jsonb ->> 'historical_count') || '/' || (current_setting('t.res_T')::jsonb ->> 'terminal_attendance_count'), '3/3/0/0/0');
select public.t_gcsc4_assert('T-gcsc4-first-occurrence-series-becomes-cancelled',
  (current_setting('t.res_T')::jsonb ->> 'series_status') || '/' || (current_setting('t.res_T')::jsonb ->> 'series_cancelled_by_this_call') || '/' || (select status from public.group_class_series where id = current_setting('t.T')::uuid), 'cancelled/true/cancelled');
select public.t_gcsc4_assert('T-gcsc4-result-carries-only-each-clients-own-classes',
  (select string_agg(r ->> 'client_id' || ':' || jsonb_array_length(r -> 'class_starts')::text, ',' order by r ->> 'client_id')
   from jsonb_array_elements(current_setting('t.res_T')::jsonb -> 'recipients') r),
  '00000000-0000-0000-0000-000000ec3001:2,00000000-0000-0000-0000-000000ec3002:1');
select public.t_gcsc4_assert('T-gcsc4-all-occurrences-cancelled-with-a-cancelled-at-stamp',
  (select (count(*) = 3 and bool_and(a.status = 'cancelled' and a.cancelled_at is not null))::text from public.appointments a where a.group_class_series_id = current_setting('t.T')::uuid), 'true');
select public.t_gcsc4_assert('T-gcsc4-booked-attendees-cancelled-through-canonical-path',
  (select count(*)::text from public.appointment_attendees aa join public.appointments a on a.id = aa.appointment_id
    where a.group_class_series_id = current_setting('t.T')::uuid and aa.status = 'booked'), '0');
select public.t_gcsc4_assert('T-gcsc4-attendee-rows-not-deleted',
  (select count(*)::text from public.appointment_attendees aa join public.appointments a on a.id = aa.appointment_id
    where a.group_class_series_id = current_setting('t.T')::uuid and aa.status = 'cancelled'), '3');
select public.t_gcsc4_assert('T-gcsc4-identity-and-index-preserved',
  (select (count(*) = 3 and bool_and(a.series_occurrence_index = b.idx and a.occurrence_original_start = b.occurrence_original_start
      and a.series_overridden_fields::text = b.ov and a.starts_at = b.starts_at and a.group_class_series_id = current_setting('t.T')::uuid))::text
   from public.appointments a join t_gcsc4_T_before b on b.id = a.id), 'true');
select public.t_gcsc4_assert('T-gcsc4-queued-reminder-of-cancelled-class-is-cancelled',
  (select status || ':' || coalesce(failure_reason, '-') from public.notification_deliveries where subject = 'T2 reminder'), 'cancelled:class_cancelled');
-- replay
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1003')::text, true);
  set local role authenticated;
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.T')::uuid, 1));
  reset role;
  perform public.t_gcsc4_assert('T-gcsc4-replay-cancels-nothing-and-returns-no-recipients',
    (v ->> 'cancelled_class_count') || '/' || (v ->> 'already_cancelled_count') || '/' || jsonb_array_length(v -> 'recipients')::text || '/' || (v ->> 'series_cancelled_by_this_call') || '/' || (v ->> 'series_status'), '0/3/0/false/cancelled');
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.T')::uuid, 3));
  perform public.t_gcsc4_assert('T-gcsc4-replay-from-a-later-occurrence-also-noop',
    (v ->> 'cancelled_class_count') || '/' || jsonb_array_length(v -> 'recipients')::text, '0/0');
  reset role;
end $$;

-- ============================================================================
-- 4. Series S: from a MIDDLE occurrence (admin): earlier / past preserved, terminal attendance preserved
-- ============================================================================
create temp table t_gcsc4_S_before as select a.id, a.series_occurrence_index idx, a.status::text st, a.occurrence_original_start, a.starts_at
  from public.appointments a where a.group_class_series_id = current_setting('t.S')::uuid;
-- idx2 is already individually cancelled (RPC) before the series operation
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1001')::text, true);
  set local role authenticated;
  perform public.cancel_group_class_appointment(public.t_gcsc4_occ(current_setting('t.S')::uuid, 2));
  reset role;
end $$;
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1002')::text, true);
  set local role authenticated;
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.S')::uuid, 3));
  reset role;
  perform set_config('t.res_S', v::text, true);
end $$;
select public.t_gcsc4_assert('T-gcsc4-middle-occurrence-counts',
  (current_setting('t.res_S')::jsonb ->> 'cancelled_class_count') || '/' || (current_setting('t.res_S')::jsonb ->> 'enrollments_cancelled') || '/' || (current_setting('t.res_S')::jsonb ->> 'terminal_attendance_count') || '/' || (current_setting('t.res_S')::jsonb ->> 'already_cancelled_count') || '/' || (current_setting('t.res_S')::jsonb ->> 'historical_count'), '3/3/1/0/0');
select public.t_gcsc4_assert('T-gcsc4-middle-occurrence-per-index-outcome',
  (select string_agg(a.series_occurrence_index || ':' || a.status::text, ',' order by a.series_occurrence_index) from public.appointments a where a.group_class_series_id = current_setting('t.S')::uuid),
  '1:scheduled,2:cancelled,3:cancelled,4:cancelled,5:scheduled,6:cancelled');
select public.t_gcsc4_assert('T-gcsc4-past-occurrence-one-unchanged',
  (select (a.status = 'scheduled' and a.starts_at = b.starts_at and a.cancelled_at is null)::text from public.appointments a join t_gcsc4_S_before b on b.id = a.id where b.idx = 1), 'true');
select public.t_gcsc4_assert('T-gcsc4-terminal-attendance-occurrence-preserved-with-its-attendance',
  (select (a.status = 'scheduled' and (select status from public.attendance_records ar where ar.appointment_id = a.id) = 'attended'
     and (select count(*) from public.appointment_attendees aa where aa.appointment_id = a.id and aa.status = 'booked') = 1)::text
   from public.appointments a where a.id = public.t_gcsc4_occ(current_setting('t.S')::uuid, 5)), 'true');
select public.t_gcsc4_assert('T-gcsc4-series-stays-active-when-an-upcoming-class-is-preserved',
  (current_setting('t.res_S')::jsonb ->> 'series_status') || '/' || (current_setting('t.res_S')::jsonb ->> 'series_cancelled_by_this_call') || '/' || (select status from public.group_class_series where id = current_setting('t.S')::uuid), 'active/false/active');
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1001')::text, true);
  set local role authenticated;
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.S')::uuid, 1));
  reset role;
  perform public.t_gcsc4_assert('T-gcsc4-series-op-from-the-first-class-after-a-middle-op-is-idempotent',
    (v ->> 'cancelled_class_count') || '/' || (v ->> 'historical_count') || '/' || (v ->> 'terminal_attendance_count') || '/' || (v ->> 'series_status'), '0/1/1/active');
end $$;

-- ============================================================================
-- 5. Series U: middle anchor whose earlier class is already past => nothing upcoming remains => series cancelled
--    Series W: middle anchor with an earlier upcoming class => series stays active
--    Series V: every upcoming class already cancelled one by one, then the series operation
-- ============================================================================
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1001')::text, true);
  set local role authenticated;
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.U')::uuid, 2));
  perform public.t_gcsc4_assert('T-gcsc4-U-middle-anchor-with-past-earlier-class-cancels-the-series',
    (v ->> 'cancelled_class_count') || '/' || (v ->> 'series_status') || '/' || (v ->> 'series_cancelled_by_this_call'), '2/cancelled/true');
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.W')::uuid, 2));
  perform set_config('t.res_W', v::text, true);
  perform public.cancel_group_class_appointment(public.t_gcsc4_occ(current_setting('t.V')::uuid, 1));
  perform public.cancel_group_class_appointment(public.t_gcsc4_occ(current_setting('t.V')::uuid, 2));
  perform public.t_gcsc4_assert('T-gcsc4-V-individually-cancelling-everything-does-not-store-a-series-status',
    (select status from public.group_class_series where id = current_setting('t.V')::uuid), 'active');
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.V')::uuid, 1));
  perform public.t_gcsc4_assert('T-gcsc4-V-series-op-after-all-individually-cancelled-records-the-series-as-cancelled',
    (v ->> 'cancelled_class_count') || '/' || (v ->> 'already_cancelled_count') || '/' || (v ->> 'series_status') || '/' || (v ->> 'series_cancelled_by_this_call'), '0/2/cancelled/true');
  v := public.cancel_group_class_series_from(public.t_gcsc4_occ(current_setting('t.V')::uuid, 1));
  perform public.t_gcsc4_assert('T-gcsc4-V-second-series-op-is-noop', (v ->> 'series_cancelled_by_this_call') || '/' || (v ->> 'series_status'), 'false/cancelled');
  reset role;
end $$;
select public.t_gcsc4_assert('T-gcsc4-W-middle-anchor-leaves-earlier-class-and-series-active',
  (select string_agg(a.series_occurrence_index || ':' || a.status::text, ',' order by a.series_occurrence_index) from public.appointments a where a.group_class_series_id = current_setting('t.W')::uuid)
  || '/' || (select status from public.group_class_series where id = current_setting('t.W')::uuid), '1:scheduled,2:cancelled,3:cancelled/active');
select public.t_gcsc4_assert('T-gcsc4-W-earlier-class-attendee-and-reminder-untouched',
  (select count(*)::text from public.appointment_attendees aa where aa.appointment_id = public.t_gcsc4_occ(current_setting('t.W')::uuid, 1) and aa.status = 'booked')
  || '/' || (select status from public.notification_deliveries where subject = 'W1 reminder'), '1/pending');
select public.t_gcsc4_assert('T-gcsc4-W-recipients-are-per-client-and-exclude-the-earlier-class',
  (select string_agg(r ->> 'client_id' || ':' || jsonb_array_length(r -> 'class_starts')::text, ',' order by r ->> 'client_id')
   from jsonb_array_elements(current_setting('t.res_W')::jsonb -> 'recipients') r),
  '00000000-0000-0000-0000-000000ec3001:1,00000000-0000-0000-0000-000000ec3002:1');

-- ============================================================================
-- 6. Credits / usage / attendance never rewritten; nothing deleted; ended is never stored
-- ============================================================================
select public.t_gcsc4_assert('T-gcsc4-money-usage-and-attendance-unchanged-across-every-series-operation',
  (select (public.t_gcsc4_money() = b.money)::text from t_gcsc4_base b), 'true');
select public.t_gcsc4_assert('T-gcsc4-no-appointment-or-attendee-row-deleted',
  (select ((select count(*) from public.appointments where group_class_series_id is not null) = b.occurrences
        and (select count(*) from public.appointment_attendees) = b.attendee_rows)::text from t_gcsc4_base b), 'true');
select public.t_gcsc4_assert('T-gcsc4-only-active-and-cancelled-statuses-are-ever-stored',
  (select string_agg(distinct s.status, ',' order by s.status) from public.group_class_series s
    where s.id in (current_setting('t.T')::uuid, current_setting('t.S')::uuid, current_setting('t.U')::uuid, current_setting('t.V')::uuid, current_setting('t.W')::uuid)), 'active,cancelled');

-- ============================================================================
-- 7. Reactivation closure (tenant roles may not reopen a cancelled group class)
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1004')::text, true);
  set local role authenticated;
  perform public.t_gcsc4_expect(format($q$update public.appointments set status = 'scheduled' where id = %L$q$, public.t_gcsc4_occ(current_setting('t.T')::uuid, 1)), 'GCSC4_CANCELLED_CLASS_REACTIVATION', 'T-gcsc4-assigned-instructor-cannot-reactivate-a-cancelled-series-class');
  perform public.t_gcsc4_expect(format($q$update public.appointments set status = 'confirmed' where id = %L$q$, public.t_gcsc4_occ(current_setting('t.T')::uuid, 2)), 'GCSC4_CANCELLED_CLASS_REACTIVATION', 'T-gcsc4-instructor-cannot-move-cancelled-to-confirmed');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ec1001')::text, true);
  perform public.t_gcsc4_expect(format($q$update public.appointments set status = 'scheduled' where id = %L$q$, public.t_gcsc4_occ(current_setting('t.T')::uuid, 3)), 'GCSC4_CANCELLED_CLASS_REACTIVATION', 'T-gcsc4-owner-cannot-reactivate-either');
  perform public.t_gcsc4_expect($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ec4001'$q$, 'GCSC3_CANCEL_VIA_RPC_ONLY', 'T-gcsc4-s1c3-direct-cancel-authority-still-refuses');
  perform public.cancel_group_class_appointment('00000000-0000-0000-0000-000000ec4001');
  perform public.t_gcsc4_expect($q$update public.appointments set status = 'scheduled' where id = '00000000-0000-0000-0000-000000ec4001'$q$, 'GCSC4_CANCELLED_CLASS_REACTIVATION', 'T-gcsc4-standalone-class-cannot-be-reactivated-either');
  perform public.t_gcsc4_ok($q$update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000ec4001'$q$, 'T-gcsc4-cancelled-to-cancelled-is-not-a-transition');
  perform public.t_gcsc4_ok($q$update public.appointments set status = 'scheduled' where id = '00000000-0000-0000-0000-000000ec4002'$q$, 'T-gcsc4-private-lesson-reactivation-unchanged');
  perform public.t_gcsc4_ok(format($q$update public.appointments set status = 'confirmed' where id = %L$q$, public.t_gcsc4_occ(current_setting('t.W')::uuid, 1)), 'T-gcsc4-non-cancel-status-moves-on-active-class-unchanged');
  perform public.t_gcsc4_ok(format($q$update public.appointments set status = 'scheduled', title = 'W1 renamed' where id = %L$q$, public.t_gcsc4_occ(current_setting('t.W')::uuid, 1)), 'T-gcsc4-single-occurrence-edit-still-allowed');
  perform public.t_gcsc4_expect($q$select public.enroll_class_attendee('00000000-0000-0000-0000-000000ec4001', '00000000-0000-0000-0000-000000ec3002', 'free_comped')$q$, 'GCSC3_CLASS_CANCELLED', 'T-gcsc4-s1c3-cancelled-class-still-refuses-enrollment');
  reset role;
end $$;
select public.t_gcsc4_assert('T-gcsc4-refused-reactivations-left-classes-cancelled',
  (select count(*)::text from public.appointments where group_class_series_id = current_setting('t.T')::uuid and status = 'cancelled'), '3');
-- non-tenant roles are not blocked (maintenance / server-side tooling): documented posture
do $$
begin
  set local role service_role;
  perform public.t_gcsc4_ok(format($q$update public.appointments set status = 'scheduled' where id = %L$q$, public.t_gcsc4_occ(current_setting('t.V')::uuid, 2)), 'T-gcsc4-service-role-is-not-a-tenant-role');
  reset role;
end $$;

-- ============================================================================
-- 8. Standalone single-class cancellation regression (the released S1C-2 path is the one source of truth)
-- ============================================================================
select public.t_gcsc4_assert('T-gcsc4-standalone-class-cancelled-by-the-canonical-rpc',
  (select a.status::text || '/' || (select string_agg(aa.status, ',') from public.appointment_attendees aa where aa.appointment_id = a.id) from public.appointments a where a.id = '00000000-0000-0000-0000-000000ec4001'), 'cancelled/cancelled');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsc4_log;

rollback;
