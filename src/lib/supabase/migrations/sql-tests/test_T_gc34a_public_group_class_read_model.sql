-- GC-3.4A -- anonymous-safe public group-class read model, live-Postgres regression suite for
-- 20261024090000_gc34a_public_group_class_read_model.sql.
--
-- Proves, as the real `anon` role (and authenticated), that:
--   * the two public functions are executable by anon/authenticated only, are SECURITY DEFINER with a pinned search_path,
--     the lineage helpers are not executable by anyone, and anon still cannot read appointments directly;
--   * only publicly discoverable group classes of publicly listed studios appear (non-discoverable, no-policy, cancelled,
--     past, other-type and private-studio rows never do), studio scoping and the listing/studio gates hold;
--   * the output exposes only the safe columns and never roster identities (a booked dancer's name is searched for);
--   * spots remaining / full / unlimited / enrollment state are derived from booked attendees in the database;
--   * a single-occurrence lookup returns a truthful cancelled / past state but nothing for hidden records;
--   * instructor name only when the instructor chose a public profile, location label precedence;
--   * a real series split (S1C-5 RPC) keeps every occurrence id, groups the lineage under one root, and the series
--     summary follows the lineage; a non-discoverable lineage is invisible;
--   * occurrence identity survives an edit.
-- One transaction, rolled back. Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261024090000 is applied. Deterministic UUID block ...000000fa....

begin;

create table public.t_gc34a_log (n serial, msg text);
grant all on public.t_gc34a_log to public;
grant usage on sequence public.t_gc34a_log_n_seq to public;
create function public.t_gc34a_pass(p text) returns void language sql as $$ insert into public.t_gc34a_log (msg) values (p) $$;
grant execute on function public.t_gc34a_pass(text) to public;

create function public.t_gc34a_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gc34a_pass(p_label);
end;
$$;
grant execute on function public.t_gc34a_assert(text, text, text) to public;

-- run a single-value query as a given role
create function public.t_gc34a_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
  exception when others then
    reset role;
    raise;
  end;
  reset role;
  return v;
end;
$$;
grant execute on function public.t_gc34a_as(text, text) to public;

-- expect a statement to fail for a role
create function public.t_gc34a_refuse(p_role text, p_sql text, p_like text, p_label text) returns void language plpgsql as $$
declare v_err text;
begin
  begin
    perform public.t_gc34a_as(p_role, p_sql);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'FAIL %: expected an error containing [%], statement succeeded', p_label, p_like;
  end if;
  if position(lower(p_like) in lower(v_err)) = 0 then
    raise exception 'FAIL %: expected error containing [%], got [%]', p_label, p_like, v_err;
  end if;
  perform public.t_gc34a_pass(p_label);
end;
$$;
grant execute on function public.t_gc34a_refuse(text, text, text, text) to public;

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, public_name, slug, timezone, public_directory_enabled, subscription_status, city, state) values
  ('00000000-0000-0000-0000-000000fa0001', 'GC34A Public Studio', 'GC34A Public Studio', 't-gc34a-public', 'America/New_York', true, 'active', 'Austin', 'TX'),
  ('00000000-0000-0000-0000-000000fa0002', 'GC34A Private Studio', 'GC34A Private Studio', 't-gc34a-private', 'America/New_York', false, 'active', 'Dallas', 'TX');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000fa1001', 't-gc34a-owner@example.test'),
  ('00000000-0000-0000-0000-000000fa1002', 't-gc34a-i1@example.test'),
  ('00000000-0000-0000-0000-000000fa1003', 't-gc34a-i2@example.test'),
  ('00000000-0000-0000-0000-000000fa1004', 't-gc34a-i3@example.test');
insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000fa1001', 't-gc34a-owner@example.test', null),
  ('00000000-0000-0000-0000-000000fa1002', 't-gc34a-i1@example.test', null),
  ('00000000-0000-0000-0000-000000fa1003', 't-gc34a-i2@example.test', null),
  ('00000000-0000-0000-0000-000000fa1004', 't-gc34a-i3@example.test', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000fa1001', '00000000-0000-0000-0000-000000fa0001', 'studio_owner', true);
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct, public_profile_enabled) values
  ('00000000-0000-0000-0000-000000fa2001', '00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa1002', 'Pat', 'Public', true, true, true),
  ('00000000-0000-0000-0000-000000fa2002', '00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa1003', 'Quinn', 'Hidden', true, true, false),
  ('00000000-0000-0000-0000-000000fa2003', '00000000-0000-0000-0000-000000fa0002', '00000000-0000-0000-0000-000000fa1004', 'Priv', 'Studio', true, true, true);
alter table public.instructors enable trigger user;
insert into public.rooms (id, studio_id, name) values
  ('00000000-0000-0000-0000-000000fa5001', '00000000-0000-0000-0000-000000fa0001', 'Main Floor');
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-000000fa3001', '00000000-0000-0000-0000-000000fa0001', 'Zelda', 'Secretname', 'active', false),
  ('00000000-0000-0000-0000-000000fa3002', '00000000-0000-0000-0000-000000fa0001', 'Yuri', 'Confidential', 'active', false),
  ('00000000-0000-0000-0000-000000fa3003', '00000000-0000-0000-0000-000000fa0001', 'Xavi', 'Hidden', 'active', false);

--   P1 ea4001 cap 3, two booked, public instructor, room       P2 unlimited, hidden-profile instructor, location_name
--   P3 not discoverable                                          P4 discoverable but cancelled
--   P5 discoverable but past                                     P6 cap 2, two booked (full)
--   P7 no policy row                                             P8 private studio, discoverable
--   P9 self enrollment off (discoverable)                        PL private lesson (not a class)
insert into public.appointments (id, studio_id, client_id, instructor_id, room_id, appointment_type, status, starts_at, ends_at, title, roster_capacity, location_name, notes) values
  ('00000000-0000-0000-0000-000000fa4001', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2001', '00000000-0000-0000-0000-000000fa5001', 'group_class', 'scheduled', now() + interval '5 days',  now() + interval '5 days 1 hour',  'P1 Salsa', 3, null, 'SECRET INTERNAL NOTE'),
  ('00000000-0000-0000-0000-000000fa4002', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2002', null, 'group_class', 'scheduled', now() + interval '6 days',  now() + interval '6 days 1 hour',  'P2 Bachata', null, 'Community Hall', null),
  ('00000000-0000-0000-0000-000000fa4003', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2001', null, 'group_class', 'scheduled', now() + interval '7 days',  now() + interval '7 days 1 hour',  'P3 Hidden', null, null, null),
  ('00000000-0000-0000-0000-000000fa4004', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2001', null, 'group_class', 'scheduled', now() + interval '8 days',  now() + interval '8 days 1 hour',  'P4 Cancelled', null, null, null),
  ('00000000-0000-0000-0000-000000fa4005', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2001', null, 'group_class', 'scheduled', now() - interval '5 days',  now() - interval '5 days' + interval '1 hour', 'P5 Past', null, null, null),
  ('00000000-0000-0000-0000-000000fa4006', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2001', null, 'group_class', 'scheduled', now() + interval '9 days',  now() + interval '9 days 1 hour',  'P6 Full', 2, null, null),
  ('00000000-0000-0000-0000-000000fa4007', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2001', null, 'group_class', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour', 'P7 No policy', null, null, null),
  ('00000000-0000-0000-0000-000000fa4008', '00000000-0000-0000-0000-000000fa0002', null, '00000000-0000-0000-0000-000000fa2003', null, 'group_class', 'scheduled', now() + interval '11 days', now() + interval '11 days 1 hour', 'P8 Private studio', null, null, null),
  ('00000000-0000-0000-0000-000000fa4009', '00000000-0000-0000-0000-000000fa0001', null, '00000000-0000-0000-0000-000000fa2001', null, 'group_class', 'scheduled', now() + interval '12 days', now() + interval '12 days 1 hour', 'P9 Enrollment off', null, null, null),
  ('00000000-0000-0000-0000-000000fa400a', '00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa3003', '00000000-0000-0000-0000-000000fa2001', null, 'private_lesson', 'scheduled', now() + interval '13 days', now() + interval '13 days 1 hour', 'PL Private', null, null, null);
update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-000000fa4004';
insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types) values
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4001', true,  true,  array['package']),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4002', true,  true,  array['package','membership']),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4003', false, false, null),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4004', true,  true,  array['package']),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4005', true,  true,  array['package']),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4006', true,  true,  array['package']),
  ('00000000-0000-0000-0000-000000fa0002', '00000000-0000-0000-0000-000000fa4008', true,  true,  array['package']),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4009', true,  false, array['package']);
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type) values
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4001', '00000000-0000-0000-0000-000000fa3001', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4001', '00000000-0000-0000-0000-000000fa3002', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4006', '00000000-0000-0000-0000-000000fa3001', 'booked', 'staff', 'free_comped'),
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4006', '00000000-0000-0000-0000-000000fa3002', 'booked', 'staff', 'free_comped');
-- a cancelled attendee does not hold a seat
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, cancelled_at, source, billing_type) values
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4002', '00000000-0000-0000-0000-000000fa3003', 'cancelled', now(), 'staff', 'free_comped');

-- ============================================================================
-- 1. Posture
-- ============================================================================
select public.t_gc34a_assert('T-gc34a-public-functions-anon-and-authenticated-only',
  (select (count(*) = 2 and bool_and(
      has_function_privilege('anon', p.oid, 'execute') and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0)
      and p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=pg_catalog, public']))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('public_group_class_occurrences', 'public_group_class_series')), 'true');
select public.t_gc34a_assert('T-gc34a-all-four-definer-functions-pin-pg_catalog-then-public',
  (select (count(*) = 4 and bool_and(p.prosecdef and p.proconfig = array['search_path=pg_catalog, public'] and pg_get_userbyid(p.proowner) = 'postgres'))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('public_group_class_occurrences', 'public_group_class_series', '_gc34a_series_root', '_gc34a_series_family')), 'true');
select public.t_gc34a_assert('T-gc34a-lineage-helpers-have-no-grants',
  (select (count(*) = 2 and bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e where e.grantee = 0)))::text
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('_gc34a_series_root', '_gc34a_series_family')), 'true');
select public.t_gc34a_assert('T-gc34a-anon-still-cannot-read-appointments', public.t_gc34a_as('anon', 'select count(*)::text from public.appointments'), '0');
select public.t_gc34a_assert('T-gc34a-anon-still-cannot-read-policies', public.t_gc34a_as('anon', 'select count(*)::text from public.group_class_enrollment_policies'), '0');
select public.t_gc34a_assert('T-gc34a-anon-cannot-read-attendees', public.t_gc34a_as('anon', 'select count(*)::text from public.appointment_attendees'), '0');
select public.t_gc34a_refuse('anon', 'select public._gc34a_series_root(gen_random_uuid())::text', 'permission denied', 'T-gc34a-anon-cannot-call-helper');
select public.t_gc34a_assert('T-gc34a-never-reads-legacy-events',
  (select (pg_get_functiondef(p.oid) !~* '\mevents\M')::text from pg_proc p where p.proname = 'public_group_class_occurrences' and p.pronamespace = 'public'::regnamespace), 'true');

-- ============================================================================
-- 2. Listing eligibility (anon)
-- ============================================================================
select public.t_gc34a_assert('T-gc34a-anon-listing-only-public-future-uncancelled',
  public.t_gc34a_as('anon', 'select string_agg(title, '','' order by starts_at) from public.public_group_class_occurrences()'),
  'P1 Salsa,P2 Bachata,P6 Full,P9 Enrollment off');
select public.t_gc34a_assert('T-gc34a-listing-by-studio-slug',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(''t-gc34a-public'')'), '4');
select public.t_gc34a_assert('T-gc34a-private-studio-has-nothing-public',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(''t-gc34a-private'')'), '0');
select public.t_gc34a_assert('T-gc34a-unknown-studio-slug-empty',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(''nope'')'), '0');
select public.t_gc34a_assert('T-gc34a-authenticated-sees-the-same-public-list',
  public.t_gc34a_as('authenticated', 'select count(*)::text from public.public_group_class_occurrences()'), '4');
select public.t_gc34a_assert('T-gc34a-limit-is-clamped',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(null, null, null, 0)'), '1');

-- ============================================================================
-- 3. Safe columns only, no roster identity
-- ============================================================================
select public.t_gc34a_assert('T-gc34a-exact-safe-column-list',
  (select array_to_string(array(select n from unnest(p.proargnames[(p.pronargs + 1):]) with ordinality as t(n, i) order by i), ',')
  from pg_proc p where p.proname = 'public_group_class_occurrences' and p.pronamespace = 'public'::regnamespace),
  'appointment_id,series_id,series_root_id,studio_slug,studio_name,studio_logo_url,studio_city,studio_state,time_zone,title,starts_at,ends_at,instructor_name,location_label,capacity,spots_remaining,availability,enrollment_state,public_state');
select public.t_gc34a_assert('T-gc34a-no-roster-or-note-leakage',
  public.t_gc34a_as('anon', 'select (string_agg(r::text, '' '') ~* ''zelda|secretname|yuri|confidential|xavi|secret internal|free_comped|package|membership'')::text from public.public_group_class_occurrences() r'),
  'false');

-- ============================================================================
-- 4. Capacity / availability derived in the database
-- ============================================================================
select public.t_gc34a_assert('T-gc34a-spots-remaining-and-available',
  public.t_gc34a_as('anon', 'select capacity || '':'' || spots_remaining || '':'' || availability || '':'' || enrollment_state from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'')'),
  '3:1:available:open');
select public.t_gc34a_assert('T-gc34a-full-class',
  public.t_gc34a_as('anon', 'select spots_remaining || '':'' || availability || '':'' || enrollment_state from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4006'')'),
  '0:full:full');
select public.t_gc34a_assert('T-gc34a-unlimited-class-and-cancelled-attendee-holds-no-seat',
  public.t_gc34a_as('anon', 'select coalesce(capacity::text, ''null'') || '':'' || coalesce(spots_remaining::text, ''null'') || '':'' || availability from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4002'')'),
  'null:null:unlimited');
select public.t_gc34a_assert('T-gc34a-enrollment-off-reports-unavailable',
  public.t_gc34a_as('anon', 'select enrollment_state from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4009'')'),
  'unavailable');
-- booking a seat is reflected immediately
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type) values
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-000000fa4001', '00000000-0000-0000-0000-000000fa3003', 'booked', 'staff', 'free_comped');
select public.t_gc34a_assert('T-gc34a-last-seat-makes-class-full',
  public.t_gc34a_as('anon', 'select spots_remaining || '':'' || enrollment_state from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'')'),
  '0:full');
delete from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-000000fa4001' and client_id = '00000000-0000-0000-0000-000000fa3003';

-- ============================================================================
-- 5. Single occurrence: truthful state, nothing hidden
-- ============================================================================
select public.t_gc34a_assert('T-gc34a-cancelled-occurrence-by-id-says-cancelled',
  public.t_gc34a_as('anon', 'select public_state || '':'' || enrollment_state from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4004'')'),
  'cancelled:closed');
select public.t_gc34a_assert('T-gc34a-past-occurrence-by-id-says-past',
  public.t_gc34a_as('anon', 'select public_state || '':'' || enrollment_state from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4005'')'),
  'past:closed');
select public.t_gc34a_assert('T-gc34a-upcoming-occurrence-by-id',
  public.t_gc34a_as('anon', 'select public_state from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'')'), 'upcoming');
select public.t_gc34a_assert('T-gc34a-non-discoverable-by-id-returns-nothing',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4003'')'), '0');
select public.t_gc34a_assert('T-gc34a-no-policy-by-id-returns-nothing',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4007'')'), '0');
select public.t_gc34a_assert('T-gc34a-private-studio-by-id-returns-nothing',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4008'')'), '0');
select public.t_gc34a_assert('T-gc34a-private-lesson-by-id-returns-nothing',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa400a'')'), '0');
select public.t_gc34a_assert('T-gc34a-studio-slug-and-id-must-agree',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(''t-gc34a-private'', null, ''00000000-0000-0000-0000-000000fa4001'')'), '0');

-- ============================================================================
-- 6. Instructor display and location label
-- ============================================================================
select public.t_gc34a_assert('T-gc34a-instructor-name-only-with-public-profile',
  public.t_gc34a_as('anon', 'select coalesce(max(instructor_name) filter (where title = ''P1 Salsa''), ''null'') || ''/'' || coalesce(max(instructor_name) filter (where title = ''P2 Bachata''), ''null'') from public.public_group_class_occurrences()'),
  'Pat Public/null');
update public.appointments set location_name = '   ' where id = '00000000-0000-0000-0000-000000fa4009';
select public.t_gc34a_assert('T-gc34a-location-is-location-name-only-trimmed-never-room',
  public.t_gc34a_as('anon', 'select coalesce(max(location_label) filter (where title = ''P1 Salsa''), ''null'') || ''/'' || coalesce(max(location_label) filter (where title = ''P2 Bachata''), ''null'') || ''/'' || coalesce(max(location_label) filter (where title = ''P6 Full''), ''null'') || ''/'' || coalesce(max(location_label) filter (where title = ''P9 Enrollment off''), ''null'') from public.public_group_class_occurrences()'),
  'null/Community Hall/null/null');
-- P1 has a room named 'Main Floor' and no location_name: the room name must not appear anywhere in public output
select public.t_gc34a_assert('T-gc34a-room-name-never-leaks-through-either-public-function',
  public.t_gc34a_as('anon', 'select ((select string_agg(r::text, '' '') from public.public_group_class_occurrences() r) || (select string_agg(r::text, '' '') from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'') r) || (select coalesce(string_agg(r::text, '' ''), '''') from public.public_group_class_series(gen_random_uuid()) r)) ~* ''main floor''::text'), 'false');
select public.t_gc34a_assert('T-gc34a-public-function-source-never-reads-rooms',
  (select (pg_get_functiondef(p.oid) !~* 'mroomsM')::text from pg_proc p where p.proname = 'public_group_class_occurrences' and p.pronamespace = 'public'::regnamespace), 'true');
select public.t_gc34a_assert('T-gc34a-studio-identity-and-time-zone',
  public.t_gc34a_as('anon', 'select studio_slug || '':'' || studio_name || '':'' || studio_city || '':'' || time_zone from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'')'),
  't-gc34a-public:GC34A Public Studio:Austin:America/New_York');

select public.t_gc34a_assert('T-gc34a-limit-picks-the-earliest-rows',
  public.t_gc34a_as('anon', 'select string_agg(title, '','' order by starts_at) from public.public_group_class_occurrences(null, null, null, 2)'), 'P1 Salsa,P2 Bachata');

-- ============================================================================
-- 7. Studio gate and occurrence identity across edits
-- ============================================================================
update public.studios set subscription_status = 'past_due' where id = '00000000-0000-0000-0000-000000fa0001';
select public.t_gc34a_assert('T-gc34a-inactive-subscription-studio-not-public',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(''t-gc34a-public'')'), '0');
update public.studios set subscription_status = 'trialing' where id = '00000000-0000-0000-0000-000000fa0001';
select public.t_gc34a_assert('T-gc34a-trialing-studio-is-public',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(''t-gc34a-public'')'), '4');
update public.studios set public_directory_enabled = false where id = '00000000-0000-0000-0000-000000fa0001';
select public.t_gc34a_assert('T-gc34a-directory-disabled-studio-not-public',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(''t-gc34a-public'')'), '0');
update public.studios set public_directory_enabled = true, subscription_status = 'active' where id = '00000000-0000-0000-0000-000000fa0001';

update public.appointments set title = 'P1 Salsa RENAMED', starts_at = now() + interval '5 days 2 hours', ends_at = now() + interval '5 days 3 hours'
 where id = '00000000-0000-0000-0000-000000fa4001';
select public.t_gc34a_assert('T-gc34a-occurrence-identity-survives-edit',
  public.t_gc34a_as('anon', 'select appointment_id::text || '':'' || title from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'')'),
  '00000000-0000-0000-0000-000000fa4001:P1 Salsa RENAMED');
update public.group_class_enrollment_policies set publicly_discoverable = false where appointment_id = '00000000-0000-0000-0000-000000fa4001';
select public.t_gc34a_assert('T-gc34a-turning-discovery-off-hides-the-class',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'')'), '0');
update public.group_class_enrollment_policies set publicly_discoverable = true where appointment_id = '00000000-0000-0000-0000-000000fa4001';

-- ============================================================================
-- 7b. A discoverable series, a real S1C-5 split, and lineage grouping
-- ============================================================================
do $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000fa1001')::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000fa0001',
    p_client_request_id => '00000000-0000-0000-0000-000000fa7001',
    p_title => 'GC34A Series', p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000fa2001', p_room_id => null, p_location_name => null, p_roster_capacity => 5,
    p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => 4,
    p_local_start_time => time '18:30', p_duration_minutes => 60,
    p_publicly_discoverable => true, p_self_enrollment_allowed => true, p_accepted_funding_types => array['package']);
  reset role;
  perform set_config('t.series', v_res ->> 'series_id', true);
end $$;
-- a second, NOT discoverable series
do $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000fa1001')::text, true);
  set local role authenticated;
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000fa0001',
    p_client_request_id => '00000000-0000-0000-0000-000000fa7002',
    p_title => 'GC34A Private Series', p_description => null,
    p_instructor_id => '00000000-0000-0000-0000-000000fa2001', p_room_id => null, p_location_name => null, p_roster_capacity => 5,
    p_weekdays => array[3]::smallint[], p_interval_weeks => 1, p_starts_on => (current_date + 20), p_ends_on => null, p_occurrence_count => 2,
    p_local_start_time => time '19:30', p_duration_minutes => 60);
  reset role;
  perform set_config('t.pseries', v_res ->> 'series_id', true);
end $$;
select set_config('t.ids_before', (select string_agg(id::text, ',' order by series_occurrence_index) from public.appointments where group_class_series_id = current_setting('t.series')::uuid), true);

select public.t_gc34a_assert('T-gc34a-series-listing-has-all-four-occurrences',
  public.t_gc34a_as('anon', format('select count(*)::text from public.public_group_class_occurrences(null, %L::uuid)', current_setting('t.series'))), '4');
select public.t_gc34a_assert('T-gc34a-series-summary-before-split',
  public.t_gc34a_as('anon', format('select title || '':'' || upcoming_count || '':'' || studio_slug from public.public_group_class_series(%L::uuid)', current_setting('t.series'))),
  'GC34A Series:4:t-gc34a-public');
select public.t_gc34a_assert('T-gc34a-non-discoverable-series-invisible',
  public.t_gc34a_as('anon', format('select count(*)::text from public.public_group_class_series(%L::uuid)', current_setting('t.pseries'))), '0');
select public.t_gc34a_assert('T-gc34a-non-discoverable-series-listing-empty',
  public.t_gc34a_as('anon', format('select count(*)::text from public.public_group_class_occurrences(null, %L::uuid)', current_setting('t.pseries'))), '0');
select public.t_gc34a_assert('T-gc34a-unknown-series-empty',
  public.t_gc34a_as('anon', 'select count(*)::text from public.public_group_class_series(gen_random_uuid())'), '0');

-- This-and-following edit from occurrence index 2 (S1C-5 split): successor series, same appointment rows
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000fa1001')::text, true);
  set local role authenticated;
  perform public.edit_group_class_series_from(
    (select id from public.appointments where group_class_series_id = current_setting('t.series')::uuid and series_occurrence_index = 2),
    '00000000-0000-0000-0000-000000fa7003'::uuid, '{"title":"GC34A Series Renamed"}'::jsonb, false);
  reset role;
end $$;
select public.t_gc34a_assert('T-gc34a-split-created-a-successor-series',
  (select count(distinct group_class_series_id)::text from public.appointments where studio_id = '00000000-0000-0000-0000-000000fa0001' and title like 'GC34A Series%'), '2');
select public.t_gc34a_assert('T-gc34a-split-keeps-every-occurrence-id',
  (select string_agg(id::text, ',' order by starts_at) from public.appointments where studio_id = '00000000-0000-0000-0000-000000fa0001' and title like 'GC34A Series%'),
  current_setting('t.ids_before'));
select public.t_gc34a_assert('T-gc34a-split-lineage-lists-all-occurrences-from-the-original-series-id',
  public.t_gc34a_as('anon', format('select string_agg(appointment_id::text, '','' order by starts_at) from public.public_group_class_occurrences(null, %L::uuid)', current_setting('t.series'))),
  current_setting('t.ids_before'));
select public.t_gc34a_assert('T-gc34a-split-lineage-lists-all-occurrences-from-the-successor-series-id',
  public.t_gc34a_as('anon', format('select string_agg(appointment_id::text, '','' order by starts_at) from public.public_group_class_occurrences(null, %L::uuid)',
    (select group_class_series_id::text from public.appointments where group_class_series_id <> current_setting('t.series')::uuid and title like 'GC34A Series%' limit 1))),
  current_setting('t.ids_before'));
select public.t_gc34a_assert('T-gc34a-split-all-occurrences-share-one-series-root',
  public.t_gc34a_as('anon', format('select count(distinct series_root_id)::text || '':'' || bool_and(series_root_id = %L::uuid)::text from public.public_group_class_occurrences(null, %L::uuid)', current_setting('t.series'), current_setting('t.series'))),
  '1:true');
select public.t_gc34a_assert('T-gc34a-split-occurrences-have-different-current-series-ids',
  public.t_gc34a_as('anon', format('select count(distinct series_id)::text from public.public_group_class_occurrences(null, %L::uuid)', current_setting('t.series'))), '2');
select public.t_gc34a_assert('T-gc34a-series-summary-follows-lineage-from-either-end',
  public.t_gc34a_as('anon', format('select title || '':'' || upcoming_count from public.public_group_class_series(%L::uuid)',
    (select group_class_series_id::text from public.appointments where group_class_series_id <> current_setting('t.series')::uuid and title like 'GC34A Series%' limit 1))),
  'GC34A Series Renamed:4');
select public.t_gc34a_assert('T-gc34a-series-summary-root-is-stable',
  public.t_gc34a_as('anon', format('select (series_root_id = %L::uuid)::text from public.public_group_class_series(%L::uuid)', current_setting('t.series'), current_setting('t.series'))), 'true');

-- a cancelled occurrence leaves the series listing
update public.appointments set status = 'cancelled'
 where id = (select id from public.appointments where group_class_series_id = current_setting('t.series')::uuid order by starts_at limit 1);
select public.t_gc34a_assert('T-gc34a-cancelled-series-occurrence-leaves-listing-and-count',
  public.t_gc34a_as('anon', format('select (select count(*) from public.public_group_class_occurrences(null, %L::uuid))::text || '':'' || (select upcoming_count from public.public_group_class_series(%L::uuid))::text', current_setting('t.series'), current_setting('t.series'))),
  '3:3');

-- (last, because deactivating the instructor would block later assignments in this fixture; the transaction is rolled back)
update public.instructors set active = false where id = '00000000-0000-0000-0000-000000fa2001';
select public.t_gc34a_assert('T-gc34a-deactivated-instructor-name-not-public',
  public.t_gc34a_as('anon', 'select coalesce(instructor_name, ''null'') from public.public_group_class_occurrences(null, null, ''00000000-0000-0000-0000-000000fa4001'')'), 'null');

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gc34a_log;

rollback;
