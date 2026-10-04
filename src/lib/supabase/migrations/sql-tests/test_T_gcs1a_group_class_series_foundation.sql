-- GC-S1A -- canonical group-class series schema + authority foundation,
-- live-Postgres regression suite.
--
-- Proves, at the real Postgres level (not mocked): the series table's CHECKs
-- and normalization; the same-studio composite FK; the all-or-none
-- occurrence integrity; the shape-trigger extension (series only on
-- group_class, every pre-existing rule preserved); the direct-write guard and
-- override tracking (tenant roles append, never remove, definer writers are
-- not tracked); RLS / grants (SELECT only, no tenant writes); function
-- security modes and execute grants; and that standalone group classes and
-- private-lesson recurrence are unaffected. The entire script runs in one
-- transaction and is rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261014090000_gcs1a_group_class_series_foundation.sql has been applied.
--
-- Deterministic UUID block reserved for this harness (...0000-0000-0000-0000-000000eNXXXX):
--   e0 studios, e1 auth.users/profiles, e2 instructors, e3 rooms,
--   e4 appointments, e5 group_class_series.

begin;

create table public.t_gcs1a_log (n serial, msg text);
grant all on public.t_gcs1a_log to public;
grant usage on sequence public.t_gcs1a_log_n_seq to public;
create function public.t_gcs1a_pass(p text) returns void language sql as $$ insert into public.t_gcs1a_log (msg) values (p) $$;
grant execute on function public.t_gcs1a_pass(text) to public;


-- ============================================================================
-- 0. Pre-flight: purely additive.
-- ============================================================================
do $$
declare v int;
begin
  select count(*) into v from public.appointments where group_class_series_id is not null;
  if v <> 0 then raise exception 'FAIL T-gcs1a-preflight: % pre-existing appointments with a series', v; end if;
  select count(*) into v from public.group_class_series;
  if v <> 0 then raise exception 'FAIL T-gcs1a-preflight: % pre-existing series rows', v; end if;
  select count(*) into v from public.appointments where cardinality(series_overridden_fields) <> 0;
  if v <> 0 then raise exception 'FAIL T-gcs1a-preflight: existing appointments carry override entries'; end if;
  perform public.t_gcs1a_pass('T-gcs1a-preflight-additive');
end $$;

-- Test helper (rolled back with the script): expect a statement to fail with
-- an error message containing p_like. Runs as the invoking role.
create function public.t_gcs1a_expect(p_sql text, p_like text, p_label text)
returns void
language plpgsql
as $$
declare
  v_failed boolean := false;
  v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_failed := true;
    v_err := sqlerrm;
  end;
  if not v_failed then
    raise exception 'FAIL %: expected an error containing [%], statement succeeded', p_label, p_like;
  end if;
  if position(lower(p_like) in lower(v_err)) = 0 then
    raise exception 'FAIL %: expected error containing [%], got [%]', p_label, p_like, v_err;
  end if;
  perform public.t_gcs1a_pass(p_label);
end;
$$;
grant execute on function public.t_gcs1a_expect(text, text, text) to anon, authenticated;

-- ============================================================================
-- FIXTURES (as the migration owner)
-- ============================================================================
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000e00001', 'GC-S1A Harness Studio A', 't-gcs1a-studio-a'),
  ('00000000-0000-0000-0000-000000e00002', 'GC-S1A Harness Studio B', 't-gcs1a-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e10001', 't-gcs1a-owner-a@example.test'),
  ('00000000-0000-0000-0000-000000e10002', 't-gcs1a-instructor-default@example.test'),
  ('00000000-0000-0000-0000-000000e10003', 't-gcs1a-instructor-occurrence@example.test'),
  ('00000000-0000-0000-0000-000000e10004', 't-gcs1a-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-000000e10005', 't-gcs1a-owner-b@example.test'),
  ('00000000-0000-0000-0000-000000e10006', 't-gcs1a-unrelated@example.test'),
  ('00000000-0000-0000-0000-000000e10007', 't-gcs1a-platform-admin@example.test'),
  ('00000000-0000-0000-0000-000000e10008', 't-gcs1a-instructor-b@example.test'),
  ('00000000-0000-0000-0000-000000e10009', 't-gcs1a-instructor-noassign@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000e10001', 't-gcs1a-owner-a@example.test', null),
  ('00000000-0000-0000-0000-000000e10002', 't-gcs1a-instructor-default@example.test', null),
  ('00000000-0000-0000-0000-000000e10003', 't-gcs1a-instructor-occurrence@example.test', null),
  ('00000000-0000-0000-0000-000000e10004', 't-gcs1a-frontdesk-a@example.test', null),
  ('00000000-0000-0000-0000-000000e10005', 't-gcs1a-owner-b@example.test', null),
  ('00000000-0000-0000-0000-000000e10006', 't-gcs1a-unrelated@example.test', null),
  ('00000000-0000-0000-0000-000000e10007', 't-gcs1a-platform-admin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-000000e10008', 't-gcs1a-instructor-b@example.test', null),
  ('00000000-0000-0000-0000-000000e10009', 't-gcs1a-instructor-noassign@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000e10001', '00000000-0000-0000-0000-000000e00001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000e10002', '00000000-0000-0000-0000-000000e00001', 'instructor', true),
  ('00000000-0000-0000-0000-000000e10003', '00000000-0000-0000-0000-000000e00001', 'instructor', true),
  ('00000000-0000-0000-0000-000000e10004', '00000000-0000-0000-0000-000000e00001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000e10005', '00000000-0000-0000-0000-000000e00002', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000e10008', '00000000-0000-0000-0000-000000e00002', 'instructor', true),
  ('00000000-0000-0000-0000-000000e10009', '00000000-0000-0000-0000-000000e00001', 'instructor', true);
-- e10006 has NO role anywhere (negative control).

-- The plan seat gate would cap instructors per studio; this harness needs several. Disabled for the
-- transaction only (rolled back with the script).
alter table public.instructors disable trigger user;

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000e20001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e10002', 'Default', 'Instructor', true, true),
  ('00000000-0000-0000-0000-000000e20002', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e10003', 'Occurrence', 'Instructor', true, true),
  ('00000000-0000-0000-0000-000000e20003', '00000000-0000-0000-0000-000000e00002', '00000000-0000-0000-0000-000000e10008', 'StudioB', 'Instructor', true, true),
  ('00000000-0000-0000-0000-000000e20004', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e10009', 'NoAssign', 'Instructor', true, false);

alter table public.instructors enable trigger user;

insert into public.rooms (id, studio_id, name) values
  ('00000000-0000-0000-0000-000000e30001', '00000000-0000-0000-0000-000000e00001', 'T-gcs1a Room A'),
  ('00000000-0000-0000-0000-000000e30002', '00000000-0000-0000-0000-000000e00001', 'T-gcs1a Room A2'),
  ('00000000-0000-0000-0000-000000e30003', '00000000-0000-0000-0000-000000e00002', 'T-gcs1a Room B');

-- ============================================================================
-- 1. Series: valid insert, normalization, defaults
-- ============================================================================
insert into public.group_class_series (
  id, studio_id, title, timezone, weekdays, starts_on, occurrence_count,
  local_start_time, duration_minutes, default_instructor_id, default_room_id, default_roster_capacity
) values (
  '00000000-0000-0000-0000-000000e50001', '00000000-0000-0000-0000-000000e00001', '  Salsa Level 1  ', 'America/New_York',
  array[5, 1, 5, 3]::smallint[], date '2027-01-04', 6, time '18:30', 60,
  '00000000-0000-0000-0000-000000e20001', '00000000-0000-0000-0000-000000e30001', 12
);

insert into public.group_class_series (
  id, studio_id, title, timezone, weekdays, starts_on, ends_on, local_start_time, duration_minutes
) values (
  '00000000-0000-0000-0000-000000e50002', '00000000-0000-0000-0000-000000e00002', 'Studio B Bachata', 'America/Los_Angeles',
  array[2]::smallint[], date '2027-01-05', date '2027-03-30', time '19:00', 75
);

do $$
declare r public.group_class_series%rowtype;
begin
  select * into r from public.group_class_series where id = '00000000-0000-0000-0000-000000e50001';
  if r.weekdays <> array[1, 3, 5]::smallint[] then raise exception 'FAIL T-gcs1a-normalize-weekdays: got %', r.weekdays; end if;
  perform public.t_gcs1a_pass('T-gcs1a-normalize-weekdays-distinct-sorted');
  if r.title <> 'Salsa Level 1' then raise exception 'FAIL T-gcs1a-title-trim: [%]', r.title; end if;
  perform public.t_gcs1a_pass('T-gcs1a-title-trimmed');
  if r.status <> 'active' or r.interval_weeks <> 1 or r.publicly_discoverable or r.self_enrollment_allowed
     or r.accepted_funding_types is not null or r.direct_payment_amount is not null then
    raise exception 'FAIL T-gcs1a-defaults';
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-defaults');
end $$;

-- ============================================================================
-- 2. Series CHECK constraints / shape trigger rejections
-- ============================================================================
do $$
declare
  base text := 'insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, occurrence_count, local_start_time, duration_minutes %s) values (''00000000-0000-0000-0000-000000e00001'', %L, %L, %s, date ''2027-02-01'', %s, time ''10:00'', %s %s)';
begin
  perform public.t_gcs1a_expect(format(base, '', 'x', 'America/New_York', 'array[]::smallint[]', '4', '60', ''), 'weekdays_valid', 'T-gcs1a-ck-weekdays-empty');
  perform public.t_gcs1a_expect(format(base, '', 'x', 'America/New_York', 'array[8]::smallint[]', '4', '60', ''), 'weekdays_valid', 'T-gcs1a-ck-weekday-out-of-range');
  perform public.t_gcs1a_expect(format(base, '', 'x', 'America/New_York', 'array[0]::smallint[]', '4', '60', ''), 'weekdays_valid', 'T-gcs1a-ck-weekday-zero');
  perform public.t_gcs1a_expect(format(base, '', '   ', 'America/New_York', 'array[1]::smallint[]', '4', '60', ''), 'title_nonblank', 'T-gcs1a-ck-title-blank');
  perform public.t_gcs1a_expect(format(base, '', 'x', 'Mars/Phobos', 'array[1]::smallint[]', '4', '60', ''), 'Unknown time zone', 'T-gcs1a-trigger-timezone-invalid');
  perform public.t_gcs1a_expect(format(base, '', 'x', '   ', 'array[1]::smallint[]', '4', '60', ''), 'Unknown time zone', 'T-gcs1a-ck-timezone-blank');
  perform public.t_gcs1a_expect(format(base, '', 'x', 'America/New_York', 'array[1]::smallint[]', '0', '60', ''), 'occurrence_count_valid', 'T-gcs1a-ck-count-zero');
  perform public.t_gcs1a_expect(format(base, '', 'x', 'America/New_York', 'array[1]::smallint[]', '105', '60', ''), 'occurrence_count_valid', 'T-gcs1a-ck-count-over-cap');
  perform public.t_gcs1a_expect(format(base, '', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '4', ''), 'duration_valid', 'T-gcs1a-ck-duration-low');
  perform public.t_gcs1a_expect(format(base, '', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '721', ''), 'duration_valid', 'T-gcs1a-ck-duration-high');
  perform public.t_gcs1a_expect(format(base, ', interval_weeks', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', 0'), 'interval_weeks_valid', 'T-gcs1a-ck-interval-zero');
  perform public.t_gcs1a_expect(format(base, ', interval_weeks', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', 53'), 'interval_weeks_valid', 'T-gcs1a-ck-interval-over');
  perform public.t_gcs1a_expect(format(base, ', status', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', ''paused'''), 'status_valid', 'T-gcs1a-ck-status');
  perform public.t_gcs1a_expect(format(base, ', default_roster_capacity', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', 0'), 'default_capacity_positive', 'T-gcs1a-ck-default-capacity');
  perform public.t_gcs1a_expect(format(base, ', accepted_funding_types', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', array[''cash'']'), 'funding_types_valid', 'T-gcs1a-ck-funding-vocabulary');
  perform public.t_gcs1a_expect(format(base, ', accepted_funding_types', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', array[''direct_payment'']'), 'direct_payment_requires_amount', 'T-gcs1a-ck-direct-payment-needs-amount');
  perform public.t_gcs1a_expect(format(base, ', accepted_funding_types, direct_payment_amount', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', array[''direct_payment''], 0'), 'amount_positive', 'T-gcs1a-ck-direct-payment-amount-positive');
  perform public.t_gcs1a_expect(format(base, ', publicly_discoverable', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', true'), 'discovery_requires_funding', 'T-gcs1a-ck-discovery-needs-funding');
  perform public.t_gcs1a_expect(format(base, ', self_enrollment_allowed, accepted_funding_types', 'x', 'America/New_York', 'array[1]::smallint[]', '4', '60', ', true, array[]::text[]'), 'discovery_requires_funding', 'T-gcs1a-ck-self-enroll-empty-allowlist');
end $$;

-- finite-only: neither / both end boundaries, ends_on before starts_on
select public.t_gcs1a_expect(
  $$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, local_start_time, duration_minutes)
    values ('00000000-0000-0000-0000-000000e00001', 'x', 'UTC', array[1]::smallint[], date '2027-02-01', time '10:00', 60)$$,
  'finite_end_exclusive', 'T-gcs1a-ck-finite-requires-an-end');
select public.t_gcs1a_expect(
  $$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, ends_on, occurrence_count, local_start_time, duration_minutes)
    values ('00000000-0000-0000-0000-000000e00001', 'x', 'UTC', array[1]::smallint[], date '2027-02-01', date '2027-03-01', 4, time '10:00', 60)$$,
  'finite_end_exclusive', 'T-gcs1a-ck-finite-not-both-ends');
select public.t_gcs1a_expect(
  $$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, ends_on, local_start_time, duration_minutes)
    values ('00000000-0000-0000-0000-000000e00001', 'x', 'UTC', array[1]::smallint[], date '2027-02-01', date '2027-01-01', time '10:00', 60)$$,
  'ends_on_after_start', 'T-gcs1a-ck-ends-on-after-start');

-- default instructor / room tenant + assignability
select public.t_gcs1a_expect(
  $$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, occurrence_count, local_start_time, duration_minutes, default_instructor_id)
    values ('00000000-0000-0000-0000-000000e00001', 'x', 'UTC', array[1]::smallint[], date '2027-02-01', 4, time '10:00', 60, '00000000-0000-0000-0000-000000e20003')$$,
  'no longer available', 'T-gcs1a-trigger-default-instructor-other-studio');
select public.t_gcs1a_expect(
  $$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, occurrence_count, local_start_time, duration_minutes, default_instructor_id)
    values ('00000000-0000-0000-0000-000000e00001', 'x', 'UTC', array[1]::smallint[], date '2027-02-01', 4, time '10:00', 60, '00000000-0000-0000-0000-000000e20004')$$,
  'no longer available', 'T-gcs1a-trigger-default-instructor-not-assignable');
select public.t_gcs1a_expect(
  $$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, occurrence_count, local_start_time, duration_minutes, default_room_id)
    values ('00000000-0000-0000-0000-000000e00001', 'x', 'UTC', array[1]::smallint[], date '2027-02-01', 4, time '10:00', 60, '00000000-0000-0000-0000-000000e30003')$$,
  'default room does not belong', 'T-gcs1a-trigger-default-room-other-studio');

-- studio immutable, updated_at maintained
select public.t_gcs1a_expect(
  $$update public.group_class_series set studio_id = '00000000-0000-0000-0000-000000e00002' where id = '00000000-0000-0000-0000-000000e50001'$$,
  'cannot be changed', 'T-gcs1a-trigger-series-studio-immutable');

do $$
declare v_after timestamptz;
begin
  -- the set_updated_at trigger overrides an explicit stale value with now()
  update public.group_class_series set description = 'touched', updated_at = timestamptz '2000-01-01 00:00:00+00'
    where id = '00000000-0000-0000-0000-000000e50001';
  select updated_at into v_after from public.group_class_series where id = '00000000-0000-0000-0000-000000e50001';
  if v_after <> now() then raise exception 'FAIL T-gcs1a-updated-at-maintained: %', v_after; end if;
  perform public.t_gcs1a_pass('T-gcs1a-updated-at-maintained');
end $$;

-- ============================================================================
-- 3. Appointments: standalone classes + private-lesson recurrence unaffected
-- ============================================================================
insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-000000e40001', '00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour');

insert into public.appointments (
  id, studio_id, appointment_type, status, starts_at, ends_at,
  recurrence_series_id, recurrence_frequency, recurrence_interval, recurrence_count
) values
  ('00000000-0000-0000-0000-000000e40002', '00000000-0000-0000-0000-000000e00001', 'private_lesson', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour',
   '00000000-0000-0000-0000-000000e4ffff', 'weekly', 1, 4);

do $$
declare r record;
begin
  select * into r from public.appointments where id = '00000000-0000-0000-0000-000000e40001';
  if r.group_class_series_id is not null or r.series_occurrence_index is not null or r.occurrence_original_start is not null
     or cardinality(r.series_overridden_fields) <> 0 then
    raise exception 'FAIL T-gcs1a-standalone-class-no-series';
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-standalone-group-class-remains-valid');

  select * into r from public.appointments where id = '00000000-0000-0000-0000-000000e40002';
  if r.recurrence_series_id is distinct from '00000000-0000-0000-0000-000000e4ffff'::uuid
     or r.recurrence_frequency <> 'weekly' or r.group_class_series_id is not null then
    raise exception 'FAIL T-gcs1a-private-lesson-recurrence';
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-private-lesson-recurrence-columns-untouched');
end $$;

-- ============================================================================
-- 4. Occurrence integrity (as the migration owner, i.e. a definer-equivalent writer)
-- ============================================================================
insert into public.appointments (
  id, studio_id, appointment_type, status, starts_at, ends_at,
  group_class_series_id, series_occurrence_index, occurrence_original_start, title, instructor_id, room_id, roster_capacity
) values
  ('00000000-0000-0000-0000-000000e41001', '00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour',
   '00000000-0000-0000-0000-000000e50001', 1, now() + interval '10 days', 'Salsa Level 1', '00000000-0000-0000-0000-000000e20001', '00000000-0000-0000-0000-000000e30001', 12),
  ('00000000-0000-0000-0000-000000e41002', '00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '17 days', now() + interval '17 days 1 hour',
   '00000000-0000-0000-0000-000000e50001', 2, now() + interval '17 days', 'Salsa Level 1', '00000000-0000-0000-0000-000000e20002', '00000000-0000-0000-0000-000000e30001', 12);

select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, group_class_series_id, series_occurrence_index, occurrence_original_start)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour',
            '00000000-0000-0000-0000-000000e50001', 1, now() + interval '24 days')$$,
  'uq_appointments_series_occurrence', 'T-gcs1a-unique-occurrence-index');
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, group_class_series_id)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour',
            '00000000-0000-0000-0000-000000e50001')$$,
  'series_fields_all_or_none', 'T-gcs1a-all-or-none-series-without-index');
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, series_occurrence_index)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour', 3)$$,
  'series_fields_all_or_none', 'T-gcs1a-all-or-none-index-without-series');
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, series_overridden_fields)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour', array['title'])$$,
  'series_fields_all_or_none', 'T-gcs1a-all-or-none-overrides-without-series');
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, group_class_series_id, series_occurrence_index, occurrence_original_start, series_overridden_fields)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour',
            '00000000-0000-0000-0000-000000e50001', 9, now() + interval '24 days', array['price'])$$,
  'series_overridden_fields_valid', 'T-gcs1a-override-vocabulary');
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, group_class_series_id, series_occurrence_index, occurrence_original_start)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour',
            '00000000-0000-0000-0000-000000e50001', 0, now() + interval '24 days')$$,
  'occurrence_index_positive', 'T-gcs1a-occurrence-index-positive');

-- tenant integrity: cross-studio attachment fails at the database layer
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, group_class_series_id, series_occurrence_index, occurrence_original_start)
    values ('00000000-0000-0000-0000-000000e00002', 'group_class', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour',
            '00000000-0000-0000-0000-000000e50001', 5, now() + interval '24 days')$$,
  'appointments_group_class_series_fk', 'T-gcs1a-fk-cross-studio-insert-rejected');
select public.t_gcs1a_expect(
  $$update public.appointments set studio_id = '00000000-0000-0000-0000-000000e00002', instructor_id = null where id = '00000000-0000-0000-0000-000000e41001'$$,
  'appointments_group_class_series_fk', 'T-gcs1a-fk-cross-studio-update-rejected');

-- series membership is group_class-only (shape trigger)
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, group_class_series_id, series_occurrence_index, occurrence_original_start)
    values ('00000000-0000-0000-0000-000000e00001', 'private_lesson', 'scheduled', now() + interval '24 days', now() + interval '24 days 1 hour',
            '00000000-0000-0000-0000-000000e50001', 6, now() + interval '24 days')$$,
  'Only a group class may belong to a group-class series', 'T-gcs1a-shape-series-only-on-group-class');

-- FK RESTRICT: a series with occurrences cannot be deleted
select public.t_gcs1a_expect(
  $$delete from public.group_class_series where id = '00000000-0000-0000-0000-000000e50001'$$,
  'appointments_group_class_series_fk', 'T-gcs1a-fk-restrict-delete');

-- pre-existing shape rules preserved verbatim
select public.t_gcs1a_expect(
  $$update public.appointments set price_amount = 10 where id = '00000000-0000-0000-0000-000000e40001'$$,
  'shared group class cannot carry', 'T-gcs1a-shape-existing-group-class-no-price');
select public.t_gcs1a_expect(
  $$update public.appointments set roster_capacity = 5 where id = '00000000-0000-0000-0000-000000e40002'$$,
  'Only a group class may carry a roster capacity', 'T-gcs1a-shape-existing-capacity-group-class-only');
select public.t_gcs1a_expect(
  $$update public.appointments set appointment_type = 'private_lesson' where id = '00000000-0000-0000-0000-000000e40001'$$,
  'cannot be changed to or from group_class', 'T-gcs1a-shape-existing-type-change-blocked');

-- ============================================================================
-- 5. Direct-write guard + override tracking (tenant role)
-- ============================================================================
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
end $$;

select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, group_class_series_id, series_occurrence_index, occurrence_original_start)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '30 days', now() + interval '30 days 1 hour',
            '00000000-0000-0000-0000-000000e50001', 20, now() + interval '30 days')$$,
  'series workflow', 'T-gcs1a-guard-direct-insert-cannot-attach-series');
select public.t_gcs1a_expect(
  $$insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, series_overridden_fields)
    values ('00000000-0000-0000-0000-000000e00001', 'group_class', 'scheduled', now() + interval '30 days', now() + interval '30 days 1 hour', array['title'])$$,
  'series workflow', 'T-gcs1a-guard-direct-insert-cannot-seed-overrides');
select public.t_gcs1a_expect(
  $$update public.appointments set group_class_series_id = '00000000-0000-0000-0000-000000e50001', series_occurrence_index = 7, occurrence_original_start = starts_at
    where id = '00000000-0000-0000-0000-000000e40001'$$,
  'series workflow', 'T-gcs1a-guard-direct-update-cannot-attach-series');
select public.t_gcs1a_expect(
  $$update public.appointments set series_occurrence_index = 99 where id = '00000000-0000-0000-0000-000000e41001'$$,
  'series workflow', 'T-gcs1a-guard-direct-update-cannot-change-index');
select public.t_gcs1a_expect(
  $$update public.appointments set occurrence_original_start = now() where id = '00000000-0000-0000-0000-000000e41001'$$,
  'series workflow', 'T-gcs1a-guard-direct-update-cannot-change-original-start');
select public.t_gcs1a_expect(
  $$update public.appointments set group_class_series_id = null, series_occurrence_index = null, occurrence_original_start = null where id = '00000000-0000-0000-0000-000000e41001'$$,
  'series workflow', 'T-gcs1a-guard-direct-update-cannot-detach-series');

-- override tracking on occurrence e41001 (instructor e20001 / room e30001 / capacity 12)
do $$
declare
  v_id uuid := '00000000-0000-0000-0000-000000e41001';
  v text[];
  v_start timestamptz;
begin
  -- no-op writes: nothing tracked (same values, blank-vs-null, whitespace-only title diff, status change)
  update public.appointments set title = title, location_name = '', notes = 'n' where id = v_id;
  update public.appointments set title = '  ' || title || ' ' where id = v_id;
  update public.appointments set status = 'confirmed' where id = v_id;
  select series_overridden_fields into v from public.appointments where id = v_id;
  if cardinality(v) <> 0 then raise exception 'FAIL T-gcs1a-track-noop-writes: %', v; end if;
  perform public.t_gcs1a_pass('T-gcs1a-track-noop-writes-not-overrides');

  update public.appointments set title = 'Salsa Level 1 (Special)' where id = v_id;
  select series_overridden_fields into v from public.appointments where id = v_id;
  if v <> array['title'] then raise exception 'FAIL T-gcs1a-track-title: %', v; end if;
  perform public.t_gcs1a_pass('T-gcs1a-track-title');

  update public.appointments set instructor_id = '00000000-0000-0000-0000-000000e20002' where id = v_id;
  update public.appointments set room_id = '00000000-0000-0000-0000-000000e30002' where id = v_id;
  update public.appointments set location_name = 'Off-site hall' where id = v_id;
  update public.appointments set roster_capacity = 8 where id = v_id;
  select starts_at into v_start from public.appointments where id = v_id;
  update public.appointments set starts_at = v_start + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = v_id;
  select series_overridden_fields into v from public.appointments where id = v_id;
  if v <> array['title', 'instructor', 'room', 'location', 'capacity', 'time'] then
    raise exception 'FAIL T-gcs1a-track-all-fields: %', v;
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-track-instructor-room-location-capacity-time-in-order');

  -- repeated real changes do not duplicate entries
  update public.appointments set title = 'Salsa Level 1 (Special 2)', roster_capacity = 9 where id = v_id;
  select series_overridden_fields into v from public.appointments where id = v_id;
  if cardinality(v) <> 6 then raise exception 'FAIL T-gcs1a-track-no-duplicates: %', v; end if;
  perform public.t_gcs1a_pass('T-gcs1a-track-no-duplicate-entries');

  -- a direct write cannot remove or replace entries
  update public.appointments set series_overridden_fields = '{}'::text[] where id = v_id;
  select series_overridden_fields into v from public.appointments where id = v_id;
  if cardinality(v) <> 6 then raise exception 'FAIL T-gcs1a-track-cannot-clear: %', v; end if;
  update public.appointments set series_overridden_fields = array['room']::text[] where id = v_id;
  select series_overridden_fields into v from public.appointments where id = v_id;
  if cardinality(v) <> 6 then raise exception 'FAIL T-gcs1a-track-cannot-replace: %', v; end if;
  perform public.t_gcs1a_pass('T-gcs1a-track-direct-write-cannot-remove-entries');
end $$;

-- a standalone class never accumulates overrides, even if the client tries
do $$
declare v text[];
begin
  update public.appointments set title = 'Standalone', series_overridden_fields = array['title']::text[]
    where id = '00000000-0000-0000-0000-000000e40001';
  select series_overridden_fields into v from public.appointments where id = '00000000-0000-0000-0000-000000e40001';
  if cardinality(v) <> 0 then raise exception 'FAIL T-gcs1a-standalone-no-overrides: %', v; end if;
  perform public.t_gcs1a_pass('T-gcs1a-standalone-class-never-tracked');
end $$;

reset role;

-- ============================================================================
-- 6. Definer writers (the future series RPCs) are neither guarded nor tracked
-- ============================================================================
create function public.t_gcs1a_definer_propagate(p_id uuid)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  update public.appointments
     set title = 'Propagated title', instructor_id = '00000000-0000-0000-0000-000000e20001',
         roster_capacity = 20, series_occurrence_index = series_occurrence_index
   where id = p_id;
end;
$$;
grant execute on function public.t_gcs1a_definer_propagate(uuid) to authenticated;

do $$
declare v text[];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
  perform public.t_gcs1a_definer_propagate('00000000-0000-0000-0000-000000e41002');
  reset role;
  select series_overridden_fields into v from public.appointments where id = '00000000-0000-0000-0000-000000e41002';
  if cardinality(v) <> 0 then raise exception 'FAIL T-gcs1a-definer-not-tracked: %', v; end if;
  if (select title from public.appointments where id = '00000000-0000-0000-0000-000000e41002') <> 'Propagated title' then
    raise exception 'FAIL T-gcs1a-definer-write-applied';
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-definer-propagation-not-marked-as-override');
end $$;

-- ============================================================================
-- 7. RLS / grants
-- ============================================================================
do $$
declare v_priv text;
begin
  if has_table_privilege('authenticated', 'public.group_class_series', 'INSERT')
     or has_table_privilege('authenticated', 'public.group_class_series', 'UPDATE')
     or has_table_privilege('authenticated', 'public.group_class_series', 'DELETE')
     or has_table_privilege('authenticated', 'public.group_class_series', 'TRUNCATE') then
    raise exception 'FAIL T-gcs1a-grants-authenticated-has-write';
  end if;
  if not has_table_privilege('authenticated', 'public.group_class_series', 'SELECT') then
    raise exception 'FAIL T-gcs1a-grants-authenticated-select-missing';
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-grants-authenticated-select-only');

  if has_table_privilege('anon', 'public.group_class_series', 'SELECT')
     or has_table_privilege('anon', 'public.group_class_series', 'INSERT') then
    raise exception 'FAIL T-gcs1a-grants-anon';
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-grants-anon-none');

  if not (select relrowsecurity from pg_class where oid = 'public.group_class_series'::regclass) then
    raise exception 'FAIL T-gcs1a-rls-enabled';
  end if;
  if (select count(*) from pg_policy where polrelid = 'public.group_class_series'::regclass) <> 1
     or (select polcmd from pg_policy where polrelid = 'public.group_class_series'::regclass) <> 'r' then
    raise exception 'FAIL T-gcs1a-policies-select-only';
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-rls-enabled-with-single-select-policy');
end $$;

-- Visibility matrix. S1 (e50001, studio A) default instructor = e20001 (user e10002),
-- occurrence e41001 currently assigned to e20002 (user e10003); S2 (e50002) is studio B.
do $$
declare
  procedure_name text;
  r record;
  v_a int; v_b int;
begin
  for r in
    select * from (values
      ('owner-a',          '00000000-0000-0000-0000-000000e10001'::uuid, 1, 0),
      ('front-desk-a',     '00000000-0000-0000-0000-000000e10004'::uuid, 1, 0),
      ('default-instr-a',  '00000000-0000-0000-0000-000000e10002'::uuid, 1, 0),
      ('occurrence-instr', '00000000-0000-0000-0000-000000e10003'::uuid, 1, 0),
      ('unassigned-instr', '00000000-0000-0000-0000-000000e10009'::uuid, 0, 0),
      ('owner-b',          '00000000-0000-0000-0000-000000e10005'::uuid, 0, 1),
      ('instructor-b',     '00000000-0000-0000-0000-000000e10008'::uuid, 0, 0),
      ('unrelated',        '00000000-0000-0000-0000-000000e10006'::uuid, 0, 0),
      ('platform-admin',   '00000000-0000-0000-0000-000000e10007'::uuid, 1, 1)
    ) as t(label, uid, exp_a, exp_b)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid)::text, true);
    set local role authenticated;
    select count(*) into v_a from public.group_class_series where id = '00000000-0000-0000-0000-000000e50001';
    select count(*) into v_b from public.group_class_series where id = '00000000-0000-0000-0000-000000e50002';
    reset role;
    if v_a <> r.exp_a or v_b <> r.exp_b then
      raise exception 'FAIL T-gcs1a-rls-visibility %: A saw % (expected %), B saw % (expected %)', r.label, v_a, r.exp_a, v_b, r.exp_b;
    end if;
    perform public.t_gcs1a_pass('T-gcs1a-rls-visibility-' || r.label);
  end loop;
end $$;

-- No tenant writes, even for the studio owner (privilege layer, then no policy).
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  set local role authenticated;
end $$;
select public.t_gcs1a_expect(
  $$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, occurrence_count, local_start_time, duration_minutes)
    values ('00000000-0000-0000-0000-000000e00001', 'x', 'UTC', array[1]::smallint[], date '2027-02-01', 4, time '10:00', 60)$$,
  'permission denied', 'T-gcs1a-no-tenant-insert');
select public.t_gcs1a_expect(
  $$update public.group_class_series set title = 'hijack' where id = '00000000-0000-0000-0000-000000e50001'$$,
  'permission denied', 'T-gcs1a-no-tenant-update');
select public.t_gcs1a_expect(
  $$delete from public.group_class_series where id = '00000000-0000-0000-0000-000000e50001'$$,
  'permission denied', 'T-gcs1a-no-tenant-delete');
reset role;

do $$ begin
  set local role anon;
end $$;
select public.t_gcs1a_expect(
  $$select count(*) from public.group_class_series$$, 'permission denied', 'T-gcs1a-anon-cannot-read');
reset role;

-- ============================================================================
-- 8. Function security modes / execute grants
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select p.proname, p.prosecdef, p.proconfig::text as cfg
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('enforce_group_class_series_shape', '_guard_appointments_group_class_series_fields', 'enforce_group_class_canonical_shape')
  loop
    if r.proname = '_guard_appointments_group_class_series_fields' and r.prosecdef then
      raise exception 'FAIL T-gcs1a-guard-fn-must-be-invoker';
    end if;
    if r.proname <> '_guard_appointments_group_class_series_fields' and not r.prosecdef then
      raise exception 'FAIL T-gcs1a-fn-must-be-definer: %', r.proname;
    end if;
    if coalesce(r.cfg, '') not like '%search_path=public%' then
      raise exception 'FAIL T-gcs1a-fn-search-path: %', r.proname;
    end if;
    if has_function_privilege('anon', ('public.' || r.proname || '()')::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', ('public.' || r.proname || '()')::regprocedure, 'EXECUTE')
       or has_function_privilege('service_role', ('public.' || r.proname || '()')::regprocedure, 'EXECUTE') then
      raise exception 'FAIL T-gcs1a-fn-execute-grants: %', r.proname;
    end if;
    perform public.t_gcs1a_pass('T-gcs1a-fn-security-' || r.proname);
  end loop;
end $$;

-- trigger ordering: the new guard sorts right after the existing _00_ guard
do $$
declare v text;
begin
  select string_agg(tgname, ',' order by tgname) into v
  from pg_trigger
  where tgrelid = 'public.appointments'::regclass and not tgisinternal and tgtype & 2 = 2;  -- BEFORE row triggers
  if position('appointments_00_guard_floor_rental_financial_fields,appointments_01_guard_group_class_series,' in v) <> 1 then
    raise exception 'FAIL T-gcs1a-trigger-order: %', v;
  end if;
  perform public.t_gcs1a_pass('T-gcs1a-trigger-order-before-triggers');
end $$;

-- ============================================================================
-- 9. Report, then roll everything back.
-- ============================================================================
select count(*) as passes, string_agg(msg, E'
' order by n) as detail from public.t_gcs1a_log;

rollback;
