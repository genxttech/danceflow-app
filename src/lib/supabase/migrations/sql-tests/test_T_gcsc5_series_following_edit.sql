-- GC-S1C-5 -- "This and following classes" series editing, live-Postgres regression suite for
-- 20261019090000_gcsc5_series_following_edit.sql.
--
-- Proves, as real tenant roles:
--   * edit_group_class_series_from: broad staff only (owner, admin, front desk, never the assigned instructor or
--     another studio's owner); the client supplies only an occurrence id, a request id, the changed values and the
--     preserve/overwrite choice;
--   * successor split from a middle occurrence (lineage, ids / indexes / original starts / rosters / attendance /
--     usage / enrollment policies untouched, predecessor trimmed), in-place edit from the first occurrence, and a
--     re-split that keeps the lineage a linear chain;
--   * customized occurrences keep their values by default, explicit overwrite replaces only the edited fields and
--     clears only those override flags;
--   * cancelled / terminal-attendance / historical occurrences keep every value and stay cancelled; the selected
--     occurrence must itself be editable; an individually cancelled series cannot be edited;
--   * conflicts (instructor, room), the capacity floor and a conflict appearing between preview and apply roll
--     the whole operation back; validation errors; idempotent replay; no duplicate successor;
--   * S1C-4 "this and following" cancellation spans the split lineage; the preview is read-only;
--   * (remediation) the customized-anchor case: the bulk edit is expressed against the series baseline, so propagating the
--     selected class's own customized value works for every editable field, preserve keeps a different customized later value,
--     overwrite replaces it, and override flags stay truthful (cleared when the value equals the new default, kept otherwise);
--   * credits, usage and attendance never move.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261019090000 (and the earlier S1C migrations) are applied. UUID block ...0000000ee....

begin;

create table public.t_gcsc5_log (n serial, msg text);
grant all on public.t_gcsc5_log to public;
grant usage on sequence public.t_gcsc5_log_n_seq to public;
create function public.t_gcsc5_pass(p text) returns void language sql as $$ insert into public.t_gcsc5_log (msg) values (p) $$;
grant execute on function public.t_gcsc5_pass(text) to public;

create function public.t_gcsc5_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsc5_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc5_assert(text, text, text) to public;

create function public.t_gcsc5_expect(p_sql text, p_like text, p_label text)
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
  perform public.t_gcsc5_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc5_expect(text, text, text) to anon, authenticated, service_role;

create function public.t_gcsc5_ok(p_sql text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise exception 'FAIL %: expected success, got [%]', p_label, sqlerrm;
  end;
  perform public.t_gcsc5_pass(p_label);
end;
$$;
grant execute on function public.t_gcsc5_ok(text, text) to anon, authenticated, service_role;

-- ids: OWN owner, ADM admin, FD front desk, INS assigned instructor, OWB other-studio owner
create function public.t_gcsc5_uid(p_who text) returns uuid language sql immutable as $x$
  select case p_who
    when 'OWN' then '00000000-0000-0000-0000-000000ee1001'
    when 'ADM' then '00000000-0000-0000-0000-000000ee1002'
    when 'FD'  then '00000000-0000-0000-0000-000000ee1003'
    when 'INS' then '00000000-0000-0000-0000-000000ee1004'
    when 'OWB' then '00000000-0000-0000-0000-000000ee1005'
  end::uuid
$x$;
grant execute on function public.t_gcsc5_uid(text) to public;

-- the occurrence ids of every fixture series, by label and index (stable across splits)
create table public.t_gcsc5_occ (label text, idx integer, id uuid, orig timestamptz);
grant all on public.t_gcsc5_occ to public;
create function public.t_gcsc5_o(p_label text, p_idx integer) returns uuid language sql stable security definer set search_path = 'public' as $x$
  select id from public.t_gcsc5_occ where label = p_label and idx = p_idx
$x$;
grant execute on function public.t_gcsc5_o(text, integer) to public;
create function public.t_gcsc5_ser(p_label text, p_idx integer) returns uuid language sql stable security definer set search_path = 'public' as $x$
  select a.group_class_series_id from public.appointments a where a.id = public.t_gcsc5_o(p_label, p_idx)
$x$;
grant execute on function public.t_gcsc5_ser(text, integer) to public;

-- one-line state of a fixture series' occurrences: idx:title:capacity:HH24:MI:minutes:status:flags
create function public.t_gcsc5_state(p_label text, p_from integer, p_to integer) returns text language sql stable security definer set search_path = 'public' as $x$
  select string_agg(o.idx || ':' || a.title || ':' || coalesce(a.roster_capacity::text, '-') || ':' ||
    to_char(a.starts_at at time zone 'America/New_York', 'HH24:MI') || ':' ||
    (extract(epoch from (a.ends_at - a.starts_at)) / 60)::integer || ':' || a.status::text || ':' ||
    array_to_string(a.series_overridden_fields, '+'), ' | ' order by o.idx)
  from public.t_gcsc5_occ o join public.appointments a on a.id = o.id
  where o.label = p_label and o.idx between p_from and p_to
$x$;
grant execute on function public.t_gcsc5_state(text, integer, integer) to public;

-- identity fingerprint (id, index, original start, studio) of every fixture occurrence
create function public.t_gcsc5_ident() returns text language sql stable security definer set search_path = 'public' as $x$
  select md5(string_agg(o.id::text || '|' || a.series_occurrence_index || '|' || a.occurrence_original_start::text || '|' || a.studio_id::text, ';' order by o.id))
  from public.t_gcsc5_occ o join public.appointments a on a.id = o.id
$x$;
grant execute on function public.t_gcsc5_ident() to public;

create function public.t_gcsc5_money() returns text language sql stable security definer set search_path = 'public' as $x$
  select (select count(*) from public.client_membership_usage)::text || '/' ||
         coalesce((select sum(quantity_used)::text from public.client_membership_usage), '0') || '/' ||
         coalesce((select sum(quantity_used + quantity_remaining)::text from public.client_package_items), '0') || '/' ||
         (select md5(coalesce(string_agg(ar::text, '|' order by ar.id), '')) from public.attendance_records ar) || '/' ||
         (select md5(coalesce(string_agg(aa.id::text || aa.status || aa.appointment_id::text, '|' order by aa.id), '')) from public.appointment_attendees aa where aa.studio_id = '00000000-0000-0000-0000-000000ee0001') || '/' ||
         (select md5(coalesce(string_agg(p::text, '|' order by p.id), '')) from public.group_class_enrollment_policies p where p.studio_id = '00000000-0000-0000-0000-000000ee0001')
$x$;
grant execute on function public.t_gcsc5_money() to public;

create function public.t_gcsc5_series_count() returns integer language sql stable security definer set search_path = 'public' as $x$
  select count(*)::integer from public.group_class_series where studio_id = '00000000-0000-0000-0000-000000ee0001'
$x$;
grant execute on function public.t_gcsc5_series_count() to public;

-- run an RPC as a user and return its jsonb
create function public.t_gcsc5_apply(p_who text, p_label text, p_idx integer, p_req text, p_changes jsonb, p_overwrite boolean default false)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid(p_who))::text, true);
  set local role authenticated;
  v := public.edit_group_class_series_from(public.t_gcsc5_o(p_label, p_idx), p_req::uuid, p_changes, p_overwrite);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsc5_apply(text, text, integer, text, jsonb, boolean) to public;

create function public.t_gcsc5_preview(p_who text, p_label text, p_idx integer, p_changes jsonb, p_overwrite boolean default false)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid(p_who))::text, true);
  set local role authenticated;
  v := public.preview_group_class_series_edit(public.t_gcsc5_o(p_label, p_idx), p_changes, p_overwrite);
  reset role;
  return v;
end $$;
grant execute on function public.t_gcsc5_preview(text, text, integer, jsonb, boolean) to public;

-- expect an apply (as a user) to be refused with a given code; the role is always reset
create function public.t_gcsc5_refuse(p_label text, p_who text, p_lbl text, p_idx integer, p_req text, p_changes jsonb, p_like text, p_overwrite boolean default false)
returns void language plpgsql as $$
declare v_failed boolean := false; v_err text;
begin
  begin
    perform public.t_gcsc5_apply(p_who, p_lbl, p_idx, p_req, p_changes, p_overwrite);
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
  perform public.t_gcsc5_pass(p_label);
end $$;
grant execute on function public.t_gcsc5_refuse(text, text, text, integer, text, jsonb, text, boolean) to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000ee0001', 'GC-S1C-5 Harness Studio A', 't-gcsc5-a', 'America/New_York'),
  ('00000000-0000-0000-0000-000000ee0002', 'GC-S1C-5 Harness Studio B', 't-gcsc5-b', 'America/New_York');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000ee1001', 't-gcsc5-owner@example.test'),
  ('00000000-0000-0000-0000-000000ee1002', 't-gcsc5-admin@example.test'),
  ('00000000-0000-0000-0000-000000ee1003', 't-gcsc5-frontdesk@example.test'),
  ('00000000-0000-0000-0000-000000ee1004', 't-gcsc5-instructor@example.test'),
  ('00000000-0000-0000-0000-000000ee1005', 't-gcsc5-owner-b@example.test'),
  ('00000000-0000-0000-0000-000000ee1006', 't-gcsc5-instructor2@example.test'),
  ('00000000-0000-0000-0000-000000ee1007', 't-gcsc5-instructor-b@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000ee1001', 't-gcsc5-owner@example.test', null),
  ('00000000-0000-0000-0000-000000ee1002', 't-gcsc5-admin@example.test', null),
  ('00000000-0000-0000-0000-000000ee1003', 't-gcsc5-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-000000ee1004', 't-gcsc5-instructor@example.test', null),
  ('00000000-0000-0000-0000-000000ee1005', 't-gcsc5-owner-b@example.test', null),
  ('00000000-0000-0000-0000-000000ee1006', 't-gcsc5-instructor2@example.test', null),
  ('00000000-0000-0000-0000-000000ee1007', 't-gcsc5-instructor-b@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000ee1001', '00000000-0000-0000-0000-000000ee0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000ee1002', '00000000-0000-0000-0000-000000ee0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-000000ee1003', '00000000-0000-0000-0000-000000ee0001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000ee1004', '00000000-0000-0000-0000-000000ee0001', 'instructor', true),
  ('00000000-0000-0000-0000-000000ee1005', '00000000-0000-0000-0000-000000ee0002', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000ee1006', '00000000-0000-0000-0000-000000ee0001', 'instructor', true),
  ('00000000-0000-0000-0000-000000ee1007', '00000000-0000-0000-0000-000000ee0002', 'instructor', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000ee2001', '00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee1004', 'Series', 'Instructor', true, true),
  ('00000000-0000-0000-0000-000000ee2002', '00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee1006', 'Second', 'Instructor', true, true),
  ('00000000-0000-0000-0000-000000ee2003', '00000000-0000-0000-0000-000000ee0002', '00000000-0000-0000-0000-000000ee1007', 'Other', 'Studio', true, true);
alter table public.instructors enable trigger user;
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-000000ee3001', '00000000-0000-0000-0000-000000ee0001', 'C', 'One', 'active', false),
  ('00000000-0000-0000-0000-000000ee3002', '00000000-0000-0000-0000-000000ee0001', 'C', 'Two', 'active', false),
  ('00000000-0000-0000-0000-000000ee3003', '00000000-0000-0000-0000-000000ee0001', 'C', 'Three', 'active', false);
insert into public.rooms (id, studio_id, name, active, max_simultaneous_bookings) values
  ('00000000-0000-0000-0000-000000ee9001', '00000000-0000-0000-0000-000000ee0001', 'S1C5 room', true, 1),
  ('00000000-0000-0000-0000-000000ee9002', '00000000-0000-0000-0000-000000ee0002', 'Other studio room', true, null);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000ee1008', 't-gcsc5-instructor3@example.test');
insert into public.profiles (id, email, platform_role) values ('00000000-0000-0000-0000-000000ee1008', 't-gcsc5-instructor3@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-000000ee1008', '00000000-0000-0000-0000-000000ee0001', 'instructor', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000ee2004', '00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee1008', 'Third', 'Instructor', true, true);
alter table public.instructors enable trigger user;
insert into public.rooms (id, studio_id, name, active, max_simultaneous_bookings) values
  ('00000000-0000-0000-0000-000000ee9003', '00000000-0000-0000-0000-000000ee0001', 'S1C5 room 3', true, null);

-- fixture series (through the released B1 RPC, as the owner); records the occurrence ids
create function public.t_gcsc5_series(p_label text, p_req text, p_count integer, p_weekday integer, p_hour integer, p_capacity integer) returns void language plpgsql as $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000ee0001', p_client_request_id => p_req::uuid,
    p_title => 'SER-' || p_label, p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000ee2001', p_room_id => null, p_location_name => null, p_roster_capacity => p_capacity,
    p_weekdays => array[p_weekday]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => p_count,
    p_local_start_time => make_time(p_hour, 0, 0), p_duration_minutes => 60);
  reset role;
  insert into public.t_gcsc5_occ (label, idx, id, orig)
  select p_label, a.series_occurrence_index, a.id, a.occurrence_original_start
  from public.appointments a where a.group_class_series_id = (v_res ->> 'series_id')::uuid;
end $$;
grant execute on function public.t_gcsc5_series(text, text, integer, integer, integer, integer) to public;

select public.t_gcsc5_series('A', '00000000-0000-0000-0000-000000ee7001', 6, 2, 10, 5);
select public.t_gcsc5_series('B', '00000000-0000-0000-0000-000000ee7002', 4, 3, 11, 5);
select public.t_gcsc5_series('C', '00000000-0000-0000-0000-000000ee7003', 5, 4, 12, 8);
select public.t_gcsc5_series('D', '00000000-0000-0000-0000-000000ee7004', 7, 5, 13, 5);
select public.t_gcsc5_series('E', '00000000-0000-0000-0000-000000ee7005', 3, 6, 14, 5);
select public.t_gcsc5_series('F', '00000000-0000-0000-0000-000000ee7006', 6, 7, 15, 5);
select public.t_gcsc5_series('G', '00000000-0000-0000-0000-000000ee7007', 4, 1, 16, 5);
select public.t_gcsc5_series('H', '00000000-0000-0000-0000-000000ee7008', 5, 2, 17, 5);
select public.t_gcsc5_series('FT', '00000000-0000-0000-0000-000000ee7101', 5, 1, 18, 5);
select public.t_gcsc5_series('FI', '00000000-0000-0000-0000-000000ee7102', 5, 2, 19, 5);
select public.t_gcsc5_series('FR', '00000000-0000-0000-0000-000000ee7103', 5, 3, 20, 5);
select public.t_gcsc5_series('FL', '00000000-0000-0000-0000-000000ee7104', 5, 4, 21, 5);
select public.t_gcsc5_series('FC', '00000000-0000-0000-0000-000000ee7105', 5, 5, 22, 5);
select public.t_gcsc5_series('FM', '00000000-0000-0000-0000-000000ee7106', 5, 6, 18, 5);
select public.t_gcsc5_series('FD', '00000000-0000-0000-0000-000000ee7107', 5, 7, 19, 5);
select public.t_gcsc5_series('FX', '00000000-0000-0000-0000-000000ee7108', 5, 1, 23, 5);
select public.t_gcsc5_series('FU', '00000000-0000-0000-0000-000000ee7109', 5, 5, 23, 5);

-- a standalone class and a private lesson (non-series)
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-000000ee4001', '00000000-0000-0000-0000-000000ee0001', null, '00000000-0000-0000-0000-000000ee2001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', 'STANDALONE');

-- bookings
create function public.t_gcsc5_book(p_label text, p_idx integer, p_client text) returns void language sql as $x$
  insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type)
  values ('00000000-0000-0000-0000-000000ee0001', public.t_gcsc5_o(p_label, p_idx), p_client::uuid, 'booked', 'staff', 'free_comped')
$x$;
create function public.t_gcsc5_past(p_label text, p_idx integer) returns void language sql as $x$
  update public.appointments set starts_at = now() - interval '10 days', ends_at = now() - interval '10 days' + interval '1 hour'
  where id = public.t_gcsc5_o(p_label, p_idx)
$x$;

select public.t_gcsc5_book('A', 3, '00000000-0000-0000-0000-000000ee3001');
select public.t_gcsc5_book('A', 4, '00000000-0000-0000-0000-000000ee3002');
select public.t_gcsc5_book('A', 5, '00000000-0000-0000-0000-000000ee3001');
select public.t_gcsc5_book('G', 3, '00000000-0000-0000-0000-000000ee3001');
select public.t_gcsc5_book('G', 3, '00000000-0000-0000-0000-000000ee3002');
select public.t_gcsc5_book('G', 3, '00000000-0000-0000-0000-000000ee3003');

-- usage keyed to A3 and a package item (must never move)
insert into public.membership_plans (id, studio_id, name) values ('00000000-0000-0000-0000-000000ee5001', '00000000-0000-0000-0000-000000ee0001', 'S1C5 plan');
insert into public.membership_plan_benefits (membership_plan_id, benefit_type, quantity, usage_period) values ('00000000-0000-0000-0000-000000ee5001', 'included_group_classes', 10, 'billing_cycle');
insert into public.client_memberships (id, studio_id, client_id, membership_plan_id, status, starts_on, current_period_start, current_period_end, auto_renew, cancel_at_period_end, name_snapshot, price_snapshot, billing_interval_snapshot)
values ('00000000-0000-0000-0000-000000ee5101', '00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee3001', '00000000-0000-0000-0000-000000ee5001', 'active', current_date - 5, current_date - 5, current_date + 25, false, false, 'S1C5 membership', 0, 'monthly');
insert into public.client_membership_usage (client_membership_id, membership_plan_benefit_id, quantity_used, reference_type, reference_id)
select '00000000-0000-0000-0000-000000ee5101', b.id, 1, 'appointment', public.t_gcsc5_o('A', 3)
from public.membership_plan_benefits b where b.membership_plan_id = '00000000-0000-0000-0000-000000ee5001' limit 1;
insert into public.client_packages (id, studio_id, client_id, name_snapshot, purchase_date, is_shareable, active) values ('00000000-0000-0000-0000-000000ee6001', '00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee3002', 'S1C5 package', current_date, false, true);
insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values ('00000000-0000-0000-0000-000000ee6101', '00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee6001', 'group_class', 5, 0, 5, false);

-- C: customized occurrences made by direct tenant edits (the S1A trigger records the overrides)
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  update public.appointments set title = 'C3 own' where id = public.t_gcsc5_o('C', 3);
  update public.appointments set roster_capacity = 6, starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = public.t_gcsc5_o('C', 4);
  reset role;
end $$;

-- D: idx3 cancelled (canonical RPC), idx4 terminal attendance on a still-upcoming class, idx5 already ended
select public.t_gcsc5_book('D', 2, '00000000-0000-0000-0000-000000ee3001');
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  perform public.cancel_group_class_appointment(public.t_gcsc5_o('D', 3));
  reset role;
end $$;
select public.t_gcsc5_book('D', 4, '00000000-0000-0000-0000-000000ee3003');
select public.t_gcsc5_past('D', 4);
insert into public.attendance_records (studio_id, appointment_id, client_id, status)
values ('00000000-0000-0000-0000-000000ee0001', public.t_gcsc5_o('D', 4), '00000000-0000-0000-0000-000000ee3003', 'attended');
update public.appointments set starts_at = now() + interval '31 days', ends_at = now() + interval '31 days 1 hour' where id = public.t_gcsc5_o('D', 4);
select public.t_gcsc5_past('D', 5);

-- E: every class cancelled individually
do $$
declare i integer;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  for i in 1..3 loop
    perform public.cancel_group_class_appointment(public.t_gcsc5_o('E', i));
  end loop;
  reset role;
end $$;

create temp table t_gcsc5_base as
select public.t_gcsc5_money() as money, public.t_gcsc5_ident() as ident, public.t_gcsc5_series_count() as series_count;

-- ============================================================================
-- 1. Posture
-- ============================================================================
select public.t_gcsc5_assert('T-gcsc5-rpcs-authenticated-only-and-definer',
  (select (count(*) = 2 and bool_and(p.prosecdef and p.proconfig = array['search_path=public']
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0)))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('edit_group_class_series_from', 'preview_group_class_series_edit')), 'true');
select public.t_gcsc5_assert('T-gcsc5-internal-helpers-no-tenant-execute',
  (select (count(*) = 5 and bool_and(
      not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0)))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('_gcsc5_series_family', '_gcsc5_edit_groups', '_gcsc5_validate_changes', '_gcsc5_edit_plan', '_gcsc5_edit_conflict')), 'true');
select public.t_gcsc5_assert('T-gcsc5-ledger-has-no-tenant-privileges-and-rls-on',
  (select (c.relrowsecurity
     and not has_table_privilege('authenticated', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'insert')
     and not has_table_privilege('anon', c.oid, 'select'))::text
   from pg_class c where c.oid = 'public.group_class_series_edit_requests'::regclass), 'true');
select public.t_gcsc5_assert('T-gcsc5-lineage-column-fk-and-single-successor-index',
  (select (exists (select 1 from information_schema.columns where table_name = 'group_class_series' and column_name = 'split_from_series_id')
     and exists (select 1 from pg_constraint where conname = 'group_class_series_split_from_fk')
     and exists (select 1 from pg_indexes where indexname = 'uq_group_class_series_split_from'))::text), 'true');
select public.t_gcsc5_assert('T-gcsc5-s1c4-interop-functions-still-posture',
  (select (count(*) = 2 and bool_and(p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('cancel_group_class_series_from', 'preview_group_class_series_cancellation')), 'true');

-- ============================================================================
-- 2. Preview is read-only; successor split from a MIDDLE occurrence (series A)
-- ============================================================================
do $$
declare v jsonb; v_before text := public.t_gcsc5_state('A', 1, 6); v_money text := public.t_gcsc5_money(); v_sc integer := public.t_gcsc5_series_count();
begin
  v := public.t_gcsc5_preview('FD', 'A', 3, '{"title":"New A","roster_capacity":9,"local_start_time":"12:00","duration_minutes":90}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-preview-middle-counts',
    (v ->> 'will_split') || '/' || (v ->> 'class_count') || '/' || (v ->> 'editable_count') || '/' || (v ->> 'changed_count') || '/' || (v ->> 'customized_count') || '/' || (v ->> 'conflict_count') || '/' || (v ->> 'capacity_blocked_count'),
    'true/4/4/4/0/0/0');
  perform public.t_gcsc5_assert('T-gcsc5-preview-changed-nothing',
    public.t_gcsc5_state('A', 1, 6) || public.t_gcsc5_money() || public.t_gcsc5_series_count(), v_before || v_money || v_sc);
end $$;

do $$
declare
  v jsonb; v_pred uuid; v_succ uuid; v_ident text := public.t_gcsc5_ident(); v_money text := public.t_gcsc5_money();
begin
  v_pred := public.t_gcsc5_ser('A', 1);
  v := public.t_gcsc5_apply('FD', 'A', 3, '00000000-0000-0000-0000-000000ee8001', '{"title":"New A","roster_capacity":9,"local_start_time":"12:00","duration_minutes":90}'::jsonb);
  v_succ := (v ->> 'series_id')::uuid;
  perform public.t_gcsc5_assert('T-gcsc5-split-result-counts',
    (v ->> 'split_created') || '/' || (v ->> 'moved_class_count') || '/' || (v ->> 'edited_class_count') || '/' || (v ->> 'replay') || '/' || (v ->> 'predecessor_series_id' = v_pred::text)::text,
    'true/4/4/false/true');
  perform public.t_gcsc5_assert('T-gcsc5-successor-lineage-and-membership',
    (select (s.split_from_series_id = v_pred and s.status = 'active' and s.id <> v_pred
        and public.t_gcsc5_ser('A', 1) = v_pred and public.t_gcsc5_ser('A', 2) = v_pred
        and public.t_gcsc5_ser('A', 3) = v_succ and public.t_gcsc5_ser('A', 6) = v_succ)::text
     from public.group_class_series s where s.id = v_succ), 'true');
  perform public.t_gcsc5_assert('T-gcsc5-appointment-identity-index-original-start-preserved', public.t_gcsc5_ident(), v_ident);
  perform public.t_gcsc5_assert('T-gcsc5-edited-values-on-following-only',
    public.t_gcsc5_state('A', 1, 6),
    '1:SER-A:5:10:00:60:scheduled: | 2:SER-A:5:10:00:60:scheduled: | 3:New A:9:12:00:90:scheduled: | 4:New A:9:12:00:90:scheduled: | 5:New A:9:12:00:90:scheduled: | 6:New A:9:12:00:90:scheduled:');
  perform public.t_gcsc5_assert('T-gcsc5-usage-attendance-attendees-and-policies-unchanged', public.t_gcsc5_money(), v_money);
  perform public.t_gcsc5_assert('T-gcsc5-successor-defaults-edited-predecessor-defaults-kept',
    (select (succ.title = 'New A' and succ.default_roster_capacity = 9 and succ.local_start_time = time '12:00' and succ.duration_minutes = 90
        and pred.title = 'SER-A' and pred.default_roster_capacity = 5 and pred.local_start_time = time '10:00' and pred.duration_minutes = 60
        and succ.weekdays = pred.weekdays and succ.timezone = pred.timezone and succ.interval_weeks = pred.interval_weeks
        and succ.studio_id = pred.studio_id and succ.occurrence_count is null and succ.ends_on is not null)::text
     from public.group_class_series succ, public.group_class_series pred where succ.id = v_succ and pred.id = v_pred), 'true');
  perform public.t_gcsc5_assert('T-gcsc5-predecessor-extent-trimmed-to-what-it-holds',
    (select (pred.occurrence_count is null and pred.ends_on = (select max((a.occurrence_original_start at time zone pred.timezone)::date) from public.appointments a where a.group_class_series_id = pred.id)
        and succ.starts_on = (select min((a.occurrence_original_start at time zone succ.timezone)::date) from public.appointments a where a.group_class_series_id = succ.id))::text
     from public.group_class_series pred, public.group_class_series succ where pred.id = v_pred and succ.id = v_succ), 'true');
  perform public.t_gcsc5_assert('T-gcsc5-no-notification-or-outbound-rows-written',
    (select count(*)::text from public.outbound_deliveries o where o.studio_id = '00000000-0000-0000-0000-000000ee0001'), '0');
end $$;

-- idempotency (series A request ee8001)
do $$
declare v jsonb; v_sc integer := public.t_gcsc5_series_count();
begin
  v := public.t_gcsc5_apply('FD', 'A', 3, '00000000-0000-0000-0000-000000ee8001', '{"title":"New A","roster_capacity":9,"local_start_time":"12:00","duration_minutes":90}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-replay-returns-stored-result-no-new-series',
    (v ->> 'replay') || '/' || (v ->> 'split_created') || '/' || (v ->> 'edited_class_count') || '/' || (public.t_gcsc5_series_count() = v_sc)::text, 'true/true/4/true');
  perform public.t_gcsc5_refuse('T-gcsc5-same-request-id-different-edit-refused', 'FD', 'A', 3, '00000000-0000-0000-0000-000000ee8001', '{"title":"Different"}'::jsonb, 'GCSC5_IDEMPOTENCY_CONFLICT');
  perform public.t_gcsc5_refuse('T-gcsc5-same-request-id-different-overwrite-refused', 'FD', 'A', 3, '00000000-0000-0000-0000-000000ee8001', '{"title":"New A","roster_capacity":9,"local_start_time":"12:00","duration_minutes":90}'::jsonb, 'GCSC5_IDEMPOTENCY_CONFLICT', true);
  perform public.t_gcsc5_refuse('T-gcsc5-new-request-same-changes-is-no-changes-never-a-second-split', 'FD', 'A', 3, '00000000-0000-0000-0000-000000ee8002', '{"title":"New A","roster_capacity":9,"local_start_time":"12:00","duration_minutes":90}'::jsonb, 'GCSC5_NO_CHANGES');
  perform public.t_gcsc5_assert('T-gcsc5-one-ledger-row-and-series-count-stable',
    (select count(*)::text from public.group_class_series_edit_requests where studio_id = '00000000-0000-0000-0000-000000ee0001') || '/' || (public.t_gcsc5_series_count() = v_sc)::text, '1/true');
end $$;

-- ============================================================================
-- 3. Edit from the FIRST occurrence of a segment edits in place (no empty predecessor): series B and A's successor
-- ============================================================================
do $$
declare v jsonb; v_series uuid := public.t_gcsc5_ser('B', 1); v_sc integer := public.t_gcsc5_series_count();
begin
  v := public.t_gcsc5_apply('OWN', 'B', 1, '00000000-0000-0000-0000-000000ee8003', '{"title":"B2","location_name":"Studio floor"}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-first-occurrence-edits-in-place-no-split',
    (v ->> 'split_created') || '/' || (v ->> 'moved_class_count') || '/' || (v ->> 'edited_class_count') || '/' || (v ->> 'series_id' = v_series::text)::text || '/' || (public.t_gcsc5_series_count() = v_sc)::text || '/' || coalesce(v ->> 'predecessor_series_id', 'none'),
    'false/0/4/true/true/none');
  perform public.t_gcsc5_assert('T-gcsc5-first-occurrence-all-four-edited-series-definition-updated',
    (select string_agg(a.title || ':' || coalesce(a.location_name, '-') || ':' || array_to_string(a.series_overridden_fields, '+'), ',' order by a.series_occurrence_index) from public.appointments a where a.group_class_series_id = v_series)
     || '/' || (select s.title || ':' || coalesce(s.default_location_name, '-') || ':' || coalesce(s.split_from_series_id::text, 'none') from public.group_class_series s where s.id = v_series),
    'B2:Studio floor:,B2:Studio floor:,B2:Studio floor:,B2:Studio floor:/B2:Studio floor:none');
end $$;

-- ============================================================================
-- 4. Re-split keeps the lineage a LINEAR CHAIN (A: pred{1,2} <- succ{3..6}; edit from 2)
-- ============================================================================
do $$
declare v jsonb; v_a1 uuid := public.t_gcsc5_ser('A', 1); v_a2 uuid := public.t_gcsc5_ser('A', 3); v_a3 uuid; v_ident text := public.t_gcsc5_ident();
begin
  v := public.t_gcsc5_apply('ADM', 'A', 2, '00000000-0000-0000-0000-000000ee8004', '{"title":"Chain"}'::jsonb);
  v_a3 := (v ->> 'series_id')::uuid;
  perform public.t_gcsc5_assert('T-gcsc5-resplit-counts', (v ->> 'split_created') || '/' || (v ->> 'moved_class_count') || '/' || (v ->> 'edited_class_count'), 'true/1/5');
  perform public.t_gcsc5_assert('T-gcsc5-chain-is-linear-and-reparented',
    (select (s3.split_from_series_id = v_a1 and s2.split_from_series_id = v_a3 and s1.split_from_series_id is null
       and public.t_gcsc5_ser('A', 1) = v_a1 and public.t_gcsc5_ser('A', 2) = v_a3 and public.t_gcsc5_ser('A', 3) = v_a2 and public.t_gcsc5_ser('A', 6) = v_a2
       and (select count(*) from public.group_class_series x where x.split_from_series_id = v_a1) = 1)::text
     from public.group_class_series s1, public.group_class_series s2, public.group_class_series s3 where s1.id = v_a1 and s2.id = v_a2 and s3.id = v_a3), 'true');
  perform public.t_gcsc5_assert('T-gcsc5-later-successor-edited-in-place-with-the-chain',
    public.t_gcsc5_state('A', 1, 6),
    '1:SER-A:5:10:00:60:scheduled: | 2:Chain:5:10:00:60:scheduled: | 3:Chain:9:12:00:90:scheduled: | 4:Chain:9:12:00:90:scheduled: | 5:Chain:9:12:00:90:scheduled: | 6:Chain:9:12:00:90:scheduled:');
  perform public.t_gcsc5_assert('T-gcsc5-later-successor-definition-took-the-edit', (select title from public.group_class_series where id = v_a2), 'Chain');
  perform public.t_gcsc5_assert('T-gcsc5-identity-still-preserved-after-resplit', public.t_gcsc5_ident(), v_ident);
end $$;

-- ============================================================================
-- 5. Customized occurrences (series C): preserve by default, explicit overwrite, only edited fields
-- ============================================================================
select public.t_gcsc5_assert('T-gcsc5-fixture-overrides-recorded-by-tenant-edits', public.t_gcsc5_state('C', 3, 4),
  '3:C3 own:8:12:00:60:scheduled:title | 4:SER-C:6:13:00:60:scheduled:capacity+time');
do $$
declare v jsonb; v_money text := public.t_gcsc5_money();
begin
  v := public.t_gcsc5_preview('FD', 'C', 2, '{"title":"C2","roster_capacity":7}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-preview-reports-customized-count-and-fields',
    (v ->> 'class_count') || '/' || (v ->> 'customized_count') || '/' || (v -> 'customized_fields')::text || '/' || (v ->> 'overwrite'),
    '4/2/{"title": 1, "capacity": 1}/false');
  v := public.t_gcsc5_preview('FD', 'C', 2, '{"title":"C2","roster_capacity":7}'::jsonb, true);
  perform public.t_gcsc5_assert('T-gcsc5-preview-overwrite-flag-echoed', (v ->> 'overwrite') || '/' || (v ->> 'customized_count'), 'true/2');
end $$;
do $$
declare v jsonb;
begin
  v := public.t_gcsc5_apply('FD', 'C', 2, '00000000-0000-0000-0000-000000ee8005', '{"title":"C2","roster_capacity":7}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-preserve-default-result-counts',
    (v ->> 'split_created') || '/' || (v ->> 'edited_class_count') || '/' || (v ->> 'preserved_customized_count') || '/' || (v ->> 'overwritten_customized_count'), 'true/4/2/0');
  perform public.t_gcsc5_assert('T-gcsc5-preserve-default-keeps-customized-values-and-flags',
    public.t_gcsc5_state('C', 1, 5),
    '1:SER-C:8:12:00:60:scheduled: | 2:C2:7:12:00:60:scheduled: | 3:C3 own:7:12:00:60:scheduled:title | 4:C2:6:13:00:60:scheduled:capacity+time | 5:C2:7:12:00:60:scheduled:');
end $$;
do $$
declare v jsonb;
begin
  v := public.t_gcsc5_apply('OWN', 'C', 2, '00000000-0000-0000-0000-000000ee8006', '{"title":"C3"}'::jsonb, true);
  perform public.t_gcsc5_assert('T-gcsc5-overwrite-result-counts', (v ->> 'split_created') || '/' || (v ->> 'edited_class_count') || '/' || (v ->> 'overwritten_customized_count'), 'false/4/1');
  perform public.t_gcsc5_assert('T-gcsc5-overwrite-replaces-edited-field-and-clears-only-that-flag-unrelated-overrides-kept',
    public.t_gcsc5_state('C', 2, 5),
    '2:C3:7:12:00:60:scheduled: | 3:C3:7:12:00:60:scheduled: | 4:C3:6:13:00:60:scheduled:capacity+time | 5:C3:7:12:00:60:scheduled:');
  v := public.t_gcsc5_apply('OWN', 'C', 2, '00000000-0000-0000-0000-000000ee8007', '{"roster_capacity":9}'::jsonb, true);
  perform public.t_gcsc5_assert('T-gcsc5-overwrite-capacity-only-leaves-time-override-and-time',
    public.t_gcsc5_state('C', 4, 4), '4:C3:9:13:00:60:scheduled:time');
end $$;
-- preserved time override: a time edit without overwrite leaves the customized-time class where it is
do $$
declare v jsonb;
begin
  v := public.t_gcsc5_apply('OWN', 'C', 3, '00000000-0000-0000-0000-000000ee8008', '{"local_start_time":"19:30","duration_minutes":75}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-time-edit-preserves-customized-time-and-edits-the-rest',
    public.t_gcsc5_state('C', 2, 5),
    '2:C3:9:12:00:60:scheduled: | 3:C3:9:19:30:75:scheduled: | 4:C3:9:13:00:60:scheduled:time | 5:C3:9:19:30:75:scheduled:');
  perform public.t_gcsc5_assert('T-gcsc5-time-edit-preserved-count', (v ->> 'preserved_customized_count') || '/' || (v ->> 'edited_class_count'), '1/2');
end $$;

-- ============================================================================
-- 6. State interplay (series D): cancelled / terminal-attendance / historical keep everything; no reactivation
-- ============================================================================
do $$
declare
  v jsonb; v_before text; v_ser uuid; v_att text;
begin
  v_before := public.t_gcsc5_state('D', 3, 5);
  v_att := (select md5(string_agg(ar::text, '|' order by ar.id)) from public.attendance_records ar where ar.appointment_id = public.t_gcsc5_o('D', 4));
  perform public.t_gcsc5_refuse('T-gcsc5-anchor-cancelled-refused', 'OWN', 'D', 3, '00000000-0000-0000-0000-000000ee8101', '{"title":"x"}'::jsonb, 'GCSC5_ANCHOR_NOT_EDITABLE');
  perform public.t_gcsc5_refuse('T-gcsc5-anchor-terminal-attendance-refused', 'OWN', 'D', 4, '00000000-0000-0000-0000-000000ee8102', '{"title":"x"}'::jsonb, 'GCSC5_ANCHOR_NOT_EDITABLE');
  perform public.t_gcsc5_refuse('T-gcsc5-anchor-historical-refused', 'OWN', 'D', 5, '00000000-0000-0000-0000-000000ee8103', '{"title":"x"}'::jsonb, 'GCSC5_ANCHOR_NOT_EDITABLE');

  v := public.t_gcsc5_apply('OWN', 'D', 2, '00000000-0000-0000-0000-000000ee8104', '{"title":"D2","instructor_id":"00000000-0000-0000-0000-000000ee2002"}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-state-mix-result-counts',
    (v ->> 'split_created') || '/' || (v ->> 'moved_class_count') || '/' || (v ->> 'edited_class_count') || '/' || (v ->> 'cancelled_class_count') || '/' || (v ->> 'historical_class_count') || '/' || (v ->> 'terminal_attendance_class_count'),
    'true/6/3/1/1/1');
  v_ser := (v ->> 'series_id')::uuid;
  perform public.t_gcsc5_assert('T-gcsc5-cancelled-terminal-historical-keep-values-and-status',
    public.t_gcsc5_state('D', 3, 5), v_before);
  perform public.t_gcsc5_assert('T-gcsc5-cancelled-class-stays-cancelled-no-reactivation',
    (select a.status::text || '/' || a.group_class_series_id::text from public.appointments a where a.id = public.t_gcsc5_o('D', 3)), 'cancelled/' || v_ser::text);
  perform public.t_gcsc5_assert('T-gcsc5-only-eligible-classes-got-the-new-title-and-instructor',
    (select string_agg(o.idx || ':' || a.title || ':' || (a.instructor_id = '00000000-0000-0000-0000-000000ee2002')::text, ',' order by o.idx)
     from public.t_gcsc5_occ o join public.appointments a on a.id = o.id where o.label = 'D'),
    '1:SER-D:false,2:D2:true,3:SER-D:false,4:SER-D:false,5:SER-D:false,6:D2:true,7:D2:true');
  perform public.t_gcsc5_assert('T-gcsc5-terminal-attendance-record-untouched',
    (select md5(string_agg(ar::text, '|' order by ar.id)) from public.attendance_records ar where ar.appointment_id = public.t_gcsc5_o('D', 4)), v_att);
  perform public.t_gcsc5_assert('T-gcsc5-segment-membership-d',
    (select string_agg(o.idx || ':' || (a.group_class_series_id = v_ser)::text, ',' order by o.idx) from public.t_gcsc5_occ o join public.appointments a on a.id = o.id where o.label = 'D'),
    '1:false,2:true,3:true,4:true,5:true,6:true,7:true');
end $$;

-- E: every remaining class individually cancelled: stored status is not rewritten and nothing is editable
select public.t_gcsc5_assert('T-gcsc5-individually-cancelled-series-stored-status-stays-active-no-eligible-occurrence',
  (select s.status || '/' || (select count(*) from public.appointments a where a.group_class_series_id = s.id and a.status <> 'cancelled')::text from public.group_class_series s where s.id = public.t_gcsc5_ser('E', 1)), 'active/0');
select public.t_gcsc5_refuse('T-gcsc5-individually-cancelled-series-cannot-be-edited', 'OWN', 'E', 2, '00000000-0000-0000-0000-000000ee8105', '{"title":"x"}'::jsonb, 'GCSC5_ANCHOR_NOT_EDITABLE');

-- ============================================================================
-- 7. S1C-4 cancellation spans the split lineage (series F)
-- ============================================================================
do $$
declare v jsonb; v_f1 uuid := public.t_gcsc5_ser('F', 1); v_f2 uuid; r jsonb;
begin
  v := public.t_gcsc5_apply('OWN', 'F', 4, '00000000-0000-0000-0000-000000ee8201', '{"title":"F2"}'::jsonb);
  v_f2 := (v ->> 'series_id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  r := public.preview_group_class_series_cancellation(public.t_gcsc5_o('F', 2));
  reset role;
  perform public.t_gcsc5_assert('T-gcsc5-cancel-preview-spans-the-lineage', (r ->> 'eligible_class_count') || '/' || (r ->> 'series_would_be_cancelled'), '5/false');
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  r := public.cancel_group_class_series_from(public.t_gcsc5_o('F', 2));
  reset role;
  perform public.t_gcsc5_assert('T-gcsc5-cancel-from-predecessor-cancels-successor-classes-too', (r ->> 'cancelled_class_count') || '/' || (r ->> 'series_status') || '/' || (r ->> 'series_cancelled_by_this_call'), '5/active/false');
  perform public.t_gcsc5_assert('T-gcsc5-cancel-lineage-statuses',
    (select s1.status || '/' || s2.status || '/' || (select string_agg(a.status::text, ',' order by a.series_occurrence_index) from public.appointments a where a.id in (select id from public.t_gcsc5_occ where label = 'F'))
     from public.group_class_series s1, public.group_class_series s2 where s1.id = v_f1 and s2.id = v_f2),
    'active/cancelled/scheduled,cancelled,cancelled,cancelled,cancelled,cancelled');
  perform public.t_gcsc5_refuse('T-gcsc5-cancelled-successor-cannot-be-edited', 'OWN', 'F', 5, '00000000-0000-0000-0000-000000ee8202', '{"title":"x"}'::jsonb, 'GCSC5_SERIES_NOT_EDITABLE');
end $$;

-- ============================================================================
-- 8. Conflicts, capacity floor, preview-to-apply drift; everything rolls back atomically (series G)
-- ============================================================================
do $$
declare
  v jsonb; v_snap text := public.t_gcsc5_state('G', 1, 4); v_sc integer := public.t_gcsc5_series_count(); v_led integer;
  v_d3 date; v_d4 date;
begin
  select (a.starts_at at time zone 'America/New_York')::date into v_d3 from public.appointments a where a.id = public.t_gcsc5_o('G', 3);
  select (a.starts_at at time zone 'America/New_York')::date into v_d4 from public.appointments a where a.id = public.t_gcsc5_o('G', 4);
  select count(*) into v_led from public.group_class_series_edit_requests;

  -- instructor conflict at the new 20:00 start of occurrence 3
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at, title)
  values ('00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee3001', '00000000-0000-0000-0000-000000ee2001', 'private_lesson', 'scheduled',
          ((v_d3 + time '20:15') at time zone 'America/New_York'), ((v_d3 + time '21:00') at time zone 'America/New_York'), 'blocker');
  v := public.t_gcsc5_preview('OWN', 'G', 2, '{"local_start_time":"20:00"}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-preview-reports-instructor-conflict',
    (v ->> 'conflict_count') || '/' || (v -> 'first_conflict' ->> 'reason') || '/' || (v -> 'first_conflict' ->> 'occurrence_index'), '1/instructor/3');
  perform public.t_gcsc5_refuse('T-gcsc5-instructor-conflict-refused-by-apply', 'OWN', 'G', 2, '00000000-0000-0000-0000-000000ee8301', '{"local_start_time":"20:00"}'::jsonb, 'GCSC5_CONFLICT: reason=instructor index=3');
  perform public.t_gcsc5_assert('T-gcsc5-conflict-rolled-back-everything',
    public.t_gcsc5_state('G', 1, 4) || '/' || (public.t_gcsc5_series_count() = v_sc)::text || '/' || ((select count(*) from public.group_class_series_edit_requests) = v_led)::text, v_snap || '/true/true');

  -- room (max 1 simultaneous) occupied at occurrence 4
  insert into public.appointments (studio_id, appointment_type, status, starts_at, ends_at, title, room_id, instructor_id)
  values ('00000000-0000-0000-0000-000000ee0001', 'group_class', 'scheduled',
          ((v_d4 + time '16:00') at time zone 'America/New_York'), ((v_d4 + time '17:00') at time zone 'America/New_York'), 'room occupant', '00000000-0000-0000-0000-000000ee9001', null);
  perform public.t_gcsc5_refuse('T-gcsc5-room-conflict-refused-by-apply', 'OWN', 'G', 2, '00000000-0000-0000-0000-000000ee8302', '{"room_id":"00000000-0000-0000-0000-000000ee9001"}'::jsonb, 'GCSC5_CONFLICT: reason=room_busy index=4');
  perform public.t_gcsc5_assert('T-gcsc5-room-conflict-rolled-back', public.t_gcsc5_state('G', 1, 4) || '/' || (public.t_gcsc5_series_count() = v_sc)::text, v_snap || '/true');

  -- capacity floor: occurrence 3 has three booked students
  v := public.t_gcsc5_preview('OWN', 'G', 2, '{"roster_capacity":2}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-preview-reports-capacity-below-booked', v ->> 'capacity_blocked_count', '1');
  perform public.t_gcsc5_refuse('T-gcsc5-capacity-floor-refused-by-apply-and-rolled-back', 'OWN', 'G', 2, '00000000-0000-0000-0000-000000ee8303', '{"title":"G cap","roster_capacity":2}'::jsonb, 'GCSC3_CAPACITY_BELOW_BOOKED');
  perform public.t_gcsc5_assert('T-gcsc5-capacity-refusal-rolled-back-title-and-split', public.t_gcsc5_state('G', 1, 4) || '/' || (public.t_gcsc5_series_count() = v_sc)::text, v_snap || '/true');

  -- a conflict that appears between preview and apply
  v := public.t_gcsc5_preview('OWN', 'G', 2, '{"local_start_time":"21:30"}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-preview-clean-before-drift', v ->> 'conflict_count', '0');
  insert into public.instructor_schedule_blocks (studio_id, instructor_id, starts_at, ends_at, title)
  values ('00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-000000ee2001', ((v_d3 + time '21:00') at time zone 'America/New_York'), ((v_d3 + time '23:00') at time zone 'America/New_York'), 'S1C5 block');
  perform public.t_gcsc5_refuse('T-gcsc5-conflict-between-preview-and-apply-refused', 'OWN', 'G', 2, '00000000-0000-0000-0000-000000ee8304', '{"local_start_time":"21:30"}'::jsonb, 'GCSC5_CONFLICT: reason=instructor_block index=3');
  perform public.t_gcsc5_assert('T-gcsc5-drift-refusal-rolled-back', public.t_gcsc5_state('G', 1, 4) || '/' || (public.t_gcsc5_series_count() = v_sc)::text, v_snap || '/true');

  -- a non-conflicting edit still applies
  v := public.t_gcsc5_apply('OWN', 'G', 2, '00000000-0000-0000-0000-000000ee8305', '{"local_start_time":"08:00","roster_capacity":6}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-nonconflicting-edit-applies-after-refusals', (v ->> 'split_created') || '/' || (v ->> 'edited_class_count'), 'true/3');
end $$;


-- ============================================================================
-- 9. Authority, validation, scope (series H)
-- ============================================================================
do $$
declare v_snap text := public.t_gcsc5_state('H', 1, 5); v_sc integer := public.t_gcsc5_series_count(); v jsonb;
begin
  perform public.t_gcsc5_refuse('T-gcsc5-assigned-instructor-refused-series-edit', 'INS', 'H', 3, '00000000-0000-0000-0000-000000ee8401', '{"title":"x"}'::jsonb, 'GCSC5_UNAUTHORIZED');
  perform public.t_gcsc5_refuse('T-gcsc5-other-studio-owner-refused', 'OWB', 'H', 3, '00000000-0000-0000-0000-000000ee8402', '{"title":"x"}'::jsonb, 'GCSC5_UNAUTHORIZED');
  begin
    perform public.t_gcsc5_preview('INS', 'H', 3, '{"title":"x"}'::jsonb);
    raise exception 'FAIL T-gcsc5-instructor-refused-preview: statement succeeded';
  exception when others then
    reset role;
    if position('GCSC5_UNAUTHORIZED' in sqlerrm) = 0 then raise; end if;
    perform public.t_gcsc5_pass('T-gcsc5-instructor-refused-preview');
  end;
  begin
    set local role anon;
    perform public.edit_group_class_series_from(public.t_gcsc5_o('H', 3), '00000000-0000-0000-0000-000000ee8403', '{"title":"x"}'::jsonb, false);
    raise exception 'FAIL T-gcsc5-anon-cannot-execute-apply: statement succeeded';
  exception when others then
    reset role;
    if position('permission denied' in lower(sqlerrm)) = 0 then raise; end if;
    perform public.t_gcsc5_pass('T-gcsc5-anon-cannot-execute-apply');
  end;
  perform public.t_gcsc5_refuse('T-gcsc5-no-request-id-refused', 'OWN', 'H', 3, null, '{"title":"x"}'::jsonb, 'GCSC5_REQUEST_ID_REQUIRED');
  perform public.t_gcsc5_refuse('T-gcsc5-missing-class-not-found', 'OWN', 'H', 99, '00000000-0000-0000-0000-000000ee8404', '{"title":"x"}'::jsonb, 'GCSC5_NOT_FOUND');

  -- the standalone class is not a series occurrence
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
    set local role authenticated;
    perform public.edit_group_class_series_from('00000000-0000-0000-0000-000000ee4001', '00000000-0000-0000-0000-000000ee8405', '{"title":"x"}'::jsonb, false);
    raise exception 'FAIL T-gcsc5-standalone-class-not-a-series-occurrence: statement succeeded';
  exception when others then
    reset role;
    if position('GCSC5_NOT_A_SERIES_OCCURRENCE' in sqlerrm) = 0 then raise; end if;
    perform public.t_gcsc5_pass('T-gcsc5-standalone-class-not-a-series-occurrence');
  end;

  -- validation
  perform public.t_gcsc5_refuse('T-gcsc5-empty-changes-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8410', '{}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-recurrence-shape-key-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8411', '{"weekdays":[1,2]}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-interval-and-count-keys-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8412', '{"interval_weeks":2,"occurrence_count":9,"ends_on":"2030-01-01"}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-enrollment-policy-keys-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8413', '{"publicly_discoverable":true,"self_enrollment_allowed":true}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-notes-and-date-keys-refused-occurrence-only', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8414', '{"notes":"x","starts_at":"2031-01-01T10:00:00Z"}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-blank-title-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8415', '{"title":"   "}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-capacity-zero-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8416', '{"roster_capacity":0}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-capacity-fraction-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8417', '{"roster_capacity":2.5}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-bad-time-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8418', '{"local_start_time":"25:99"}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-duration-out-of-range-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8419', '{"duration_minutes":4}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-malformed-instructor-id-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8420', '{"instructor_id":"not-a-uuid"}'::jsonb, 'GCSC5_INVALID_CHANGES');
  perform public.t_gcsc5_refuse('T-gcsc5-other-studio-instructor-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8421', '{"instructor_id":"00000000-0000-0000-0000-000000ee2003"}'::jsonb, 'GCSC5_INSTRUCTOR_UNASSIGNABLE');
  perform public.t_gcsc5_refuse('T-gcsc5-other-studio-room-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8422', '{"room_id":"00000000-0000-0000-0000-000000ee9002"}'::jsonb, 'GCSC5_ROOM_INVALID');
  perform public.t_gcsc5_refuse('T-gcsc5-no-effective-change-refused', 'OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8423', '{"title":"SER-H","roster_capacity":5}'::jsonb, 'GCSC5_NO_CHANGES');
  perform public.t_gcsc5_assert('T-gcsc5-every-refusal-changed-nothing', public.t_gcsc5_state('H', 1, 5) || '/' || (public.t_gcsc5_series_count() = v_sc)::text, v_snap || '/true');

  -- broad staff succeed (front desk and admin already used above); the owner clears a nullable field
  v := public.t_gcsc5_apply('OWN', 'H', 3, '00000000-0000-0000-0000-000000ee8430', '{"roster_capacity":null,"room_id":"00000000-0000-0000-0000-000000ee9001","instructor_id":null}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-nullable-fields-can-be-cleared-and-room-set',
    (select string_agg(coalesce(a.roster_capacity::text, 'unlimited') || ':' || coalesce(a.room_id::text, 'noroom') || ':' || coalesce(a.instructor_id::text, 'noinstructor'), ',' order by o.idx)
     from public.t_gcsc5_occ o join public.appointments a on a.id = o.id where o.label = 'H' and o.idx between 2 and 4),
    '5:noroom:00000000-0000-0000-0000-000000ee2001,unlimited:00000000-0000-0000-0000-000000ee9001:noinstructor,unlimited:00000000-0000-0000-0000-000000ee9001:noinstructor');
end $$;

-- the assigned instructor keeps single-occurrence edit authority (S1C-1): a direct edit works and is tracked as an override
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('INS'))::text, true);
  set local role authenticated;
  perform public.t_gcsc5_ok(format($q$update public.appointments set title = 'instructor renamed' where id = %L$q$, public.t_gcsc5_o('B', 4)), 'T-gcsc5-instructor-single-occurrence-edit-unchanged');
  reset role;
end $$;
select public.t_gcsc5_assert('T-gcsc5-instructor-edit-tracked-as-override',
  (select a.title || '/' || array_to_string(a.series_overridden_fields, '+') from public.appointments a where a.id = public.t_gcsc5_o('B', 4)), 'instructor renamed/title');

-- the cancel RPCs still refuse an assigned instructor; the series edit never reactivates
select public.t_gcsc5_assert('T-gcsc5-no-cancelled-class-reactivated-anywhere',
  (select count(*)::text from public.appointments a where a.id in (select id from public.t_gcsc5_occ where label in ('D', 'E', 'F'))
     and a.status <> 'cancelled' and a.id in (public.t_gcsc5_o('D', 3), public.t_gcsc5_o('E', 1), public.t_gcsc5_o('E', 2), public.t_gcsc5_o('E', 3), public.t_gcsc5_o('F', 3), public.t_gcsc5_o('F', 6))), '0');

-- ============================================================================
-- 9b. REMEDIATION: customized-anchor bulk edit (B1) and override-flag reconciliation (M1), generic over every field
--     Per field: series baseline X0; occurrence 2 (the anchor) customized to X; occurrence 4 customized to Y plus an
--     unrelated customization; the owner propagates X (a value that differs from the series baseline but equals the
--     anchor's own value). Preserve: 2 keeps X with its flag CLEARED, 3 and 5 become X, 4 keeps Y and keeps both flags,
--     1 is untouched. Overwrite: 4 becomes X and only the edited field's flag clears.
-- ============================================================================
create function public.t_gcsc5_val(p_getter text, p_id uuid) returns text language plpgsql stable security definer set search_path = 'public' as $f$
declare v text;
begin
  execute format('select %s from public.appointments a where a.id = %L', p_getter, p_id) into v;
  return v;
end $f$;
grant execute on function public.t_gcsc5_val(text, uuid) to public;
create function public.t_gcsc5_flags(p_id uuid) returns text language sql stable security definer set search_path = 'public' as $f$
  select coalesce((select string_agg(x, '+' order by x) from public.appointments a, unnest(a.series_overridden_fields) x where a.id = p_id), '')
$f$;
grant execute on function public.t_gcsc5_flags(uuid) to public;

create function public.t_gcsc5_b1(
  p_label text, p_group text, p_unrel_group text,
  p_set_x text, p_set_y text, p_set_u text,
  p_changes jsonb, p_getter text, p_req_a text, p_req_b text
) returns void language plpgsql as $f$
declare
  v_base text; v_x text; v_y text; v jsonb;
  o1 uuid := public.t_gcsc5_o(p_label, 1); o2 uuid := public.t_gcsc5_o(p_label, 2); o3 uuid := public.t_gcsc5_o(p_label, 3);
  o4 uuid := public.t_gcsc5_o(p_label, 4); o5 uuid := public.t_gcsc5_o(p_label, 5);
  v_both text := (select string_agg(x, '+' order by x) from unnest(array[p_group, p_unrel_group]) x);
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  execute format('update public.appointments set %s where id = %L', p_set_x, o2);
  execute format('update public.appointments set %s where id = %L', p_set_y, o4);
  execute format('update public.appointments set %s where id = %L', p_set_u, o4);
  reset role;

  v_base := public.t_gcsc5_val(p_getter, o3); v_x := public.t_gcsc5_val(p_getter, o2); v_y := public.t_gcsc5_val(p_getter, o4);
  perform public.t_gcsc5_assert('T-gcsc5-b1-' || p_label || '-precondition-anchor-customized-later-customized-differently',
    (v_x is distinct from v_base)::text || '/' || (v_y is distinct from v_x)::text || '/' || public.t_gcsc5_flags(o2) || '/' || public.t_gcsc5_flags(o4), 'true/true/' || p_group || '/' || v_both);

  v := public.t_gcsc5_apply('OWN', p_label, 2, p_req_a::text, p_changes, false);
  perform public.t_gcsc5_assert('T-gcsc5-b1-' || p_label || '-preserve-propagates-the-anchor-value-keeps-the-later-customization',
    public.t_gcsc5_val(p_getter, o1) || '|' || public.t_gcsc5_val(p_getter, o2) || '|' || public.t_gcsc5_val(p_getter, o3) || '|' || public.t_gcsc5_val(p_getter, o4) || '|' || public.t_gcsc5_val(p_getter, o5),
    v_base || '|' || v_x || '|' || v_x || '|' || v_y || '|' || v_x);
  perform public.t_gcsc5_assert('T-gcsc5-b1-' || p_label || '-preserve-flags-truthful-anchor-cleared-later-kept-unrelated-kept',
    '[' || public.t_gcsc5_flags(o1) || ']/[' || public.t_gcsc5_flags(o2) || ']/[' || public.t_gcsc5_flags(o3) || ']/[' || public.t_gcsc5_flags(o4) || ']/[' || public.t_gcsc5_flags(o5) || ']',
    '[]/[]/[]/[' || v_both || ']/[]');
  perform public.t_gcsc5_assert('T-gcsc5-b1-' || p_label || '-preserve-counts-value-changes-only-and-reports-the-kept-customization',
    (v ->> 'edited_class_count') || '/' || (v ->> 'preserved_customized_count') || '/' || (v ->> 'overwritten_customized_count') || '/' || (v ->> 'split_created'), '2/1/0/true');

  v := public.t_gcsc5_apply('OWN', p_label, 2, p_req_b::text, p_changes, true);
  perform public.t_gcsc5_assert('T-gcsc5-b1-' || p_label || '-overwrite-replaces-the-later-customization',
    public.t_gcsc5_val(p_getter, o2) || '|' || public.t_gcsc5_val(p_getter, o3) || '|' || public.t_gcsc5_val(p_getter, o4) || '|' || public.t_gcsc5_val(p_getter, o5), v_x || '|' || v_x || '|' || v_x || '|' || v_x);
  perform public.t_gcsc5_assert('T-gcsc5-b1-' || p_label || '-overwrite-clears-only-the-edited-field-flag',
    '[' || public.t_gcsc5_flags(o4) || ']/[' || public.t_gcsc5_flags(o2) || ']', '[' || p_unrel_group || ']/[]');
  perform public.t_gcsc5_assert('T-gcsc5-b1-' || p_label || '-overwrite-counts', (v ->> 'edited_class_count') || '/' || (v ->> 'overwritten_customized_count') || '/' || (v ->> 'preserved_customized_count'), '1/1/0');
end $f$;
grant execute on function public.t_gcsc5_b1(text, text, text, text, text, text, jsonb, text, text, text) to public;

select public.t_gcsc5_b1('FT', 'title', 'capacity', $$title = 'T-X'$$, $$title = 'T-Y'$$, $$roster_capacity = 9$$,
  '{"title":"T-X"}'::jsonb, 'a.title', '00000000-0000-0000-0000-000000ee8501', '00000000-0000-0000-0000-000000ee8502');
select public.t_gcsc5_b1('FI', 'instructor', 'title', $$instructor_id = '00000000-0000-0000-0000-000000ee2002'$$, $$instructor_id = '00000000-0000-0000-0000-000000ee2004'$$, $$title = 'unrelated'$$,
  '{"instructor_id":"00000000-0000-0000-0000-000000ee2002"}'::jsonb, 'a.instructor_id::text', '00000000-0000-0000-0000-000000ee8503', '00000000-0000-0000-0000-000000ee8504');
select public.t_gcsc5_b1('FR', 'room', 'title', $$room_id = '00000000-0000-0000-0000-000000ee9001'$$, $$room_id = '00000000-0000-0000-0000-000000ee9003'$$, $$title = 'unrelated'$$,
  '{"room_id":"00000000-0000-0000-0000-000000ee9001"}'::jsonb, $$coalesce(a.room_id::text, '-')$$, '00000000-0000-0000-0000-000000ee8505', '00000000-0000-0000-0000-000000ee8506');
select public.t_gcsc5_b1('FL', 'location', 'capacity', $$location_name = 'Loc X'$$, $$location_name = 'Loc Y'$$, $$roster_capacity = 9$$,
  '{"location_name":"Loc X"}'::jsonb, $$coalesce(a.location_name, '-')$$, '00000000-0000-0000-0000-000000ee8507', '00000000-0000-0000-0000-000000ee8508');
select public.t_gcsc5_b1('FC', 'capacity', 'title', $$roster_capacity = 7$$, $$roster_capacity = 9$$, $$title = 'unrelated'$$,
  '{"roster_capacity":7}'::jsonb, $$coalesce(a.roster_capacity::text, '-')$$, '00000000-0000-0000-0000-000000ee8509', '00000000-0000-0000-0000-000000ee8510');
select public.t_gcsc5_b1('FM', 'time', 'title', $$starts_at = starts_at + interval '30 minutes', ends_at = ends_at + interval '30 minutes'$$, $$starts_at = starts_at + interval '60 minutes', ends_at = ends_at + interval '60 minutes'$$, $$title = 'unrelated'$$,
  '{"local_start_time":"18:30"}'::jsonb, $$to_char(a.starts_at at time zone 'America/New_York', 'HH24:MI')$$, '00000000-0000-0000-0000-000000ee8511', '00000000-0000-0000-0000-000000ee8512');
select public.t_gcsc5_b1('FD', 'time', 'title', $$ends_at = ends_at + interval '15 minutes'$$, $$ends_at = ends_at - interval '15 minutes'$$, $$title = 'unrelated'$$,
  '{"duration_minutes":75}'::jsonb, $$(extract(epoch from a.ends_at - a.starts_at) / 60)::integer::text$$, '00000000-0000-0000-0000-000000ee8513', '00000000-0000-0000-0000-000000ee8514');

-- mixed edit: the anchor's customized instructor propagates AND a new title is applied in the same operation
do $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  update public.appointments set instructor_id = '00000000-0000-0000-0000-000000ee2002' where id = public.t_gcsc5_o('FX', 2);
  reset role;
  v := public.t_gcsc5_apply('OWN', 'FX', 2, '00000000-0000-0000-0000-000000ee8515', '{"instructor_id":"00000000-0000-0000-0000-000000ee2002","title":"Mixed"}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-b1-mixed-edit-propagates-customized-instructor-and-applies-the-title',
    (select string_agg(o.idx || ':' || a.title || ':' || (a.instructor_id = '00000000-0000-0000-0000-000000ee2002')::text || ':[' || public.t_gcsc5_flags(a.id) || ']', ' ' order by o.idx)
     from public.t_gcsc5_occ o join public.appointments a on a.id = o.id where o.label = 'FX'),
    '1:SER-FX:false:[] 2:Mixed:true:[] 3:Mixed:true:[] 4:Mixed:true:[] 5:Mixed:true:[]');
end $$;

-- untouched relative to the series baseline: the anchor's customization alone is not a change
select public.t_gcsc5_assert('T-gcsc5-b1-untouched-bulk-form-fixture-anchor-customized',
  (select (select string_agg(o.idx || ':' || (a.instructor_id = '00000000-0000-0000-0000-000000ee2002')::text, ' ' order by o.idx) from public.t_gcsc5_occ o join public.appointments a on a.id = o.id where o.label = 'FU')), '1:false 2:false 3:false 4:false 5:false');
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', public.t_gcsc5_uid('OWN'))::text, true);
  set local role authenticated;
  update public.appointments set instructor_id = '00000000-0000-0000-0000-000000ee2002' where id = public.t_gcsc5_o('FU', 2);
  reset role;
  perform public.t_gcsc5_refuse('T-gcsc5-b1-sending-the-series-baseline-value-is-no-change-and-keeps-the-customized-anchor', 'OWN', 'FU', 2, '00000000-0000-0000-0000-000000ee8516',
    '{"instructor_id":"00000000-0000-0000-0000-000000ee2001"}'::jsonb, 'GCSC5_NO_CHANGES');
  perform public.t_gcsc5_assert('T-gcsc5-b1-nothing-moved-by-the-refused-baseline-edit',
    (select string_agg(o.idx || ':' || (a.instructor_id = '00000000-0000-0000-0000-000000ee2002')::text || ':[' || public.t_gcsc5_flags(a.id) || ']', ' ' order by o.idx) from public.t_gcsc5_occ o join public.appointments a on a.id = o.id where o.label = 'FU'),
    '1:false:[] 2:true:[instructor] 3:false:[] 4:false:[] 5:false:[]');
end $$;

-- the preview agrees with the apply about what is customized (customized only when a DIFFERENT value would be kept or replaced)
do $$
declare v jsonb;
begin
  v := public.t_gcsc5_preview('OWN', 'FU', 2, '{"instructor_id":"00000000-0000-0000-0000-000000ee2002"}'::jsonb);
  perform public.t_gcsc5_assert('T-gcsc5-b1-preview-propagating-the-anchor-value-reports-no-kept-customization',
    (v ->> 'customized_count') || '/' || (v ->> 'changed_count') || '/' || (v ->> 'editable_count'), '0/3/4');
end $$;

-- ============================================================================
-- 10. Everything that must never move
-- ============================================================================
select public.t_gcsc5_assert('T-gcsc5-usage-credits-attendance-policies-never-moved-across-the-whole-suite',
  public.t_gcsc5_money(), (select money from t_gcsc5_base));
select public.t_gcsc5_assert('T-gcsc5-no-appointment-or-attendee-deleted',
  (select count(*)::text from public.appointments a join public.t_gcsc5_occ o on o.id = a.id), (select count(*)::text from public.t_gcsc5_occ));
select public.t_gcsc5_assert('T-gcsc5-only-active-and-cancelled-statuses-ever-stored',
  (select string_agg(distinct s.status, ',' order by s.status) from public.group_class_series s where s.studio_id = '00000000-0000-0000-0000-000000ee0001'), 'active,cancelled');
select public.t_gcsc5_assert('T-gcsc5-lineage-has-at-most-one-successor-per-series',
  (select (count(*) = 0)::text from (select split_from_series_id from public.group_class_series where split_from_series_id is not null group by 1 having count(*) > 1) x), 'true');
select public.t_gcsc5_assert('T-gcsc5-every-successor-is-same-studio-and-has-occurrences',
  (select (bool_and(p.studio_id = s.studio_id) and bool_and(exists (select 1 from public.appointments a where a.group_class_series_id = s.id)))::text
   from public.group_class_series s join public.group_class_series p on p.id = s.split_from_series_id where s.studio_id = '00000000-0000-0000-0000-000000ee0001'), 'true');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsc5_log;

rollback;
