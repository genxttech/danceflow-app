-- GC-S1D-2 -- series ("this and following classes") enrollment / removal, live-Postgres regression suite for
-- 20261021090000_gcsd2_series_enroll_remove.sql.
--
-- Proves, as real tenant roles:
--   AUTHORITY   broad staff (owner, front desk) may preview / apply series enroll and remove; the assigned instructor,
--               another studio's owner, anon and service_role may not (the instructor keeps single-class authority);
--               a client of another studio, a non-series class and a non-group class are refused with stable codes;
--               invalid funding is refused.
--   TRAVERSAL   the selected occurrence and the following ones are targeted, earlier ones are never touched, an unrelated
--               series is untouched, and a split (successor) lineage is traversed across the split.
--   ENROLLMENT  all-eligible enrolls atomically; a full class, a funding-policy refusal, an exhausted finite membership
--               (cumulatively) or a membership that is not the dancer's blocks the WHOLE operation and enrolls nothing;
--               an already-enrolled class is reported and never duplicated; incompatible existing funding is never
--               overwritten; cancelled, ended and (per-dancer) terminal-attendance occurrences are skipped and reported;
--               a stale expected count is refused; nothing eligible is a no-op result; preview never writes.
--   REMOVAL     every removable booked row is cancelled (a checked-in dancer included), earlier rows are untouched,
--               terminal attendance is preserved and reported, not-enrolled is reported, a repeat is a no-op, attendance and
--               money rows never change, and the S1D-1 guard is unweakened.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV AFTER the migration.
-- UUID block ...000000f3....

begin;

create table public.t_gcsd2_log (n serial, msg text);
grant all on public.t_gcsd2_log to public;
grant usage on sequence public.t_gcsd2_log_n_seq to public;
create function public.t_gcsd2_pass(p text) returns void language sql as $$ insert into public.t_gcsd2_log (msg) values (p) $$;
grant execute on function public.t_gcsd2_pass(text) to public;

create function public.t_gcsd2_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsd2_pass(p_label);
end;
$$;
grant execute on function public.t_gcsd2_assert(text, text, text) to public;

create function public.t_gcsd2_uid(p_who text) returns uuid language sql immutable as $x$
  select case p_who
    when 'OWN' then '00000000-0000-0000-0000-000000f31001'
    when 'FD'  then '00000000-0000-0000-0000-000000f31002'
    when 'INS' then '00000000-0000-0000-0000-000000f31003'
    when 'OWB' then '00000000-0000-0000-0000-000000f31005'
  end::uuid
$x$;
grant execute on function public.t_gcsd2_uid(text) to public;

create function public.t_gcsd2_cl(p_n integer) returns uuid language sql immutable as $x$
  select ('00000000-0000-0000-0000-000000f33' || lpad(p_n::text, 3, '0'))::uuid
$x$;
grant execute on function public.t_gcsd2_cl(integer) to public;

-- occurrence ids by series label and index (stable across splits)
create table public.t_gcsd2_occ (label text, idx integer, id uuid);
grant all on public.t_gcsd2_occ to public;
create function public.t_gcsd2_o(p_label text, p_idx integer) returns uuid language sql stable security definer set search_path = 'public' as $x$
  select id from public.t_gcsd2_occ where label = p_label and idx = p_idx
$x$;
grant execute on function public.t_gcsd2_o(text, integer) to public;

-- the four RPCs as a user (errors propagate; the role is always reset on success)
create function public.t_gcsd2_pe(p_who text, p_appt uuid, p_client uuid, p_billing text default 'free_comped', p_pkg uuid default null, p_mem uuid default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid(p_who))::text, true);
  set local role authenticated;
  v := public.preview_group_class_series_enrollment(p_appt, p_client, p_billing, p_pkg, p_mem);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsd2_pe(text, uuid, uuid, text, uuid, uuid) to public;

create function public.t_gcsd2_ae(p_who text, p_appt uuid, p_client uuid, p_billing text default 'free_comped', p_pkg uuid default null, p_mem uuid default null, p_expected integer default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid(p_who))::text, true);
  set local role authenticated;
  v := public.enroll_group_class_series_from(p_appt, p_client, p_billing, p_pkg, p_mem, p_expected);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsd2_ae(text, uuid, uuid, text, uuid, uuid, integer) to public;

create function public.t_gcsd2_pr(p_who text, p_appt uuid, p_client uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid(p_who))::text, true);
  set local role authenticated;
  v := public.preview_group_class_series_removal(p_appt, p_client);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsd2_pr(text, uuid, uuid) to public;

create function public.t_gcsd2_ar(p_who text, p_appt uuid, p_client uuid, p_expected integer default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid(p_who))::text, true);
  set local role authenticated;
  v := public.remove_group_class_series_from(p_appt, p_client, p_expected);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsd2_ar(text, uuid, uuid, integer) to public;

-- run one of the four RPCs as a user; return the error text (null when it succeeded). The role is always reset.
create function public.t_gcsd2_err(p_kind text, p_who text, p_appt uuid, p_client uuid, p_billing text default 'free_comped')
returns text language plpgsql as $$
declare v_err text;
begin
  begin
    if p_kind = 'pe' then perform public.t_gcsd2_pe(p_who, p_appt, p_client, p_billing);
    elsif p_kind = 'ae' then perform public.t_gcsd2_ae(p_who, p_appt, p_client, p_billing);
    elsif p_kind = 'pr' then perform public.t_gcsd2_pr(p_who, p_appt, p_client);
    else perform public.t_gcsd2_ar(p_who, p_appt, p_client);
    end if;
  exception when others then
    v_err := sqlerrm;
  end;
  reset role;
  return v_err;
end $$;
grant execute on function public.t_gcsd2_err(text, text, uuid, uuid, text) to public;

create function public.t_gcsd2_cnt(p_result jsonb, p_key text) returns text language sql immutable as $x$
  select coalesce(p_result -> 'counts' ->> p_key, '0')
$x$;
grant execute on function public.t_gcsd2_cnt(jsonb, text) to public;

-- one char per occurrence idx in [from, to] for a dancer: B booked, x only cancelled, - none
create function public.t_gcsd2_states(p_label text, p_from integer, p_to integer, p_client integer) returns text language sql volatile security definer set search_path = 'public' as $x$
  select string_agg(
    case
      when exists (select 1 from public.appointment_attendees aa where aa.appointment_id = o.id and aa.client_id = public.t_gcsd2_cl(p_client) and aa.status = 'booked') then 'B'
      when exists (select 1 from public.appointment_attendees aa where aa.appointment_id = o.id and aa.client_id = public.t_gcsd2_cl(p_client)) then 'x'
      else '-' end, '' order by o.idx)
  from public.t_gcsd2_occ o where o.label = p_label and o.idx between p_from and p_to
$x$;
grant execute on function public.t_gcsd2_states(text, integer, integer, integer) to public;

create function public.t_gcsd2_rows(p_client integer) returns integer language sql volatile security definer set search_path = 'public' as $x$
  select count(*)::integer from public.appointment_attendees where client_id = public.t_gcsd2_cl(p_client)
$x$;
grant execute on function public.t_gcsd2_rows(integer) to public;

-- classes of a result as "idx:state" in order
create function public.t_gcsd2_classes(p_result jsonb) returns text language sql immutable as $x$
  select string_agg((e ->> 'occurrence_index') || ':' || (e ->> 'state'), ',' order by (e ->> 'occurrence_index')::integer)
  from jsonb_array_elements(p_result -> 'classes') e
$x$;
grant execute on function public.t_gcsd2_classes(jsonb) to public;

-- attendance and money fingerprint
create function public.t_gcsd2_attn() returns text language sql volatile security definer set search_path = 'public' as $x$
  select md5(coalesce((select string_agg(to_jsonb(ar)::text, '|' order by ar.id) from public.attendance_records ar where ar.studio_id = '00000000-0000-0000-0000-000000f30001'), ''))
$x$;
grant execute on function public.t_gcsd2_attn() to public;
create function public.t_gcsd2_money() returns text language sql volatile security definer set search_path = 'public' as $x$
  select md5(
    coalesce((select string_agg(to_jsonb(u)::text, '|' order by u.id) from public.client_membership_usage u), '')
    || coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.id) from public.client_package_items i), '')
    || coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from public.client_packages p where p.studio_id = '00000000-0000-0000-0000-000000f30001'), ''))
$x$;
grant execute on function public.t_gcsd2_money() to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000f30001', 'GC-S1D-2 Harness Studio A', 't-gcsd2-a', 'America/New_York'),
  ('00000000-0000-0000-0000-000000f30002', 'GC-S1D-2 Harness Studio B', 't-gcsd2-b', 'America/New_York');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f31001', 't-gcsd2-owner@example.test'),
  ('00000000-0000-0000-0000-000000f31002', 't-gcsd2-frontdesk@example.test'),
  ('00000000-0000-0000-0000-000000f31003', 't-gcsd2-instructor@example.test'),
  ('00000000-0000-0000-0000-000000f31005', 't-gcsd2-owner-b@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000f31001', 't-gcsd2-owner@example.test', null),
  ('00000000-0000-0000-0000-000000f31002', 't-gcsd2-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-000000f31003', 't-gcsd2-instructor@example.test', null),
  ('00000000-0000-0000-0000-000000f31005', 't-gcsd2-owner-b@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000f31001', '00000000-0000-0000-0000-000000f30001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000f31002', '00000000-0000-0000-0000-000000f30001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000f31003', '00000000-0000-0000-0000-000000f30001', 'instructor', true),
  ('00000000-0000-0000-0000-000000f31005', '00000000-0000-0000-0000-000000f30002', 'studio_owner', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000f32001', '00000000-0000-0000-0000-000000f30001', '00000000-0000-0000-0000-000000f31003', 'Series', 'Instructor', true, true);
alter table public.instructors enable trigger user;

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor)
select public.t_gcsd2_cl(n),
       case when n = 20 then '00000000-0000-0000-0000-000000f30002' else '00000000-0000-0000-0000-000000f30001' end::uuid,
       'C', 'N' || n, 'active', false
from generate_series(1, 20) n;

-- fixture series (through the released B1 RPC, as the owner); records the occurrence ids
create function public.t_gcsd2_series(p_label text, p_req text, p_count integer, p_weekday integer, p_hour integer, p_capacity integer) returns void language plpgsql as $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid('OWN'))::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f30001', p_client_request_id => p_req::uuid,
    p_title => 'SER-' || p_label, p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000f32001', p_room_id => null, p_location_name => null, p_roster_capacity => p_capacity,
    p_weekdays => array[p_weekday]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => p_count,
    p_local_start_time => make_time(p_hour, 0, 0), p_duration_minutes => 60);
  reset role;
  insert into public.t_gcsd2_occ (label, idx, id)
  select p_label, a.series_occurrence_index, a.id
  from public.appointments a where a.group_class_series_id = (v_res ->> 'series_id')::uuid;
end $$;

select public.t_gcsd2_series('A', '00000000-0000-0000-0000-000000f37001', 6, 1, 9, null);   -- main enroll / remove
select public.t_gcsd2_series('B', '00000000-0000-0000-0000-000000f37002', 4, 2, 10, 2);     -- capacity 2
select public.t_gcsd2_series('C', '00000000-0000-0000-0000-000000f37003', 3, 3, 11, null);  -- unrelated series
select public.t_gcsd2_series('D', '00000000-0000-0000-0000-000000f37004', 6, 4, 12, null);  -- split lineage
select public.t_gcsd2_series('E', '00000000-0000-0000-0000-000000f37005', 4, 5, 13, null);  -- finite membership
select public.t_gcsd2_series('F', '00000000-0000-0000-0000-000000f37006', 3, 6, 14, null);  -- funding policy
select public.t_gcsd2_series('G', '00000000-0000-0000-0000-000000f37007', 6, 7, 15, null);  -- cancelled / ended / terminal
select public.t_gcsd2_series('H', '00000000-0000-0000-0000-000000f37008', 2, 1, 16, null);  -- nothing eligible
select public.t_gcsd2_series('I', '00000000-0000-0000-0000-000000f37009', 3, 2, 17, null);  -- incompatible funding / stale count

-- a non-series group class and a private lesson in studio A
insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000f34001', '00000000-0000-0000-0000-000000f30001', '00000000-0000-0000-0000-000000f32001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', 'STANDALONE');
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000f34002', '00000000-0000-0000-0000-000000f30001', public.t_gcsd2_cl(1), '00000000-0000-0000-0000-000000f32001', 'private_lesson', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour', 'PRIVATE');

-- finite memberships: P2 allows 2 classes per period, P5 allows 5 (c4 holds the first, c5 the second)
insert into public.membership_plans (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-000000f3a001', '00000000-0000-0000-0000-000000f30001', 'GCSD2 Two Plan', true),
  ('00000000-0000-0000-0000-000000f3a002', '00000000-0000-0000-0000-000000f30001', 'GCSD2 Five Plan', true);
insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, usage_period) values
  ('00000000-0000-0000-0000-000000f3b001', '00000000-0000-0000-0000-000000f3a001', 'included_group_classes', 2, 'billing_cycle'),
  ('00000000-0000-0000-0000-000000f3b002', '00000000-0000-0000-0000-000000f3a002', 'included_group_classes', 5, 'billing_cycle');
insert into public.client_memberships (id, studio_id, client_id, membership_plan_id, name_snapshot, status, starts_on, current_period_start, current_period_end, billing_interval_snapshot, auto_renew, price_snapshot, created_by) values
  ('00000000-0000-0000-0000-000000f3c001', '00000000-0000-0000-0000-000000f30001', public.t_gcsd2_cl(4), '00000000-0000-0000-0000-000000f3a001', 'GCSD2 Two Plan', 'active', current_date - 1, current_date - 1, current_date + 90, 'monthly', true, 0, '00000000-0000-0000-0000-000000f31001'),
  ('00000000-0000-0000-0000-000000f3c002', '00000000-0000-0000-0000-000000f30001', public.t_gcsd2_cl(5), '00000000-0000-0000-0000-000000f3a002', 'GCSD2 Five Plan', 'active', current_date - 1, current_date - 1, current_date + 90, 'monthly', true, 0, '00000000-0000-0000-0000-000000f31001');
insert into public.client_membership_periods (studio_id, client_id, client_membership_id, period_start, period_end, amount_due, amount_paid, currency, payment_status, payment_due_at, created_by)
select studio_id, client_id, id, current_period_start, current_period_end, 0, 0, 'usd', 'paid', current_period_start::timestamptz, created_by
from public.client_memberships where id in ('00000000-0000-0000-0000-000000f3c001', '00000000-0000-0000-0000-000000f3c002');

-- baseline fingerprints
create table public.t_gcsd2_base as select public.t_gcsd2_attn() as attn, public.t_gcsd2_money() as money;

-- ============================================================================
-- 1. POSTURE
-- ============================================================================
select public.t_gcsd2_assert('T-gcsd2-public-rpcs-authenticated-only-definer-search-path',
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text || '/' || has_function_privilege('anon', p.oid, 'execute')::text || '/' || has_function_privilege('service_role', p.oid, 'execute')::text, ';' order by p.proname)
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('preview_group_class_series_enrollment', 'enroll_group_class_series_from', 'preview_group_class_series_removal', 'remove_group_class_series_from')),
  'enroll_group_class_series_from:true:search_path=public:true/false/false;preview_group_class_series_enrollment:true:search_path=public:true/false/false;preview_group_class_series_removal:true:search_path=public:true/false/false;remove_group_class_series_from:true:search_path=public:true/false/false');
select public.t_gcsd2_assert('T-gcsd2-helpers-are-granted-to-no-tenant-role',
  (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_gcsd2\_%' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))), '0');
select public.t_gcsd2_assert('T-gcsd2-anon-cannot-call-the-rpcs',
  (select case when public.t_gcsd2_err('pe', 'OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)) is null then 'owner-ok' else 'owner-failed' end), 'owner-ok');
do $$
declare v_err text;
begin
  set local role anon;
  begin perform public.preview_group_class_series_enrollment(public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1), 'free_comped', null, null);
  exception when others then v_err := sqlerrm; end;
  reset role;
  perform public.t_gcsd2_assert('T-gcsd2-anon-denied', coalesce(case when v_err ilike '%permission denied%' then 'denied' else v_err end, 'no error'), 'denied');
  v_err := null;
  set local role service_role;
  begin perform public.remove_group_class_series_from(public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1), null);
  exception when others then v_err := sqlerrm; end;
  reset role;
  perform public.t_gcsd2_assert('T-gcsd2-service-role-denied', coalesce(case when v_err ilike '%permission denied%' then 'denied' else v_err end, 'no error'), 'denied');
end $$;

-- ============================================================================
-- 2. AUTHORITY
-- ============================================================================
select public.t_gcsd2_assert('T-gcsd2-owner-preview-enroll-allowed-and-read-only',
  (public.t_gcsd2_pe('OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)) ->> 'outcome') || '/' || public.t_gcsd2_rows(1)::text, 'ready/0');
select public.t_gcsd2_assert('T-gcsd2-front-desk-preview-enroll-allowed',
  public.t_gcsd2_pe('FD', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)) ->> 'outcome', 'ready');
select public.t_gcsd2_assert('T-gcsd2-front-desk-preview-remove-allowed',
  public.t_gcsd2_pr('FD', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)) ->> 'outcome', 'noop');

select public.t_gcsd2_assert('T-gcsd2-instructor-preview-enroll-refused',
  left(public.t_gcsd2_err('pe', 'INS', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)), 17), 'GCSD2_UNAUTHORIZE');
select public.t_gcsd2_assert('T-gcsd2-instructor-apply-enroll-refused',
  left(public.t_gcsd2_err('ae', 'INS', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)), 17), 'GCSD2_UNAUTHORIZE');
select public.t_gcsd2_assert('T-gcsd2-instructor-preview-remove-refused',
  left(public.t_gcsd2_err('pr', 'INS', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)), 17), 'GCSD2_UNAUTHORIZE');
select public.t_gcsd2_assert('T-gcsd2-instructor-apply-remove-refused',
  left(public.t_gcsd2_err('ar', 'INS', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)), 17), 'GCSD2_UNAUTHORIZE');
select public.t_gcsd2_assert('T-gcsd2-instructor-refusal-created-no-rows', public.t_gcsd2_rows(1)::text, '0');
select public.t_gcsd2_assert('T-gcsd2-other-studio-owner-refused-enroll',
  left(public.t_gcsd2_err('ae', 'OWB', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)), 17), 'GCSD2_UNAUTHORIZE');
select public.t_gcsd2_assert('T-gcsd2-other-studio-owner-refused-remove',
  left(public.t_gcsd2_err('ar', 'OWB', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1)), 17), 'GCSD2_UNAUTHORIZE');
select public.t_gcsd2_assert('T-gcsd2-client-of-another-studio-refused',
  left(public.t_gcsd2_err('ae', 'OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(20)), 23), 'GCSD2_CLIENT_NOT_FOUND:');
select public.t_gcsd2_assert('T-gcsd2-non-series-group-class-refused',
  left(public.t_gcsd2_err('ae', 'OWN', '00000000-0000-0000-0000-000000f34001'::uuid, public.t_gcsd2_cl(1)), 26), 'GCSD2_NOT_A_SERIES_OCCURRE');
select public.t_gcsd2_assert('T-gcsd2-non-group-class-appointment-refused',
  left(public.t_gcsd2_err('pe', 'OWN', '00000000-0000-0000-0000-000000f34002'::uuid, public.t_gcsd2_cl(1)), 16), 'GCSD2_NOT_FOUND:');
select public.t_gcsd2_assert('T-gcsd2-unknown-class-refused',
  left(public.t_gcsd2_err('ar', 'OWN', '00000000-0000-0000-0000-000000f3ffff'::uuid, public.t_gcsd2_cl(1)), 16), 'GCSD2_NOT_FOUND:');
select public.t_gcsd2_assert('T-gcsd2-invalid-billing-type-refused',
  left(public.t_gcsd2_err('ae', 'OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1), 'cash'), 20), 'GCSD2_INVALID_FUNDIN');
select public.t_gcsd2_assert('T-gcsd2-membership-without-a-membership-refused',
  left(public.t_gcsd2_err('ae', 'OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1), 'membership'), 20), 'GCSD2_INVALID_FUNDIN');

-- ============================================================================
-- 3. TRAVERSAL + all-eligible enrollment (series A, unrelated series C)
-- ============================================================================
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('A', 3), public.t_gcsd2_cl(1));
  perform public.t_gcsd2_assert('T-gcsd2-enroll-from-3-enrolls-4-atomically', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_cnt(v, 'will_enroll'), 'enrolled/4/4');
  perform public.t_gcsd2_assert('T-gcsd2-enroll-from-3-selected-and-following-only', public.t_gcsd2_states('A', 1, 6, 1), '--BBBB');
  perform public.t_gcsd2_assert('T-gcsd2-unrelated-series-untouched', public.t_gcsd2_states('C', 1, 3, 1), '---');
  perform public.t_gcsd2_assert('T-gcsd2-result-lists-every-class-in-order', public.t_gcsd2_classes(v), '3:will_enroll,4:will_enroll,5:will_enroll,6:will_enroll');
  perform public.t_gcsd2_assert('T-gcsd2-rows-are-ordinary-staff-attendees',
    (select string_agg(distinct aa.source || '/' || aa.billing_type || '/' || aa.status, ',') from public.appointment_attendees aa where aa.client_id = public.t_gcsd2_cl(1)), 'staff/free_comped/booked');
end $$;

-- ============================================================================
-- 4. IDEMPOTENCY: already enrolled is reported, never duplicated
-- ============================================================================
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_pe('OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1));
  perform public.t_gcsd2_assert('T-gcsd2-preview-counts-already-enrolled', public.t_gcsd2_cnt(v, 'will_enroll') || '/' || public.t_gcsd2_cnt(v, 'already_enrolled') || '/' || (v ->> 'outcome'), '2/4/ready');
  perform public.t_gcsd2_assert('T-gcsd2-preview-wrote-nothing', public.t_gcsd2_states('A', 1, 6, 1), '--BBBB');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1));
  perform public.t_gcsd2_assert('T-gcsd2-enroll-from-1-adds-only-the-missing', public.t_gcsd2_states('A', 1, 6, 1) || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_cnt(v, 'already_enrolled'), 'BBBBBB/2/4');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('A', 1), public.t_gcsd2_cl(1));
  perform public.t_gcsd2_assert('T-gcsd2-repeat-is-a-no-op-result', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_cnt(v, 'already_enrolled') || '/' || public.t_gcsd2_rows(1)::text, 'noop/0/6/6');
  perform public.t_gcsd2_assert('T-gcsd2-no-duplicate-booked-rows',
    (select (count(*) - count(distinct (appointment_id, client_id)))::text from public.appointment_attendees where status = 'booked' and studio_id = '00000000-0000-0000-0000-000000f30001'), '0');
end $$;

-- ============================================================================
-- 5. ATOMICITY: full class, funding policy, finite membership, foreign membership
-- ============================================================================
-- capacity: series B (capacity 2); occurrence 3 is already full
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type)
select '00000000-0000-0000-0000-000000f30001', public.t_gcsd2_o('B', 3), public.t_gcsd2_cl(n), 'booked', 'staff', 'free_comped' from unnest(array[11, 12]) n;
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_pe('OWN', public.t_gcsd2_o('B', 2), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-full-target-preview-blocked-and-names-the-class', (v ->> 'outcome') || '/' || public.t_gcsd2_classes(v), 'blocked/2:will_enroll,3:blocked_capacity,4:will_enroll');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('B', 2), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-full-target-apply-blocked-nothing-enrolled', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_states('B', 1, 4, 2) || '/' || public.t_gcsd2_rows(2)::text, 'blocked/0/----/0');
  perform public.t_gcsd2_assert('T-gcsd2-full-target-counts', public.t_gcsd2_cnt(v, 'blocked_capacity'), '1');
end $$;

-- funding policy: occurrence 2 of series F accepts only membership funding
update public.group_class_enrollment_policies set accepted_funding_types = array['membership']::text[]
  where appointment_id = public.t_gcsd2_o('F', 2);
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('F', 1), public.t_gcsd2_cl(3));
  perform public.t_gcsd2_assert('T-gcsd2-funding-policy-blocks-whole-operation', (v ->> 'outcome') || '/' || public.t_gcsd2_classes(v) || '/' || public.t_gcsd2_rows(3)::text, 'blocked/1:will_enroll,2:blocked_funding_policy,3:will_enroll/0');
end $$;

-- finite membership: c4 holds a 2-class allowance for 4 classes (cumulative), c5 holds 5
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_pe('OWN', public.t_gcsd2_o('E', 1), public.t_gcsd2_cl(4), 'membership', null, '00000000-0000-0000-0000-000000f3c001');
  perform public.t_gcsd2_assert('T-gcsd2-finite-membership-exhausted-cumulatively-preview', (v ->> 'outcome') || '/' || public.t_gcsd2_classes(v), 'blocked/1:will_enroll,2:will_enroll,3:blocked_membership_allowance,4:blocked_membership_allowance');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('E', 1), public.t_gcsd2_cl(4), 'membership', null, '00000000-0000-0000-0000-000000f3c001');
  perform public.t_gcsd2_assert('T-gcsd2-finite-membership-apply-blocked-none-enrolled', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_rows(4)::text, 'blocked/0/0');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('E', 3), public.t_gcsd2_cl(4), 'membership', null, '00000000-0000-0000-0000-000000f3c001');
  perform public.t_gcsd2_assert('T-gcsd2-finite-membership-within-allowance-enrolls', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_states('E', 1, 4, 4), 'enrolled/2/--BB');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('E', 1), public.t_gcsd2_cl(5), 'membership', null, '00000000-0000-0000-0000-000000f3c002');
  perform public.t_gcsd2_assert('T-gcsd2-larger-membership-enrolls-every-class', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_states('E', 1, 4, 5), 'enrolled/4/BBBB');
  perform public.t_gcsd2_assert('T-gcsd2-membership-rows-keep-the-membership',
    (select string_agg(distinct aa.billing_type || '/' || coalesce(aa.client_membership_id::text, 'none'), ',') from public.appointment_attendees aa where aa.client_id = public.t_gcsd2_cl(5)), 'membership/00000000-0000-0000-0000-000000f3c002');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('I', 1), public.t_gcsd2_cl(6), 'membership', null, '00000000-0000-0000-0000-000000f3c002');
  perform public.t_gcsd2_assert('T-gcsd2-another-dancers-membership-blocked', (v ->> 'outcome') || '/' || public.t_gcsd2_cnt(v, 'blocked_funding_invalid') || '/' || public.t_gcsd2_rows(6)::text, 'blocked/3/0');
end $$;

-- ============================================================================
-- 6. INCOMPATIBLE EXISTING ENROLLMENT + stale expected count (series I)
-- ============================================================================
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type)
values ('00000000-0000-0000-0000-000000f30001', public.t_gcsd2_o('I', 2), public.t_gcsd2_cl(7), 'booked', 'staff', 'pay_as_you_go');
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('I', 1), public.t_gcsd2_cl(7), 'free_comped');
  perform public.t_gcsd2_assert('T-gcsd2-incompatible-existing-funding-blocks', (v ->> 'outcome') || '/' || public.t_gcsd2_classes(v), 'blocked/1:will_enroll,2:blocked_incompatible,3:will_enroll');
  perform public.t_gcsd2_assert('T-gcsd2-incompatible-enrollment-not-overwritten-and-nothing-added',
    public.t_gcsd2_states('I', 1, 3, 7) || '/' || (select aa.billing_type from public.appointment_attendees aa where aa.appointment_id = public.t_gcsd2_o('I', 2) and aa.client_id = public.t_gcsd2_cl(7)), '-B-/pay_as_you_go');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('I', 1), public.t_gcsd2_cl(7), 'pay_as_you_go');
  perform public.t_gcsd2_assert('T-gcsd2-matching-existing-funding-is-compatible', (v ->> 'outcome') || '/' || public.t_gcsd2_states('I', 1, 3, 7), 'enrolled/BBB');
end $$;
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('I', 1), public.t_gcsd2_cl(8), 'free_comped', null, null, 99);
  perform public.t_gcsd2_assert('T-gcsd2-stale-expected-count-refused-nothing-enrolled', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_rows(8)::text, 'changed/0/0');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('I', 1), public.t_gcsd2_cl(8), 'free_comped', null, null, 3);
  perform public.t_gcsd2_assert('T-gcsd2-matching-expected-count-applies', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count'), 'enrolled/3');
  v := public.t_gcsd2_ar('OWN', public.t_gcsd2_o('I', 1), public.t_gcsd2_cl(8), 99);
  perform public.t_gcsd2_assert('T-gcsd2-stale-expected-removal-count-refused', (v ->> 'outcome') || '/' || public.t_gcsd2_states('I', 1, 3, 8), 'changed/BBB');
end $$;

-- ============================================================================
-- 7. SKIPPED OCCURRENCES: cancelled, ended, per-dancer terminal attendance (series G); nothing eligible (series H)
-- ============================================================================
create function public.t_gcsd2_cancel_class(p_label text, p_idx integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid('OWN'))::text, true);
  set local role authenticated;
  perform public.cancel_group_class_appointment(public.t_gcsd2_o(p_label, p_idx));
  reset role;
end $$;
grant execute on function public.t_gcsd2_cancel_class(text, integer) to public;

-- G: occurrence 2 cancelled (released RPC), 3 ended (past), 4 in progress with c8's terminal attendance, c10 booked on the ended class 3
select public.t_gcsd2_cancel_class('G', 2);
update public.appointments set starts_at = now() - interval '10 days', ends_at = now() - interval '10 days' + interval '1 hour' where id = public.t_gcsd2_o('G', 3);
update public.appointments set starts_at = now() - interval '30 minutes', ends_at = now() + interval '30 minutes' where id = public.t_gcsd2_o('G', 4);
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type) values
  ('00000000-0000-0000-0000-000000f30001', public.t_gcsd2_o('G', 4), public.t_gcsd2_cl(8), 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000f30001', public.t_gcsd2_o('G', 3), public.t_gcsd2_cl(10), 'booked', 'staff', 'free_comped');
insert into public.attendance_records (studio_id, appointment_id, client_id, status)
values ('00000000-0000-0000-0000-000000f30001', public.t_gcsd2_o('G', 4), public.t_gcsd2_cl(8), 'attended');

do $$
declare v jsonb;
begin
  v := public.t_gcsd2_pe('OWN', public.t_gcsd2_o('G', 1), public.t_gcsd2_cl(8));
  perform public.t_gcsd2_assert('T-gcsd2-skips-cancelled-ended-and-terminal-for-this-dancer',
    public.t_gcsd2_classes(v), '1:will_enroll,2:skipped_cancelled,3:skipped_ended,4:skipped_terminal,5:will_enroll,6:will_enroll');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('G', 1), public.t_gcsd2_cl(8));
  perform public.t_gcsd2_assert('T-gcsd2-skips-do-not-block-the-valid-classes', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_states('G', 1, 6, 8), 'enrolled/3/B--BBB');
  perform public.t_gcsd2_assert('T-gcsd2-skipped-counts', public.t_gcsd2_cnt(v, 'skipped_cancelled') || '/' || public.t_gcsd2_cnt(v, 'skipped_ended') || '/' || public.t_gcsd2_cnt(v, 'skipped_terminal'), '1/1/1');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('G', 1), public.t_gcsd2_cl(9));
  perform public.t_gcsd2_assert('T-gcsd2-terminal-attendance-is-per-dancer', (v ->> 'enrolled_count') || '/' || public.t_gcsd2_states('G', 1, 6, 9) || '/' || public.t_gcsd2_cnt(v, 'skipped_terminal'), '4/B--BBB/0');
end $$;

-- H: every class cancelled, so nothing is eligible
select public.t_gcsd2_cancel_class('H', 1);
select public.t_gcsd2_cancel_class('H', 2);
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_pe('OWN', public.t_gcsd2_o('H', 1), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-nothing-eligible-preview', (v ->> 'outcome') || '/' || public.t_gcsd2_cnt(v, 'skipped_cancelled'), 'no_eligible_targets/2');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('H', 1), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-nothing-eligible-apply-is-a-result-not-an-error', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_rows(2)::text, 'no_eligible_targets/0/0');
  v := public.t_gcsd2_ar('OWN', public.t_gcsd2_o('H', 1), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-nothing-to-remove-is-a-no-op-result', (v ->> 'outcome') || '/' || public.t_gcsd2_cnt(v, 'skipped_cancelled'), 'noop/2');
end $$;

-- ============================================================================
-- 8. REMOVAL (series A: c1 is booked on 1..6; 4 is in progress with a checked-in record, 5 has an attended record)
-- ============================================================================
update public.appointments set starts_at = now() - interval '30 minutes', ends_at = now() + interval '30 minutes' where id = public.t_gcsd2_o('A', 4);
update public.appointments set starts_at = now() - interval '20 minutes', ends_at = now() + interval '40 minutes' where id = public.t_gcsd2_o('A', 5);
insert into public.attendance_records (studio_id, appointment_id, client_id, status) values
  ('00000000-0000-0000-0000-000000f30001', public.t_gcsd2_o('A', 4), public.t_gcsd2_cl(1), 'checked_in'),
  ('00000000-0000-0000-0000-000000f30001', public.t_gcsd2_o('A', 5), public.t_gcsd2_cl(1), 'attended');
create table public.t_gcsd2_base2 as select public.t_gcsd2_attn() as attn, public.t_gcsd2_money() as money;

do $$
declare v jsonb; v_rows integer;
begin
  v := public.t_gcsd2_pr('OWN', public.t_gcsd2_o('A', 2), public.t_gcsd2_cl(1));
  perform public.t_gcsd2_assert('T-gcsd2-removal-preview-classifies-every-class',
    (v ->> 'outcome') || '/' || public.t_gcsd2_classes(v), 'ready/2:will_remove,3:will_remove,4:will_remove,5:skipped_terminal,6:will_remove');
  perform public.t_gcsd2_assert('T-gcsd2-removal-preview-wrote-nothing', public.t_gcsd2_states('A', 1, 6, 1), 'BBBBBB');
  v := public.t_gcsd2_ar('FD', public.t_gcsd2_o('A', 2), public.t_gcsd2_cl(1), 4);
  perform public.t_gcsd2_assert('T-gcsd2-front-desk-removes-the-removable-rows-including-checked-in', (v ->> 'outcome') || '/' || (v ->> 'removed_count') || '/' || public.t_gcsd2_states('A', 1, 6, 1), 'removed/4/BxxxBx');
  perform public.t_gcsd2_assert('T-gcsd2-terminal-attendance-class-reported-and-kept', public.t_gcsd2_cnt(v, 'skipped_terminal') || '/' || public.t_gcsd2_classes(v), '1/2:will_remove,3:will_remove,4:will_remove,5:skipped_terminal,6:will_remove');
  perform public.t_gcsd2_assert('T-gcsd2-removed-rows-are-cancelled-with-actor',
    (select count(*)::text from public.appointment_attendees aa where aa.client_id = public.t_gcsd2_cl(1) and aa.status = 'cancelled' and aa.cancelled_at is not null and aa.cancelled_by = public.t_gcsd2_uid('FD')), '4');
  perform public.t_gcsd2_assert('T-gcsd2-removal-never-moves-attendance-or-money',
    (select (b.attn = public.t_gcsd2_attn() and b.money = public.t_gcsd2_money())::text from public.t_gcsd2_base2 b), 'true');
  v := public.t_gcsd2_ar('OWN', public.t_gcsd2_o('A', 2), public.t_gcsd2_cl(1));
  perform public.t_gcsd2_assert('T-gcsd2-repeated-removal-is-a-no-op-result', (v ->> 'outcome') || '/' || (v ->> 'removed_count') || '/' || public.t_gcsd2_cnt(v, 'not_enrolled') || '/' || public.t_gcsd2_cnt(v, 'skipped_terminal'), 'noop/0/4/1');
end $$;
do $$
declare v_err text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid('OWN'))::text, true);
  set local role authenticated;
  begin
    perform public.cancel_class_attendee((select aa.id from public.appointment_attendees aa where aa.appointment_id = public.t_gcsd2_o('A', 5) and aa.client_id = public.t_gcsd2_cl(1)));
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  perform public.t_gcsd2_assert('T-gcsd2-s1d1-guard-still-refuses-the-attended-dancer', coalesce(case when v_err like 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED%' then 'refused' else v_err end, 'no error'), 'refused');
  perform public.t_gcsd2_assert('T-gcsd2-attended-dancer-still-booked', public.t_gcsd2_states('A', 5, 5, 1), 'B');
end $$;

-- re-enrollment after removal creates fresh rows; the terminal-attendance class is still skipped
do $$
declare v jsonb;
begin
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('A', 2), public.t_gcsd2_cl(1));
  perform public.t_gcsd2_assert('T-gcsd2-reenroll-after-removal', (v ->> 'outcome') || '/' || (v ->> 'enrolled_count') || '/' || public.t_gcsd2_cnt(v, 'skipped_terminal') || '/' || public.t_gcsd2_states('A', 1, 6, 1), 'enrolled/4/1/BBBBBB');
  perform public.t_gcsd2_assert('T-gcsd2-no-duplicate-booked-rows-after-reenrollment',
    (select (count(*) - count(distinct (appointment_id, client_id)))::text from public.appointment_attendees where status = 'booked' and studio_id = '00000000-0000-0000-0000-000000f30001'), '0');
end $$;

-- G removals: cancelled / ended / terminal classes are skipped, other dancers are untouched
do $$
declare v jsonb; v_c9_before integer;
begin
  v_c9_before := public.t_gcsd2_rows(9);
  v := public.t_gcsd2_ar('FD', public.t_gcsd2_o('G', 1), public.t_gcsd2_cl(8));
  perform public.t_gcsd2_assert('T-gcsd2-remove-skips-cancelled-ended-and-terminal',
    (v ->> 'removed_count') || '/' || public.t_gcsd2_cnt(v, 'skipped_cancelled') || '/' || public.t_gcsd2_cnt(v, 'skipped_ended') || '/' || public.t_gcsd2_cnt(v, 'skipped_terminal') || '/' || public.t_gcsd2_states('G', 1, 6, 8), '3/1/1/1/x--Bxx');
  perform public.t_gcsd2_assert('T-gcsd2-another-dancer-untouched', public.t_gcsd2_states('G', 1, 6, 9) || '/' || (public.t_gcsd2_rows(9) = v_c9_before)::text, 'B--BBB/true');
  v := public.t_gcsd2_ar('OWN', public.t_gcsd2_o('G', 1), public.t_gcsd2_cl(9));
  perform public.t_gcsd2_assert('T-gcsd2-dancer-without-terminal-attendance-fully-removed', (v ->> 'removed_count') || '/' || public.t_gcsd2_states('G', 1, 6, 9), '4/x--xxx');
  v := public.t_gcsd2_ar('OWN', public.t_gcsd2_o('G', 1), public.t_gcsd2_cl(10));
  perform public.t_gcsd2_assert('T-gcsd2-booking-on-an-ended-class-is-preserved', (v ->> 'outcome') || '/' || public.t_gcsd2_cnt(v, 'skipped_ended') || '/' || public.t_gcsd2_states('G', 1, 6, 10), 'noop/1/--B---');
  perform public.t_gcsd2_assert('T-gcsd2-client-of-another-studio-refused-on-removal',
    left(public.t_gcsd2_err('ar', 'OWN', public.t_gcsd2_o('G', 1), public.t_gcsd2_cl(20)), 23), 'GCSD2_CLIENT_NOT_FOUND:');
end $$;

-- the assigned instructor keeps single-class removal authority (series B class 3, instructor of record)
do $$
declare v_err text; v_att uuid;
begin
  select aa.id into v_att from public.appointment_attendees aa where aa.appointment_id = public.t_gcsd2_o('B', 3) and aa.client_id = public.t_gcsd2_cl(11);
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid('INS'))::text, true);
  set local role authenticated;
  begin
    perform public.cancel_class_attendee(v_att);
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  perform public.t_gcsd2_assert('T-gcsd2-instructor-keeps-single-class-removal', coalesce(v_err, 'ok') || '/' || public.t_gcsd2_states('B', 3, 3, 11), 'ok/x');
end $$;

-- ============================================================================
-- 9. SPLIT LINEAGE (series D: successor from occurrence 4)
-- ============================================================================
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsd2_uid('OWN'))::text, true);
  set local role authenticated;
  v := public.edit_group_class_series_from(public.t_gcsd2_o('D', 4), '00000000-0000-0000-0000-000000f38001'::uuid, '{"title":"D-NEW"}'::jsonb, false);
  reset role;
  perform public.t_gcsd2_assert('T-gcsd2-fixture-series-D-is-split-into-two-segments',
    (select (a3.group_class_series_id <> a4.group_class_series_id and a4.group_class_series_id = a6.group_class_series_id)::text
     from public.appointments a3, public.appointments a4, public.appointments a6
     where a3.id = public.t_gcsd2_o('D', 3) and a4.id = public.t_gcsd2_o('D', 4) and a6.id = public.t_gcsd2_o('D', 6)), 'true');

  v := public.t_gcsd2_pe('OWN', public.t_gcsd2_o('D', 3), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-split-preview-spans-the-successor', public.t_gcsd2_classes(v), '3:will_enroll,4:will_enroll,5:will_enroll,6:will_enroll');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('D', 3), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-split-enroll-from-the-predecessor-segment-spans-both', (v ->> 'enrolled_count') || '/' || public.t_gcsd2_states('D', 1, 6, 2), '4/--BBBB');
  v := public.t_gcsd2_ae('OWN', public.t_gcsd2_o('D', 5), public.t_gcsd2_cl(3));
  perform public.t_gcsd2_assert('T-gcsd2-split-enroll-from-the-successor-never-backfills', (v ->> 'enrolled_count') || '/' || public.t_gcsd2_states('D', 1, 6, 3), '2/----BB');
  v := public.t_gcsd2_ar('OWN', public.t_gcsd2_o('D', 4), public.t_gcsd2_cl(2));
  perform public.t_gcsd2_assert('T-gcsd2-split-removal-from-the-first-successor-occurrence', (v ->> 'removed_count') || '/' || public.t_gcsd2_states('D', 1, 6, 2), '3/--Bxxx');
  perform public.t_gcsd2_assert('T-gcsd2-split-other-dancer-untouched-by-removal', public.t_gcsd2_states('D', 1, 6, 3), '----BB');
end $$;

-- ============================================================================
-- 10. Nothing else moved
-- ============================================================================
select public.t_gcsd2_assert('T-gcsd2-attendance-and-money-never-changed-by-any-operation',
  (select (b.attn = public.t_gcsd2_attn() and b.money = public.t_gcsd2_money())::text from public.t_gcsd2_base2 b), 'true');
select public.t_gcsd2_assert('T-gcsd2-money-fingerprint-unchanged-from-the-start',
  (select (b.money = public.t_gcsd2_money())::text from public.t_gcsd2_base b), 'true');
select public.t_gcsd2_assert('T-gcsd2-no-duplicate-booked-rows-anywhere',
  (select (count(*) - count(distinct (appointment_id, client_id)))::text from public.appointment_attendees where status = 'booked'), '0');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsd2_log;

rollback;
