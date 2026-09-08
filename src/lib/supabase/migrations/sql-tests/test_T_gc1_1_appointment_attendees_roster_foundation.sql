-- GC-1.1 -- appointment_attendees roster foundation live-Postgres regression
-- suite.
--
-- Proves, at the real Postgres level (not mocked), that the new roster
-- table's integrity trigger, constraints, uniqueness invariant, and RLS
-- persona matrix all behave exactly as approved. Entire script runs in one
-- transaction and is rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER the
-- forward migration
-- (20260908110000_gc1_1_appointment_attendees_roster_foundation.sql) has
-- been applied.
--
-- Deterministic UUID block reserved for this harness (distinct from every
-- prior harness's 6a-6e/7a-7e block):
-- 00000000-0000-0000-0000-0000008aXXXX (studios)
-- 00000000-0000-0000-0000-0000008bXXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-0000008cXXXX (instructors)
-- 00000000-0000-0000-0000-0000008dXXXX (clients)
-- 00000000-0000-0000-0000-0000008eXXXX (appointments)
-- 00000000-0000-0000-0000-0000008fXXXX (client_packages)
-- 00000000-0000-0000-0000-0000009aXXXX (client_memberships)
-- 00000000-0000-0000-0000-0000009bXXXX (membership_plans)

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000008a0001', 'GC-1.1 Harness Studio A', 't-gc1-1-studio-a'),
  ('00000000-0000-0000-0000-0000008a0002', 'GC-1.1 Harness Studio B', 't-gc1-1-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000008b0001', 't-gc1-1-owner@example.test'),
  ('00000000-0000-0000-0000-0000008b0002', 't-gc1-1-admin@example.test'),
  ('00000000-0000-0000-0000-0000008b0003', 't-gc1-1-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000008b0004', 't-gc1-1-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000008b0005', 't-gc1-1-instructor-b@example.test'),
  ('00000000-0000-0000-0000-0000008b0006', 't-gc1-1-hybrid@example.test'),
  ('00000000-0000-0000-0000-0000008b0007', 't-gc1-1-indepinstructor@example.test'),
  ('00000000-0000-0000-0000-0000008b0008', 't-gc1-1-portalself@example.test'),
  ('00000000-0000-0000-0000-0000008b0009', 't-gc1-1-portalother@example.test'),
  ('00000000-0000-0000-0000-0000008b0010', 't-gc1-1-platformadmin@example.test'),
  ('00000000-0000-0000-0000-0000008b0011', 't-gc1-1-crossstudio@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000008b0001', 't-gc1-1-owner@example.test', null),
  ('00000000-0000-0000-0000-0000008b0002', 't-gc1-1-admin@example.test', null),
  ('00000000-0000-0000-0000-0000008b0003', 't-gc1-1-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-0000008b0004', 't-gc1-1-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-0000008b0005', 't-gc1-1-instructor-b@example.test', null),
  ('00000000-0000-0000-0000-0000008b0006', 't-gc1-1-hybrid@example.test', null),
  ('00000000-0000-0000-0000-0000008b0007', 't-gc1-1-indepinstructor@example.test', null),
  ('00000000-0000-0000-0000-0000008b0008', 't-gc1-1-portalself@example.test', null),
  ('00000000-0000-0000-0000-0000008b0009', 't-gc1-1-portalother@example.test', null),
  ('00000000-0000-0000-0000-0000008b0010', 't-gc1-1-platformadmin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-0000008b0011', 't-gc1-1-crossstudio@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000008b0001', '00000000-0000-0000-0000-0000008a0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000008b0002', '00000000-0000-0000-0000-0000008a0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000008b0003', '00000000-0000-0000-0000-0000008a0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000008b0004', '00000000-0000-0000-0000-0000008a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000008b0005', '00000000-0000-0000-0000-0000008a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000008b0006', '00000000-0000-0000-0000-0000008a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000008b0007', '00000000-0000-0000-0000-0000008a0001', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000008b0011', '00000000-0000-0000-0000-0000008a0002', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000008c0001', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008b0004', 'Instructor', 'A', true),
  ('00000000-0000-0000-0000-0000008c0002', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008b0005', 'Instructor', 'B', true),
  ('00000000-0000-0000-0000-0000008c0003', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008b0006', 'Hybrid', 'Teacher', true),
  ('00000000-0000-0000-0000-0000008c0004', '00000000-0000-0000-0000-0000008a0002', '00000000-0000-0000-0000-0000008b0011', 'CrossStudio', 'Instructor', true);

-- Note: 8d0001 is deliberately status='lead' -- proving a lead-status client
-- is a fully valid roster identity (GC-0 confirmation). 8b0007 (independent
-- instructor persona) has no clients row and no instructors row at all --
-- their denial cannot be a false positive from an accidental relationship.
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-0000008d0001', '00000000-0000-0000-0000-0000008a0001', 'Lead', 'Attendee', 'lead', false),
  ('00000000-0000-0000-0000-0000008d0002', '00000000-0000-0000-0000-0000008a0001', 'Active', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-0000008d0003', '00000000-0000-0000-0000-0000008a0001', 'Portal', 'Self', 'active', false),
  ('00000000-0000-0000-0000-0000008d0004', '00000000-0000-0000-0000-0000008a0001', 'Portal', 'Other', 'active', false),
  ('00000000-0000-0000-0000-0000008d0005', '00000000-0000-0000-0000-0000008a0002', 'CrossStudio', 'Client', 'active', false),
  ('00000000-0000-0000-0000-0000008d0006', '00000000-0000-0000-0000-0000008a0001', 'Wrong', 'Owner', 'active', false);

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, initiated_by) values
  ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008d0003', '00000000-0000-0000-0000-0000008b0008', 'linked', 'self', 'studio'),
  ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008d0004', '00000000-0000-0000-0000-0000008b0009', 'linked', 'self', 'studio');

insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008a0001', null, '00000000-0000-0000-0000-0000008c0001', 'group_class',    'scheduled', '2026-09-20T10:00:00+00', '2026-09-20T11:00:00+00'),
  ('00000000-0000-0000-0000-0000008e0002', '00000000-0000-0000-0000-0000008a0001', null, '00000000-0000-0000-0000-0000008c0001', 'private_lesson', 'scheduled', '2026-09-20T11:00:00+00', '2026-09-20T12:00:00+00'),
  ('00000000-0000-0000-0000-0000008e0003', '00000000-0000-0000-0000-0000008a0002', null, '00000000-0000-0000-0000-0000008c0004', 'group_class',    'scheduled', '2026-09-20T10:00:00+00', '2026-09-20T11:00:00+00'),
  ('00000000-0000-0000-0000-0000008e0004', '00000000-0000-0000-0000-0000008a0001', null, '00000000-0000-0000-0000-0000008c0003', 'group_class',    'scheduled', '2026-09-20T12:00:00+00', '2026-09-20T13:00:00+00'),
  ('00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008a0001', null, '00000000-0000-0000-0000-0000008c0002', 'group_class',    'scheduled', '2026-09-20T13:00:00+00', '2026-09-20T14:00:00+00');

-- Aliases:
-- APPT_A_CLASS     = ...8e0001  Instructor A's own group_class (main test class)
-- APPT_A_PRIVATE   = ...8e0002  Instructor A's private_lesson (wrong-type integrity test)
-- APPT_CROSS_CLASS = ...8e0003  Studio B group_class (cross-studio integrity + RLS test)
-- APPT_HYBRID_CLASS= ...8e0004  Hybrid's own group_class
-- APPT_B_CLASS     = ...8e0005  Instructor B's group_class (colleague/unassigned-instructor test)

insert into public.membership_plans (id, studio_id, name) values
  ('00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000008a0001', 'GC-1.1 Test Plan');

insert into public.client_packages (id, studio_id, client_id, name_snapshot, purchase_date, is_shareable, active) values
  ('00000000-0000-0000-0000-0000008f0001', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008d0001', 'Valid Package', current_date, false, true),
  ('00000000-0000-0000-0000-0000008f0002', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008d0006', 'Wrong Client Package', current_date, false, true),
  ('00000000-0000-0000-0000-0000008f0003', '00000000-0000-0000-0000-0000008a0002', '00000000-0000-0000-0000-0000008d0001', 'Wrong Studio Package', current_date, false, true);

insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on, current_period_start, current_period_end,
  auto_renew, cancel_at_period_end, name_snapshot, price_snapshot, billing_interval_snapshot
) values
  ('00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008d0001', '00000000-0000-0000-0000-0000009b0001', 'active', current_date, current_date, current_date + 30, false, false, 'Valid Membership', 0, 'monthly'),
  ('00000000-0000-0000-0000-0000009a0002', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008d0006', '00000000-0000-0000-0000-0000009b0001', 'active', current_date, current_date, current_date + 30, false, false, 'Wrong Client Membership', 0, 'monthly'),
  -- status is deliberately not 'active' here: a client may only hold one
  -- active membership at a time (uq_client_one_active_membership), and this
  -- fixture intentionally shares client_id 8d0001 with the valid membership
  -- above. The integrity trigger only checks client_id/studio_id ownership,
  -- never status, so this remains a valid fixture for the wrong-studio case.
  ('00000000-0000-0000-0000-0000009a0003', '00000000-0000-0000-0000-0000008a0002', '00000000-0000-0000-0000-0000008d0001', '00000000-0000-0000-0000-0000009b0001', 'paused', current_date, current_date, current_date + 30, false, false, 'Wrong Studio Membership', 0, 'monthly');

-- ============================================================================
-- 1-8, 16. Integrity trigger failures (INSERT), uniform message text.
-- ============================================================================
do $$
declare
  v_studio_a uuid := '00000000-0000-0000-0000-0000008a0001';
  v_lead_client uuid := '00000000-0000-0000-0000-0000008d0001';
  v_errored boolean;
  v_msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);

  -- 1. nonexistent appointment
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values (v_studio_a, '00000000-0000-0000-0000-00000000dead', v_lead_client, 'staff');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-1: nonexistent appointment was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-1-msg: got %', v_msg; end if;

  -- 2. cross-studio appointment (APPT_CROSS_CLASS is studio B, studio_id claims studio A)
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values (v_studio_a, '00000000-0000-0000-0000-0000008e0003', v_lead_client, 'staff');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-2: cross-studio appointment was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-2-msg: got %', v_msg; end if;

  -- 3. wrong appointment_type (private_lesson)
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values (v_studio_a, '00000000-0000-0000-0000-0000008e0002', v_lead_client, 'staff');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-3: private_lesson appointment was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-3-msg: got %', v_msg; end if;

  -- 4. client belongs to a different studio
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values (v_studio_a, '00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008d0005', 'staff');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-4: cross-studio client was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-4-msg: got %', v_msg; end if;

  -- 5. package belongs to a different client
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, client_package_id)
    values (v_studio_a, '00000000-0000-0000-0000-0000008e0001', v_lead_client, 'staff', '00000000-0000-0000-0000-0000008f0002');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-5: wrong-client package was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-5-msg: got %', v_msg; end if;

  -- 6. package belongs to right client but wrong studio
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, client_package_id)
    values (v_studio_a, '00000000-0000-0000-0000-0000008e0001', v_lead_client, 'staff', '00000000-0000-0000-0000-0000008f0003');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-6: wrong-studio package was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-6-msg: got %', v_msg; end if;

  -- 7. membership belongs to a different client
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, client_membership_id)
    values (v_studio_a, '00000000-0000-0000-0000-0000008e0001', v_lead_client, 'staff', '00000000-0000-0000-0000-0000009a0002');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-7: wrong-client membership was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-7-msg: got %', v_msg; end if;

  -- 8. membership belongs to right client but wrong studio
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, client_membership_id)
    values (v_studio_a, '00000000-0000-0000-0000-0000008e0001', v_lead_client, 'staff', '00000000-0000-0000-0000-0000009a0003');
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-integrity-8: wrong-studio membership was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-integrity-8-msg: got %', v_msg; end if;

  reset role;
  raise notice 'PASS T-gc1-1-integrity-failures: all 8 integrity checks reject with the uniform message';
end $$;

-- ============================================================================
-- 9-10. Valid inserts: lead-status client with no package/membership, and a
--       second row with correctly-owned package + membership both present.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);

  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, source)
  values ('00000000-0000-0000-0000-0000009c0001', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008d0001', 'staff');

  select count(*) into v_count from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0001'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-valid-lead: valid insert for a lead-status client did not take effect'; end if;

  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, source, client_package_id, client_membership_id)
  values ('00000000-0000-0000-0000-0000009c0002', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0004', '00000000-0000-0000-0000-0000008d0001', 'staff', '00000000-0000-0000-0000-0000008f0001', '00000000-0000-0000-0000-0000009a0001');

  select count(*) into v_count from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-valid-package-membership: valid insert with owned package+membership did not take effect'; end if;

  reset role;
  raise notice 'PASS T-gc1-1-valid-inserts: lead-status client and package+membership-bearing rows both succeed';
end $$;

-- ============================================================================
-- 11-13, 15-16. UPDATE identity-retarget protection and re-validation.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);

  -- 11. retarget appointment_id
  v_errored := false;
  begin
    update public.appointment_attendees set appointment_id = '00000000-0000-0000-0000-0000008e0004'
    where id = '00000000-0000-0000-0000-0000009c0001'::uuid;
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-retarget-appointment: appointment_id retarget was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-retarget-appointment-msg: got %', v_msg; end if;

  -- 12. retarget client_id
  v_errored := false;
  begin
    update public.appointment_attendees set client_id = '00000000-0000-0000-0000-0000008d0002'
    where id = '00000000-0000-0000-0000-0000009c0001'::uuid;
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-retarget-client: client_id retarget was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-retarget-client-msg: got %', v_msg; end if;

  -- 13. retarget studio_id
  v_errored := false;
  begin
    update public.appointment_attendees set studio_id = '00000000-0000-0000-0000-0000008a0002'
    where id = '00000000-0000-0000-0000-0000009c0001'::uuid;
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-retarget-studio: studio_id retarget was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-retarget-studio-msg: got %', v_msg; end if;

  -- 14. legitimate field update succeeds
  update public.appointment_attendees set payment_status = 'paid', billing_note = 'covered by studio credit'
  where id = '00000000-0000-0000-0000-0000009c0001'::uuid;

  -- 15. repoint client_package_id to a package owned by a different client -- re-validated on UPDATE
  v_errored := false;
  begin
    update public.appointment_attendees set client_package_id = '00000000-0000-0000-0000-0000008f0002'
    where id = '00000000-0000-0000-0000-0000009c0002'::uuid;
  exception when others then
    v_errored := true; v_msg := sqlerrm;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-update-repoint-package: wrong-client package repoint on UPDATE was not rejected'; end if;
  if v_msg is distinct from 'Invalid roster enrollment.' then raise exception 'FAIL T-gc1-1-update-repoint-package-msg: got %', v_msg; end if;

  reset role;

  -- Verify the legitimate update from case 14 actually took effect.
  perform 1 from public.appointment_attendees
  where id = '00000000-0000-0000-0000-0000009c0001'::uuid
    and payment_status = 'paid'
    and billing_note = 'covered by studio credit';
  if not found then raise exception 'FAIL T-gc1-1-legitimate-update-verify: legitimate field update did not persist'; end if;

  raise notice 'PASS T-gc1-1-update-protection: identity fields locked, re-validation on UPDATE holds, legitimate updates succeed';
end $$;

-- ============================================================================
-- 17-21. Controlled-vocabulary constraint checks.
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'staff', 'waitlisted');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-1-status-check: status=waitlisted was not rejected'; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'unknown_channel');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-1-source-check: source=unknown_channel was not rejected'; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, payment_status)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'staff', 'not_a_status');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-1-payment-status-check: invalid payment_status was not rejected'; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, billing_type)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'staff', 'not_a_type');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-1-billing-type-check: invalid billing_type was not rejected'; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, confirmation_source)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'staff', 'not_a_source');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-1-confirmation-source-check: invalid confirmation_source was not rejected'; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status, cancelled_at)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'staff', 'cancelled', null);
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-1-cancellation-check-a: cancelled without cancelled_at was not rejected'; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status, cancelled_at)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'staff', 'booked', now());
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-1-cancellation-check-b: booked with stale cancelled_at was not rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-1-constraints: all controlled-vocabulary and cancellation-consistency checks reject invalid values';
end $$;

-- ============================================================================
-- 22-23. Duplicate active enrollment prevention, rebooking after cancellation.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);

  -- duplicate while first is still 'booked'
  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008d0001', 'staff');
  exception when unique_violation then
    v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-duplicate: duplicate active (appointment_id, client_id) was not rejected'; end if;

  -- cancel the original, then rebooking for the same pair succeeds
  update public.appointment_attendees set status = 'cancelled', cancelled_at = now()
  where id = '00000000-0000-0000-0000-0000009c0001'::uuid;

  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, source)
  values ('00000000-0000-0000-0000-0000009c0003', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008d0001', 'staff');

  select count(*) into v_count from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-rebooking: legitimate rebooking after cancellation was rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-1-duplicate-rebooking: duplicate active enrollment denied, rebooking after cancellation succeeds';
end $$;

-- ============================================================================
-- 24-25. Soft-cancel retention, hard DELETE denied.
-- ============================================================================
do $$
declare
  v_count int;
  v_status text;
begin
  -- Verify (as fixture owner, no RLS) the cancelled row from the previous
  -- block still exists.
  select status into v_status from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0001'::uuid;
  if v_status is distinct from 'cancelled' then raise exception 'FAIL T-gc1-1-soft-cancel-retention: cancelled row missing or wrong status (%)', v_status; end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);

  -- Attempt a hard DELETE as a broad role (studio_owner) -- no DELETE policy
  -- exists, so this must affect zero rows (RLS silently excludes every row
  -- from the DELETE's own WHERE clause), not raise.
  delete from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0003'::uuid;

  reset role;

  select count(*) into v_count from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0003'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-hard-delete-denied: row was deleted despite no DELETE policy existing'; end if;

  raise notice 'PASS T-gc1-1-soft-cancel-hard-delete: cancelled rows retained, hard DELETE structurally denied for every role';
end $$;

-- ============================================================================
-- 26-32. RLS personas.
-- ============================================================================
do $$
declare
  v_count int;
  v_errored boolean;
begin
  -- 26. broad roles: SELECT/INSERT/UPDATE succeed.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0010')::text, true); -- platform_admin
  select count(*) into v_count from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0002'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-broad-platformadmin-select: platform_admin could not SELECT'; end if;
  update public.appointment_attendees set billing_note = 'platform admin touch' where id = '00000000-0000-0000-0000-0000009c0002'::uuid;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0002')::text, true); -- studio_admin
  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, source)
  values ('00000000-0000-0000-0000-0000009c0004', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0002', 'staff');
  reset role;
  select count(*) into v_count from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0004'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-broad-admin-insert: studio_admin could not INSERT'; end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0003')::text, true); -- front_desk
  select count(*) into v_count from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0004'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-broad-frontdesk-select: front_desk could not SELECT'; end if;
  reset role;

  -- 27. assigned instructor: SELECT own class roster, INSERT/UPDATE denied.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0004')::text, true); -- instructor A
  -- appointment_id = 8e0001 legitimately carries 2 rows by this point (one
  -- cancelled, one active -- the rebooking pair proven in the duplicate/
  -- rebooking block above), so the meaningful assertion is against the
  -- active row specifically, not a bare row count.
  select count(*) into v_count from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000008e0001'::uuid and status <> 'cancelled';
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-assigned-select: instructor A could not SELECT own class roster (active rows), got %', v_count; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008d0002', 'staff');
  exception when insufficient_privilege then v_errored := true;
  when others then v_errored := true;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-1-assigned-insert-denied: instructor A was able to INSERT enrollment'; end if;

  v_errored := false;
  begin
    update public.appointment_attendees set billing_note = 'instructor edit attempt' where id = '00000000-0000-0000-0000-0000009c0004'::uuid;
  exception when others then v_errored := true; end;
  reset role;
  -- UPDATE with no matching row is a silent no-op (0 rows), not necessarily
  -- an exception -- verify no-op by re-checking the value was not changed.
  perform 1 from public.appointment_attendees where id = '00000000-0000-0000-0000-0000009c0004'::uuid and billing_note = 'instructor edit attempt';
  if found then raise exception 'FAIL T-gc1-1-assigned-update-denied: instructor A was able to UPDATE enrollment'; end if;

  -- 28. unassigned instructor: SELECT of colleague's class returns zero rows, INSERT denied.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0005')::text, true); -- instructor B
  select count(*) into v_count from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000008e0001'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-gc1-1-unassigned-select: unassigned instructor B saw colleague class roster, got %', v_count; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008d0002', 'staff');
  exception when others then v_errored := true; end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-1-unassigned-insert-denied: unassigned instructor B was able to INSERT'; end if;

  -- 29. independent instructor (floor-rental-only persona, no real teaching relationship): zero visibility.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0007')::text, true);
  select count(*) into v_count from public.appointment_attendees where appointment_id in ('00000000-0000-0000-0000-0000008e0001'::uuid, '00000000-0000-0000-0000-0000008e0004'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-gc1-1-indep-select: independent instructor saw a host class roster via bare studio relationship, got %', v_count; end if;
  reset role;

  -- 30. hybrid: SELECT succeeds for own assigned class, denied for a colleague's.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0006')::text, true);
  select count(*) into v_count from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000008e0004'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-hybrid-own-select: hybrid could not SELECT own assigned class roster, got %', v_count; end if;

  select count(*) into v_count from public.appointment_attendees where appointment_id in ('00000000-0000-0000-0000-0000008e0001'::uuid, '00000000-0000-0000-0000-0000008e0005'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-gc1-1-hybrid-colleague-select: hybrid saw a colleague class roster despite active instructor role, got %', v_count; end if;
  reset role;

  -- 31. portal client: sees only own row, never a classmate's row on the same
  --     appointment. Both fixture rows are inserted by a broad role -- portal
  --     has zero INSERT authority in GC-1.1 by design, so inserting "as"
  --     the portal persona would itself be an RLS violation, not a valid way
  --     to seed this test.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);
  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, source)
  values ('00000000-0000-0000-0000-0000009c0005', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0003', 'staff');
  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, source)
  values ('00000000-0000-0000-0000-0000009c0006', '00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0005', '00000000-0000-0000-0000-0000008d0004', 'staff');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0008')::text, true); -- portal self
  select count(*) into v_count from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000008e0005'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-1-portal-isolation: portal client saw % rows on a shared class roster, expected exactly 1 (their own)', v_count; end if;
  perform 1 from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000008e0005'::uuid and client_id = '00000000-0000-0000-0000-0000008d0003'::uuid;
  if not found then raise exception 'FAIL T-gc1-1-portal-isolation-own: portal client could not see their own row'; end if;
  perform 1 from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000008e0005'::uuid and client_id = '00000000-0000-0000-0000-0000008d0004'::uuid;
  if found then raise exception 'FAIL T-gc1-1-portal-isolation-classmate: portal client could see a classmate row'; end if;
  reset role;

  -- 32. cross-studio: Studio B instructor cannot see or write Studio A roster.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0011')::text, true);
  select count(*) into v_count from public.appointment_attendees where appointment_id in ('00000000-0000-0000-0000-0000008e0001'::uuid, '00000000-0000-0000-0000-0000008e0004'::uuid, '00000000-0000-0000-0000-0000008e0005'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-gc1-1-crossstudio-select: Studio B instructor saw Studio A roster rows, got %', v_count; end if;

  v_errored := false;
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, source)
    values ('00000000-0000-0000-0000-0000008a0001', '00000000-0000-0000-0000-0000008e0001', '00000000-0000-0000-0000-0000008d0002', 'staff');
  exception when others then v_errored := true; end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-1-crossstudio-insert-denied: Studio B instructor was able to INSERT into Studio A roster'; end if;

  raise notice 'PASS T-gc1-1-rls-personas: broad roles manage, assigned instructor read-only own class, unassigned/independent denied, hybrid teaching-only, portal self-only, cross-studio denied';
end $$;

-- ============================================================================
-- 33-34. Table inventory: exactly 3 policies, no DELETE, RLS enabled/not forced.
-- ============================================================================
do $$
declare
  v_names text[];
  v_rowsecurity boolean;
  v_forcerowsecurity boolean;
begin
  select array_agg(polname order by polname) into v_names
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  where c.relname = 'appointment_attendees';

  if v_names is distinct from array[
    'appointment_attendees_insert',
    'appointment_attendees_select',
    'appointment_attendees_update'
  ] then
    raise exception 'FAIL T-gc1-1-inventory: unexpected policy set (expected exactly 3): %', v_names;
  end if;

  select relrowsecurity, relforcerowsecurity into v_rowsecurity, v_forcerowsecurity
  from pg_class where oid = 'public.appointment_attendees'::regclass;

  if v_rowsecurity is distinct from true or v_forcerowsecurity is distinct from false then
    raise exception 'FAIL T-gc1-1-rls-state: RLS state wrong (rowsecurity=%, forcerowsecurity=%)', v_rowsecurity, v_forcerowsecurity;
  end if;

  raise notice 'PASS T-gc1-1-inventory: exactly 3 policies (select/insert/update), no delete policy, RLS enabled/not forced';
end $$;

-- ============================================================================
-- 35. Direct trigger-function execution denied for every client-facing role;
--     grant catalog confirms no PUBLIC/anon/authenticated grantee.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_grantee_count int;
begin
  select count(*) into v_grantee_count
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name = 'enforce_appointment_attendee_integrity'
    and grantee in ('PUBLIC', 'anon', 'authenticated');

  if v_grantee_count <> 0 then
    raise exception 'FAIL T-gc1-1-function-grants: found % unexpected grantee(s) among PUBLIC/anon/authenticated', v_grantee_count;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000008b0001')::text, true);

  v_errored := false;
  begin
    perform public.enforce_appointment_attendee_integrity();
    -- If this line is reached, the call was not blocked by privilege.
  exception when insufficient_privilege then
    v_errored := true;
  when others then
    -- Any other error (e.g. a trigger-context error) still does not prove
    -- the privilege barrier held -- only insufficient_privilege does.
    null;
  end;
  reset role;

  if not v_errored then
    raise exception 'FAIL T-gc1-1-direct-call-denied: authenticated role was not blocked by insufficient_privilege when calling the trigger function directly';
  end if;

  raise notice 'PASS T-gc1-1-function-privileges: no PUBLIC/anon/authenticated grant exists, and direct invocation as authenticated is blocked by insufficient_privilege';
end $$;

rollback;
