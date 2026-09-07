-- FC-1B5D2 D2C -- appointments RLS tightening live-Postgres regression
-- suite.
--
-- Proves, at the real Postgres level (not mocked), that the tightened
-- appointments_select/insert/update/delete policies (plus the preserved
-- portal/floor-rental policies) produce exactly the persona/command
-- behavior the D2C design specifies. Entire script runs in one transaction
-- and is rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER the
-- forward migration (20260907050000_fc1b5d2_d2c_appointments_rls_tightening.sql)
-- has been applied.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000006aXXXX (studios)
-- 00000000-0000-0000-0000-0000006bXXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-0000006cXXXX (instructors)
-- 00000000-0000-0000-0000-0000006dXXXX (clients)
-- 00000000-0000-0000-0000-0000006eXXXX (appointments)
--
-- CORRECTED (post-independent-review, pre-commit hardening pass): the
-- UPDATE type-flip guard now calls can_preserve_existing_group_class_for_
-- instructor instead of the earlier _appointment_current_type_is_group_class
-- (a generic, relationship-independent oracle -- see the forward
-- migration's own comment). This file adds permanent regression coverage
-- for: oracle closure (a non-owning caller gets the identical false result
-- for a hidden private lesson and a hidden group_class row), an
-- instructor editing their own already-group_class row, an id-collision
-- exploit attempt against the type-flip guard, explicit cross-studio
-- instructor INSERT denial, independent-instructor floor-rental-to-
-- teaching-row escalation denial, and same-studio hybrid UPDATE/DELETE
-- isolation (previously verified only ad hoc during review, not codified).

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000006a0001', 'FC-1B5D2 D2C Harness Studio A', 't-fc1b5d2-d2c-studio-a'),
  ('00000000-0000-0000-0000-0000006a0002', 'FC-1B5D2 D2C Harness Studio B', 't-fc1b5d2-d2c-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000006b0001', 't-fc1b5d2-d2c-owner@example.test'),
  ('00000000-0000-0000-0000-0000006b0002', 't-fc1b5d2-d2c-admin@example.test'),
  ('00000000-0000-0000-0000-0000006b0003', 't-fc1b5d2-d2c-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000006b0004', 't-fc1b5d2-d2c-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000006b0005', 't-fc1b5d2-d2c-instructor-b@example.test'),
  ('00000000-0000-0000-0000-0000006b0006', 't-fc1b5d2-d2c-hybrid@example.test'),
  ('00000000-0000-0000-0000-0000006b0007', 't-fc1b5d2-d2c-indepinstructor@example.test'),
  ('00000000-0000-0000-0000-0000006b0008', 't-fc1b5d2-d2c-unrelatedrenter@example.test'),
  ('00000000-0000-0000-0000-0000006b0009', 't-fc1b5d2-d2c-noaccount@example.test'),
  ('00000000-0000-0000-0000-0000006b0010', 't-fc1b5d2-d2c-platformadmin@example.test'),
  ('00000000-0000-0000-0000-0000006b0011', 't-fc1b5d2-d2c-crossstudio@example.test'),
  ('00000000-0000-0000-0000-0000006b0012', 't-fc1b5d2-d2c-portalclient@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000006b0001', 't-fc1b5d2-d2c-owner@example.test', null),
  ('00000000-0000-0000-0000-0000006b0002', 't-fc1b5d2-d2c-admin@example.test', null),
  ('00000000-0000-0000-0000-0000006b0003', 't-fc1b5d2-d2c-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-0000006b0004', 't-fc1b5d2-d2c-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-0000006b0005', 't-fc1b5d2-d2c-instructor-b@example.test', null),
  ('00000000-0000-0000-0000-0000006b0006', 't-fc1b5d2-d2c-hybrid@example.test', null),
  ('00000000-0000-0000-0000-0000006b0007', 't-fc1b5d2-d2c-indepinstructor@example.test', null),
  ('00000000-0000-0000-0000-0000006b0008', 't-fc1b5d2-d2c-unrelatedrenter@example.test', null),
  ('00000000-0000-0000-0000-0000006b0009', 't-fc1b5d2-d2c-noaccount@example.test', null),
  ('00000000-0000-0000-0000-0000006b0010', 't-fc1b5d2-d2c-platformadmin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-0000006b0011', 't-fc1b5d2-d2c-crossstudio@example.test', null),
  ('00000000-0000-0000-0000-0000006b0012', 't-fc1b5d2-d2c-portalclient@example.test', null);

-- user_studio_roles. Note: hybrid has exactly ONE role row (instructor),
-- despite also having a real client_account_links relationship -- proving
-- the dual capability comes from having both real relationships, not from
-- a second role. platform_admin_user and portal_client_user deliberately
-- have NO user_studio_roles row anywhere. noaccount_user likewise has none.
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000006b0001', '00000000-0000-0000-0000-0000006a0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000006b0002', '00000000-0000-0000-0000-0000006a0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000006b0003', '00000000-0000-0000-0000-0000006a0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000006b0004', '00000000-0000-0000-0000-0000006a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000006b0005', '00000000-0000-0000-0000-0000006a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000006b0006', '00000000-0000-0000-0000-0000006a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000006b0007', '00000000-0000-0000-0000-0000006a0001', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000006b0008', '00000000-0000-0000-0000-0000006a0001', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000006b0011', '00000000-0000-0000-0000-0000006a0002', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000006c0001', '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006b0004', 'Instructor', 'A', true),
  ('00000000-0000-0000-0000-0000006c0002', '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006b0005', 'Instructor', 'B', true),
  ('00000000-0000-0000-0000-0000006c0003', '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006b0006', 'Hybrid', 'Teacher', true),
  ('00000000-0000-0000-0000-0000006c0004', '00000000-0000-0000-0000-0000006a0002', '00000000-0000-0000-0000-0000006b0011', 'CrossStudio', 'Instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-0000006d0001', '00000000-0000-0000-0000-0000006a0001', 'Hybrid', 'Renter', 'active', true),
  ('00000000-0000-0000-0000-0000006d0002', '00000000-0000-0000-0000-0000006a0001', 'Indep', 'Instructor', 'active', true),
  ('00000000-0000-0000-0000-0000006d0003', '00000000-0000-0000-0000-0000006a0001', 'Unrelated', 'Renter', 'active', true),
  ('00000000-0000-0000-0000-0000006d0004', '00000000-0000-0000-0000-0000006a0001', 'Portal', 'Client', 'active', false);

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type) values
  ('00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0001', '00000000-0000-0000-0000-0000006b0006', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0002', '00000000-0000-0000-0000-0000006b0007', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0003', '00000000-0000-0000-0000-0000006b0008', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0004', '00000000-0000-0000-0000-0000006b0012', 'linked', 'self');

insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-0000006e0001', '00000000-0000-0000-0000-0000006a0001', null, '00000000-0000-0000-0000-0000006c0001', 'private_lesson', 'scheduled', '2026-09-10T10:00:00+00', '2026-09-10T11:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0002', '00000000-0000-0000-0000-0000006a0001', null, '00000000-0000-0000-0000-0000006c0002', 'private_lesson', 'scheduled', '2026-09-10T11:00:00+00', '2026-09-10T12:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0003', '00000000-0000-0000-0000-0000006a0001', null, null, 'private_lesson', 'scheduled', '2026-09-10T12:00:00+00', '2026-09-10T13:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0004', '00000000-0000-0000-0000-0000006a0001', null, '00000000-0000-0000-0000-0000006c0002', 'group_class', 'scheduled', '2026-09-10T13:00:00+00', '2026-09-10T14:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0005', '00000000-0000-0000-0000-0000006a0001', null, '00000000-0000-0000-0000-0000006c0003', 'private_lesson', 'scheduled', '2026-09-10T14:00:00+00', '2026-09-10T15:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0006', '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0001', null, 'floor_space_rental', 'scheduled', '2026-09-10T15:00:00+00', '2026-09-10T16:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0007', '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0003', null, 'floor_space_rental', 'scheduled', '2026-09-10T16:00:00+00', '2026-09-10T17:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0008', '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0002', null, 'floor_space_rental', 'scheduled', '2026-09-10T17:00:00+00', '2026-09-10T18:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0009', '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006d0004', null, 'private_lesson', 'scheduled', '2026-09-10T18:00:00+00', '2026-09-10T19:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0010', '00000000-0000-0000-0000-0000006a0002', null, '00000000-0000-0000-0000-0000006c0004', 'private_lesson', 'scheduled', '2026-09-10T10:00:00+00', '2026-09-10T11:00:00+00'),
  ('00000000-0000-0000-0000-0000006e0011', '00000000-0000-0000-0000-0000006a0001', null, '00000000-0000-0000-0000-0000006c0001', 'group_class', 'scheduled', '2026-09-10T19:00:00+00', '2026-09-10T20:00:00+00');

-- Convenience aliases (as SQL comments only, for readability below):
-- APPT_A        = ...6e0001  Instructor A's own teaching row
-- APPT_B        = ...6e0002  Instructor B's own teaching row (A's colleague-row target)
-- APPT_UNASSIGNED = ...6e0003  instructor_id IS NULL
-- APPT_GROUP    = ...6e0004  group_class, taught by Instructor B
-- APPT_HYBRID_TEACH  = ...6e0005  Hybrid's own teaching row
-- APPT_HYBRID_RENTAL = ...6e0006  Hybrid's own floor rental (client ...6d0001)
-- APPT_OTHER_RENTAL  = ...6e0007  Unrelated renter's floor rental (client ...6d0003)
-- APPT_INDEP_RENTAL  = ...6e0008  Independent instructor's own floor rental (client ...6d0002)
-- APPT_PORTAL_SELF   = ...6e0009  Portal client's own booked lesson (client ...6d0004)
-- APPT_CROSS_STUDIO  = ...6e0010  Studio B row
-- APPT_A_GROUP  = ...6e0011  Instructor A's OWN group_class row

-- ============================================================================
-- studio_owner -- broad access (SELECT/INSERT/UPDATE/DELETE).
-- ============================================================================
do $$
declare
  v_select_count int;
  v_new_id uuid := '00000000-0000-0000-0000-0000006e0101';
  v_update_id uuid := '00000000-0000-0000-0000-0000006e0102';
  v_delete_id uuid := '00000000-0000-0000-0000-0000006e0103';
  v_row record;
begin
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
  values (v_update_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0002', 'private_lesson', 'scheduled', '2026-09-11T10:00:00+00', '2026-09-11T11:00:00+00');
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
  values (v_delete_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0002', 'private_lesson', 'scheduled', '2026-09-11T11:00:00+00', '2026-09-11T12:00:00+00');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0001')::text, true);

  -- SELECT: a colleague row (not owner's own) at their studio.
  select count(*) into v_select_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0002'::uuid;
  if v_select_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-owner-select: studio_owner could not select a colleague row, got %', v_select_count; end if;

  -- INSERT: a brand-new appointment assigned to someone else.
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
  values (v_new_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0002', 'private_lesson', 'scheduled', '2026-09-11T09:00:00+00', '2026-09-11T09:30:00+00');
  select count(*) into v_select_count from public.appointments where id = v_new_id;
  if v_select_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-owner-insert: studio_owner insert did not take effect'; end if;

  -- UPDATE: any row at the studio.
  update public.appointments set status = 'confirmed' where id = v_update_id;
  select status into v_row from public.appointments where id = v_update_id;
  if v_row.status is distinct from 'confirmed' then raise exception 'FAIL T-fc1b5d2-d2c-owner-update: studio_owner update did not take effect'; end if;

  -- DELETE: any row at the studio.
  delete from public.appointments where id = v_delete_id;
  select count(*) into v_select_count from public.appointments where id = v_delete_id;
  if v_select_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-owner-delete: studio_owner delete did not take effect'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2-d2c-owner: studio_owner select/insert/update/delete all succeed broadly';
end $$;

-- ============================================================================
-- studio_admin -- same broad behavior as studio_owner.
-- ============================================================================
do $$
declare
  v_count int;
  v_update_id uuid := '00000000-0000-0000-0000-0000006e0111';
  v_delete_id uuid := '00000000-0000-0000-0000-0000006e0112';
  v_row record;
begin
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
  values (v_update_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0001', 'private_lesson', 'scheduled', '2026-09-11T12:00:00+00', '2026-09-11T13:00:00+00');
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
  values (v_delete_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0001', 'private_lesson', 'scheduled', '2026-09-11T13:00:00+00', '2026-09-11T14:00:00+00');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0002')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-admin-select: studio_admin could not select a colleague row'; end if;

  update public.appointments set status = 'confirmed' where id = v_update_id;
  select status into v_row from public.appointments where id = v_update_id;
  if v_row.status is distinct from 'confirmed' then raise exception 'FAIL T-fc1b5d2-d2c-admin-update: studio_admin update did not take effect'; end if;

  delete from public.appointments where id = v_delete_id;
  select count(*) into v_count from public.appointments where id = v_delete_id;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-admin-delete: studio_admin delete did not take effect'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2-d2c-admin: studio_admin select/update/delete all succeed broadly';
end $$;

-- ============================================================================
-- front_desk -- same broad behavior, INCLUDING hard delete (the explicit
-- dedicated path this migration adds, replacing the old accidental
-- FOR-ALL overlap).
-- ============================================================================
do $$
declare
  v_count int;
  v_delete_id uuid := '00000000-0000-0000-0000-0000006e0121';
begin
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
  values (v_delete_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0001', 'private_lesson', 'scheduled', '2026-09-11T15:00:00+00', '2026-09-11T16:00:00+00');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0003')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-frontdesk-select: front_desk could not select a colleague row'; end if;

  delete from public.appointments where id = v_delete_id;
  select count(*) into v_count from public.appointments where id = v_delete_id;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-frontdesk-delete: front_desk hard delete did not take effect'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2-d2c-frontdesk: front_desk select and hard delete both succeed';
end $$;

-- ============================================================================
-- ordinary instructor (Instructor A) -- own-assignment scoping.
-- ============================================================================
do $$
declare
  v_count int;
  v_row record;
  v_insert_own_id uuid := '00000000-0000-0000-0000-0000006e0131';
  v_insert_colleague_id uuid := '00000000-0000-0000-0000-0000006e0132';
  v_denied boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0004')::text, true);

  -- select own assigned allowed
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-instr-select-own: expected own row visible'; end if;

  -- select colleague denied
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0002'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-instr-select-colleague: colleague row should be denied'; end if;

  -- select unassigned denied
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0003'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-instr-select-unassigned: unassigned row should be denied'; end if;

  -- insert own allowed
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
  values (v_insert_own_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0001', 'private_lesson', 'scheduled', '2026-09-12T09:00:00+00', '2026-09-12T09:30:00+00');

  -- insert colleague denied (WITH CHECK failure raises insufficient_privilege)
  v_denied := false;
  begin
    insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
    values (v_insert_colleague_id, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0002', 'private_lesson', 'scheduled', '2026-09-12T10:00:00+00', '2026-09-12T10:30:00+00');
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2-d2c-instr-insert-colleague: instructor inserted an appointment assigned to a colleague'; end if;

  -- update own allowed
  update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_row.status is distinct from 'confirmed' then raise exception 'FAIL T-fc1b5d2-d2c-instr-update-own: own-row update did not take effect'; end if;

  -- update colleague denied (silent -- USING excludes the row, 0 rows affected)
  update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000006e0002'::uuid;

  -- reassign own to colleague denied (WITH CHECK failure)
  v_denied := false;
  begin
    update public.appointments set instructor_id = '00000000-0000-0000-0000-0000006c0002'::uuid where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2-d2c-instr-reassign: instructor reassigned own appointment to a colleague'; end if;

  -- delete own denied (silent, 0 rows affected)
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;

  -- delete colleague denied (silent, 0 rows affected)
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0002'::uuid;

  reset role;

  -- Verify, as the fixture owner (no RLS), that the two "denied" updates/
  -- deletes above genuinely had zero effect.
  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0002'::uuid;
  if v_row.status is distinct from 'scheduled' then raise exception 'FAIL T-fc1b5d2-d2c-instr-update-colleague: colleague row status was changed'; end if;

  select count(*) into v_count from public.appointments where id in ('00000000-0000-0000-0000-0000006e0001'::uuid, '00000000-0000-0000-0000-0000006e0002'::uuid);
  if v_count <> 2 then raise exception 'FAIL T-fc1b5d2-d2c-instr-delete: own or colleague row was deleted despite denial, got % remaining', v_count; end if;

  raise notice 'PASS T-fc1b5d2-d2c-instr: ordinary instructor own-assignment scoping fully correct (select/insert/update/reassign/delete)';
end $$;

-- ============================================================================
-- same-studio hybrid (one user, real instructors row + real
-- client_account_links row, ONE user_studio_roles row).
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0006')::text, true);

  -- own teaching row allowed
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0005'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-teach: hybrid could not select own teaching row'; end if;

  -- own floor-rental row allowed
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0006'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-rental: hybrid could not select own floor-rental row'; end if;

  -- colleague teaching row denied
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-colleague: hybrid should not see colleague teaching row'; end if;

  -- other renter's floor-rental denied
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0007'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-otherrenter: hybrid should not see another renter''s floor rental'; end if;

  -- no broad leakage: unassigned row and cross-studio row both denied
  select count(*) into v_count from public.appointments where id in ('00000000-0000-0000-0000-0000006e0003'::uuid, '00000000-0000-0000-0000-0000006e0010'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-leakage: hybrid saw an unassigned or cross-studio row, got % rows', v_count; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2-d2c-hybrid: dual teaching+floor-rental relationship correctly scoped, no broad leakage';
end $$;

-- ============================================================================
-- independent instructor -- own floor-rental only, no teaching relationship.
-- ============================================================================
do $$
declare
  v_count int;
  v_row record;
  v_denied boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0007')::text, true);

  -- own floor-rental SELECT preserved
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0008'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-indep-select: independent instructor could not select own floor rental'; end if;

  -- own floor-rental UPDATE preserved
  update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000006e0008'::uuid;
  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0008'::uuid;
  if v_row.status is distinct from 'confirmed' then raise exception 'FAIL T-fc1b5d2-d2c-indep-update: independent instructor own floor-rental update did not take effect'; end if;

  -- unrelated floor-rental denied
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0007'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-indep-unrelated: independent instructor should not see another renter''s floor rental'; end if;

  -- host teaching rows denied (no real instructors row for this user)
  select count(*) into v_count from public.appointments where id in ('00000000-0000-0000-0000-0000006e0001'::uuid, '00000000-0000-0000-0000-0000006e0002'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-indep-teaching: independent instructor without a real instructors row should not see any teaching rows'; end if;

  -- delete denied (silent, 0 rows affected, even on own row)
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0008'::uuid;

  reset role;
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0008'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-indep-delete: independent instructor''s own floor rental was deleted despite denial'; end if;

  raise notice 'PASS T-fc1b5d2-d2c-indep: independent instructor floor-rental-only scoping correct, delete denied';
end $$;

-- ============================================================================
-- group-class temporary legacy compatibility (FC-1B5D2c).
-- ============================================================================
do $$
declare
  v_count int;
  v_denied boolean;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0004')::text, true);

  -- ordinary active instructor may SELECT group_class row regardless of assignment
  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0004'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-group-select: instructor could not select an unassigned group_class row'; end if;

  -- group_class does not broaden INSERT: instructor A cannot insert a
  -- group_class appointment assigned to colleague B.
  v_denied := false;
  begin
    insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
    values ('00000000-0000-0000-0000-0000006e0141'::uuid, '00000000-0000-0000-0000-0000006a0001', '00000000-0000-0000-0000-0000006c0002', 'group_class', 'scheduled', '2026-09-13T09:00:00+00', '2026-09-13T09:30:00+00');
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2-d2c-group-insert: group_class did not block an insert assigned to a colleague'; end if;

  -- group_class does not broaden UPDATE: instructor A cannot update the
  -- group_class row taught by B (a colleague's row, not A's own).
  update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000006e0004'::uuid;

  -- group_class does not broaden DELETE: same row, delete also denied.
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0004'::uuid;

  -- ordinary instructor cannot flip own non-group row into group_class.
  v_denied := false;
  begin
    update public.appointments set appointment_type = 'group_class' where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2-d2c-group-flip-own: instructor flipped own row into group_class'; end if;

  -- unrelated non-owned row cannot be made reachable by type flip
  -- (already denied at USING before WITH CHECK is even reached -- silent).
  update public.appointments set appointment_type = 'group_class' where id = '00000000-0000-0000-0000-0000006e0002'::uuid;

  reset role;

  -- Verify none of the "denied" mutations above actually took effect.
  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0004'::uuid;
  if v_row.status is distinct from 'scheduled' then raise exception 'FAIL T-fc1b5d2-d2c-group-update: group_class row status was changed by a non-owning instructor'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0004'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-group-delete: group_class row was deleted by a non-owning instructor'; end if;

  select appointment_type::text as appointment_type into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_row.appointment_type is distinct from 'private_lesson' then raise exception 'FAIL T-fc1b5d2-d2c-group-flip-verify: own row type was actually flipped to group_class'; end if;

  select appointment_type::text as appointment_type into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0002'::uuid;
  if v_row.appointment_type is distinct from 'private_lesson' then raise exception 'FAIL T-fc1b5d2-d2c-group-flip-unowned: colleague row type was flipped to group_class'; end if;

  raise notice 'PASS T-fc1b5d2-d2c-group: group_class compatibility is SELECT-only -- no INSERT/UPDATE/DELETE broadening, type-flip guard holds';
end $$;

-- ============================================================================
-- oracle closure -- can_preserve_existing_group_class_for_instructor must
-- return the SAME (false) result whether the hidden, unrelated appointment
-- is actually a private lesson or actually a group_class row -- the
-- caller must not be able to distinguish the two unless they genuinely own
-- the supplied studio+instructor relationship. Instructor A probes using
-- their OWN real (studio, instructor) pair (the only pair the RLS-calling
-- context would ever legitimately supply) against two DIFFERENT hidden
-- appointments actually owned by colleague B: one private_lesson
-- (APPT_B), one group_class (APPT_GROUP).
-- ============================================================================
do $$
declare
  v_result_private boolean;
  v_result_group boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0004')::text, true);

  select public.can_preserve_existing_group_class_for_instructor(
    '00000000-0000-0000-0000-0000006e0002'::uuid,  -- APPT_B, hidden private_lesson
    '00000000-0000-0000-0000-0000006a0001'::uuid,
    '00000000-0000-0000-0000-0000006c0001'::uuid   -- A's own instructor id (not B's)
  ) into v_result_private;

  select public.can_preserve_existing_group_class_for_instructor(
    '00000000-0000-0000-0000-0000006e0004'::uuid,  -- APPT_GROUP, hidden group_class
    '00000000-0000-0000-0000-0000006a0001'::uuid,
    '00000000-0000-0000-0000-0000006c0001'::uuid
  ) into v_result_group;

  reset role;

  if v_result_private is distinct from false or v_result_group is distinct from false then
    raise exception 'FAIL T-fc1b5d2-d2c-oracle: helper leaked a distinguishing result for a non-owned row (private=%, group=%), expected false/false', v_result_private, v_result_group;
  end if;

  if v_result_private is distinct from v_result_group then
    raise exception 'FAIL T-fc1b5d2-d2c-oracle-distinguish: hidden private_lesson and hidden group_class produced DIFFERENT results -- oracle not closed';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c-oracle: a non-owning caller receives the identical false result regardless of the hidden row''s real type -- oracle closed';
end $$;

-- ============================================================================
-- existing group_class own-row edit -- an instructor updating their OWN
-- already-group_class appointment (ordinary field edit, type re-submitted
-- unchanged) must succeed, not be incorrectly blocked by the type-flip
-- guard.
-- ============================================================================
do $$
declare
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0004')::text, true);

  update public.appointments
  set appointment_type = 'group_class', status = 'attended'
  where id = '00000000-0000-0000-0000-0000006e0011'::uuid;

  reset role;

  select status, appointment_type::text as appointment_type into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0011'::uuid;
  if v_row.status is distinct from 'attended' or v_row.appointment_type is distinct from 'group_class' then
    raise exception 'FAIL T-fc1b5d2-d2c-own-group-edit: instructor could not edit their own already-group_class row (status=%, type=%)', v_row.status, v_row.appointment_type;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c-own-group-edit: instructor can update their own already-group_class row without being blocked';
end $$;

-- ============================================================================
-- ID manipulation -- attempting to rewrite own row's primary key to an
-- existing, unrelated, real group_class row's id while simultaneously
-- flipping type to group_class must not bypass the guard.
-- ============================================================================
do $$
declare
  v_errored boolean := false;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0004')::text, true);

  begin
    update public.appointments
    set id = '00000000-0000-0000-0000-0000006e0004'::uuid, appointment_type = 'group_class'
    where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  exception when unique_violation then
    v_errored := true;
  when insufficient_privilege then
    v_errored := true;
  end;

  reset role;

  if not v_errored then
    raise exception 'FAIL T-fc1b5d2-d2c-id-manipulation: id-collision type-flip attempt did not error -- investigate for a real bypass';
  end if;

  select appointment_type::text as appointment_type into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_row.appointment_type is distinct from 'private_lesson' then
    raise exception 'FAIL T-fc1b5d2-d2c-id-manipulation-verify: source row for the id-collision attempt was mutated despite the attempt failing';
  end if;

  select appointment_type::text as appointment_type into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0004'::uuid;
  if v_row.appointment_type is distinct from 'group_class' then
    raise exception 'FAIL T-fc1b5d2-d2c-id-manipulation-target: unrelated target group_class row was mutated by the id-collision attempt';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c-id-manipulation: id-collision type-flip exploit attempt is rejected, no bypass found';
end $$;

-- ============================================================================
-- cross-studio insert -- an instructor's own real instructor id (bound to
-- Studio A) cannot be used to insert an appointment at Studio B.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0004')::text, true);

  begin
    insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at)
    values ('00000000-0000-0000-0000-0000006e0151'::uuid, '00000000-0000-0000-0000-0000006a0002', '00000000-0000-0000-0000-0000006c0001', 'private_lesson', 'scheduled', '2026-09-13T09:00:00+00', '2026-09-13T09:30:00+00');
  exception when insufficient_privilege then
    v_denied := true;
  end;

  reset role;

  if not v_denied then raise exception 'FAIL T-fc1b5d2-d2c-crossstudio-insert: cross-studio instructor insert was NOT denied'; end if;

  raise notice 'PASS T-fc1b5d2-d2c-crossstudio-insert: an instructor''s own instructor id cannot be used to insert at a studio they have no instructors row at';
end $$;

-- ============================================================================
-- independent instructor escalation -- cannot convert an own floor rental
-- into a teaching/group-class row to gain authority.
-- ============================================================================
do $$
declare
  v_denied boolean;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0007')::text, true);

  v_denied := false;
  begin
    update public.appointments set appointment_type = 'group_class' where id = '00000000-0000-0000-0000-0000006e0008'::uuid;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2-d2c-indep-escalate-group: independent instructor flipped own floor rental into group_class'; end if;

  v_denied := false;
  begin
    update public.appointments set appointment_type = 'private_lesson', instructor_id = '00000000-0000-0000-0000-0000006c0001'::uuid where id = '00000000-0000-0000-0000-0000006e0008'::uuid;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2-d2c-indep-escalate-private: independent instructor converted own floor rental into an instructor-assigned private_lesson'; end if;

  reset role;

  select appointment_type::text as appointment_type, instructor_id into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0008'::uuid;
  if v_row.appointment_type is distinct from 'floor_space_rental' or v_row.instructor_id is not null then
    raise exception 'FAIL T-fc1b5d2-d2c-indep-escalate-verify: floor rental row was mutated despite denials (type=%, instructor_id=%)', v_row.appointment_type, v_row.instructor_id;
  end if;

  raise notice 'PASS T-fc1b5d2-d2c-indep-escalate: independent instructor cannot convert own floor rental into a teaching/group-class row';
end $$;

-- ============================================================================
-- hybrid UPDATE/DELETE isolation -- the same-studio hybrid's dual
-- (teaching + floor-rental) relationship must remain narrowly scoped for
-- write operations exactly as it is for SELECT.
-- ============================================================================
do $$
declare
  v_row record;
  v_count int;
  -- Captured BEFORE hybrid's own attempts -- earlier blocks in this file
  -- already mutated APPT_A's status (the ordinary-instructor block updates
  -- their own row), so this test compares against the actual pre-attempt
  -- value rather than assuming a hardcoded 'scheduled', which would
  -- otherwise spuriously fail due to that unrelated earlier mutation.
  v_colleague_status_before appointment_status;
  v_otherrenter_status_before appointment_status;
begin
  select status into v_colleague_status_before from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  select status into v_otherrenter_status_before from public.appointments where id = '00000000-0000-0000-0000-0000006e0007'::uuid;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0006')::text, true);

  -- update own teaching row allowed
  update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000006e0005'::uuid;
  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0005'::uuid;
  if v_row.status is distinct from 'confirmed' then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-update-teach: hybrid could not update own teaching row'; end if;

  -- update own floor-rental row allowed
  update public.appointments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000006e0006'::uuid;
  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0006'::uuid;
  if v_row.status is distinct from 'confirmed' then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-update-rental: hybrid could not update own floor-rental row'; end if;

  -- update colleague teaching row denied (silent no-op) -- use a distinct
  -- sentinel value so "no-op" vs "changed" is unambiguous either way.
  update public.appointments set status = 'attended' where id = '00000000-0000-0000-0000-0000006e0001'::uuid;

  -- update another renter's floor-rental denied (silent no-op)
  update public.appointments set status = 'attended' where id = '00000000-0000-0000-0000-0000006e0007'::uuid;

  -- delete own teaching row denied (silent no-op -- instructor role has no DELETE branch at all)
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0005'::uuid;

  -- delete own floor-rental row denied (same reason)
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0006'::uuid;

  -- delete colleague teaching row denied
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;

  -- delete another renter's floor-rental denied
  delete from public.appointments where id = '00000000-0000-0000-0000-0000006e0007'::uuid;

  reset role;

  -- Verify none of the "denied" mutations above actually took effect.
  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_row.status is distinct from v_colleague_status_before then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-update-colleague: colleague teaching row status was changed by hybrid (was %, now %)', v_colleague_status_before, v_row.status; end if;

  select status into v_row from public.appointments where id = '00000000-0000-0000-0000-0000006e0007'::uuid;
  if v_row.status is distinct from v_otherrenter_status_before then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-update-otherrenter: another renter''s floor-rental status was changed by hybrid (was %, now %)', v_otherrenter_status_before, v_row.status; end if;

  select count(*) into v_count from public.appointments where id in (
    '00000000-0000-0000-0000-0000006e0001'::uuid,
    '00000000-0000-0000-0000-0000006e0005'::uuid,
    '00000000-0000-0000-0000-0000006e0006'::uuid,
    '00000000-0000-0000-0000-0000006e0007'::uuid
  );
  if v_count <> 4 then raise exception 'FAIL T-fc1b5d2-d2c-hybrid-delete: at least one row was deleted by hybrid despite denial, got % of 4 remaining', v_count; end if;

  raise notice 'PASS T-fc1b5d2-d2c-hybrid-write: hybrid UPDATE/DELETE isolation holds -- own rows writable (update only), colleague/other-renter rows fully denied, DELETE denied uniformly';
end $$;

-- ============================================================================
-- portal self -- preserve existing behavior.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0012')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0009'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-portal-self: portal client could not select own booked appointment'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-portal-unrelated: portal client should not see an unrelated appointment'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2-d2c-portal-self: portal self-select behavior preserved';
end $$;

-- ============================================================================
-- unrelated studio -- denied.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0011')::text, true);

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2-d2c-crossstudio: a Studio B instructor should not see a Studio A row'; end if;

  select count(*) into v_count from public.appointments where id = '00000000-0000-0000-0000-0000006e0010'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2-d2c-crossstudio-own: a Studio B instructor should still see their own Studio B row'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2-d2c-crossstudio: cross-studio isolation holds';
end $$;

-- ============================================================================
-- platform_admin -- broad without any studio-role row.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000006b0010')::text, true);

  select count(*) into v_count from public.appointments where id in ('00000000-0000-0000-0000-0000006e0001'::uuid, '00000000-0000-0000-0000-0000006e0010'::uuid);
  if v_count <> 2 then raise exception 'FAIL T-fc1b5d2-d2c-platformadmin: platform admin should see rows across studios with zero role rows, got %', v_count; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2-d2c-platformadmin: platform_admin broad access confirmed without any user_studio_roles row';
end $$;

-- ============================================================================
-- policy inventory -- exact final policy set, no broad FOR ALL policy.
-- ============================================================================
do $$
declare
  v_names text[];
  v_forall_count int;
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
    raise exception 'FAIL T-fc1b5d2-d2c-inventory: unexpected final policy set: %', v_names;
  end if;

  select count(*) into v_forall_count
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  where c.relname = 'appointments' and pol.polcmd = '*';

  if v_forall_count <> 0 then
    raise exception 'FAIL T-fc1b5d2-d2c-inventory-forall: a broad FOR ALL policy still exists on appointments';
  end if;

  raise notice 'PASS T-fc1b5d2-d2c-inventory: exactly the 8 expected policies exist, no FOR ALL policy remains';
end $$;

rollback;
