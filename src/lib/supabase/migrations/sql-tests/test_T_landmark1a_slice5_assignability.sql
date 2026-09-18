-- Landmark 1A -- Slice 5: Instructor Assignability Validation
--
-- Regression suite for the trigger/helper pair added by
-- 20260918020000_landmark1a_instructor_assignability_enforcement.sql.
-- One transaction, synthetic fixtures only (UUID block
-- 00000000-0000-0000-0000-00001a5XXXXX), rolled back at the end -- zero
-- persistent data. Assumes the forward migration has already been
-- applied in this environment.

begin;

-- Fixtures -------------------------------------------------------------

insert into public.studios (id, name, slug)
values
  ('00000000-0000-0000-0000-00001a500001', 'Slice5 Test Studio A', 't-landmark1a-s5-studio-a'),
  ('00000000-0000-0000-0000-00001a500002', 'Slice5 Test Studio B', 't-landmark1a-s5-studio-b');

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00001a500101', 't-landmark1a-s5-eligible-a@example.test'),
  ('00000000-0000-0000-0000-00001a500102', 't-landmark1a-s5-eligible-b@example.test'),
  ('00000000-0000-0000-0000-00001a500103', 't-landmark1a-s5-inactive-a@example.test'),
  ('00000000-0000-0000-0000-00001a500104', 't-landmark1a-s5-incapable-a@example.test');

insert into public.profiles (id, email, full_name)
values
  ('00000000-0000-0000-0000-00001a500101', 't-landmark1a-s5-eligible-a@example.test', 'Slice5 Eligible A'),
  ('00000000-0000-0000-0000-00001a500102', 't-landmark1a-s5-eligible-b@example.test', 'Slice5 Eligible B'),
  ('00000000-0000-0000-0000-00001a500103', 't-landmark1a-s5-inactive-a@example.test', 'Slice5 Inactive A'),
  ('00000000-0000-0000-0000-00001a500104', 't-landmark1a-s5-incapable-a@example.test', 'Slice5 Incapable A');

-- Eligible at Studio A: active, can_instruct, user_id populated.
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
values ('00000000-0000-0000-0000-00001a500201', '00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500101', 'Eligible', 'InstructorA', true, true);

-- Eligible at Studio B: same person as above is NOT linked here; a
-- distinct instructor identity confirms studio-scoping without implying
-- the same user could teach at both (that case is exercised separately).
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
values ('00000000-0000-0000-0000-00001a500202', '00000000-0000-0000-0000-00001a500002', '00000000-0000-0000-0000-00001a500102', 'Eligible', 'InstructorB', true, true);

-- Inactive at Studio A.
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
values ('00000000-0000-0000-0000-00001a500203', '00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500103', 'Inactive', 'InstructorA', false, true);

-- can_instruct=false at Studio A (e.g. admin/front-desk without capability, or a pure renter).
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
values ('00000000-0000-0000-0000-00001a500204', '00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500104', 'Incapable', 'InstructorA', true, false);

-- user_id NULL at Studio A (active + can_instruct=true, but unlinked -- legacy/noncompliant).
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
values ('00000000-0000-0000-0000-00001a500205', '00000000-0000-0000-0000-00001a500001', null, 'Unlinked', 'InstructorA', true, true);

insert into public.clients (id, studio_id, first_name, last_name, status)
values ('00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500001', 'Test', 'Client', 'active');

-- Test cases -------------------------------------------------------------

do $$
declare
  v_appt_id uuid;
  v_failed boolean;
begin

  -- 1. Valid active+capable+account-linked instructor succeeds.
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
  values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500201', 'private_lesson', 't', now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled', null)
  returning id into v_appt_id;
  assert v_appt_id is not null, 'Case 1 FAILED: valid instructor should succeed';
  raise notice 'Case 1 PASSED: valid instructor succeeds';

  -- 2. Inactive instructor fails.
  v_failed := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
    values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500203', 'private_lesson', 't', now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled', null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 2 FAILED: inactive instructor should be rejected';
  raise notice 'Case 2 PASSED: inactive instructor rejected';

  -- 3. can_instruct=false fails.
  v_failed := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
    values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500204', 'private_lesson', 't', now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled', null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 3 FAILED: can_instruct=false should be rejected';
  raise notice 'Case 3 PASSED: can_instruct=false rejected';

  -- 4. user_id=NULL fails.
  v_failed := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
    values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500205', 'private_lesson', 't', now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled', null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 4 FAILED: user_id=NULL should be rejected';
  raise notice 'Case 4 PASSED: user_id=NULL rejected';

  -- 5. Wrong-studio instructor fails (Studio B's eligible instructor used at Studio A).
  v_failed := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
    values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500202', 'private_lesson', 't', now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled', null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 5 FAILED: wrong-studio instructor should be rejected';
  raise notice 'Case 5 PASSED: wrong-studio instructor rejected';

  -- 6. Nonexistent UUID fails safely.
  v_failed := false;
  begin
    insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
    values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a5099999999', 'private_lesson', 't', now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled', null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 6 FAILED: nonexistent UUID should be rejected';
  raise notice 'Case 6 PASSED: nonexistent UUID rejected';

  -- 7. Unrelated-field edit (instructor_id/studio_id/appointment_type
  -- unchanged) succeeds even though the assigned instructor has since
  -- become inactive -- deactivate the valid instructor from case 1 first.
  update public.instructors set active = false where id = '00000000-0000-0000-0000-00001a500201';
  update public.appointments set notes = 'unrelated edit' where id = v_appt_id;
  assert (select notes from public.appointments where id = v_appt_id) = 'unrelated edit',
    'Case 7 FAILED: unrelated-field edit should succeed despite a since-deactivated instructor';
  raise notice 'Case 7 PASSED: unrelated-field edit succeeds, non-disruptive rule holds';

  -- 8. Changing only studio_id (same instructor_id) fails, since that
  -- instructor is not valid at the destination studio.
  v_failed := false;
  begin
    update public.appointments set studio_id = '00000000-0000-0000-0000-00001a500002' where id = v_appt_id;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 8 FAILED: studio-move with a now-ineligible-there instructor should be rejected';
  raise notice 'Case 8 PASSED: studio-move bypass closed';

  -- Reactivate for the remaining cases.
  update public.instructors set active = true where id = '00000000-0000-0000-0000-00001a500201';

  -- 9. Excluded type (floor_space_rental) with a non-can_instruct
  -- renter-style instructor succeeds -- the renter's own instructor row
  -- is deliberately non-capable, and this type is excluded entirely.
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
  values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500204', 'floor_space_rental', 't', now() + interval '2 day', now() + interval '2 day 1 hour', 'scheduled', null)
  returning id into v_appt_id;
  assert v_appt_id is not null, 'Case 9 FAILED: floor_space_rental should remain unaffected';
  raise notice 'Case 9 PASSED: floor_space_rental unaffected';

  -- 10. room_unavailable with a null instructor succeeds (the normal
  -- shape for this type) -- confirms the exclusion and the null-passthrough.
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
  values ('00000000-0000-0000-0000-00001a500001', null, null, 'room_unavailable', 't', now() + interval '3 day', now() + interval '3 day 1 hour', 'scheduled', null)
  returning id into v_appt_id;
  assert v_appt_id is not null, 'Case 10 FAILED: room_unavailable should remain unaffected';
  raise notice 'Case 10 PASSED: room_unavailable unaffected';

  -- 11. Changing from an excluded type into an instructional type, same
  -- ineligible instructor_id unchanged, fails.
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
  values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500204', 'floor_space_rental', 't', now() + interval '4 day', now() + interval '4 day 1 hour', 'scheduled', null)
  returning id into v_appt_id;
  v_failed := false;
  begin
    update public.appointments set appointment_type = 'private_lesson' where id = v_appt_id;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 11 FAILED: type-change-into-instructional bypass should be closed';
  raise notice 'Case 11 PASSED: type-change-into-instructional bypass closed';

  -- 12. Instructional-to-instructional type change with an ineligible
  -- current instructor revalidates and fails (private_lesson -> coaching,
  -- avoiding group_class since its type is already locked by
  -- enforce_group_class_canonical_shape independent of this trigger).
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, created_by)
  values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500301', '00000000-0000-0000-0000-00001a500204', 'floor_space_rental', 't', now() + interval '5 day', now() + interval '5 day 1 hour', 'scheduled', null)
  returning id into v_appt_id;
  -- Seed it into an instructional type first via direct catalog bypass is
  -- not possible (the trigger fires on this same statement) -- instead,
  -- start from a genuinely eligible instructor+instructional pairing, then
  -- deactivate that instructor, then attempt the type change.
  update public.appointments set instructor_id = '00000000-0000-0000-0000-00001a500201', appointment_type = 'private_lesson' where id = v_appt_id;
  update public.instructors set active = false where id = '00000000-0000-0000-0000-00001a500201';
  v_failed := false;
  begin
    update public.appointments set appointment_type = 'coaching' where id = v_appt_id;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 12 FAILED: instructional-to-instructional type change with an ineligible instructor should revalidate and fail';
  raise notice 'Case 12 PASSED: instructional-to-instructional type change revalidates correctly';
  update public.instructors set active = true where id = '00000000-0000-0000-0000-00001a500201';

  -- 13. group_class is the type create_group_class_appointment's own RPC
  -- body has zero instructor validation for (confirmed by direct read of
  -- its current body) -- proving the DB trigger rejects an ineligible
  -- instructor on a raw INSERT shaped exactly like that RPC's own INSERT
  -- (studio_id, instructor_id, appointment_type='group_class') directly
  -- demonstrates the persistence-layer backstop holds regardless of
  -- caller, without depending on the RPC's own auth.uid()-based staff
  -- authority check (which a migration-connection test context cannot
  -- satisfy, since there is no real JWT/session here) -- a cleaner,
  -- caller-independent proof of exactly what item 6 requires: this type
  -- is protected "even if called directly," not merely by the RPC's own
  -- authority gate.
  v_failed := false;
  begin
    insert into public.appointments (studio_id, instructor_id, room_id, appointment_type, title, starts_at, ends_at, status, client_id, created_by)
    values ('00000000-0000-0000-0000-00001a500001', '00000000-0000-0000-0000-00001a500204', null, 'group_class', 'Bad Class', now() + interval '6 day', now() + interval '6 day 1 hour', 'scheduled', null, null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'Case 13 FAILED: a group_class row with an ineligible instructor should be rejected at the DB layer';
  raise notice 'Case 13 PASSED: group_class DB-layer enforcement holds independent of the RPC''s own authority check';

  raise notice 'LANDMARK 1A SLICE 5 SQL REGRESSION: ALL 13 CASES PASSED';
end $$;

rollback;
