-- FC-1B5D2c-0C -- appointments_select group_class compatibility-branch
-- removal live-Postgres regression suite.
--
-- Proves, at the real Postgres level (not mocked), that removing the
-- temporary group_class SELECT branch from appointments_select preserves
-- every intended persona's access exactly as designed, and denies exactly
-- the one case the branch's removal targets: an active studio member with
-- no genuine relationship to a group_class row (unassigned instructor,
-- independent instructor, or a hybrid user acting outside their own
-- assignment) can no longer read it merely by virtue of an active
-- user_studio_roles row. Entire script runs in one transaction and is
-- rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER the
-- forward migration
-- (20260908100000_fc1b5d2c0c_appointments_group_class_select_cleanup.sql)
-- has been applied.
--
-- Deterministic UUID block reserved for this harness (distinct from the
-- FC-1B5D2 D2C harness's 6a/6b/6c/6d/6e block, so both files could in
-- principle run back-to-back without collision):
-- 00000000-0000-0000-0000-0000007aXXXX (studios)
-- 00000000-0000-0000-0000-0000007bXXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-0000007cXXXX (instructors)
-- 00000000-0000-0000-0000-0000007dXXXX (clients)
-- 00000000-0000-0000-0000-0000007eXXXX (appointments)

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000007a0001', 'FC-1B5D2c-0C Harness Studio A', 't-fc1b5d2c0c-studio-a'),
  ('00000000-0000-0000-0000-0000007a0002', 'FC-1B5D2c-0C Harness Studio B', 't-fc1b5d2c0c-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000007b0001', 't-fc1b5d2c0c-owner@example.test'),
  ('00000000-0000-0000-0000-0000007b0002', 't-fc1b5d2c0c-admin@example.test'),
  ('00000000-0000-0000-0000-0000007b0003', 't-fc1b5d2c0c-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000007b0004', 't-fc1b5d2c0c-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000007b0005', 't-fc1b5d2c0c-instructor-b@example.test'),
  ('00000000-0000-0000-0000-0000007b0006', 't-fc1b5d2c0c-instructor-c@example.test'),
  ('00000000-0000-0000-0000-0000007b0007', 't-fc1b5d2c0c-hybrid@example.test'),
  ('00000000-0000-0000-0000-0000007b0008', 't-fc1b5d2c0c-indepinstructor@example.test'),
  ('00000000-0000-0000-0000-0000007b0009', 't-fc1b5d2c0c-portalself@example.test'),
  ('00000000-0000-0000-0000-0000007b0010', 't-fc1b5d2c0c-portalother@example.test'),
  ('00000000-0000-0000-0000-0000007b0011', 't-fc1b5d2c0c-crossstudio@example.test'),
  ('00000000-0000-0000-0000-0000007b0012', 't-fc1b5d2c0c-platformadmin@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000007b0001', 't-fc1b5d2c0c-owner@example.test', null),
  ('00000000-0000-0000-0000-0000007b0002', 't-fc1b5d2c0c-admin@example.test', null),
  ('00000000-0000-0000-0000-0000007b0003', 't-fc1b5d2c0c-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-0000007b0004', 't-fc1b5d2c0c-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-0000007b0005', 't-fc1b5d2c0c-instructor-b@example.test', null),
  ('00000000-0000-0000-0000-0000007b0006', 't-fc1b5d2c0c-instructor-c@example.test', null),
  ('00000000-0000-0000-0000-0000007b0007', 't-fc1b5d2c0c-hybrid@example.test', null),
  ('00000000-0000-0000-0000-0000007b0008', 't-fc1b5d2c0c-indepinstructor@example.test', null),
  ('00000000-0000-0000-0000-0000007b0009', 't-fc1b5d2c0c-portalself@example.test', null),
  ('00000000-0000-0000-0000-0000007b0010', 't-fc1b5d2c0c-portalother@example.test', null),
  ('00000000-0000-0000-0000-0000007b0011', 't-fc1b5d2c0c-crossstudio@example.test', null),
  ('00000000-0000-0000-0000-0000007b0012', 't-fc1b5d2c0c-platformadmin@example.test', 'platform_admin');

-- user_studio_roles. platform_admin_user and both portal client users
-- deliberately have NO user_studio_roles row anywhere (matches the D2C
-- harness convention -- platform_admin authority comes from
-- profiles.platform_role, portal authority from client_account_links).
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000007b0001', '00000000-0000-0000-0000-0000007a0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000007b0002', '00000000-0000-0000-0000-0000007a0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000007b0003', '00000000-0000-0000-0000-0000007a0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000007b0004', '00000000-0000-0000-0000-0000007a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007b0005', '00000000-0000-0000-0000-0000007a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007b0006', '00000000-0000-0000-0000-0000007a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007b0007', '00000000-0000-0000-0000-0000007a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007b0008', '00000000-0000-0000-0000-0000007a0001', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000007b0011', '00000000-0000-0000-0000-0000007a0002', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007b0004', 'Instructor', 'A', true),
  ('00000000-0000-0000-0000-0000007c0002', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007b0005', 'Instructor', 'B', true),
  ('00000000-0000-0000-0000-0000007c0003', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007b0006', 'Instructor', 'C', true),
  ('00000000-0000-0000-0000-0000007c0004', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007b0007', 'Hybrid', 'Teacher', true),
  ('00000000-0000-0000-0000-0000007c0005', '00000000-0000-0000-0000-0000007a0002', '00000000-0000-0000-0000-0000007b0011', 'CrossStudio', 'Instructor', true);

-- Note: independent instructor (7b0008) deliberately has NO instructors row
-- -- proving "cannot see host group class merely from studio relationship"
-- is not accidentally passing because of a real (but irrelevant) teaching
-- relationship.
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-0000007d0001', '00000000-0000-0000-0000-0000007a0001', 'Hybrid', 'Renter', 'active', true),
  ('00000000-0000-0000-0000-0000007d0002', '00000000-0000-0000-0000-0000007a0001', 'Indep', 'Instructor', 'active', true),
  ('00000000-0000-0000-0000-0000007d0003', '00000000-0000-0000-0000-0000007a0001', 'Portal', 'Self', 'active', false),
  ('00000000-0000-0000-0000-0000007d0004', '00000000-0000-0000-0000-0000007a0001', 'Portal', 'Other', 'active', false);

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type) values
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0001', '00000000-0000-0000-0000-0000007b0007', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0002', '00000000-0000-0000-0000-0000007b0008', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0003', '00000000-0000-0000-0000-0000007b0009', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0004', '00000000-0000-0000-0000-0000007b0010', 'linked', 'self');

insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-0000007e0001', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0001', 'group_class',       'scheduled', '2026-09-14T10:00:00+00', '2026-09-14T11:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0002', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0001', 'private_lesson',    'scheduled', '2026-09-14T11:00:00+00', '2026-09-14T12:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0003', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0002', 'group_class',       'scheduled', '2026-09-14T12:00:00+00', '2026-09-14T13:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0004', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0002', 'private_lesson',    'scheduled', '2026-09-14T13:00:00+00', '2026-09-14T14:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0005', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0003', 'private_lesson',    'scheduled', '2026-09-14T14:00:00+00', '2026-09-14T15:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0006', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0004', 'private_lesson',    'scheduled', '2026-09-14T15:00:00+00', '2026-09-14T16:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0007', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0001', null, 'floor_space_rental', 'scheduled', '2026-09-14T16:00:00+00', '2026-09-14T17:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0008', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0002', null, 'floor_space_rental', 'scheduled', '2026-09-14T17:00:00+00', '2026-09-14T18:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0009', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0003', null, 'private_lesson',    'scheduled', '2026-09-14T18:00:00+00', '2026-09-14T19:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0010', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0004', null, 'private_lesson',    'scheduled', '2026-09-14T19:00:00+00', '2026-09-14T20:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0011', '00000000-0000-0000-0000-0000007a0002', null, '00000000-0000-0000-0000-0000007c0005', 'private_lesson',    'scheduled', '2026-09-14T10:00:00+00', '2026-09-14T11:00:00+00');

-- Aliases (readability only):
-- APPT_A_GROUP    = ...7e0001  Instructor A's own group_class
-- APPT_A_PRIVATE  = ...7e0002  Instructor A's own private_lesson
-- APPT_B_GROUP    = ...7e0003  Instructor B's group_class (the "colleague" target)
-- APPT_B_PRIVATE  = ...7e0004  Instructor B's private_lesson (the "colleague" target)
-- APPT_C_PRIVATE  = ...7e0005  Instructor C's own private_lesson (proves C retains own access)
-- APPT_HYBRID_TEACH  = ...7e0006  Hybrid's own teaching appointment
-- APPT_HYBRID_RENTAL = ...7e0007  Hybrid's own floor rental
-- APPT_INDEP_RENTAL  = ...7e0008  Independent instructor's own floor rental
-- APPT_PORTAL_SELF   = ...7e0009  Portal-self client's own appointment
-- APPT_PORTAL_OTHER  = ...7e0010  Portal-other client's appointment (denied to portal-self)
-- APPT_CROSS_STUDIO  = ...7e0011  Studio B row

-- ============================================================================
-- 1-4. Broad roles can see a colleague's group_class appointment (branches
--      1/2, unaffected by this migration).
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0012')::text, true);
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-platformadmin: platform_admin could not see colleague group_class'; end if;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0001')::text, true);
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-owner: studio_owner could not see colleague group_class'; end if;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0002')::text, true);
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-admin: studio_admin could not see colleague group_class'; end if;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0003')::text, true);
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-frontdesk: front_desk could not see colleague group_class'; end if;
  reset role;

  raise notice 'PASS T-fc1b5d2c0c-broad: platform_admin/studio_owner/studio_admin/front_desk all retain colleague group_class visibility';
end $$;

-- ============================================================================
-- 5-6. Assigned instructor (A) sees own group_class and own private_lesson.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0004')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-assigned-group: instructor A could not see own group_class'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-assigned-private: instructor A could not see own private_lesson'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0c-assigned: assigned instructor retains own group_class and own private_lesson visibility';
end $$;

-- ============================================================================
-- 7-9. Unassigned instructor (C): denied colleague group_class and colleague
--      private_lesson, retains own assigned appointment. This is the flipped
--      assertion vs. pre-migration behavior for the group_class case.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0006')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0003'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0c-unassigned-group: unassigned instructor C could still see colleague B''s group_class -- temporary branch not fully removed'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0004'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0c-unassigned-private: unassigned instructor C could see colleague B''s private_lesson'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0005'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-unassigned-own: unassigned instructor C lost visibility into their own assigned appointment'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0c-unassigned: unassigned instructor denied colleague group_class/private_lesson, retains own assignment';
end $$;

-- ============================================================================
-- 10-11. Independent instructor: cannot see host group_class merely from
--        studio relationship (no real instructors row at all), retains own
--        floor-rental visibility via branch 4.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0008')::text, true);

  select count(*) into v_count from public.appointments where id in ('00000000-0000-0000-0000-0000007e0001'::uuid, '00000000-0000-0000-0000-0000007e0003'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0c-indep-group: independent instructor saw a host group_class row via bare studio relationship, got % rows', v_count; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0008'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-indep-rental: independent instructor lost own floor-rental visibility'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0c-indep: independent instructor denied host group_class, retains own floor-rental visibility';
end $$;

-- ============================================================================
-- 12-14. Hybrid: sees own teaching appointment and own floor-rental
--        appointment, but -- despite holding an active instructor role at
--        the studio -- can no longer see a colleague's group_class. This is
--        the flipped assertion for the hybrid persona specifically, since
--        hybrid's active user_studio_roles row previously satisfied the
--        removed branch directly.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0007')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0006'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-hybrid-teach: hybrid could not see own teaching appointment'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0007'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-hybrid-rental: hybrid could not see own floor-rental appointment'; end if;

  select count(*) into v_count from public.appointments where id in ('00000000-0000-0000-0000-0000007e0001'::uuid, '00000000-0000-0000-0000-0000007e0003'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0c-hybrid-colleague-group: hybrid could still see a colleague group_class row despite active instructor role, got % rows -- temporary branch not fully removed', v_count; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0c-hybrid: hybrid retains own teaching/floor-rental visibility, denied colleague group_class';
end $$;

-- ============================================================================
-- 15-16. Portal client: sees own appointment, denied another client's.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0009')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0009'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-portal-self: portal client could not see own appointment'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0010'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0c-portal-other: portal client could see another client''s appointment'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0c-portal: portal client sees own appointment only, unchanged';
end $$;

-- ============================================================================
-- 17. Cross-studio: denied studio A rows, retains own studio B row.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0011')::text, true);

  select count(*) into v_count from public.appointments where id in ('00000000-0000-0000-0000-0000007e0001'::uuid, '00000000-0000-0000-0000-0000007e0003'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0c-crossstudio: a Studio B instructor saw a Studio A row, got % rows', v_count; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000007e0011'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0c-crossstudio-own: a Studio B instructor should still see their own Studio B row'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0c-crossstudio: cross-studio isolation holds';
end $$;

-- ============================================================================
-- 18/20. Policy inventory: exactly 8 policies remain, appointments_select's
--        body no longer references group_class, RLS enabled/forced state
--        unchanged.
-- ============================================================================
do $$
declare
  v_names text[];
  v_select_qual text;
  v_rowsecurity boolean;
  v_forcerowsecurity boolean;
begin
  select array_agg(polname order by polname) into v_names
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  where c.relname = 'appointments';

  if v_names is distinct from array[
    'appointments_delete',
    'appointments_insert',
    'appointments_select',
    'appointments_update',
    'portal instructors can create own floor rentals',
    'portal instructors can update own floor rentals',
    'portal instructors can view own floor rentals',
    'portal users can view own appointments'
  ] then
    raise exception 'FAIL T-fc1b5d2c0c-inventory: unexpected final policy set (expected exactly 8 unchanged names): %', v_names;
  end if;

  select pg_get_expr(pol.polqual, pol.polrelid) into v_select_qual
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  where c.relname = 'appointments' and pol.polname = 'appointments_select';

  if v_select_qual ilike '%group_class%' then
    raise exception 'FAIL T-fc1b5d2c0c-branch-removed: appointments_select still references group_class -- temporary branch not removed';
  end if;

  select relrowsecurity, relforcerowsecurity into v_rowsecurity, v_forcerowsecurity
  from pg_class where oid = 'public.appointments'::regclass;

  if v_rowsecurity is distinct from true or v_forcerowsecurity is distinct from false then
    raise exception 'FAIL T-fc1b5d2c0c-rls-state: RLS enabled/forced state changed (rowsecurity=%, forcerowsecurity=%)', v_rowsecurity, v_forcerowsecurity;
  end if;

  raise notice 'PASS T-fc1b5d2c0c-inventory: exactly 8 policies remain, appointments_select no longer references group_class, RLS state unchanged';
end $$;

rollback;
