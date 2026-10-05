-- GC-S1D-3 -- series ("this and following classes") enrollment settings, live-Postgres regression suite for
-- 20261022090000_gcsd3_series_enrollment_settings.sql.
--
-- Proves, as real tenant roles:
--   AUTHORITY   broad staff (owner, front desk) may preview / apply; the assigned instructor, another studio's owner, anon and
--               service_role may not; an unknown class, a non-series group class and a private lesson are refused with stable
--               codes; the studio, series and lineage are derived from the occurrence (the RPCs take only the occurrence id).
--   TRAVERSAL   the selected occurrence and the following ones are updated, earlier ones and an unrelated series are never
--               touched, and a split (successor) lineage is traversed across the split; an anchor starting inside the
--               successor never reaches back.
--   BEHAVIOR    a differing later class is overwritten by design (no preserve-customization), matching classes are counted and
--               not written, unmanaged funding values and the dormant direct-payment amount are preserved per class, a class
--               without a policy row gets one, repeated identical apply is a no-op that writes nothing, and a stale expected
--               count is refused.
--   ATOMICITY   one class that cannot take the settings blocks the whole operation and nothing changes; preview never writes.
--   LIFECYCLE   cancelled and ended classes are skipped and reported (a skipped anchor is reported, never shifted); nothing
--               eligible is a result, not an error.
--   NO NEW MODEL no table, column or override metadata is created; the series default columns, attendance, enrollment and
--               money rows never change.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV AFTER the migration.
-- UUID block ...000000f5....

begin;

create table public.t_gcsd3_log (n serial, msg text);
grant all on public.t_gcsd3_log to public;
grant usage on sequence public.t_gcsd3_log_n_seq to public;
create function public.t_gcsd3_pass(p text) returns void language sql as $$ insert into public.t_gcsd3_log (msg) values (p) $$;
grant execute on function public.t_gcsd3_pass(text) to public;

create function public.t_gcsd3_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsd3_pass(p_label);
end;
$$;
grant execute on function public.t_gcsd3_assert(text, text, text) to public;

create function public.t_gcsd3_uid(p_who text) returns uuid language sql immutable as $x$
  select case p_who
    when 'OWN' then '00000000-0000-0000-0000-000000f51001'
    when 'FD'  then '00000000-0000-0000-0000-000000f51002'
    when 'INS' then '00000000-0000-0000-0000-000000f51003'
    when 'OWB' then '00000000-0000-0000-0000-000000f51005'
    when 'PA'  then '00000000-0000-0000-0000-000000f51006'
  end::uuid
$x$;
grant execute on function public.t_gcsd3_uid(text) to public;

create table public.t_gcsd3_occ (label text, idx integer, id uuid);
grant all on public.t_gcsd3_occ to public;
create function public.t_gcsd3_o(p_label text, p_idx integer) returns uuid language sql stable security definer set search_path = 'public' as $x$
  select id from public.t_gcsd3_occ where label = p_label and idx = p_idx
$x$;
grant execute on function public.t_gcsd3_o(text, integer) to public;

create function public.t_gcsd3_pv(p_who text, p_appt uuid, p_d boolean, p_s boolean, p_pkg boolean, p_mem boolean)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd3_uid(p_who))::text, true);
  set local role authenticated;
  v := public.preview_group_class_series_enrollment_settings(p_appt, p_d, p_s, p_pkg, p_mem);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsd3_pv(text, uuid, boolean, boolean, boolean, boolean) to public;

create function public.t_gcsd3_ap(p_who text, p_appt uuid, p_d boolean, p_s boolean, p_pkg boolean, p_mem boolean, p_expected integer default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd3_uid(p_who))::text, true);
  set local role authenticated;
  v := public.apply_group_class_series_enrollment_settings(p_appt, p_d, p_s, p_pkg, p_mem, p_expected);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsd3_ap(text, uuid, boolean, boolean, boolean, boolean, integer) to public;

-- run preview ('p') or apply ('a') as a user; return the error text (null when it succeeded). The role is always reset.
create function public.t_gcsd3_err(p_kind text, p_who text, p_appt uuid)
returns text language plpgsql as $$
declare v_err text;
begin
  begin
    if p_kind = 'p' then perform public.t_gcsd3_pv(p_who, p_appt, true, false, true, false);
    else perform public.t_gcsd3_ap(p_who, p_appt, true, false, true, false);
    end if;
  exception when others then
    v_err := sqlerrm;
  end;
  reset role;
  return v_err;
end $$;
grant execute on function public.t_gcsd3_err(text, text, uuid) to public;

create function public.t_gcsd3_rls_update(p_who text, p_appt uuid) returns integer language plpgsql as $$
declare v_rows integer;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd3_uid(p_who))::text, true);
  set local role authenticated;
  update public.group_class_enrollment_policies set publicly_discoverable = publicly_discoverable where appointment_id = p_appt;
  get diagnostics v_rows = row_count;
  reset role;
  return v_rows;
end $$;
grant execute on function public.t_gcsd3_rls_update(text, uuid) to public;

create function public.t_gcsd3_cnt(p_result jsonb, p_key text) returns text language sql immutable as $x$
  select coalesce(p_result -> 'counts' ->> p_key, '0')
$x$;
grant execute on function public.t_gcsd3_cnt(jsonb, text) to public;

create function public.t_gcsd3_classes(p_result jsonb) returns text language sql immutable as $x$
  select string_agg((e ->> 'occurrence_index') || ':' || (e ->> 'state'), ',' order by (e ->> 'occurrence_index')::integer)
  from jsonb_array_elements(p_result -> 'classes') e
$x$;
grant execute on function public.t_gcsd3_classes(jsonb) to public;

-- compact policy state per occurrence in [from, to]: D/S/pkg+mem or '-' when no row, joined by commas
create function public.t_gcsd3_pol(p_label text, p_from integer, p_to integer) returns text language sql volatile security definer set search_path = 'public' as $x$
  select string_agg(
    coalesce((select (case when p.publicly_discoverable then 'D' else 'd' end) || (case when p.self_enrollment_allowed then 'S' else 's' end) || '/' || coalesce(array_to_string(p.accepted_funding_types, '+'), '-')
              from public.group_class_enrollment_policies p where p.appointment_id = o.id), 'none'), ',' order by o.idx)
  from public.t_gcsd3_occ o where o.label = p_label and o.idx between p_from and p_to
$x$;
grant execute on function public.t_gcsd3_pol(text, integer, integer) to public;

create function public.t_gcsd3_cancel_class(p_label text, p_idx integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd3_uid('OWN'))::text, true);
  set local role authenticated;
  perform public.cancel_group_class_appointment(public.t_gcsd3_o(p_label, p_idx));
  reset role;
end $$;
grant execute on function public.t_gcsd3_cancel_class(text, integer) to public;

-- everything that must never move: series default columns, appointments identity, attendance, enrollment, money
create function public.t_gcsd3_other() returns text language sql volatile security definer set search_path = 'public' as $x$
  select md5(
    coalesce((select string_agg(s.id::text || coalesce(s.publicly_discoverable::text, '') || s.self_enrollment_allowed::text || coalesce(array_to_string(s.accepted_funding_types, '+'), '-') || coalesce(s.direct_payment_amount::text, '-'), '|' order by s.id) from public.group_class_series s where s.studio_id = '00000000-0000-0000-0000-000000f50001'), '')
    || coalesce((select string_agg(a.id::text || a.status::text || coalesce(a.series_occurrence_index::text, '-') || coalesce(array_to_string(a.series_overridden_fields, '+'), '-'), '|' order by a.id) from public.appointments a where a.studio_id = '00000000-0000-0000-0000-000000f50001'), '')
    || coalesce((select string_agg(to_jsonb(ar)::text, '|' order by ar.id) from public.attendance_records ar where ar.studio_id = '00000000-0000-0000-0000-000000f50001'), '')
    || coalesce((select string_agg(to_jsonb(aa)::text, '|' order by aa.id) from public.appointment_attendees aa where aa.studio_id = '00000000-0000-0000-0000-000000f50001'), '')
    || coalesce((select string_agg(to_jsonb(u)::text, '|' order by u.id) from public.client_membership_usage u), '')
    || coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.id) from public.client_package_items i), ''))
$x$;
grant execute on function public.t_gcsd3_other() to public;

create table public.t_gcsd3_sids (id uuid);
grant all on public.t_gcsd3_sids to public;
-- the same, without appointment lifecycle (later sections cancel, end and split classes on purpose), and with the series default
-- columns limited to the series that existed at the start
create function public.t_gcsd3_stable() returns text language sql volatile security definer set search_path = 'public' as $x$
  select md5(
    coalesce((select string_agg(s.id::text || coalesce(s.publicly_discoverable::text, '') || s.self_enrollment_allowed::text || coalesce(array_to_string(s.accepted_funding_types, '+'), '-') || coalesce(s.direct_payment_amount::text, '-'), '|' order by s.id) from public.group_class_series s where s.id in (select id from public.t_gcsd3_sids)), '')
    || coalesce((select string_agg(to_jsonb(ar)::text, '|' order by ar.id) from public.attendance_records ar where ar.studio_id = '00000000-0000-0000-0000-000000f50001'), '')
    || coalesce((select string_agg(to_jsonb(aa)::text, '|' order by aa.id) from public.appointment_attendees aa where aa.studio_id = '00000000-0000-0000-0000-000000f50001'), '')
    || coalesce((select string_agg(to_jsonb(u)::text, '|' order by u.id) from public.client_membership_usage u), '')
    || coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.id) from public.client_package_items i), ''))
$x$;
grant execute on function public.t_gcsd3_stable() to public;

create function public.t_gcsd3_schema() returns text language sql volatile security definer set search_path = 'public' as $x$
  select md5(
    (select string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, ordinal_position) from information_schema.columns where table_schema = 'public' and table_name in ('group_class_enrollment_policies', 'group_class_series', 'appointments'))
    || (select count(*)::text from information_schema.tables where table_schema = 'public' and table_name not like 't\_gcsd3\_%'))
$x$;
grant execute on function public.t_gcsd3_schema() to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000f50001', 'GC-S1D-3 Harness Studio A', 't-gcsd3-a', 'America/New_York'),
  ('00000000-0000-0000-0000-000000f50002', 'GC-S1D-3 Harness Studio B', 't-gcsd3-b', 'America/New_York');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f51001', 't-gcsd3-owner@example.test'),
  ('00000000-0000-0000-0000-000000f51002', 't-gcsd3-frontdesk@example.test'),
  ('00000000-0000-0000-0000-000000f51003', 't-gcsd3-instructor@example.test'),
  ('00000000-0000-0000-0000-000000f51005', 't-gcsd3-owner-b@example.test'),
  ('00000000-0000-0000-0000-000000f51006', 't-gcsd3-platform-admin@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000f51001', 't-gcsd3-owner@example.test', null),
  ('00000000-0000-0000-0000-000000f51002', 't-gcsd3-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-000000f51003', 't-gcsd3-instructor@example.test', null),
  ('00000000-0000-0000-0000-000000f51005', 't-gcsd3-owner-b@example.test', null),
  ('00000000-0000-0000-0000-000000f51006', 't-gcsd3-platform-admin@example.test', 'platform_admin');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000f51001', '00000000-0000-0000-0000-000000f50001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000f51002', '00000000-0000-0000-0000-000000f50001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000f51003', '00000000-0000-0000-0000-000000f50001', 'instructor', true),
  ('00000000-0000-0000-0000-000000f51005', '00000000-0000-0000-0000-000000f50002', 'studio_owner', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000f52001', '00000000-0000-0000-0000-000000f50001', '00000000-0000-0000-0000-000000f51003', 'Series', 'Instructor', true, true);
alter table public.instructors enable trigger user;
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor)
values ('00000000-0000-0000-0000-000000f53001', '00000000-0000-0000-0000-000000f50001', 'C', 'One', 'active', false);

create function public.t_gcsd3_series(p_label text, p_req text, p_count integer, p_weekday integer, p_hour integer) returns void language plpgsql as $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd3_uid('OWN'))::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f50001', p_client_request_id => p_req::uuid,
    p_title => 'SER-' || p_label, p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000f52001', p_room_id => null, p_location_name => null, p_roster_capacity => null,
    p_weekdays => array[p_weekday]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => p_count,
    p_local_start_time => make_time(p_hour, 0, 0), p_duration_minutes => 60);
  reset role;
  insert into public.t_gcsd3_occ (label, idx, id)
  select p_label, a.series_occurrence_index, a.id
  from public.appointments a where a.group_class_series_id = (v_res ->> 'series_id')::uuid;
end $$;

select public.t_gcsd3_series('A', '00000000-0000-0000-0000-000000f57001', 6, 1, 9);    -- main apply / overwrite / preserve
select public.t_gcsd3_series('B', '00000000-0000-0000-0000-000000f57002', 4, 2, 10);   -- unrelated series
select public.t_gcsd3_series('D', '00000000-0000-0000-0000-000000f57004', 6, 4, 12);   -- split lineage
select public.t_gcsd3_series('E', '00000000-0000-0000-0000-000000f57005', 4, 5, 13);   -- atomic refusal
select public.t_gcsd3_series('G', '00000000-0000-0000-0000-000000f57007', 6, 7, 15);   -- cancelled / ended
select public.t_gcsd3_series('H', '00000000-0000-0000-0000-000000f57008', 4, 1, 16);   -- missing policy row, stale count
select public.t_gcsd3_series('I', '00000000-0000-0000-0000-000000f57009', 2, 2, 17);   -- nothing eligible
select public.t_gcsd3_series('J', '00000000-0000-0000-0000-000000f57010', 4, 3, 11);   -- late-target failure after earlier insert + updates
select public.t_gcsd3_series('K', '00000000-0000-0000-0000-000000f57011', 4, 6, 19);   -- stale preview: cancel / flip
select public.t_gcsd3_series('L', '00000000-0000-0000-0000-000000f57012', 4, 2, 21);   -- stale preview: split between preview and apply
select public.t_gcsd3_series('M', '00000000-0000-0000-0000-000000f57013', 4, 7, 20);   -- stale preview: missing row appears

insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000f54001', '00000000-0000-0000-0000-000000f50001', '00000000-0000-0000-0000-000000f52001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', 'STANDALONE');
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000f54002', '00000000-0000-0000-0000-000000f50001', '00000000-0000-0000-0000-000000f53001', '00000000-0000-0000-0000-000000f52001', 'private_lesson', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour', 'PRIVATE');

insert into public.t_gcsd3_sids select distinct a.group_class_series_id from public.appointments a where a.studio_id = '00000000-0000-0000-0000-000000f50001' and a.group_class_series_id is not null;
create table public.t_gcsd3_base as select public.t_gcsd3_other() as other, public.t_gcsd3_schema() as schema, public.t_gcsd3_stable() as stable;

-- ============================================================================
-- 1. POSTURE
-- ============================================================================
select public.t_gcsd3_assert('T-gcsd3-public-rpcs-authenticated-only-definer-search-path',
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text || '/' || has_function_privilege('anon', p.oid, 'execute')::text || '/' || has_function_privilege('service_role', p.oid, 'execute')::text, ';' order by p.proname)
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('preview_group_class_series_enrollment_settings', 'apply_group_class_series_enrollment_settings')),
  'apply_group_class_series_enrollment_settings:true:search_path=public:true/false/false;preview_group_class_series_enrollment_settings:true:search_path=public:true/false/false');
select public.t_gcsd3_assert('T-gcsd3-helpers-are-granted-to-no-tenant-role',
  (select count(*)::text || '/' || count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_gcsd3\_%'), '3/0');
do $$
declare v_err text;
begin
  set local role anon;
  begin perform public.preview_group_class_series_enrollment_settings(public.t_gcsd3_o('A', 1), true, false, true, false);
  exception when others then v_err := sqlerrm; end;
  reset role;
  perform public.t_gcsd3_assert('T-gcsd3-anon-denied', coalesce(case when v_err ilike '%permission denied%' then 'denied' else v_err end, 'no error'), 'denied');
  v_err := null;
  set local role service_role;
  begin perform public.apply_group_class_series_enrollment_settings(public.t_gcsd3_o('A', 1), true, false, true, false, null);
  exception when others then v_err := sqlerrm; end;
  reset role;
  perform public.t_gcsd3_assert('T-gcsd3-service-role-denied', coalesce(case when v_err ilike '%permission denied%' then 'denied' else v_err end, 'no error'), 'denied');
end $$;

-- ============================================================================
-- 2. AUTHORITY
-- ============================================================================
select public.t_gcsd3_assert('T-gcsd3-owner-preview-allowed-and-read-only',
  (public.t_gcsd3_pv('OWN', public.t_gcsd3_o('A', 1), true, true, true, true) ->> 'outcome') || '/' || public.t_gcsd3_pol('A', 1, 2), 'ready/ds/-,ds/-');
select public.t_gcsd3_assert('T-gcsd3-front-desk-preview-allowed', public.t_gcsd3_pv('FD', public.t_gcsd3_o('A', 1), true, true, true, true) ->> 'outcome', 'ready');
select public.t_gcsd3_assert('T-gcsd3-instructor-preview-refused', left(public.t_gcsd3_err('p', 'INS', public.t_gcsd3_o('A', 1)), 17), 'GCSD3_UNAUTHORIZE');
select public.t_gcsd3_assert('T-gcsd3-instructor-apply-refused', left(public.t_gcsd3_err('a', 'INS', public.t_gcsd3_o('A', 1)), 17), 'GCSD3_UNAUTHORIZE');
select public.t_gcsd3_assert('T-gcsd3-other-studio-owner-refused-preview', left(public.t_gcsd3_err('p', 'OWB', public.t_gcsd3_o('A', 1)), 17), 'GCSD3_UNAUTHORIZE');
select public.t_gcsd3_assert('T-gcsd3-other-studio-owner-refused-apply', left(public.t_gcsd3_err('a', 'OWB', public.t_gcsd3_o('A', 1)), 17), 'GCSD3_UNAUTHORIZE');
select public.t_gcsd3_assert('T-gcsd3-platform-admin-is-the-existing-policy-table-authority-not-a-new-grant',
  public.t_gcsd3_rls_update('OWN', public.t_gcsd3_o('A', 1))::text || '/' || public.t_gcsd3_rls_update('FD', public.t_gcsd3_o('A', 1))::text || '/' || public.t_gcsd3_rls_update('PA', public.t_gcsd3_o('A', 1))::text || '/' || public.t_gcsd3_rls_update('INS', public.t_gcsd3_o('A', 1))::text || '/' || public.t_gcsd3_rls_update('OWB', public.t_gcsd3_o('A', 1))::text,
  '1/1/1/0/0');
select public.t_gcsd3_assert('T-gcsd3-series-authority-equals-single-class-write-authority-platform-admin-allowed',
  (public.t_gcsd3_pv('PA', public.t_gcsd3_o('A', 1), true, true, true, true) ->> 'outcome') || '/' || left(public.t_gcsd3_err('p', 'INS', public.t_gcsd3_o('A', 1)), 17), 'ready/GCSD3_UNAUTHORIZE');
select public.t_gcsd3_assert('T-gcsd3-refusals-changed-nothing', (select (b.other = public.t_gcsd3_other())::text || '/' || public.t_gcsd3_pol('A', 1, 6) from public.t_gcsd3_base b), 'true/ds/-,ds/-,ds/-,ds/-,ds/-,ds/-');
select public.t_gcsd3_assert('T-gcsd3-non-series-group-class-refused', left(public.t_gcsd3_err('a', 'OWN', '00000000-0000-0000-0000-000000f54001'::uuid), 26), 'GCSD3_NOT_A_SERIES_OCCURRE');
select public.t_gcsd3_assert('T-gcsd3-private-lesson-refused', left(public.t_gcsd3_err('p', 'OWN', '00000000-0000-0000-0000-000000f54002'::uuid), 16), 'GCSD3_NOT_FOUND:');
select public.t_gcsd3_assert('T-gcsd3-unknown-class-refused', left(public.t_gcsd3_err('a', 'OWN', '00000000-0000-0000-0000-000000f5ffff'::uuid), 16), 'GCSD3_NOT_FOUND:');

-- ============================================================================
-- 3. PREVIEW COUNTS, OVERWRITE BY DESIGN, PRESERVED VALUES, TRAVERSAL (series A, unrelated series B)
-- ============================================================================
-- idx4 already matches the target; idx5 differs; idx6 carries unmanaged direct-payment funding and a dormant amount
update public.group_class_enrollment_policies set publicly_discoverable = true, self_enrollment_allowed = true, accepted_funding_types = array['package', 'membership']::text[] where appointment_id = public.t_gcsd3_o('A', 4);
update public.group_class_enrollment_policies set accepted_funding_types = array['membership']::text[] where appointment_id = public.t_gcsd3_o('A', 5);
update public.group_class_enrollment_policies set accepted_funding_types = array['direct_payment']::text[], direct_payment_amount = 25 where appointment_id = public.t_gcsd3_o('A', 6);

do $$
declare v jsonb; v_before text;
begin
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('A', 3), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-preview-counts-differing-versus-matching', (v ->> 'outcome') || '/' || public.t_gcsd3_cnt(v, 'will_change') || '/' || public.t_gcsd3_cnt(v, 'matches'), 'ready/3/1');
  perform public.t_gcsd3_assert('T-gcsd3-preview-lists-every-class-from-the-anchor', public.t_gcsd3_classes(v), '3:will_change,4:matches,5:will_change,6:will_change');
  perform public.t_gcsd3_assert('T-gcsd3-preview-wrote-nothing', public.t_gcsd3_pol('A', 3, 6), 'ds/-,DS/package+membership,ds/membership,ds/direct_payment');

  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('A', 3), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-apply-updates-selected-and-following', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_cnt(v, 'matches'), 'updated/3/1');
  perform public.t_gcsd3_assert('T-gcsd3-earlier-occurrences-untouched', public.t_gcsd3_pol('A', 1, 2), 'ds/-,ds/-');
  perform public.t_gcsd3_assert('T-gcsd3-differing-later-settings-overwritten-by-design', public.t_gcsd3_pol('A', 3, 5), 'DS/package+membership,DS/package+membership,DS/package+membership');
  perform public.t_gcsd3_assert('T-gcsd3-unmanaged-funding-preserved-per-class', public.t_gcsd3_pol('A', 6, 6), 'DS/direct_payment+package+membership');
  perform public.t_gcsd3_assert('T-gcsd3-dormant-direct-payment-amount-preserved', (select p.direct_payment_amount::text from public.group_class_enrollment_policies p where p.appointment_id = public.t_gcsd3_o('A', 6)), '25');
  perform public.t_gcsd3_assert('T-gcsd3-unrelated-series-untouched', public.t_gcsd3_pol('B', 1, 4), 'ds/-,ds/-,ds/-,ds/-');
  perform public.t_gcsd3_assert('T-gcsd3-no-policy-rows-created-or-lost',
    (select count(*)::text from public.group_class_enrollment_policies p join public.appointments a on a.id = p.appointment_id where a.studio_id = '00000000-0000-0000-0000-000000f50001' and a.group_class_series_id is not null), '48');
  perform public.t_gcsd3_assert('T-gcsd3-nothing-but-policy-moved-no-override-metadata-no-schema',
    (select (b.other = public.t_gcsd3_other() and b.schema = public.t_gcsd3_schema())::text from public.t_gcsd3_base b), 'true');

  -- repeated identical apply is a no-op that writes nothing (updated_at untouched)
  select md5(string_agg(p.id::text || p.updated_at::text, '|' order by p.id)) into v_before from public.group_class_enrollment_policies p where p.appointment_id in (select id from public.t_gcsd3_occ where label = 'A');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('A', 3), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-repeat-is-a-no-op-result', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_cnt(v, 'matches'), 'noop/0/4');
  perform public.t_gcsd3_assert('T-gcsd3-repeat-wrote-nothing', (select (md5(string_agg(p.id::text || p.updated_at::text, '|' order by p.id)) = v_before)::text from public.group_class_enrollment_policies p where p.appointment_id in (select id from public.t_gcsd3_occ where label = 'A')), 'true');
  v := public.t_gcsd3_pv('FD', public.t_gcsd3_o('A', 3), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-no-op-preview-when-everything-matches', (v ->> 'outcome') || '/' || public.t_gcsd3_cnt(v, 'will_change'), 'noop/0');

  -- turning settings off is an ordinary change, and the discovery switch is independent of funding when other funding remains
  v := public.t_gcsd3_ap('FD', public.t_gcsd3_o('A', 5), false, false, false, true);
  perform public.t_gcsd3_assert('T-gcsd3-front-desk-can-apply-and-unset-package', (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('A', 3, 6), '2/DS/package+membership,DS/package+membership,ds/membership,ds/direct_payment+membership');
end $$;

-- ============================================================================
-- 4. ATOMIC REFUSAL, STALE COUNT, MISSING POLICY ROW (series E, H)
-- ============================================================================
-- E: occurrence 3 carries unmanaged funding, so discovery with no managed funding is valid there; occurrence 4 has none, so it is not
update public.group_class_enrollment_policies set accepted_funding_types = array['manual_other']::text[] where appointment_id = public.t_gcsd3_o('E', 3);
do $$
declare v jsonb;
begin
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('E', 3), true, false, false, false);
  perform public.t_gcsd3_assert('T-gcsd3-one-unfit-class-blocks-and-is-named-preview', (v ->> 'outcome') || '/' || public.t_gcsd3_classes(v), 'blocked/3:will_change,4:blocked_requires_funding');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('E', 3), true, false, false, false);
  perform public.t_gcsd3_assert('T-gcsd3-one-unfit-class-rolls-back-the-whole-operation', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('E', 1, 4), 'blocked/0/ds/-,ds/-,ds/manual_other,ds/-');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('E', 1), true, false, true, false);
  perform public.t_gcsd3_assert('T-gcsd3-with-valid-funding-every-class-updates', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('E', 1, 4), 'updated/4/Ds/package,Ds/package,Ds/manual_other+package,Ds/package');
end $$;

-- H: occurrence 2 has no policy row (the insert path), stale count refusal
delete from public.group_class_enrollment_policies where appointment_id = public.t_gcsd3_o('H', 2);
do $$
declare v jsonb; v_before text;
begin
  select md5(string_agg(p.id::text || p.updated_at::text || p.publicly_discoverable::text || coalesce(array_to_string(p.accepted_funding_types, '+'), '-'), '|' order by p.id)) into v_before
    from public.group_class_enrollment_policies p where p.appointment_id in (select id from public.t_gcsd3_occ where label = 'H');
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('H', 1), false, false, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-preview-plans-the-missing-row-as-a-change', (v ->> 'outcome') || '/' || public.t_gcsd3_classes(v), 'ready/1:will_change,2:will_change,3:will_change,4:will_change');
  perform public.t_gcsd3_assert('T-gcsd3-preview-leaves-no-inserted-row-no-updated-row-no-timestamp',
    public.t_gcsd3_pol('H', 1, 4) || '/' || (select (md5(string_agg(p.id::text || p.updated_at::text || p.publicly_discoverable::text || coalesce(array_to_string(p.accepted_funding_types, '+'), '-'), '|' order by p.id)) = v_before)::text
      from public.group_class_enrollment_policies p where p.appointment_id in (select id from public.t_gcsd3_occ where label = 'H')),
    'ds/-,none,ds/-,ds/-/true');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('H', 1), false, true, true, true, 99);
  perform public.t_gcsd3_assert('T-gcsd3-stale-expected-count-refused-nothing-changed', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('H', 1, 4), 'changed/0/ds/-,none,ds/-,ds/-');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('H', 1), false, false, true, true, 4);
  perform public.t_gcsd3_assert('T-gcsd3-matching-expected-count-applies-and-creates-the-missing-row', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('H', 1, 4), 'updated/4/ds/package+membership,ds/package+membership,ds/package+membership,ds/package+membership');
  perform public.t_gcsd3_assert('T-gcsd3-created-row-belongs-to-the-studio-and-actor',
    (select (p.studio_id = '00000000-0000-0000-0000-000000f50001' and p.created_by = public.t_gcsd3_uid('OWN'))::text from public.group_class_enrollment_policies p where p.appointment_id = public.t_gcsd3_o('H', 2)), 'true');
end $$;

-- ============================================================================
-- 5. LIFECYCLE: cancelled / ended skipped, skipped anchor never shifted, nothing eligible (series G, I)
-- ============================================================================
select public.t_gcsd3_cancel_class('G', 2);
update public.appointments set starts_at = now() - interval '10 days', ends_at = now() - interval '10 days' + interval '1 hour' where id = public.t_gcsd3_o('G', 3);
do $$
declare v jsonb;
begin
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('G', 1), true, true, true, false);
  perform public.t_gcsd3_assert('T-gcsd3-cancelled-and-ended-classes-skipped-and-reported', public.t_gcsd3_classes(v), '1:will_change,2:skipped_cancelled,3:skipped_ended,4:will_change,5:will_change,6:will_change');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('G', 1), true, true, true, false);
  perform public.t_gcsd3_assert('T-gcsd3-skips-never-block-the-valid-classes', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('G', 1, 6), 'updated/4/DS/package,ds/-,ds/-,DS/package,DS/package,DS/package');
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('G', 2), false, false, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-a-skipped-anchor-is-reported-and-never-shifted', public.t_gcsd3_classes(v), '2:skipped_cancelled,3:skipped_ended,4:will_change,5:will_change,6:will_change');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('G', 2), false, false, false, true);
  perform public.t_gcsd3_assert('T-gcsd3-skipped-anchor-apply-mutates-nothing-on-the-anchor-and-continues-after-it', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('G', 1, 6), 'updated/3/DS/package,ds/-,ds/-,ds/membership,ds/membership,ds/membership');
  perform public.t_gcsd3_assert('T-gcsd3-skipped-anchor-never-reaches-back-to-the-earlier-class', public.t_gcsd3_pol('G', 1, 1), 'DS/package');
end $$;
select public.t_gcsd3_cancel_class('I', 1);
select public.t_gcsd3_cancel_class('I', 2);
do $$
declare v jsonb;
begin
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('I', 1), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-nothing-eligible-is-a-result-not-an-error', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_cnt(v, 'skipped_cancelled'), 'no_eligible_targets/0/2');
end $$;

-- ============================================================================
-- 5b. ATOMIC ROLLBACK WITH A LATE TARGET FAILURE (series J): earlier targets update AND insert successfully inside the
--     attempt, the last target fails (a test-only trigger), and every earlier change is proven rolled back
-- ============================================================================
update public.group_class_enrollment_policies set accepted_funding_types = array['package']::text[] where appointment_id = public.t_gcsd3_o('J', 1);
delete from public.group_class_enrollment_policies where appointment_id = public.t_gcsd3_o('J', 2);
update public.group_class_enrollment_policies set accepted_funding_types = array['membership']::text[] where appointment_id = public.t_gcsd3_o('J', 3);
create function public.t_gcsd3_boom() returns trigger language plpgsql as $$
begin
  if new.appointment_id = public.t_gcsd3_o('J', 4) then raise exception 'test-only late failure'; end if;
  return new;
end $$;
create trigger t_gcsd3_boom_trg before insert or update on public.group_class_enrollment_policies for each row execute function public.t_gcsd3_boom();
do $$
declare v jsonb;
begin
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('J', 1), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-late-failure-preview-shows-earlier-ok-and-the-late-blocker', (v ->> 'outcome') || '/' || public.t_gcsd3_classes(v), 'blocked/1:will_change,2:will_change,3:will_change,4:blocked_other');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('J', 1), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-late-failure-rolls-back-the-earlier-update-and-the-earlier-insert', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('J', 1, 4), 'blocked/0/ds/package,none,ds/membership,ds/-');
end $$;
drop trigger t_gcsd3_boom_trg on public.group_class_enrollment_policies;
do $$
declare v jsonb;
begin
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('J', 1), true, true, true, true);
  perform public.t_gcsd3_assert('T-gcsd3-without-the-failure-the-same-apply-succeeds-including-the-insert', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('J', 1, 4), 'updated/4/DS/package+membership,DS/package+membership,DS/package+membership,DS/package+membership');
end $$;

-- ============================================================================
-- 5c. STALE PREVIEW SEMANTICS (series K, L, M): expected_count is the number of classes the apply would UPDATE
-- ============================================================================
do $$
declare v jsonb;
begin
  -- K: preview says 4; a class that was going to change gets cancelled -> the count differs -> changed, nothing applied
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('K', 1), true, true, true, false);
  perform public.t_gcsd3_assert('T-gcsd3-stale-preview-counts-four', public.t_gcsd3_cnt(v, 'will_change'), '4');
  perform public.t_gcsd3_cancel_class('K', 3);
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('K', 1), true, true, true, false, 4);
  perform public.t_gcsd3_assert('T-gcsd3-stale-a-class-to-be-updated-became-cancelled-is-changed', (v ->> 'outcome') || '/' || public.t_gcsd3_cnt(v, 'will_change') || '/' || public.t_gcsd3_cnt(v, 'skipped_cancelled') || '/' || public.t_gcsd3_pol('K', 1, 4), 'changed/3/1/ds/-,ds/-,ds/-,ds/-');
  -- a differing class becomes matching in between -> the count differs -> changed
  update public.group_class_enrollment_policies set publicly_discoverable = true, self_enrollment_allowed = true, accepted_funding_types = array['package']::text[] where appointment_id = public.t_gcsd3_o('K', 2);
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('K', 1), true, true, true, false, 3);
  perform public.t_gcsd3_assert('T-gcsd3-stale-a-differing-class-became-matching-is-changed', (v ->> 'outcome') || '/' || public.t_gcsd3_cnt(v, 'will_change') || '/' || public.t_gcsd3_cnt(v, 'matches'), 'changed/2/1');
  -- a class that already matched becomes cancelled -> the number to update is unchanged -> safely re-evaluated and applied
  perform public.t_gcsd3_cancel_class('K', 2);
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('K', 1), true, true, true, false, 2);
  perform public.t_gcsd3_assert('T-gcsd3-stale-a-matching-class-became-cancelled-is-safely-reevaluated', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('K', 1, 4), 'updated/2/DS/package,DS/package,ds/-,DS/package');
  -- a matching class becomes differing -> the count grows -> changed (then a fresh preview applies)
  update public.group_class_enrollment_policies set publicly_discoverable = false where appointment_id = public.t_gcsd3_o('K', 4);
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('K', 1), true, true, true, false, 0);
  perform public.t_gcsd3_assert('T-gcsd3-stale-a-matching-class-became-differing-is-changed', (v ->> 'outcome') || '/' || public.t_gcsd3_cnt(v, 'will_change'), 'changed/1');

  -- L: a successor split between preview and apply changes the lineage, not the classes to update -> applied across both segments
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('L', 1), true, true, true, false);
  perform public.t_gcsd3_assert('T-gcsd3-stale-preview-before-split-counts-four', public.t_gcsd3_cnt(v, 'will_change'), '4');
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd3_uid('OWN'))::text, true);
  set local role authenticated;
  v := public.edit_group_class_series_from(public.t_gcsd3_o('L', 3), '00000000-0000-0000-0000-000000f58002'::uuid, '{"title":"L-NEW"}'::jsonb, false);
  reset role;
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('L', 1), true, true, true, false, 4);
  perform public.t_gcsd3_assert('T-gcsd3-stale-a-split-between-preview-and-apply-is-reevaluated-across-both-segments', (v ->> 'outcome') || '/' || (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('L', 1, 4), 'updated/4/DS/package,DS/package,DS/package,DS/package');

  -- M: a missing row appears (already matching) in between -> the count drops -> changed
  delete from public.group_class_enrollment_policies where appointment_id = public.t_gcsd3_o('M', 2);
  v := public.t_gcsd3_pv('OWN', public.t_gcsd3_o('M', 1), true, true, true, false);
  perform public.t_gcsd3_assert('T-gcsd3-stale-preview-with-a-missing-row-counts-four', public.t_gcsd3_cnt(v, 'will_change'), '4');
  insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types)
  values ('00000000-0000-0000-0000-000000f50001', public.t_gcsd3_o('M', 2), true, true, array['package']::text[]);
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('M', 1), true, true, true, false, 4);
  perform public.t_gcsd3_assert('T-gcsd3-stale-a-missing-row-appearing-matching-is-changed', (v ->> 'outcome') || '/' || public.t_gcsd3_cnt(v, 'will_change') || '/' || public.t_gcsd3_cnt(v, 'matches'), 'changed/3/1');
end $$;

-- ============================================================================
-- 6. SPLIT LINEAGE (series D: successor from occurrence 4)
-- ============================================================================
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd3_uid('OWN'))::text, true);
  set local role authenticated;
  v := public.edit_group_class_series_from(public.t_gcsd3_o('D', 4), '00000000-0000-0000-0000-000000f58001'::uuid, '{"title":"D-NEW"}'::jsonb, false);
  reset role;
  perform public.t_gcsd3_assert('T-gcsd3-fixture-series-D-is-split-into-two-segments',
    (select (a3.group_class_series_id <> a4.group_class_series_id and a4.group_class_series_id = a6.group_class_series_id)::text
     from public.appointments a3, public.appointments a4, public.appointments a6
     where a3.id = public.t_gcsd3_o('D', 3) and a4.id = public.t_gcsd3_o('D', 4) and a6.id = public.t_gcsd3_o('D', 6)), 'true');

  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('D', 3), true, true, false, true);
  perform public.t_gcsd3_assert('T-gcsd3-split-apply-from-the-predecessor-segment-spans-both', (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('D', 1, 6), '4/ds/-,ds/-,DS/membership,DS/membership,DS/membership,DS/membership');
  v := public.t_gcsd3_ap('OWN', public.t_gcsd3_o('D', 5), false, false, true, false);
  perform public.t_gcsd3_assert('T-gcsd3-split-apply-from-the-successor-never-reaches-back', (v ->> 'updated_count') || '/' || public.t_gcsd3_pol('D', 1, 6), '2/ds/-,ds/-,DS/membership,DS/membership,ds/package,ds/package');
end $$;

-- ============================================================================
-- 7. Nothing else moved
-- ============================================================================
select public.t_gcsd3_assert('T-gcsd3-attendance-enrollment-money-and-series-defaults-never-changed',
  (select (b.stable = public.t_gcsd3_stable())::text from public.t_gcsd3_base b), 'true');
select public.t_gcsd3_assert('T-gcsd3-no-table-column-or-override-metadata-created',
  (select (b.schema = public.t_gcsd3_schema())::text from public.t_gcsd3_base b), 'true');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsd3_log;

rollback;
