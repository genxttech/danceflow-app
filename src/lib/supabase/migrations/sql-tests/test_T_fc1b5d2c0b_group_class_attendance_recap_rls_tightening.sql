-- FC-1B5D2c-0B -- attendance_records / group_lesson_recaps /
-- group_lesson_recap_recipients / group_lesson_recap_syllabus_steps RLS
-- tightening live-Postgres regression suite.
--
-- Proves, at the real Postgres level (not mocked), that the tightened
-- policies produce exactly the persona/command behavior FC-1B5D2c-0B
-- specifies -- AND, just as importantly, that the discovered dual-purpose
-- (schedule-appointment vs. ticketed-event) usage of all four tables is
-- correctly partitioned: schedule-linked rows get the new relationship
-- scoping, event-linked rows retain the exact pre-migration "any active
-- studio member" behavior with zero regression. Entire script runs in one
-- transaction and is rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER the
-- forward migration
-- (20260908090000_fc1b5d2c0b_group_class_attendance_recap_rls_tightening.sql)
-- has been applied.
--
-- CORRECTED (post-independent-review): adds regression coverage for two
-- findings from direct empirical testing -- (1) oracle closure on
-- group_lesson_recap_is_event_linked / attendance_record_is_event_linked /
-- group_lesson_recap_recipient_is_event_linked (an unrelated caller must
-- not learn event-linkage classification for an arbitrary target; a
-- genuinely-related caller must still get correct results; no anon/PUBLIC
-- execute grant), and (2) the appointment_id NOT NULL -> NULL
-- linkage-transition bypass (an assigned instructor could previously null
-- out their own schedule-linked row's appointment_id to move it into the
-- legacy any-active-role bucket; now blocked on UPDATE for all three
-- tables with a mutable appointment_id, while ordinary edits and the
-- already-blocked colleague-retarget case are reconfirmed unchanged).
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000007aXXXX (studios)
-- 00000000-0000-0000-0000-0000007bXXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-0000007cXXXX (instructors)
-- 00000000-0000-0000-0000-0000007dXXXX (clients)
-- 00000000-0000-0000-0000-0000007eXXXX (appointments)
-- 00000000-0000-0000-0000-0000007fXXXX (syllabus catalog: styles/dances/steps)
-- 00000000-0000-0000-0000-000000710XXX (attendance_records)
-- 00000000-0000-0000-0000-000000711XXX (group_lesson_recaps)
-- 00000000-0000-0000-0000-000000712XXX (group_lesson_recap_recipients)
-- 00000000-0000-0000-0000-000000713XXX (group_lesson_recap_syllabus_steps)

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000007a0001', 'FC-1B5D2c-0B Harness Studio A', 't-fc1b5d2c0b-studio-a'),
  ('00000000-0000-0000-0000-0000007a0002', 'FC-1B5D2c-0B Harness Studio B', 't-fc1b5d2c0b-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000007b0001', 't-fc1b5d2c0b-owner@example.test'),
  ('00000000-0000-0000-0000-0000007b0002', 't-fc1b5d2c0b-admin@example.test'),
  ('00000000-0000-0000-0000-0000007b0003', 't-fc1b5d2c0b-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000007b0004', 't-fc1b5d2c0b-instr-assigned@example.test'),
  ('00000000-0000-0000-0000-0000007b0005', 't-fc1b5d2c0b-instr-colleague@example.test'),
  ('00000000-0000-0000-0000-0000007b0006', 't-fc1b5d2c0b-hybrid@example.test'),
  ('00000000-0000-0000-0000-0000007b0007', 't-fc1b5d2c0b-indepinstructor@example.test'),
  ('00000000-0000-0000-0000-0000007b0010', 't-fc1b5d2c0b-platformadmin@example.test'),
  ('00000000-0000-0000-0000-0000007b0011', 't-fc1b5d2c0b-crossstudio@example.test'),
  ('00000000-0000-0000-0000-0000007b0012', 't-fc1b5d2c0b-portalclient@example.test'),
  ('00000000-0000-0000-0000-0000007b0013', 't-fc1b5d2c0b-portalclientother@example.test'),
  ('00000000-0000-0000-0000-0000007b0014', 't-fc1b5d2c0b-unrelated@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000007b0001', 't-fc1b5d2c0b-owner@example.test', null),
  ('00000000-0000-0000-0000-0000007b0002', 't-fc1b5d2c0b-admin@example.test', null),
  ('00000000-0000-0000-0000-0000007b0003', 't-fc1b5d2c0b-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-0000007b0004', 't-fc1b5d2c0b-instr-assigned@example.test', null),
  ('00000000-0000-0000-0000-0000007b0005', 't-fc1b5d2c0b-instr-colleague@example.test', null),
  ('00000000-0000-0000-0000-0000007b0006', 't-fc1b5d2c0b-hybrid@example.test', null),
  ('00000000-0000-0000-0000-0000007b0007', 't-fc1b5d2c0b-indepinstructor@example.test', null),
  ('00000000-0000-0000-0000-0000007b0010', 't-fc1b5d2c0b-platformadmin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-0000007b0011', 't-fc1b5d2c0b-crossstudio@example.test', null),
  ('00000000-0000-0000-0000-0000007b0012', 't-fc1b5d2c0b-portalclient@example.test', null),
  ('00000000-0000-0000-0000-0000007b0013', 't-fc1b5d2c0b-portalclientother@example.test', null),
  ('00000000-0000-0000-0000-0000007b0014', 't-fc1b5d2c0b-unrelated@example.test', null);

-- user_studio_roles. hybrid has exactly ONE role row (instructor), despite
-- also having a real client_account_links relationship -- proving the dual
-- capability comes from two real relationships, not a second role.
-- platform_admin_user, portal_client_user(s), and unrelated_user
-- deliberately have NO user_studio_roles row anywhere.
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000007b0001', '00000000-0000-0000-0000-0000007a0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000007b0002', '00000000-0000-0000-0000-0000007a0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000007b0003', '00000000-0000-0000-0000-0000007a0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000007b0004', '00000000-0000-0000-0000-0000007a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007b0005', '00000000-0000-0000-0000-0000007a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007b0006', '00000000-0000-0000-0000-0000007a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007b0007', '00000000-0000-0000-0000-0000007a0001', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000007b0011', '00000000-0000-0000-0000-0000007a0002', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007b0004', 'Instructor', 'Assigned', true),
  ('00000000-0000-0000-0000-0000007c0002', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007b0005', 'Instructor', 'Colleague', true),
  ('00000000-0000-0000-0000-0000007c0003', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007b0006', 'Hybrid', 'Teacher', true),
  ('00000000-0000-0000-0000-0000007c0004', '00000000-0000-0000-0000-0000007a0002', '00000000-0000-0000-0000-0000007b0011', 'CrossStudio', 'Instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-0000007d0001', '00000000-0000-0000-0000-0000007a0001', 'Hybrid', 'Renter', 'active', true),
  ('00000000-0000-0000-0000-0000007d0002', '00000000-0000-0000-0000-0000007a0001', 'Indep', 'Instructor', 'active', true),
  ('00000000-0000-0000-0000-0000007d0003', '00000000-0000-0000-0000-0000007a0001', 'Portal', 'Client', 'active', false),
  ('00000000-0000-0000-0000-0000007d0004', '00000000-0000-0000-0000-0000007a0001', 'Portal', 'ClientOther', 'active', false);

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type) values
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0001', '00000000-0000-0000-0000-0000007b0006', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0002', '00000000-0000-0000-0000-0000007b0007', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0003', '00000000-0000-0000-0000-0000007b0012', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007d0004', '00000000-0000-0000-0000-0000007b0013', 'linked', 'self');

insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-0000007e0001', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0001', 'group_class', 'scheduled', '2026-09-14T10:00:00+00', '2026-09-14T11:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0002', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0002', 'group_class', 'scheduled', '2026-09-14T11:00:00+00', '2026-09-14T12:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0003', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007c0003', 'group_class', 'scheduled', '2026-09-14T12:00:00+00', '2026-09-14T13:00:00+00'),
  ('00000000-0000-0000-0000-0000007e0005', '00000000-0000-0000-0000-0000007a0002', null, '00000000-0000-0000-0000-0000007c0004', 'group_class', 'scheduled', '2026-09-14T10:00:00+00', '2026-09-14T11:00:00+00');

-- Convenience aliases (as SQL comments only, for readability below):
-- APPT_GROUP            = ...7e0001  Instructor Assigned's own group class
-- APPT_COLLEAGUE_GROUP  = ...7e0002  Instructor Colleague's own group class (target for "unassigned" tests)
-- APPT_HYBRID_GROUP     = ...7e0003  Hybrid's own group class
-- APPT_CROSS            = ...7e0005  Studio B group class

-- Minimal syllabus catalog chain (studio -> style -> dance -> step) needed
-- to satisfy group_lesson_recap_syllabus_steps.syllabus_step_id's NOT NULL
-- FK -- catalog data, not appointment-scoped, reused across recaps.
insert into public.syllabus_styles (id, studio_id, name) values
  ('00000000-0000-0000-0000-0000007f0001', '00000000-0000-0000-0000-0000007a0001', 'T-FC1B5D2c0B Style');

insert into public.syllabus_dances (id, studio_id, style_id, name) values
  ('00000000-0000-0000-0000-0000007f0002', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007f0001', 'T-FC1B5D2c0B Dance');

insert into public.syllabus_steps (id, studio_id, dance_id, name) values
  ('00000000-0000-0000-0000-0000007f0003', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007f0002', 'T-FC1B5D2c0B Step');

-- Minimal events fixture chain (attendance_records.attendance_records_source_check
-- requires EXACTLY ONE of appointment_id/event_registration_id -- the
-- event-linked attendance row below needs a real event_registrations row,
-- not just a null appointment_id).
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date) values
  ('00000000-0000-0000-0000-0000007f0004', '00000000-0000-0000-0000-0000007a0001', 'T-FC1B5D2c0B Event', 't-fc1b5d2c0b-event', 'group_class', '2026-09-14', '2026-09-14');

insert into public.event_registrations (id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email) values
  ('00000000-0000-0000-0000-0000007f0005', '00000000-0000-0000-0000-0000007f0004', '00000000-0000-0000-0000-0000007a0001', 'Portal', 'Client', 't-fc1b5d2c0b-portalclient@example.test');

-- attendance_records: schedule-linked + event-linked (appointment_id null,
-- event_registration_id set -- required by attendance_records_source_check)
insert into public.attendance_records (id, studio_id, appointment_id, event_registration_id, client_id, status) values
  ('00000000-0000-0000-0000-000000710001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0001', null, '00000000-0000-0000-0000-0000007d0003', 'registered'),
  ('00000000-0000-0000-0000-000000710002', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0002', null, '00000000-0000-0000-0000-0000007d0004', 'registered'),
  ('00000000-0000-0000-0000-000000710003', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007f0005', '00000000-0000-0000-0000-0000007d0003', 'checked_in');
-- AR_GROUP = ...710001 (APPT_GROUP)  AR_COLLEAGUE = ...710002 (APPT_COLLEAGUE_GROUP)  AR_EVENT = ...710003 (event-linked)

-- group_lesson_recaps: schedule-linked + event-linked
insert into public.group_lesson_recaps (id, studio_id, appointment_id, title, status) values
  ('00000000-0000-0000-0000-000000711001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0001', 'Recap Group', 'draft'),
  ('00000000-0000-0000-0000-000000711002', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0002', 'Recap Colleague', 'draft'),
  ('00000000-0000-0000-0000-000000711003', '00000000-0000-0000-0000-0000007a0001', null, 'Recap Event', 'draft');
-- RECAP_GROUP = ...711001  RECAP_COLLEAGUE = ...711002  RECAP_EVENT = ...711003

-- group_lesson_recap_recipients: schedule-linked (own + other, for portal
-- isolation) + event-linked
insert into public.group_lesson_recap_recipients (id, recap_id, studio_id, appointment_id, client_id, user_id, source, delivery_status) values
  ('00000000-0000-0000-0000-000000712001', '00000000-0000-0000-0000-000000711001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0001', '00000000-0000-0000-0000-0000007d0003', '00000000-0000-0000-0000-0000007b0012', 'checked_in', 'available'),
  ('00000000-0000-0000-0000-000000712002', '00000000-0000-0000-0000-000000711001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0001', '00000000-0000-0000-0000-0000007d0004', '00000000-0000-0000-0000-0000007b0013', 'checked_in', 'available'),
  ('00000000-0000-0000-0000-000000712003', '00000000-0000-0000-0000-000000711002', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0002', '00000000-0000-0000-0000-0000007d0004', '00000000-0000-0000-0000-0000007b0013', 'checked_in', 'available'),
  ('00000000-0000-0000-0000-000000712004', '00000000-0000-0000-0000-000000711003', '00000000-0000-0000-0000-0000007a0001', null, '00000000-0000-0000-0000-0000007d0003', '00000000-0000-0000-0000-0000007b0012', 'checked_in', 'available');
-- RECIP_GROUP_PORTAL = ...712001 (portal_client's own row on RECAP_GROUP)
-- RECIP_GROUP_OTHER  = ...712002 (portal_client_other's row on RECAP_GROUP -- must be invisible to portal_client)
-- RECIP_COLLEAGUE    = ...712003 (RECAP_COLLEAGUE -- unassigned-instructor-denied target)
-- RECIP_EVENT        = ...712004 (event-linked)

-- group_lesson_recap_syllabus_steps: schedule-linked + event-linked
insert into public.group_lesson_recap_syllabus_steps (id, studio_id, group_lesson_recap_id, syllabus_step_id, progress_status) values
  ('00000000-0000-0000-0000-000000713001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-000000711001', '00000000-0000-0000-0000-0000007f0003', 'practiced'),
  ('00000000-0000-0000-0000-000000713002', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-000000711002', '00000000-0000-0000-0000-0000007f0003', 'practiced'),
  ('00000000-0000-0000-0000-000000713003', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-000000711003', '00000000-0000-0000-0000-0000007f0003', 'practiced');
-- SYL_GROUP = ...713001  SYL_COLLEAGUE = ...713002  SYL_EVENT = ...713003

-- ============================================================================
-- studio_owner -- broad SELECT/INSERT/UPDATE/DELETE across all four tables,
-- both schedule-linked and event-linked rows.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0001')::text, true);

  -- attendance_records: schedule + event rows both visible/writable
  select count(*) into v_count from public.attendance_records where id in ('00000000-0000-0000-0000-000000710001'::uuid, '00000000-0000-0000-0000-000000710002'::uuid, '00000000-0000-0000-0000-000000710003'::uuid);
  if v_count <> 3 then raise exception 'FAIL T-fc1b5d2c0b-owner-ar-select: expected 3, got %', v_count; end if;
  update public.attendance_records set notes = 'owner-edit' where id = '00000000-0000-0000-0000-000000710001'::uuid;

  -- group_lesson_recaps
  select count(*) into v_count from public.group_lesson_recaps where id in ('00000000-0000-0000-0000-000000711001'::uuid, '00000000-0000-0000-0000-000000711002'::uuid, '00000000-0000-0000-0000-000000711003'::uuid);
  if v_count <> 3 then raise exception 'FAIL T-fc1b5d2c0b-owner-recap-select: expected 3, got %', v_count; end if;
  update public.group_lesson_recaps set summary = 'owner-edit' where id = '00000000-0000-0000-0000-000000711002'::uuid;

  -- group_lesson_recap_recipients
  select count(*) into v_count from public.group_lesson_recap_recipients where id in ('00000000-0000-0000-0000-000000712001'::uuid, '00000000-0000-0000-0000-000000712002'::uuid, '00000000-0000-0000-0000-000000712003'::uuid, '00000000-0000-0000-0000-000000712004'::uuid);
  if v_count <> 4 then raise exception 'FAIL T-fc1b5d2c0b-owner-recip-select: expected 4, got %', v_count; end if;

  -- group_lesson_recap_syllabus_steps
  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where id in ('00000000-0000-0000-0000-000000713001'::uuid, '00000000-0000-0000-0000-000000713002'::uuid, '00000000-0000-0000-0000-000000713003'::uuid);
  if v_count <> 3 then raise exception 'FAIL T-fc1b5d2c0b-owner-syl-select: expected 3, got %', v_count; end if;
  update public.group_lesson_recap_syllabus_steps set recap_note = 'owner-edit' where id = '00000000-0000-0000-0000-000000713002'::uuid;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-owner: studio_owner broad access confirmed across all four tables, both row kinds';
end $$;

-- ============================================================================
-- studio_admin / platform_admin -- same broad behavior (lighter check,
-- proving the pattern generalizes without re-testing every command).
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0002')::text, true);

  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-admin-ar: studio_admin denied a colleague-taught attendance row'; end if;
  select count(*) into v_count from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-admin-recap: studio_admin denied a colleague-taught recap'; end if;
  update public.group_lesson_recaps set summary = 'admin-edit' where id = '00000000-0000-0000-0000-000000711001'::uuid;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-admin: studio_admin broad access confirmed';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0010')::text, true);

  select count(*) into v_count from public.attendance_records where id in ('00000000-0000-0000-0000-000000710001'::uuid, '00000000-0000-0000-0000-000000710002'::uuid);
  if v_count <> 2 then raise exception 'FAIL T-fc1b5d2c0b-platformadmin-ar: expected 2, got % -- broad access without any studio-role row', v_count; end if;
  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-platformadmin-syl: platform_admin denied a syllabus-step row despite zero role rows'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-platformadmin: platform_admin broad access confirmed via the standard profiles.platform_role predicate, no studio-role row needed';
end $$;

-- ============================================================================
-- front_desk -- attendance full CRUD; recap/recipient/syllabus SELECT
-- allowed, write DENIED.
-- ============================================================================
do $$
declare
  v_count int;
  v_denied boolean;
  v_recap_summary_before text;
  v_recap_summary_after text;
  v_syl_note_before text;
  v_syl_note_after text;
begin
  select summary into v_recap_summary_before from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711001'::uuid;
  select recap_note into v_syl_note_before from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713001'::uuid;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0003')::text, true);

  -- attendance: full operational access, including a class front_desk does not teach
  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-frontdesk-ar-select: front_desk denied attendance SELECT'; end if;
  update public.attendance_records set status = 'checked_in' where id = '00000000-0000-0000-0000-000000710001'::uuid;
  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status) values ('00000000-0000-0000-0000-000000710011', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0001', '00000000-0000-0000-0000-0000007d0004', 'registered');
  delete from public.attendance_records where id = '00000000-0000-0000-0000-000000710011'::uuid;

  -- group_lesson_recaps: read allowed
  select count(*) into v_count from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-frontdesk-recap-select: front_desk denied recap SELECT'; end if;

  -- group_lesson_recaps: write DENIED -- USING excludes the row, so this is
  -- a silent 0-row no-op, not an exception; verified via before/after below.
  update public.group_lesson_recaps set summary = 'frontdesk-should-fail' where id = '00000000-0000-0000-0000-000000711001'::uuid;

  -- recipients: read allowed, write denied (INSERT genuinely evaluates
  -- WITH CHECK against a new row, so this one DOES raise insufficient_privilege)
  select count(*) into v_count from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-frontdesk-recip-select: front_desk denied recipient SELECT'; end if;
  v_denied := false;
  begin
    insert into public.group_lesson_recap_recipients (id, recap_id, studio_id, appointment_id, client_id) values ('00000000-0000-0000-0000-000000712011', '00000000-0000-0000-0000-000000711001', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0001', '00000000-0000-0000-0000-0000007d0003');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2c0b-frontdesk-recip-insert: front_desk was able to insert a group_lesson_recap_recipients row'; end if;

  -- syllabus steps: read allowed, write denied (silent no-op, same as recap)
  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-frontdesk-syl-select: front_desk denied syllabus-step SELECT'; end if;
  update public.group_lesson_recap_syllabus_steps set recap_note = 'frontdesk-should-fail' where id = '00000000-0000-0000-0000-000000713001'::uuid;

  reset role;

  select summary into v_recap_summary_after from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711001'::uuid;
  if v_recap_summary_after is distinct from v_recap_summary_before then
    raise exception 'FAIL T-fc1b5d2c0b-frontdesk-recap-update: front_desk was able to write a group_lesson_recaps row (was %, now %)', v_recap_summary_before, v_recap_summary_after;
  end if;

  select recap_note into v_syl_note_after from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713001'::uuid;
  if v_syl_note_after is distinct from v_syl_note_before then
    raise exception 'FAIL T-fc1b5d2c0b-frontdesk-syl-update: front_desk was able to write a syllabus-step row (was %, now %)', v_syl_note_before, v_syl_note_after;
  end if;

  raise notice 'PASS T-fc1b5d2c0b-frontdesk: attendance full CRUD; recap/recipient/syllabus read-only confirmed (recap/syllabus UPDATE silently no-ops, recipient INSERT raises insufficient_privilege)';
end $$;

-- ============================================================================
-- assigned instructor -- full operational access on their OWN class's rows
-- across all four tables (attendance, recap, recipients, syllabus steps).
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0004')::text, true);

  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-instr-ar-select: assigned instructor denied own-class attendance SELECT'; end if;
  update public.attendance_records set status = 'attended' where id = '00000000-0000-0000-0000-000000710001'::uuid;
  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status) values ('00000000-0000-0000-0000-000000710021', '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0001', '00000000-0000-0000-0000-0000007d0004', 'registered');
  delete from public.attendance_records where id = '00000000-0000-0000-0000-000000710021'::uuid;

  select count(*) into v_count from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-instr-recap-select: assigned instructor denied own-class recap SELECT'; end if;
  update public.group_lesson_recaps set summary = 'instructor-edit' where id = '00000000-0000-0000-0000-000000711001'::uuid;

  select count(*) into v_count from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-instr-recip-select: assigned instructor denied own-class recipient SELECT'; end if;
  update public.group_lesson_recap_recipients set delivery_status = 'available' where id = '00000000-0000-0000-0000-000000712001'::uuid;

  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-instr-syl-select: assigned instructor denied own-class syllabus-step SELECT'; end if;
  update public.group_lesson_recap_syllabus_steps set recap_note = 'instructor-edit' where id = '00000000-0000-0000-0000-000000713001'::uuid;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-instr-assigned: assigned instructor has full operational access to own class rows across all four tables';
end $$;

-- ============================================================================
-- unassigned instructor (Instructor Colleague, teaches APPT_COLLEAGUE_GROUP
-- but NOT APPT_GROUP) -- denied across all four tables when targeting
-- APPT_GROUP's rows. Also cross-checks: still full access to their OWN
-- class's rows.
-- ============================================================================
do $$
declare
  v_count int;
  v_status_before text;
  v_status_after text;
begin
  select status into v_status_before from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0005')::text, true);

  -- denied on APPT_GROUP (not their class)
  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unassigned-ar: unassigned instructor could see a colleague-taught attendance row'; end if;
  select count(*) into v_count from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unassigned-recap: unassigned instructor could see a colleague-taught recap'; end if;
  select count(*) into v_count from public.group_lesson_recap_recipients where id in ('00000000-0000-0000-0000-000000712001'::uuid, '00000000-0000-0000-0000-000000712002'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unassigned-recip: unassigned instructor could see a colleague-taught class''s recipients'; end if;
  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unassigned-syl: unassigned instructor could see a colleague-taught class''s syllabus step'; end if;

  -- UPDATE against a row excluded by USING is a silent 0-row no-op, not an
  -- exception -- verified below via the pre/post status comparison.
  update public.attendance_records set status = 'attended' where id = '00000000-0000-0000-0000-000000710001'::uuid;

  -- still full access to their OWN class (APPT_COLLEAGUE_GROUP)
  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-unassigned-own-ar: instructor colleague denied their OWN class''s attendance row'; end if;
  select count(*) into v_count from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-unassigned-own-recap: instructor colleague denied their OWN class''s recap'; end if;

  reset role;

  select status into v_status_after from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;
  if v_status_after is distinct from v_status_before then
    raise exception 'FAIL T-fc1b5d2c0b-unassigned-ar-noop: denied UPDATE on a colleague-taught row actually took effect (was %, now %)', v_status_before, v_status_after;
  end if;

  raise notice 'PASS T-fc1b5d2c0b-unassigned: unassigned instructor denied across all four tables for a colleague''s class (including a silent-no-op UPDATE), retains full access to their own class';
end $$;

-- ============================================================================
-- cross-studio instructor (Studio B) -- denied on Studio A's rows.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0011')::text, true);

  select count(*) into v_count from public.attendance_records where id in ('00000000-0000-0000-0000-000000710001'::uuid, '00000000-0000-0000-0000-000000710002'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-crossstudio-ar: cross-studio instructor saw a Studio A attendance row'; end if;
  select count(*) into v_count from public.group_lesson_recaps where id in ('00000000-0000-0000-0000-000000711001'::uuid, '00000000-0000-0000-0000-000000711002'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-crossstudio-recap: cross-studio instructor saw a Studio A recap'; end if;
  select count(*) into v_count from public.group_lesson_recap_recipients where studio_id = '00000000-0000-0000-0000-0000007a0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-crossstudio-recip: cross-studio instructor saw Studio A recipients'; end if;
  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where studio_id = '00000000-0000-0000-0000-0000007a0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-crossstudio-syl: cross-studio instructor saw Studio A syllabus steps'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-crossstudio: cross-studio instructor denied across all four tables';
end $$;

-- ============================================================================
-- independent instructor (floor-rental-only relationship, NO instructors
-- row) -- denied across all four host-class tables for APPT_GROUP.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0007')::text, true);

  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-indep-ar: independent instructor (floor-rental-only) could see a group-class attendance row'; end if;
  select count(*) into v_count from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-indep-recap: independent instructor could see a group-class recap'; end if;
  select count(*) into v_count from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-indep-recip: independent instructor could see a group-class recipient row'; end if;
  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-indep-syl: independent instructor could see a group-class syllabus-step row -- the erroneous role-list entry this migration removes must be closed';
  end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-indep: independent instructor (floor-rental-only) denied across all four host-class tables, including the previously-erroneous syllabus-step access';
end $$;

-- ============================================================================
-- same-studio hybrid -- real instructors row (assigned to APPT_HYBRID_GROUP)
-- + real floor-rental client relationship, ONE user_studio_roles row. Own
-- class fully accessible; a colleague's class denied despite the active
-- floor-rental relationship existing elsewhere -- proving that relationship
-- never widens host-class authority.
-- ============================================================================
do $$
declare
  v_count int;
  v_recap_hybrid_id uuid := '00000000-0000-0000-0000-000000711010';
  v_ar_hybrid_id uuid := '00000000-0000-0000-0000-000000710010';
begin
  insert into public.group_lesson_recaps (id, studio_id, appointment_id, title, status)
  values (v_recap_hybrid_id, '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0003', 'Recap Hybrid', 'draft');
  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values (v_ar_hybrid_id, '00000000-0000-0000-0000-0000007a0001', '00000000-0000-0000-0000-0000007e0003', '00000000-0000-0000-0000-0000007d0003', 'registered');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0006')::text, true);

  -- own class (via teaching relationship) fully accessible
  select count(*) into v_count from public.attendance_records where id = v_ar_hybrid_id;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-hybrid-ar-own: hybrid could not select own-class attendance row'; end if;
  update public.attendance_records set status = 'attended' where id = v_ar_hybrid_id;

  select count(*) into v_count from public.group_lesson_recaps where id = v_recap_hybrid_id;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-hybrid-recap-own: hybrid could not select own-class recap'; end if;
  update public.group_lesson_recaps set summary = 'hybrid-edit' where id = v_recap_hybrid_id;

  -- colleague's class (APPT_GROUP, APPT_COLLEAGUE_GROUP) denied despite the
  -- active floor-rental relationship existing elsewhere for this same user
  select count(*) into v_count from public.attendance_records where id in ('00000000-0000-0000-0000-000000710001'::uuid, '00000000-0000-0000-0000-000000710002'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-hybrid-ar-colleague: hybrid saw a colleague-taught attendance row -- floor-rental relationship must not widen host-class authority'; end if;
  select count(*) into v_count from public.group_lesson_recaps where id in ('00000000-0000-0000-0000-000000711001'::uuid, '00000000-0000-0000-0000-000000711002'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-hybrid-recap-colleague: hybrid saw a colleague-taught recap -- floor-rental relationship must not widen host-class authority'; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-hybrid: own class fully accessible via teaching relationship; colleague classes denied; floor-rental relationship confirmed not to widen host-class authority';
end $$;

-- ============================================================================
-- event-linked rows (appointment_id is null) -- preserved "any active
-- studio member" behavior, PROVEN via a persona (unassigned instructor)
-- who is explicitly DENIED on schedule-linked rows above but MUST still
-- succeed here -- the core regression check for the dual-purpose-table
-- discovery this migration's design is built around.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0005')::text, true);

  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-event-ar: any-active-role access to an event-linked attendance row regressed'; end if;
  update public.attendance_records set notes = 'event-edit' where id = '00000000-0000-0000-0000-000000710003'::uuid;

  select count(*) into v_count from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-event-recap: any-active-role access to an event-linked recap regressed'; end if;
  update public.group_lesson_recaps set summary = 'event-edit' where id = '00000000-0000-0000-0000-000000711003'::uuid;

  select count(*) into v_count from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712004'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-event-recip: any-active-role access to an event-linked recipient row regressed'; end if;

  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where id = '00000000-0000-0000-0000-000000713003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-event-syl: any-active-role access to an event-linked syllabus-step row regressed'; end if;
  update public.group_lesson_recap_syllabus_steps set recap_note = 'event-edit' where id = '00000000-0000-0000-0000-000000713003'::uuid;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-event-preserved: event-linked rows retain the exact pre-migration any-active-studio-member behavior across all four tables -- zero regression to the events feature';
end $$;

-- ============================================================================
-- portal / student -- own recipient row allowed, another recipient row
-- denied, no write escalation.
-- ============================================================================
do $$
declare
  v_count int;
  v_status_before text;
  v_status_after text;
begin
  select delivery_status into v_status_before from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712001'::uuid;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0012')::text, true);

  -- own recipient row (user_id = auth.uid()) allowed -- untouched portal policy
  select count(*) into v_count from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-fc1b5d2c0b-portal-own: portal client denied their own recipient row'; end if;

  -- another client's recipient row on the SAME recap denied
  select count(*) into v_count from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712002'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-portal-other: portal client could see another recipient''s row'; end if;

  -- no staff-side visibility into attendance_records/recaps/syllabus (no
  -- portal branch exists on those tables at all)
  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-portal-ar: portal client should not see attendance_records at all'; end if;

  -- no write escalation on recipients (portal policy is SELECT-only; the
  -- staff write policies require a role/relationship this user has none of
  -- -- USING excludes the row for every write policy, so this is a silent
  -- 0-row no-op, not an exception; verified via before/after below).
  update public.group_lesson_recap_recipients set delivery_status = 'revoked' where id = '00000000-0000-0000-0000-000000712001'::uuid;

  reset role;

  select delivery_status into v_status_after from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712001'::uuid;
  if v_status_after is distinct from v_status_before then
    raise exception 'FAIL T-fc1b5d2c0b-portal-write: portal client was able to write their own recipient row (was %, now %) -- read-only access should not include write', v_status_before, v_status_after;
  end if;

  raise notice 'PASS T-fc1b5d2c0b-portal: own recipient row allowed, another recipient denied, no write escalation -- untouched portal policy behaves exactly as before';
end $$;

-- ============================================================================
-- unrelated user -- zero role, zero relationship anywhere -- denied
-- everywhere, including event-linked rows (no active studio role at all).
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0014')::text, true);

  select count(*) into v_count from public.attendance_records where studio_id = '00000000-0000-0000-0000-0000007a0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unrelated-ar: unrelated user saw attendance_records rows, got %', v_count; end if;
  select count(*) into v_count from public.group_lesson_recaps where studio_id = '00000000-0000-0000-0000-0000007a0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unrelated-recap: unrelated user saw group_lesson_recaps rows, got %', v_count; end if;
  select count(*) into v_count from public.group_lesson_recap_recipients where studio_id = '00000000-0000-0000-0000-0000007a0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unrelated-recip: unrelated user saw recipient rows, got %', v_count; end if;
  select count(*) into v_count from public.group_lesson_recap_syllabus_steps where studio_id = '00000000-0000-0000-0000-0000007a0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-fc1b5d2c0b-unrelated-syl: unrelated user saw syllabus-step rows, got %', v_count; end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-unrelated: unrelated user denied everywhere, including event-linked rows';
end $$;

-- ============================================================================
-- CORRECTED: oracle closure -- group_lesson_recap_is_event_linked,
-- attendance_record_is_event_linked, and group_lesson_recap_recipient_is_
-- event_linked must not reveal event-linkage classification to a caller
-- with no active role at the target studio, regardless of the target's
-- real state (event-linked OR schedule-linked -- both must produce the
-- identical false result to an unrelated caller) -- and must still return
-- the CORRECT classification for a caller who genuinely holds an active
-- role there, since real policy evaluation depends on that.
-- ============================================================================
do $$
declare
  v_result boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0014')::text, true);

  -- unrelated_user (zero role anywhere) probing a REAL event-linked row --
  -- must get false, not true.
  select public.group_lesson_recap_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000711003'::uuid) into v_result;
  if v_result is distinct from false then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-recap: unrelated user learned event-linkage classification for a recap at a studio they have no role at (got %)', v_result;
  end if;

  select public.attendance_record_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000710003'::uuid) into v_result;
  if v_result is distinct from false then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-ar: unrelated user learned event-linkage classification for an attendance row at a studio they have no role at (got %)', v_result;
  end if;

  select public.group_lesson_recap_recipient_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000712004'::uuid) into v_result;
  if v_result is distinct from false then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-recip: unrelated user learned event-linkage classification for a recipient row at a studio they have no role at (got %)', v_result;
  end if;

  -- also probing a SCHEDULE-linked (non-event) row -- must be equally
  -- false, indistinguishable from the event-linked probe above (proves the
  -- false result isn't itself leaking "this one happens to be
  -- schedule-linked").
  select public.group_lesson_recap_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000711001'::uuid) into v_result;
  if v_result is distinct from false then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-recap-schedule: unrelated user got a non-false result probing a schedule-linked recap (got %)', v_result;
  end if;

  reset role;

  -- legitimate evaluation: a caller WITH an active role at the studio gets
  -- the CORRECT classification (true for event-linked, false for
  -- schedule-linked) -- the fix must not break real policy evaluation.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0001')::text, true);

  select public.group_lesson_recap_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000711003'::uuid) into v_result;
  if v_result is distinct from true then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-legit-recap-event: studio_owner (active role) got false for a genuinely event-linked recap (got %)', v_result;
  end if;

  select public.group_lesson_recap_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000711001'::uuid) into v_result;
  if v_result is distinct from false then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-legit-recap-schedule: studio_owner (active role) got true for a genuinely schedule-linked recap (got %)', v_result;
  end if;

  select public.attendance_record_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000710003'::uuid) into v_result;
  if v_result is distinct from true then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-legit-ar-event: studio_owner (active role) got false for a genuinely event-linked attendance row (got %)', v_result;
  end if;

  select public.group_lesson_recap_recipient_is_event_linked('00000000-0000-0000-0000-0000007a0001'::uuid, '00000000-0000-0000-0000-000000712004'::uuid) into v_result;
  if v_result is distinct from true then
    raise exception 'FAIL T-fc1b5d2c0b-oracle-legit-recip-event: studio_owner (active role) got false for a genuinely event-linked recipient row (got %)', v_result;
  end if;

  reset role;
  raise notice 'PASS T-fc1b5d2c0b-oracle: unrelated user cannot learn event-linkage classification for any target (event-linked or schedule-linked alike); a caller with a genuine active role still gets correct results';
end $$;

-- ============================================================================
-- CORRECTED: no anonymous/PUBLIC execution -- defense in depth alongside
-- the internal active-role gate above.
-- ============================================================================
do $$
declare
  v_has_priv boolean;
begin
  select has_function_privilege('anon', 'public.group_lesson_recap_is_event_linked(uuid,uuid)', 'EXECUTE') into v_has_priv;
  if v_has_priv then raise exception 'FAIL T-fc1b5d2c0b-oracle-anon-recap: anon has EXECUTE on group_lesson_recap_is_event_linked'; end if;

  select has_function_privilege('anon', 'public.attendance_record_is_event_linked(uuid,uuid)', 'EXECUTE') into v_has_priv;
  if v_has_priv then raise exception 'FAIL T-fc1b5d2c0b-oracle-anon-ar: anon has EXECUTE on attendance_record_is_event_linked'; end if;

  select has_function_privilege('anon', 'public.group_lesson_recap_recipient_is_event_linked(uuid,uuid)', 'EXECUTE') into v_has_priv;
  if v_has_priv then raise exception 'FAIL T-fc1b5d2c0b-oracle-anon-recip: anon has EXECUTE on group_lesson_recap_recipient_is_event_linked'; end if;

  select has_function_privilege('public', 'public.group_lesson_recap_is_event_linked(uuid,uuid)', 'EXECUTE') into v_has_priv;
  if v_has_priv then raise exception 'FAIL T-fc1b5d2c0b-oracle-public-recap: PUBLIC has EXECUTE on group_lesson_recap_is_event_linked'; end if;

  select has_function_privilege('public', 'public.attendance_record_is_event_linked(uuid,uuid)', 'EXECUTE') into v_has_priv;
  if v_has_priv then raise exception 'FAIL T-fc1b5d2c0b-oracle-public-ar: PUBLIC has EXECUTE on attendance_record_is_event_linked'; end if;

  select has_function_privilege('public', 'public.group_lesson_recap_recipient_is_event_linked(uuid,uuid)', 'EXECUTE') into v_has_priv;
  if v_has_priv then raise exception 'FAIL T-fc1b5d2c0b-oracle-public-recip: PUBLIC has EXECUTE on group_lesson_recap_recipient_is_event_linked'; end if;

  raise notice 'PASS T-fc1b5d2c0b-oracle-anon: no anon/PUBLIC execute grant on any of the three event-linked helpers';
end $$;

-- ============================================================================
-- CORRECTED: linkage-transition bypass -- an assigned instructor may
-- continue making ordinary edits to their own schedule-linked rows, may
-- NOT null out appointment_id to escape into the legacy any-active-role
-- bucket, and may NOT retarget appointment_id to a colleague's appointment
-- (already-existing protection, reconfirmed unchanged here). Covers all
-- three tables with a mutable, directly-stored appointment_id column.
-- group_lesson_recap_syllabus_steps is not included -- its
-- group_lesson_recap_id FK is NOT NULL, so it was never exposed to this
-- bypass class in the first place.
-- ============================================================================
do $$
declare
  v_denied boolean;
  v_value_after uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000007b0004')::text, true);

  -- ordinary UPDATE on own schedule-linked rows remains allowed
  update public.attendance_records set notes = 'linkage-test-ordinary-edit' where id = '00000000-0000-0000-0000-000000710001'::uuid;
  update public.group_lesson_recaps set summary = 'linkage-test-ordinary-edit' where id = '00000000-0000-0000-0000-000000711001'::uuid;
  update public.group_lesson_recap_recipients set delivery_status = 'available' where id = '00000000-0000-0000-0000-000000712001'::uuid;

  -- attendance_records: null-out denied
  v_denied := false;
  begin
    update public.attendance_records set appointment_id = null where id = '00000000-0000-0000-0000-000000710001'::uuid;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2c0b-linkage-ar-null: assigned instructor was able to null appointment_id on their own attendance row'; end if;

  -- attendance_records: retarget to colleague's appointment denied
  v_denied := false;
  begin
    update public.attendance_records set appointment_id = '00000000-0000-0000-0000-0000007e0002'::uuid where id = '00000000-0000-0000-0000-000000710001'::uuid;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2c0b-linkage-ar-retarget: assigned instructor was able to retarget attendance appointment_id to a colleague''s class'; end if;

  -- group_lesson_recaps: null-out denied
  v_denied := false;
  begin
    update public.group_lesson_recaps set appointment_id = null where id = '00000000-0000-0000-0000-000000711001'::uuid;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2c0b-linkage-recap-null: assigned instructor was able to null appointment_id on their own recap'; end if;

  -- group_lesson_recaps: retarget denied
  v_denied := false;
  begin
    update public.group_lesson_recaps set appointment_id = '00000000-0000-0000-0000-0000007e0002'::uuid where id = '00000000-0000-0000-0000-000000711001'::uuid;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2c0b-linkage-recap-retarget: assigned instructor was able to retarget recap appointment_id to a colleague''s class'; end if;

  -- group_lesson_recap_recipients: null-out denied
  v_denied := false;
  begin
    update public.group_lesson_recap_recipients set appointment_id = null where id = '00000000-0000-0000-0000-000000712001'::uuid;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2c0b-linkage-recip-null: assigned instructor was able to null appointment_id on their own recipient row'; end if;

  -- group_lesson_recap_recipients: retarget denied
  v_denied := false;
  begin
    update public.group_lesson_recap_recipients set appointment_id = '00000000-0000-0000-0000-0000007e0002'::uuid where id = '00000000-0000-0000-0000-000000712001'::uuid;
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'FAIL T-fc1b5d2c0b-linkage-recip-retarget: assigned instructor was able to retarget recipient appointment_id to a colleague''s class'; end if;

  reset role;

  -- verify none of the denied attempts actually took effect
  select appointment_id into v_value_after from public.attendance_records where id = '00000000-0000-0000-0000-000000710001'::uuid;
  if v_value_after is distinct from '00000000-0000-0000-0000-0000007e0001'::uuid then
    raise exception 'FAIL T-fc1b5d2c0b-linkage-ar-verify: attendance appointment_id was actually changed despite denials (now %)', v_value_after;
  end if;

  select appointment_id into v_value_after from public.group_lesson_recaps where id = '00000000-0000-0000-0000-000000711001'::uuid;
  if v_value_after is distinct from '00000000-0000-0000-0000-0000007e0001'::uuid then
    raise exception 'FAIL T-fc1b5d2c0b-linkage-recap-verify: recap appointment_id was actually changed despite denials (now %)', v_value_after;
  end if;

  select appointment_id into v_value_after from public.group_lesson_recap_recipients where id = '00000000-0000-0000-0000-000000712001'::uuid;
  if v_value_after is distinct from '00000000-0000-0000-0000-0000007e0001'::uuid then
    raise exception 'FAIL T-fc1b5d2c0b-linkage-recip-verify: recipient appointment_id was actually changed despite denials (now %)', v_value_after;
  end if;

  raise notice 'PASS T-fc1b5d2c0b-linkage: ordinary edits on own schedule-linked rows remain allowed; null-out and retarget both denied across attendance/recap/recipients, verified unchanged in the underlying data';
end $$;

-- ============================================================================
-- policy inventory -- exact final policy set on all four tables, no
-- lingering broad FOR ALL policy anywhere.
-- ============================================================================
do $$
declare
  v_names text[];
  v_forall_count int;
begin
  select array_agg(polname order by polname) into v_names
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where c.relname = 'attendance_records';
  if v_names is distinct from array['attendance_records_delete','attendance_records_insert','attendance_records_select','attendance_records_update'] then
    raise exception 'FAIL T-fc1b5d2c0b-inventory-ar: unexpected policy set: %', v_names;
  end if;

  select array_agg(polname order by polname) into v_names
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where c.relname = 'group_lesson_recaps';
  if v_names is distinct from array['Linked students can read published group lesson recaps','group_lesson_recaps_delete','group_lesson_recaps_insert','group_lesson_recaps_select','group_lesson_recaps_update'] then
    raise exception 'FAIL T-fc1b5d2c0b-inventory-recap: unexpected policy set: %', v_names;
  end if;

  select array_agg(polname order by polname) into v_names
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where c.relname = 'group_lesson_recap_recipients';
  if v_names is distinct from array['Linked students can read own group lesson recap recipients','group_lesson_recap_recipients_delete','group_lesson_recap_recipients_insert','group_lesson_recap_recipients_select','group_lesson_recap_recipients_update'] then
    raise exception 'FAIL T-fc1b5d2c0b-inventory-recip: unexpected policy set: %', v_names;
  end if;

  select array_agg(polname order by polname) into v_names
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where c.relname = 'group_lesson_recap_syllabus_steps';
  if v_names is distinct from array['group_lesson_recap_syllabus_steps_delete','group_lesson_recap_syllabus_steps_insert','group_lesson_recap_syllabus_steps_select','group_lesson_recap_syllabus_steps_update'] then
    raise exception 'FAIL T-fc1b5d2c0b-inventory-syl: unexpected policy set: %', v_names;
  end if;

  select count(*) into v_forall_count
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where c.relname in ('attendance_records','group_lesson_recaps','group_lesson_recap_recipients','group_lesson_recap_syllabus_steps')
    and pol.polcmd = '*';
  if v_forall_count <> 0 then
    raise exception 'FAIL T-fc1b5d2c0b-inventory-forall: a broad FOR ALL policy still exists on one of the four tables';
  end if;

  raise notice 'PASS T-fc1b5d2c0b-inventory: exact expected policy set on all four tables, no FOR ALL policy remains, portal policies untouched';
end $$;

rollback;
