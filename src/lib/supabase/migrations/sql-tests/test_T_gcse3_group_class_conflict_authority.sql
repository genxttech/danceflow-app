-- GC-S1E-3 -- Group-class conflict authority, live-Postgres regression suite for
-- 20261023090000_gcse3_group_class_conflict_authority.sql.
--
-- Proves, as real tenant roles:
--   * one shared rule (_gcse3_schedule_conflict): instructor overlap, instructor schedule block, room unavailable,
--     exclusive room, room simultaneous-booking PEAK capacity (not a pairwise count), cancelled / no-show excluded,
--     back-to-back allowed, self-exclusion on edit, no client-overlap rule for classes, studio-scoped;
--   * one-time class create (create_group_class_appointment) and series create (create_group_class_series) refuse a
--     conflict atomically (no series row, no occurrence, no policy row), skipped dates are exempt, replay still works;
--   * the direct single-occurrence edit is refused by the database on conflict (whole statement rolled back), allows a
--     move into free time / a different instructor or room, excludes itself, ignores edits that do not touch
--     instructor / room / time, keeps the released authority (assigned instructor may edit their own class, another
--     studio cannot) and the S1A override tracking;
--   * S1C-5 uses the shared rule (instructor, block, room capacity), refuses atomically, and still splits normally;
--   * the new helpers are internal (no grants, SECURITY DEFINER, fixed search_path); the replaced RPCs keep their grants;
--     the direct-write triggers govern only anon / authenticated statements.
-- Concurrency is proven separately by concurrency/run_gcse3_concurrency.sh.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261023090000 is applied. UUID block ...0000e5e3....

begin;

create table public.t_gcse3_log (n serial, msg text);
grant all on public.t_gcse3_log to public;
grant usage on sequence public.t_gcse3_log_n_seq to public;
create function public.t_gcse3_pass(p text) returns void language sql as $$ insert into public.t_gcse3_log (msg) values (p) $$;
grant execute on function public.t_gcse3_pass(text) to public;

create function public.t_gcse3_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcse3_pass(p_label);
end;
$$;
grant execute on function public.t_gcse3_assert(text, text, text) to public;

-- ids by label: users, instructors, rooms, clients, studios
create function public.t_gcse3_id(p text) returns uuid language sql immutable as $x$
  select case p
    when 'S'    then '00000000-0000-0000-0000-0000e5e30001'
    when 'SB'   then '00000000-0000-0000-0000-0000e5e30002'
    when 'OWN'  then '00000000-0000-0000-0000-0000e5e31001'
    when 'FD'   then '00000000-0000-0000-0000-0000e5e31002'
    when 'INS'  then '00000000-0000-0000-0000-0000e5e31003'
    when 'INS2' then '00000000-0000-0000-0000-0000e5e31004'
    when 'INS3' then '00000000-0000-0000-0000-0000e5e31005'
    when 'OWB'  then '00000000-0000-0000-0000-0000e5e31006'
    when 'INB'  then '00000000-0000-0000-0000-0000e5e31007'
    when 'I1'   then '00000000-0000-0000-0000-0000e5e32001'
    when 'I2'   then '00000000-0000-0000-0000-0000e5e32002'
    when 'I3'   then '00000000-0000-0000-0000-0000e5e32003'
    when 'IB'   then '00000000-0000-0000-0000-0000e5e32004'
    when 'C1'   then '00000000-0000-0000-0000-0000e5e33001'
    when 'R1'   then '00000000-0000-0000-0000-0000e5e39001'
    when 'R2'   then '00000000-0000-0000-0000-0000e5e39002'
    when 'R3'   then '00000000-0000-0000-0000-0000e5e39003'
    when 'RB'   then '00000000-0000-0000-0000-0000e5e39004'
  end::uuid
$x$;
grant execute on function public.t_gcse3_id(text) to public;

-- an instant: day offset (from current_date + 40) at HH:MI UTC
create function public.t_gcse3_t(p_day integer, p_hm text) returns timestamptz language sql stable as $x$
  select ((current_date + 40 + p_day)::text || ' ' || p_hm)::timestamp at time zone 'UTC'
$x$;
grant execute on function public.t_gcse3_t(integer, text) to public;

-- recorded class ids by label
create table public.t_gcse3_c (label text primary key, id uuid);
grant all on public.t_gcse3_c to public;
create function public.t_gcse3_cid(p_label text) returns uuid language sql stable security definer set search_path = 'public' as $x$
  select id from public.t_gcse3_c where label = p_label
$x$;
grant execute on function public.t_gcse3_cid(text) to public;

create function public.t_gcse3_as(p_who text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcse3_id(p_who))::text, true);
  set local role authenticated;
end $$;
grant execute on function public.t_gcse3_as(text) to public;

-- one-time class through the released RPC, as a user; records the id under p_label (when given)
create function public.t_gcse3_mk(p_label text, p_who text, p_ins text, p_room text, p_day integer, p_from text, p_to text)
returns uuid language plpgsql as $$
declare v uuid;
begin
  perform public.t_gcse3_as(p_who);
  v := public.create_group_class_appointment(
    public.t_gcse3_id('S'), public.t_gcse3_id(p_ins), public.t_gcse3_id(p_room), coalesce(p_label, 'class'),
    public.t_gcse3_t(p_day, p_from), public.t_gcse3_t(p_day, p_to));
  reset role;
  if p_label is not null then
    insert into public.t_gcse3_c (label, id) values (p_label, v);
  end if;
  return v;
end $$;
grant execute on function public.t_gcse3_mk(text, text, text, text, integer, text, text) to public;

-- a direct update of one appointment as a user (what the single-occurrence edit does); returns rows updated
create function public.t_gcse3_upd(p_who text, p_id uuid, p_set text) returns integer language plpgsql as $$
declare v integer;
begin
  perform public.t_gcse3_as(p_who);
  execute format('update public.appointments set %s where id = %L', p_set, p_id);
  get diagnostics v = row_count;
  reset role;
  return v;
end $$;
grant execute on function public.t_gcse3_upd(text, uuid, text) to public;

-- run a statement and expect an error containing p_like; the role is always reset
create function public.t_gcse3_expect(p_sql text, p_like text, p_label text)
returns void language plpgsql as $$
declare v_failed boolean := false; v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_failed := true; v_err := sqlerrm;
  end;
  reset role;
  if not v_failed then
    raise exception 'FAIL %: expected an error containing [%], statement succeeded', p_label, p_like;
  end if;
  if position(lower(p_like) in lower(v_err)) = 0 then
    raise exception 'FAIL %: expected error containing [%], got [%]', p_label, p_like, v_err;
  end if;
  perform public.t_gcse3_pass(p_label);
end;
$$;
grant execute on function public.t_gcse3_expect(text, text, text) to public;

create function public.t_gcse3_ok(p_sql text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    reset role;
    raise exception 'FAIL %: expected success, got [%]', p_label, sqlerrm;
  end;
  reset role;
  perform public.t_gcse3_pass(p_label);
end;
$$;
grant execute on function public.t_gcse3_ok(text, text) to public;

-- the exact refusal text (no other studio's or booking's details)
create function public.t_gcse3_err(p_sql text) returns text language plpgsql as $$
declare v_err text := null;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
  end;
  reset role;
  return coalesce(v_err, 'NO ERROR');
end;
$$;
grant execute on function public.t_gcse3_err(text) to public;

-- series create through the released RPC, as a user (weekday, local hour, occurrences, skipped indexes)
create function public.t_gcse3_series(p_who text, p_req text, p_title text, p_ins text, p_room text, p_weekday integer,
  p_hour integer, p_count integer, p_skip integer[] default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform public.t_gcse3_as(p_who);
  v := public.create_group_class_series(
    p_studio_id => public.t_gcse3_id('S'), p_client_request_id => p_req::uuid,
    p_title => p_title, p_description => null,
    p_instructor_id => public.t_gcse3_id(p_ins), p_room_id => public.t_gcse3_id(p_room), p_location_name => null,
    p_roster_capacity => null,
    p_weekdays => array[p_weekday]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 60), p_ends_on => null,
    p_occurrence_count => p_count, p_local_start_time => make_time(p_hour, 0, 0), p_duration_minutes => 60,
    p_skip_indices => p_skip);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcse3_series(text, text, text, text, text, integer, integer, integer, integer[]) to public;

-- the instant of occurrence p_idx of such a series (same generator as the RPC)
create function public.t_gcse3_occ_at(p_weekday integer, p_hour integer, p_count integer, p_idx integer) returns timestamptz
language sql stable security definer set search_path = 'public' as $x$
  select g.starts_at from public._gcsb1_generate_series_occurrences(
    'America/New_York', array[p_weekday]::smallint[], 1, current_date + 60, null, p_count, make_time(p_hour, 0, 0), 60) g
  where g.occurrence_index = p_idx
$x$;
grant execute on function public.t_gcse3_occ_at(integer, integer, integer, integer) to public;

-- S1C-5 apply as a user, on occurrence p_idx of a series
create function public.t_gcse3_s1c5(p_who text, p_series uuid, p_idx integer, p_req text, p_changes jsonb) returns jsonb
language plpgsql as $$
declare v jsonb; v_id uuid;
begin
  select a.id into v_id from public.appointments a where a.group_class_series_id = p_series and a.series_occurrence_index = p_idx;
  perform public.t_gcse3_as(p_who);
  v := public.edit_group_class_series_from(v_id, p_req::uuid, p_changes, false);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcse3_s1c5(text, uuid, integer, text, jsonb) to public;

-- instructor label of every occurrence of a series lineage that started as p_series, by index (I1/I2/I3/-)
create function public.t_gcse3_ins_by_idx(p_title text) returns text language sql stable security definer set search_path = 'public' as $x$
  select string_agg(a.series_occurrence_index || ':' || case a.instructor_id
    when public.t_gcse3_id('I1') then 'I1' when public.t_gcse3_id('I2') then 'I2' when public.t_gcse3_id('I3') then 'I3' else '-' end,
    ',' order by a.series_occurrence_index)
  from public.appointments a
  join public.group_class_series s on s.id = a.group_class_series_id
  where s.studio_id = public.t_gcse3_id('S') and (s.title = p_title or s.split_from_series_id in (select id from public.group_class_series where title = p_title))
$x$;
grant execute on function public.t_gcse3_ins_by_idx(text) to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-0000e5e30001', 'GC-S1E-3 Harness Studio A', 't-gcse3-a', 'America/New_York'),
  ('00000000-0000-0000-0000-0000e5e30002', 'GC-S1E-3 Harness Studio B', 't-gcse3-b', 'America/New_York');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000e5e31001', 't-gcse3-owner@example.test'),
  ('00000000-0000-0000-0000-0000e5e31002', 't-gcse3-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000e5e31003', 't-gcse3-instructor1@example.test'),
  ('00000000-0000-0000-0000-0000e5e31004', 't-gcse3-instructor2@example.test'),
  ('00000000-0000-0000-0000-0000e5e31005', 't-gcse3-instructor3@example.test'),
  ('00000000-0000-0000-0000-0000e5e31006', 't-gcse3-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000e5e31007', 't-gcse3-instructor-b@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000e5e31001', 't-gcse3-owner@example.test', null),
  ('00000000-0000-0000-0000-0000e5e31002', 't-gcse3-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-0000e5e31003', 't-gcse3-instructor1@example.test', null),
  ('00000000-0000-0000-0000-0000e5e31004', 't-gcse3-instructor2@example.test', null),
  ('00000000-0000-0000-0000-0000e5e31005', 't-gcse3-instructor3@example.test', null),
  ('00000000-0000-0000-0000-0000e5e31006', 't-gcse3-owner-b@example.test', null),
  ('00000000-0000-0000-0000-0000e5e31007', 't-gcse3-instructor-b@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000e5e31001', '00000000-0000-0000-0000-0000e5e30001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000e5e31002', '00000000-0000-0000-0000-0000e5e30001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000e5e31003', '00000000-0000-0000-0000-0000e5e30001', 'instructor', true),
  ('00000000-0000-0000-0000-0000e5e31004', '00000000-0000-0000-0000-0000e5e30001', 'instructor', true),
  ('00000000-0000-0000-0000-0000e5e31005', '00000000-0000-0000-0000-0000e5e30001', 'instructor', true),
  ('00000000-0000-0000-0000-0000e5e31006', '00000000-0000-0000-0000-0000e5e30002', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000e5e31007', '00000000-0000-0000-0000-0000e5e30002', 'instructor', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-0000e5e32001', '00000000-0000-0000-0000-0000e5e30001', '00000000-0000-0000-0000-0000e5e31003', 'One', 'Instructor', true, true),
  ('00000000-0000-0000-0000-0000e5e32002', '00000000-0000-0000-0000-0000e5e30001', '00000000-0000-0000-0000-0000e5e31004', 'Two', 'Instructor', true, true),
  ('00000000-0000-0000-0000-0000e5e32003', '00000000-0000-0000-0000-0000e5e30001', '00000000-0000-0000-0000-0000e5e31005', 'Three', 'Instructor', true, true),
  ('00000000-0000-0000-0000-0000e5e32004', '00000000-0000-0000-0000-0000e5e30002', '00000000-0000-0000-0000-0000e5e31007', 'Other', 'Studio', true, true);
alter table public.instructors enable trigger user;
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-0000e5e33001', '00000000-0000-0000-0000-0000e5e30001', 'C', 'One', 'active', false);
insert into public.rooms (id, studio_id, name, active, max_simultaneous_bookings) values
  ('00000000-0000-0000-0000-0000e5e39001', '00000000-0000-0000-0000-0000e5e30001', 'S1E3 shared room (2)', true, 2),
  ('00000000-0000-0000-0000-0000e5e39002', '00000000-0000-0000-0000-0000e5e30001', 'S1E3 open room', true, null),
  ('00000000-0000-0000-0000-0000e5e39003', '00000000-0000-0000-0000-0000e5e30001', 'S1E3 single room (1)', true, 1),
  ('00000000-0000-0000-0000-0000e5e39004', '00000000-0000-0000-0000-0000e5e30002', 'S1E3 other studio room', true, 1);

-- ============================================================================
-- SECURITY / SHAPE
-- ============================================================================
select public.t_gcse3_assert('T-gcse3-helpers-internal-no-grants',
  (select string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'execute')::text || '/'
     || has_function_privilege('authenticated', p.oid, 'execute')::text || '/' || has_function_privilege('service_role', p.oid, 'execute')::text, ',' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('_gcse3_schedule_conflict', '_gcse3_lock_resources', '_gcse3_guard_direct_class_schedule', '_gcsc5_edit_conflict')),
  '_gcsc5_edit_conflict:false/false/false,_gcse3_guard_direct_class_schedule:false/false/false,_gcse3_lock_resources:false/false/false,_gcse3_schedule_conflict:false/false/false');
select public.t_gcse3_assert('T-gcse3-helpers-definer-fixed-search-path',
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=public'])::text
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('_gcse3_schedule_conflict', '_gcse3_lock_resources', '_gcse3_guard_direct_class_schedule',
     'create_group_class_appointment', 'create_group_class_series', 'edit_group_class_series_from')), 'true');
select public.t_gcse3_assert('T-gcse3-replaced-rpcs-keep-grants',
  (select string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'execute')::text || '/'
     || has_function_privilege('authenticated', p.oid, 'execute')::text || '/' || has_function_privilege('service_role', p.oid, 'execute')::text, ',' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('create_group_class_appointment', 'create_group_class_series', 'edit_group_class_series_from')),
  'create_group_class_appointment:false/true/false,create_group_class_series:false/true/false,edit_group_class_series_from:false/true/false');
select public.t_gcse3_assert('T-gcse3-s1c5-uses-shared-rule-and-locks',
  (select (pg_get_functiondef('public.edit_group_class_series_from(uuid, uuid, jsonb, boolean)'::regprocedure) like '%_gcse3_schedule_conflict(%'
       and pg_get_functiondef('public.edit_group_class_series_from(uuid, uuid, jsonb, boolean)'::regprocedure) like '%_gcse3_lock_resources(%'
       and pg_get_functiondef('public.edit_group_class_series_from(uuid, uuid, jsonb, boolean)'::regprocedure) not like '%_gcsc5_edit_conflict(%'
       and pg_get_functiondef('public._gcsc5_edit_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz)'::regprocedure) like '%_gcse3_schedule_conflict(%')::text),
  'true');
select public.t_gcse3_assert('T-gcse3-direct-write-triggers-statement-level-role-gated',
  (select string_agg(t.tgname || ':' || (pg_get_triggerdef(t.oid) like '%FOR EACH STATEMENT WHEN ((CURRENT_USER = ANY (ARRAY[''anon''::name, ''authenticated''::name])))%')::text, ',' order by t.tgname)
   from pg_trigger t where t.tgrelid = 'public.appointments'::regclass and t.tgname like 'appointments_gcse3_direct_%'),
  'appointments_gcse3_direct_class_schedule_insert:true,appointments_gcse3_direct_class_schedule_update:true');
select public.t_gcse3_expect(
  $s$select public.t_gcse3_as('OWN'); select public._gcse3_schedule_conflict('00000000-0000-0000-0000-0000e5e30001', null, null, null, now(), now() + interval '1 hour', false)$s$,
  'permission denied', 'T-gcse3-authenticated-cannot-call-rule-directly');
select public.t_gcse3_expect(
  $s$select public.t_gcse3_as('OWN'); select public._gcse3_lock_resources(array['00000000-0000-0000-0000-0000e5e32001'::uuid], null)$s$,
  'permission denied', 'T-gcse3-authenticated-cannot-call-lock-directly');

-- ============================================================================
-- AUTHORITY (one-time create)
-- ============================================================================
select public.t_gcse3_ok($s$select public.t_gcse3_mk('A1', 'OWN', 'I1', null, 0, '10:00', '11:00')$s$, 'T-gcse3-owner-creates-class');
select public.t_gcse3_ok($s$select public.t_gcse3_mk('A2', 'FD', 'I2', null, 0, '10:00', '11:00')$s$, 'T-gcse3-front-desk-creates-class-other-instructor-same-time');
select public.t_gcse3_expect($s$select public.t_gcse3_mk(null, 'OWB', 'I3', null, 0, '12:00', '13:00')$s$, 'Not authorized', 'T-gcse3-other-studio-owner-cannot-create');
select public.t_gcse3_expect($s$select public.t_gcse3_mk(null, 'INS', 'I1', null, 0, '14:00', '15:00')$s$, 'Not authorized', 'T-gcse3-instructor-cannot-create-class');

-- ============================================================================
-- SEMANTICS (one-time create as the probe)
-- ============================================================================
-- instructor overlap and boundaries (A1 = I1 day 0 10:00-11:00)
select public.t_gcse3_assert('T-gcse3-instructor-overlap-refused-with-category-only',
  public.t_gcse3_err($s$select public.t_gcse3_mk(null, 'OWN', 'I1', null, 0, '10:30', '11:30')$s$), 'GCSE3_CONFLICT: reason=instructor');
select public.t_gcse3_expect($s$select public.t_gcse3_mk(null, 'OWN', 'I1', null, 0, '09:00', '12:00')$s$, 'reason=instructor', 'T-gcse3-instructor-containing-overlap-refused');
select public.t_gcse3_ok($s$select public.t_gcse3_mk('A3', 'OWN', 'I1', null, 0, '11:00', '12:00')$s$, 'T-gcse3-back-to-back-after-allowed');
select public.t_gcse3_ok($s$select public.t_gcse3_mk('A4', 'OWN', 'I1', null, 0, '09:00', '10:00')$s$, 'T-gcse3-back-to-back-before-allowed');
select public.t_gcse3_assert('T-gcse3-refused-create-wrote-nothing',
  (select count(*)::text from public.appointments where studio_id = public.t_gcse3_id('S') and instructor_id = public.t_gcse3_id('I1')
     and starts_at < public.t_gcse3_t(0, '12:00') and ends_at > public.t_gcse3_t(0, '09:00')), '3');

-- cancelled / no-show do not block, attended / confirmed / rescheduled do (day 1)
insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I2'), 'private_lesson', 'cancelled', public.t_gcse3_t(1, '10:00'), public.t_gcse3_t(1, '11:00'), 'cancelled lesson'),
  (public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I2'), 'private_lesson', 'no_show', public.t_gcse3_t(1, '12:00'), public.t_gcse3_t(1, '13:00'), 'no-show lesson'),
  (public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I2'), 'private_lesson', 'confirmed', public.t_gcse3_t(1, '14:00'), public.t_gcse3_t(1, '15:00'), 'confirmed lesson'),
  (public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I2'), 'private_lesson', 'rescheduled', public.t_gcse3_t(1, '16:00'), public.t_gcse3_t(1, '17:00'), 'rescheduled lesson');
insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), null, public.t_gcse3_id('I2'), 'group_class', 'cancelled', public.t_gcse3_t(1, '18:00'), public.t_gcse3_t(1, '19:00'), 'cancelled class');
select public.t_gcse3_ok($s$select public.t_gcse3_mk(null, 'OWN', 'I2', null, 1, '10:00', '11:00')$s$, 'T-gcse3-cancelled-lesson-does-not-block');
select public.t_gcse3_ok($s$select public.t_gcse3_mk(null, 'OWN', 'I2', null, 1, '12:00', '13:00')$s$, 'T-gcse3-no-show-does-not-block');
select public.t_gcse3_ok($s$select public.t_gcse3_mk(null, 'OWN', 'I2', null, 1, '18:00', '19:00')$s$, 'T-gcse3-cancelled-class-does-not-block');
select public.t_gcse3_expect($s$select public.t_gcse3_mk(null, 'OWN', 'I2', null, 1, '14:30', '15:30')$s$, 'reason=instructor', 'T-gcse3-confirmed-lesson-blocks');
select public.t_gcse3_expect($s$select public.t_gcse3_mk(null, 'OWN', 'I2', null, 1, '16:30', '17:30')$s$, 'reason=instructor', 'T-gcse3-rescheduled-lesson-blocks');

-- instructor schedule block (day 2): overlap refused, touching allowed
insert into public.instructor_schedule_blocks (studio_id, instructor_id, title, starts_at, ends_at) values
  (public.t_gcse3_id('S'), public.t_gcse3_id('I3'), 'Lunch', public.t_gcse3_t(2, '12:00'), public.t_gcse3_t(2, '13:00'));
select public.t_gcse3_assert('T-gcse3-personal-block-refused',
  public.t_gcse3_err($s$select public.t_gcse3_mk(null, 'OWN', 'I3', null, 2, '12:30', '13:30')$s$), 'GCSE3_CONFLICT: reason=instructor_block');
select public.t_gcse3_ok($s$select public.t_gcse3_mk(null, 'OWN', 'I3', null, 2, '13:00', '14:00')$s$, 'T-gcse3-touching-personal-block-allowed');

-- client overlap is not a class rule: C1 has an active lesson at day 3 10:00; a class at that time is fine
insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I2'), 'private_lesson', 'scheduled', public.t_gcse3_t(3, '10:00'), public.t_gcse3_t(3, '11:00'), 'client lesson');
select public.t_gcse3_ok($s$select public.t_gcse3_mk(null, 'OWN', 'I3', 'R2', 3, '10:00', '11:00')$s$, 'T-gcse3-no-client-overlap-rule-for-classes');

-- room unavailable (day 4) and exclusive occupant (day 5), open room R2 has no capacity limit
insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), null, null, public.t_gcse3_id('R2'), 'room_unavailable', 'scheduled', public.t_gcse3_t(4, '10:00'), public.t_gcse3_t(4, '11:00'), 'closed');
select public.t_gcse3_assert('T-gcse3-room-unavailable-refused',
  public.t_gcse3_err($s$select public.t_gcse3_mk(null, 'OWN', null, 'R2', 4, '10:30', '11:30')$s$), 'GCSE3_CONFLICT: reason=room_unavailable');
select public.t_gcse3_ok($s$select public.t_gcse3_mk(null, 'OWN', null, 'R2', 4, '11:00', '12:00')$s$, 'T-gcse3-touching-room-unavailable-allowed');
insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, starts_at, ends_at, title, exclusive_room_use) values
  (public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I2'), public.t_gcse3_id('R2'), 'private_lesson', 'scheduled', public.t_gcse3_t(5, '10:00'), public.t_gcse3_t(5, '11:00'), 'exclusive', true),
  (public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I2'), public.t_gcse3_id('R2'), 'private_lesson', 'scheduled', public.t_gcse3_t(5, '12:00'), public.t_gcse3_t(5, '13:00'), 'shared', false);
select public.t_gcse3_assert('T-gcse3-exclusive-occupant-refused',
  public.t_gcse3_err($s$select public.t_gcse3_mk(null, 'OWN', null, 'R2', 5, '10:30', '11:30')$s$), 'GCSE3_CONFLICT: reason=room_busy');
select public.t_gcse3_ok($s$select public.t_gcse3_mk(null, 'OWN', null, 'R2', 5, '12:00', '13:00')$s$, 'T-gcse3-shared-occupant-unlimited-room-allowed');
select public.t_gcse3_assert('T-gcse3-rule-requested-exclusive-blocked-by-any-occupant',
  coalesce(public._gcse3_schedule_conflict(public.t_gcse3_id('S'), null, null, public.t_gcse3_id('R2'), public.t_gcse3_t(5, '12:30'), public.t_gcse3_t(5, '13:30'), true), 'none'), 'room_busy');

-- room capacity (R1 = 2): peak occupancy, not a pairwise count (day 6)
select public.t_gcse3_ok($s$select public.t_gcse3_mk('P1', 'OWN', null, 'R1', 6, '10:00', '11:00')$s$, 'T-gcse3-capacity-below');
select public.t_gcse3_ok($s$select public.t_gcse3_mk('P2', 'OWN', null, 'R1', 6, '11:00', '12:00')$s$, 'T-gcse3-capacity-back-to-back-not-counted');
select public.t_gcse3_ok($s$select public.t_gcse3_mk('P3', 'OWN', null, 'R1', 6, '10:00', '12:00')$s$, 'T-gcse3-capacity-two-overlapping-rows-but-peak-one-allowed');
select public.t_gcse3_assert('T-gcse3-capacity-exceeded-at-peak-refused',
  public.t_gcse3_err($s$select public.t_gcse3_mk(null, 'OWN', null, 'R1', 6, '10:30', '10:45')$s$), 'GCSE3_CONFLICT: reason=room_busy');
select public.t_gcse3_assert('T-gcse3-capacity-exactly-at-limit-state',
  (select count(*)::text from public.appointments where room_id = public.t_gcse3_id('R1') and status = 'scheduled'), '3');
-- cancelling one of the overlapping classes frees the seat (as the owner; S1C-2 cancellation authority)
update public.appointments set status = 'cancelled' where id = public.t_gcse3_cid('P1');
select public.t_gcse3_ok($s$select public.t_gcse3_mk('P4', 'OWN', null, 'R1', 6, '10:30', '10:45')$s$, 'T-gcse3-capacity-cancelled-class-excluded');

-- ============================================================================
-- SINGLE-OCCURRENCE EDIT (direct update, the released S1C-1 path)
-- ============================================================================
-- day 10: E1 = I1 10:00-11:00 (the class being edited), E2 = I2 12:00-13:00, E3 = I3 in R3 (capacity 1) 14:00-15:00,
-- E4 = no instructor in R2 16:00-17:00, E5 = I1 16:00-17:00
select public.t_gcse3_mk('E1', 'OWN', 'I1', null, 10, '10:00', '11:00');
select public.t_gcse3_mk('E2', 'OWN', 'I2', null, 10, '12:00', '13:00');
select public.t_gcse3_mk('E3', 'OWN', 'I3', 'R3', 10, '14:00', '15:00');
select public.t_gcse3_mk('E4', 'OWN', null, 'R2', 10, '16:00', '17:00');
select public.t_gcse3_mk('E5', 'OWN', 'I1', null, 10, '16:00', '17:00');

create function public.t_gcse3_state(p_label text) returns text language sql stable security definer set search_path = 'public' as $x$
  select a.title || '|' || case a.instructor_id when public.t_gcse3_id('I1') then 'I1' when public.t_gcse3_id('I2') then 'I2'
      when public.t_gcse3_id('I3') then 'I3' else '-' end || '|' || case a.room_id when public.t_gcse3_id('R2') then 'R2'
      when public.t_gcse3_id('R3') then 'R3' else '-' end || '|' || to_char(a.starts_at at time zone 'UTC', 'HH24:MI') || '-' ||
      to_char(a.ends_at at time zone 'UTC', 'HH24:MI')
  from public.appointments a where a.id = public.t_gcse3_cid(p_label)
$x$;
grant execute on function public.t_gcse3_state(text) to public;
create function public.t_gcse3_set(p_ins text, p_room text, p_day integer, p_from text, p_to text, p_title text default null) returns text
language sql stable as $x$
  select format('instructor_id = %L, room_id = %L, starts_at = %L, ends_at = %L%s', public.t_gcse3_id(p_ins), public.t_gcse3_id(p_room),
    public.t_gcse3_t(p_day, p_from), public.t_gcse3_t(p_day, p_to), case when p_title is null then '' else format(', title = %L', p_title) end)
$x$;
grant execute on function public.t_gcse3_set(text, text, integer, text, text, text) to public;
-- the statement that edits class p_label as p_who
create function public.t_gcse3_upd_sql(p_who text, p_label text, p_set text) returns text language sql stable as $x$
  select format('select public.t_gcse3_upd(%L, %L, %L)', p_who, public.t_gcse3_cid(p_label), p_set)
$x$;
grant execute on function public.t_gcse3_upd_sql(text, text, text) to public;

select public.t_gcse3_assert('T-gcse3-edit-self-excluded-when-shifting-over-own-time',
  public.t_gcse3_upd('OWN', public.t_gcse3_cid('E1'), public.t_gcse3_set('I1', null, 10, '10:30', '11:30'))::text, '1');
select public.t_gcse3_assert('T-gcse3-edit-move-onto-busy-instructor-refused',
  public.t_gcse3_err(public.t_gcse3_upd_sql('OWN', 'E1', public.t_gcse3_set('I2', null, 10, '12:30', '13:30', 'renamed'))),
  'GCSE3_CONFLICT: reason=instructor');
select public.t_gcse3_assert('T-gcse3-edit-refusal-left-no-partial-update', public.t_gcse3_state('E1'), 'E1|I1|-|10:30-11:30');
select public.t_gcse3_assert('T-gcse3-edit-move-to-other-instructor-back-to-back-allowed',
  public.t_gcse3_upd('OWN', public.t_gcse3_cid('E1'), public.t_gcse3_set('I2', null, 10, '13:00', '14:00'))::text, '1');
select public.t_gcse3_assert('T-gcse3-edit-move-back-old-instructor-released',
  public.t_gcse3_upd('OWN', public.t_gcse3_cid('E1'), public.t_gcse3_set('I1', null, 10, '12:30', '13:30'))::text, '1');
select public.t_gcse3_assert('T-gcse3-edit-new-instructor-now-free-for-others',
  public.t_gcse3_upd('OWN', public.t_gcse3_cid('E2'), public.t_gcse3_set('I2', null, 10, '13:00', '14:00'))::text, '1');
select public.t_gcse3_assert('T-gcse3-edit-room-move-into-full-room-refused',
  public.t_gcse3_err(public.t_gcse3_upd_sql('OWN', 'E4', public.t_gcse3_set(null, 'R3', 10, '14:30', '15:30'))),
  'GCSE3_CONFLICT: reason=room_busy');
select public.t_gcse3_assert('T-gcse3-edit-room-refusal-left-no-partial-update', public.t_gcse3_state('E4'), 'E4|-|R2|16:00-17:00');
select public.t_gcse3_assert('T-gcse3-edit-room-move-into-free-time-allowed',
  public.t_gcse3_upd('OWN', public.t_gcse3_cid('E4'), public.t_gcse3_set(null, 'R3', 10, '15:00', '16:00'))::text, '1');
select public.t_gcse3_assert('T-gcse3-edit-capacity-self-excluded',
  public.t_gcse3_upd('OWN', public.t_gcse3_cid('E3'), public.t_gcse3_set('I3', 'R3', 10, '13:45', '14:45'))::text, '1');
select public.t_gcse3_assert('T-gcse3-edit-capacity-exceeded-against-another-refused',
  public.t_gcse3_err(public.t_gcse3_upd_sql('OWN', 'E3', public.t_gcse3_set('I3', 'R3', 10, '14:30', '15:30'))),
  'GCSE3_CONFLICT: reason=room_busy');

-- authority is unchanged: the assigned instructor may edit their own class (and is refused on conflict); another
-- studio's owner and an unassigned instructor update nothing
select public.t_gcse3_assert('T-gcse3-edit-assigned-instructor-own-class-allowed',
  public.t_gcse3_upd('INS', public.t_gcse3_cid('E1'), public.t_gcse3_set('I1', null, 10, '13:30', '14:30'))::text, '1');
select public.t_gcse3_assert('T-gcse3-edit-assigned-instructor-conflict-refused',
  public.t_gcse3_err(public.t_gcse3_upd_sql('INS', 'E1', public.t_gcse3_set('I1', null, 10, '16:30', '17:30'))),
  'GCSE3_CONFLICT: reason=instructor');
select public.t_gcse3_assert('T-gcse3-edit-other-studio-owner-updates-nothing',
  public.t_gcse3_upd('OWB', public.t_gcse3_cid('E1'), public.t_gcse3_set('I1', null, 10, '18:00', '19:00'))::text, '0');
select public.t_gcse3_assert('T-gcse3-edit-unassigned-instructor-updates-nothing',
  public.t_gcse3_upd('INS2', public.t_gcse3_cid('E1'), public.t_gcse3_set('I1', null, 10, '18:00', '19:00'))::text, '0');
select public.t_gcse3_assert('T-gcse3-edit-unauthorized-left-class-unchanged', public.t_gcse3_state('E1'), 'E1|I1|-|13:30-14:30');

-- historical conflicting data is not rewritten or blocked from unrelated edits; a schedule change is governed
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-0000e5e34001', public.t_gcse3_id('S'), null, public.t_gcse3_id('I3'), 'group_class', 'scheduled', public.t_gcse3_t(11, '10:00'), public.t_gcse3_t(11, '11:00'), 'H1'),
  ('00000000-0000-0000-0000-0000e5e34002', public.t_gcse3_id('S'), null, public.t_gcse3_id('I3'), 'group_class', 'scheduled', public.t_gcse3_t(11, '10:30'), public.t_gcse3_t(11, '11:30'), 'H2');
select public.t_gcse3_assert('T-gcse3-edit-existing-conflict-unrelated-fields-allowed',
  public.t_gcse3_upd('OWN', '00000000-0000-0000-0000-0000e5e34001', format('title = %L, notes = %L, instructor_id = %L, starts_at = %L, ends_at = %L',
    'H1 renamed', 'n', public.t_gcse3_id('I3'), public.t_gcse3_t(11, '10:00'), public.t_gcse3_t(11, '11:00')))::text, '1');
select public.t_gcse3_expect(format('select public.t_gcse3_upd(%L, %L, %L)', 'OWN', '00000000-0000-0000-0000-0000e5e34001',
    format('starts_at = %L', public.t_gcse3_t(11, '09:55'))),
  'GCSE3_CONFLICT: reason=instructor', 'T-gcse3-edit-existing-conflict-schedule-change-governed');
select public.t_gcse3_expect(format($f$select public.t_gcse3_as('OWN'); insert into public.appointments (studio_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values (%L, %L, 'group_class', 'scheduled', %L, %L, 'direct')$f$,
    public.t_gcse3_id('S'), public.t_gcse3_id('I3'), public.t_gcse3_t(11, '10:15'), public.t_gcse3_t(11, '10:45')),
  'GCSE3_CONFLICT: reason=instructor', 'T-gcse3-direct-authenticated-class-insert-governed');
-- posture: a privileged (owner / maintenance) write is outside the product-role protocol, like the S1A guard
update public.appointments set starts_at = public.t_gcse3_t(11, '10:05') where id = '00000000-0000-0000-0000-0000e5e34002';
select public.t_gcse3_assert('T-gcse3-privileged-write-not-governed-posture',
  (select to_char(starts_at at time zone 'UTC', 'HH24:MI') from public.appointments where id = '00000000-0000-0000-0000-0000e5e34002'), '10:05');

-- ============================================================================
-- SERIES CREATE
-- ============================================================================
-- SA: I2, weekday 3, 09:00 local, 4 classes; blocker I2 class at occurrence 2 (written by the owner role, outside the protocol)
insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), null, public.t_gcse3_id('I2'), 'group_class', 'scheduled', public.t_gcse3_occ_at(3, 9, 4, 2) + interval '30 minutes', public.t_gcse3_occ_at(3, 9, 4, 2) + interval '90 minutes', 'blocker SA2');
select public.t_gcse3_assert('T-gcse3-series-conflict-refused-with-first-index-and-count',
  public.t_gcse3_err($s$select public.t_gcse3_series('OWN', '00000000-0000-0000-0000-0000e5e37001', 'SA', 'I2', null, 3, 9, 4)$s$),
  'GCSE3_CONFLICT: reason=instructor index=2 count=1');
insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), null, public.t_gcse3_id('I2'), 'group_class', 'scheduled', public.t_gcse3_occ_at(3, 9, 4, 4), public.t_gcse3_occ_at(3, 9, 4, 4) + interval '1 hour', 'blocker SA4');
select public.t_gcse3_assert('T-gcse3-series-multi-conflict-count',
  public.t_gcse3_err($s$select public.t_gcse3_series('OWN', '00000000-0000-0000-0000-0000e5e37001', 'SA', 'I2', null, 3, 9, 4)$s$),
  'GCSE3_CONFLICT: reason=instructor index=2 count=2');
select public.t_gcse3_assert('T-gcse3-series-refusal-wrote-nothing',
  (select (select count(*) from public.group_class_series where studio_id = public.t_gcse3_id('S') and title = 'SA')::text || '/' ||
          (select count(*) from public.appointments where studio_id = public.t_gcse3_id('S') and title = 'SA')::text || '/' ||
          (select count(*) from public.group_class_enrollment_policies p join public.appointments a on a.id = p.appointment_id where a.title = 'SA')::text), '0/0/0');
select public.t_gcse3_assert('T-gcse3-series-skipped-conflicts-exempt',
  (public.t_gcse3_series('OWN', '00000000-0000-0000-0000-0000e5e37001', 'SA', 'I2', null, 3, 9, 4, array[2, 4]) ->> 'materialized_count'), '2');
select public.t_gcse3_assert('T-gcse3-series-replay-not-a-self-conflict',
  (public.t_gcse3_series('OWN', '00000000-0000-0000-0000-0000e5e37001', 'SA', 'I2', null, 3, 9, 4, array[2, 4]) ->> 'replay'), 'true');
-- SR: room R3 only (no instructor), weekday 4; room unavailable at occurrence 3
insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), null, null, public.t_gcse3_id('R3'), 'room_unavailable', 'scheduled', public.t_gcse3_occ_at(4, 9, 3, 3), public.t_gcse3_occ_at(4, 9, 3, 3) + interval '1 hour', 'closed SR3');
select public.t_gcse3_assert('T-gcse3-series-room-unavailable-refused',
  public.t_gcse3_err($s$select public.t_gcse3_series('OWN', '00000000-0000-0000-0000-0000e5e37002', 'SR', null, 'R3', 4, 9, 3)$s$),
  'GCSE3_CONFLICT: reason=room_unavailable index=3 count=1');
-- SB: I3 with a personal block on occurrence 1
insert into public.instructor_schedule_blocks (studio_id, instructor_id, title, starts_at, ends_at) values
  (public.t_gcse3_id('S'), public.t_gcse3_id('I3'), 'Travel', public.t_gcse3_occ_at(5, 9, 3, 1) - interval '30 minutes', public.t_gcse3_occ_at(5, 9, 3, 1) + interval '15 minutes');
select public.t_gcse3_assert('T-gcse3-series-personal-block-refused',
  public.t_gcse3_err($s$select public.t_gcse3_series('OWN', '00000000-0000-0000-0000-0000e5e37003', 'SB', 'I3', null, 5, 9, 3)$s$),
  'GCSE3_CONFLICT: reason=instructor_block index=1 count=1');
-- SOK: no conflict
select public.t_gcse3_assert('T-gcse3-series-no-conflict-success',
  (public.t_gcse3_series('FD', '00000000-0000-0000-0000-0000e5e37004', 'SOK', 'I3', 'R3', 6, 9, 3) ->> 'materialized_count'), '3');
select public.t_gcse3_expect($s$select public.t_gcse3_series('INS', '00000000-0000-0000-0000-0000e5e37005', 'SINS', 'I1', null, 6, 12, 2)$s$,
  'GCSB1_UNAUTHORIZED', 'T-gcse3-series-instructor-cannot-create');
-- S1A override tracking still records a direct single edit of a series occurrence, and the edit is governed
select public.t_gcse3_assert('T-gcse3-series-occurrence-direct-edit-allowed',
  (select public.t_gcse3_upd('OWN', a.id, format('starts_at = %L, ends_at = %L', a.starts_at + interval '2 hours', a.ends_at + interval '2 hours'))::text
   from public.appointments a join public.group_class_series s on s.id = a.group_class_series_id where s.title = 'SOK' and a.series_occurrence_index = 2), '1');
select public.t_gcse3_assert('T-gcse3-series-occurrence-direct-edit-still-tracked',
  (select array_to_string(a.series_overridden_fields, '+') from public.appointments a join public.group_class_series s on s.id = a.group_class_series_id
   where s.title = 'SOK' and a.series_occurrence_index = 2), 'time');
select public.t_gcse3_assert('T-gcse3-series-occurrence-direct-edit-into-conflict-refused',
  public.t_gcse3_err((select format('select public.t_gcse3_upd(%L, %L, %L)', 'OWN', a.id, format('starts_at = %L, ends_at = %L', b.starts_at, b.ends_at))
   from public.appointments a join public.group_class_series s on s.id = a.group_class_series_id
   join public.appointments b on b.group_class_series_id = s.id and b.series_occurrence_index = 3
   where s.title = 'SOK' and a.series_occurrence_index = 2)), 'GCSE3_CONFLICT: reason=instructor');

-- ============================================================================
-- S1C-5 "this and following" (shared rule, atomic refusal, split unchanged)
-- ============================================================================
select public.t_gcse3_series('OWN', '00000000-0000-0000-0000-0000e5e37010', 'SX', 'I1', null, 2, 18, 4);
select set_config('t.SX', (select id::text from public.group_class_series where studio_id = public.t_gcse3_id('S') and title = 'SX'), true);
insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), null, public.t_gcse3_id('I2'), 'group_class', 'scheduled', public.t_gcse3_occ_at(2, 18, 4, 3), public.t_gcse3_occ_at(2, 18, 4, 3) + interval '1 hour', 'blocker SX3');
insert into public.appointments (studio_id, client_id, instructor_id, room_id, appointment_type, status, starts_at, ends_at, title) values
  (public.t_gcse3_id('S'), null, null, public.t_gcse3_id('R3'), 'group_class', 'scheduled', public.t_gcse3_occ_at(2, 18, 4, 2) + interval '45 minutes', public.t_gcse3_occ_at(2, 18, 4, 2) + interval '2 hours', 'occupant SX2');
insert into public.instructor_schedule_blocks (studio_id, instructor_id, title, starts_at, ends_at) values
  (public.t_gcse3_id('S'), public.t_gcse3_id('I3'), 'Meeting', public.t_gcse3_occ_at(2, 18, 4, 4), public.t_gcse3_occ_at(2, 18, 4, 4) + interval '1 hour');

select public.t_gcse3_expect(format($f$select public.t_gcse3_s1c5('OWN', %L, 2, '00000000-0000-0000-0000-0000e5e38001', jsonb_build_object('instructor_id', %L))$f$,
    current_setting('t.SX'), public.t_gcse3_id('I2')), 'GCSC5_CONFLICT: reason=instructor index=3', 'T-gcse3-s1c5-instructor-conflict-refused');
select public.t_gcse3_expect(format($f$select public.t_gcse3_s1c5('OWN', %L, 2, '00000000-0000-0000-0000-0000e5e38002', jsonb_build_object('instructor_id', %L))$f$,
    current_setting('t.SX'), public.t_gcse3_id('I3')), 'GCSC5_CONFLICT: reason=instructor_block index=4', 'T-gcse3-s1c5-personal-block-refused');
select public.t_gcse3_expect(format($f$select public.t_gcse3_s1c5('OWN', %L, 1, '00000000-0000-0000-0000-0000e5e38003', jsonb_build_object('room_id', %L))$f$,
    current_setting('t.SX'), public.t_gcse3_id('R3')), 'GCSC5_CONFLICT: reason=room_busy index=2', 'T-gcse3-s1c5-room-capacity-refused');
select public.t_gcse3_assert('T-gcse3-s1c5-refusals-atomic', public.t_gcse3_ins_by_idx('SX') || '|' ||
  (select count(*)::text from public.group_class_series where studio_id = public.t_gcse3_id('S') and title = 'SX') || '|' ||
  (select count(*)::text from public.group_class_series_edit_requests where studio_id = public.t_gcse3_id('S')), '1:I1,2:I1,3:I1,4:I1|1|0');
select public.t_gcse3_expect(format($f$select public.t_gcse3_s1c5('INS', %L, 2, '00000000-0000-0000-0000-0000e5e38004', jsonb_build_object('title', 'x'))$f$,
    current_setting('t.SX')), 'GCSC5_UNAUTHORIZED', 'T-gcse3-s1c5-instructor-cannot-series-edit');
select public.t_gcse3_assert('T-gcse3-s1c5-success-split-unchanged',
  (select (r ->> 'split_created') || '|' || (r ->> 'edited_class_count') from (select public.t_gcse3_s1c5('OWN', current_setting('t.SX')::uuid, 4,
     '00000000-0000-0000-0000-0000e5e38005', jsonb_build_object('instructor_id', public.t_gcse3_id('I2'))) r) x), 'true|1');
select public.t_gcse3_assert('T-gcse3-s1c5-success-state', public.t_gcse3_ins_by_idx('SX') || '|' ||
  (select count(*)::text from public.group_class_series where studio_id = public.t_gcse3_id('S') and title = 'SX'), '1:I1,2:I1,3:I1,4:I2|2');
select public.t_gcse3_assert('T-gcse3-s1c5-preview-uses-shared-rule',
  (select (p ->> 'conflict_count') || '|' || (p -> 'first_conflict' ->> 'reason') from (select public.preview_group_class_series_edit(
     (select a.id from public.appointments a where a.group_class_series_id = current_setting('t.SX')::uuid and a.series_occurrence_index = 1),
     jsonb_build_object('room_id', public.t_gcse3_id('R3')), false) p) x), '1|room_busy');

-- ============================================================================
-- REVIEW REMEDIATION (20261023090100): lock order, studio scope, trigger gating
-- ============================================================================
select public.t_gcse3_assert('T-gcse3-before-row-lock-triggers-role-gated',
  (select string_agg(t.tgname || ':' || (pg_get_triggerdef(t.oid) like '%BEFORE%FOR EACH ROW WHEN (((CURRENT_USER = ANY (ARRAY[''anon''::name, ''authenticated''::name])) AND (new.appointment_type = ''group_class''::appointment_type)%')::text, ',' order by t.tgname)
   from pg_trigger t where t.tgrelid = 'public.appointments'::regclass and t.tgname like 'appointments_gcse3_lock_%'),
  'appointments_gcse3_lock_direct_class_insert:true,appointments_gcse3_lock_direct_class_update:true');
select public.t_gcse3_assert('T-gcse3-row-lock-helper-internal',
  (select (has_function_privilege('authenticated', 'public._gcse3_lock_direct_class_row()', 'execute')
        or has_function_privilege('anon', 'public._gcse3_lock_direct_class_row()', 'execute')
        or has_function_privilege('service_role', 'public._gcse3_lock_direct_class_row()', 'execute'))::text), 'false');

-- studio scope: another studio's room or instructor is refused before anything is locked or written
select public.t_gcse3_assert('T-gcse3-onetime-other-studio-room-refused',
  public.t_gcse3_err($s$select public.t_gcse3_mk('XR', 'OWN', 'I1', 'RB', 20, '10:00', '11:00')$s$), 'GCSE3_ROOM_INVALID: That room does not belong to this studio.');
select public.t_gcse3_expect($s$select public.t_gcse3_mk('XI', 'OWN', 'IB', null, 20, '10:00', '11:00')$s$,
  'no longer available for assignment', 'T-gcse3-onetime-other-studio-instructor-refused');
select public.t_gcse3_assert('T-gcse3-onetime-studio-refusals-wrote-nothing',
  (select count(*)::text from public.appointments where title in ('XR', 'XI')), '0');
select public.t_gcse3_assert('T-gcse3-direct-edit-other-studio-room-refused',
  public.t_gcse3_err(public.t_gcse3_upd_sql('OWN', 'E5', format('room_id = %L', public.t_gcse3_id('RB')))), 'GCSE3_ROOM_INVALID: That room does not belong to this studio.');

-- gating: other appointment types, unrelated updates of an already-conflicting class, privileged contexts
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-0000e5e34003', public.t_gcse3_id('S'), public.t_gcse3_id('C1'), public.t_gcse3_id('I1'), 'private_lesson', 'scheduled', public.t_gcse3_t(13, '10:00'), public.t_gcse3_t(13, '11:00'), 'LESSON');
select public.t_gcse3_mk('K13', 'OWN', 'I1', null, 13, '12:00', '13:00');
select public.t_gcse3_assert('T-gcse3-gating-private-lesson-direct-move-not-governed',
  public.t_gcse3_upd('OWN', '00000000-0000-0000-0000-0000e5e34003', format('starts_at = %L, ends_at = %L', public.t_gcse3_t(13, '12:00'), public.t_gcse3_t(13, '13:00')))::text, '1');
select public.t_gcse3_assert('T-gcse3-gating-capacity-only-update-of-conflicting-class-allowed',
  public.t_gcse3_upd('OWN', '00000000-0000-0000-0000-0000e5e34001', 'roster_capacity = 5')::text, '1');
select public.t_gcse3_assert('T-gcse3-gating-status-only-update-of-conflicting-class-allowed',
  public.t_gcse3_upd('OWN', '00000000-0000-0000-0000-0000e5e34001', $q$status = 'confirmed'$q$)::text, '1');
select public.t_gcse3_ok(format($f$set local role service_role; update public.appointments set starts_at = %L, ends_at = %L where id = %L$f$,
    public.t_gcse3_t(13, '12:30'), public.t_gcse3_t(13, '13:30'), public.t_gcse3_cid('E5')),
  'T-gcse3-gating-service-role-write-not-governed');
create function public.t_gcse3_definer_move(p_id uuid, p_s timestamptz, p_e timestamptz) returns integer
language plpgsql security definer set search_path = 'public' as $$
declare v integer;
begin
  update public.appointments set starts_at = p_s, ends_at = p_e where id = p_id;
  get diagnostics v = row_count;
  return v;
end $$;
grant execute on function public.t_gcse3_definer_move(uuid, timestamptz, timestamptz) to authenticated;
select public.t_gcse3_assert('T-gcse3-gating-definer-rpc-context-not-governed',
  public.t_gcse3_err(format($f$select public.t_gcse3_as('OWN'); select public.t_gcse3_definer_move(%L, %L, %L)$f$,
    public.t_gcse3_cid('K13'), public.t_gcse3_t(13, '12:30'), public.t_gcse3_t(13, '13:30'))), 'NO ERROR');

-- a multi-row statement is checked against its own final state
select public.t_gcse3_mk('M1', 'OWN', 'I2', null, 14, '10:00', '11:00');
select public.t_gcse3_mk('M2', 'OWN', 'I2', null, 14, '12:00', '13:00');
select public.t_gcse3_assert('T-gcse3-multi-row-statement-intra-conflict-refused',
  public.t_gcse3_err(format($f$select public.t_gcse3_as('OWN'); update public.appointments set starts_at = %L, ends_at = %L where id in (%L, %L)$f$,
    public.t_gcse3_t(14, '15:00'), public.t_gcse3_t(14, '16:00'), public.t_gcse3_cid('M1'), public.t_gcse3_cid('M2'))), 'GCSE3_CONFLICT: reason=instructor');
select public.t_gcse3_assert('T-gcse3-multi-row-statement-refusal-atomic', public.t_gcse3_state('M1') || ' ' || public.t_gcse3_state('M2'), 'M1|I2|-|10:00-11:00 M2|I2|-|12:00-13:00');
select public.t_gcse3_ok(format($f$select public.t_gcse3_as('OWN'); update public.appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id in (%L, %L)$f$,
    public.t_gcse3_cid('M1'), public.t_gcse3_cid('M2')), 'T-gcse3-multi-row-statement-non-conflicting-allowed');

-- S1A: a refused edit leaves no override behind; the assigned instructor's own edit is tracked as before
select public.t_gcse3_assert('T-gcse3-refused-series-edit-leaves-no-override',
  public.t_gcse3_err((select format('select public.t_gcse3_upd(%L, %L, %L)', 'OWN', a.id, format('starts_at = %L, ends_at = %L', b.starts_at, b.ends_at))
     from public.appointments a join public.group_class_series s on s.id = a.group_class_series_id
     join public.appointments b on b.group_class_series_id = s.id and b.series_occurrence_index = 1
     where s.title = 'SOK' and a.series_occurrence_index = 3)), 'GCSE3_CONFLICT: reason=instructor');
select public.t_gcse3_assert('T-gcse3-refused-series-edit-left-no-override-or-time-change',
  (select array_to_string(a.series_overridden_fields, '+') || '|' || (a.starts_at = a.occurrence_original_start)::text
   from public.appointments a join public.group_class_series s on s.id = a.group_class_series_id
   where s.title = 'SOK' and a.series_occurrence_index = 3), '|true');
select public.t_gcse3_assert('T-gcse3-instructor-own-series-occurrence-edit-allowed',
  (select public.t_gcse3_upd('INS3', a.id, format('starts_at = %L, ends_at = %L', a.starts_at + interval '3 hours', a.ends_at + interval '3 hours'))::text
   from public.appointments a join public.group_class_series s on s.id = a.group_class_series_id where s.title = 'SOK' and a.series_occurrence_index = 3), '1');
select public.t_gcse3_assert('T-gcse3-instructor-own-series-occurrence-edit-tracked',
  (select array_to_string(a.series_overridden_fields, '+') from public.appointments a join public.group_class_series s on s.id = a.group_class_series_id
     where s.title = 'SOK' and a.series_occurrence_index = 3), 'time');

-- the rule with nothing to conflict on
select public.t_gcse3_assert('T-gcse3-rule-no-instructor-no-room-is-no-conflict',
  coalesce(public._gcse3_schedule_conflict(public.t_gcse3_id('S'), null, null, null, public.t_gcse3_t(0, '10:00'), public.t_gcse3_t(0, '11:00'), false), 'none'), 'none');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcse3_log;

rollback;
