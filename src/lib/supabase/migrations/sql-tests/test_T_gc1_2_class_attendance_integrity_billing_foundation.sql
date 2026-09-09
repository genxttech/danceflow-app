-- GC-1.2 -- class attendance integrity + billing foundation live-Postgres
-- regression suite.
--
-- Proves, at the real Postgres level, that the shared eligibility predicate,
-- the class attendance-integrity trigger, the class package-billing
-- trigger, the legacy lesson/appointment billing guard, and both new/
-- widened unique indexes all behave exactly as designed. Entire script runs
-- in one transaction and is rolled back at the end -- nothing persists. Run
-- via `supabase db query --linked --file <this file>` against DEV, AFTER
-- all three GC-1.2 forward migrations have been applied.
--
-- Deterministic UUID block reserved for this harness (distinct from every
-- prior harness's 6a-6e/7a-7e/8a-9c block; using only 0-9a-f):
-- 00000000-0000-0000-0000-00000000baXXX (studios)
-- 00000000-0000-0000-0000-00000000bbXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-00000000bcXXX (instructors)
-- 00000000-0000-0000-0000-00000000bdXXX (clients)
-- 00000000-0000-0000-0000-00000000beXXX (appointments)
-- 00000000-0000-0000-0000-00000000bfXXX (appointment_attendees)
-- 00000000-0000-0000-0000-00000000c0XXX (client_packages)
-- 00000000-0000-0000-0000-00000000c1XXX (client_package_items)
-- 00000000-0000-0000-0000-00000000c2XXX (attendance_records, where explicit ids are needed)
-- 00000000-0000-0000-0000-00000000d0XXX (membership_plans)
-- 00000000-0000-0000-0000-00000000d1XXX (client_memberships)

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00000000ba01', 'GC-1.2 Harness Studio A', 't-gc1-2-studio-a'),
  ('00000000-0000-0000-0000-00000000ba02', 'GC-1.2 Harness Studio B', 't-gc1-2-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000bb01', 't-gc1-2-owner@example.test'),
  ('00000000-0000-0000-0000-00000000bb02', 't-gc1-2-admin@example.test'),
  ('00000000-0000-0000-0000-00000000bb03', 't-gc1-2-frontdesk@example.test'),
  ('00000000-0000-0000-0000-00000000bb04', 't-gc1-2-instructor-a@example.test'),
  ('00000000-0000-0000-0000-00000000bb05', 't-gc1-2-instructor-b@example.test'),
  ('00000000-0000-0000-0000-00000000bb06', 't-gc1-2-hybrid@example.test'),
  ('00000000-0000-0000-0000-00000000bb07', 't-gc1-2-indepinstructor@example.test'),
  ('00000000-0000-0000-0000-00000000bb08', 't-gc1-2-portalself@example.test'),
  ('00000000-0000-0000-0000-00000000bb09', 't-gc1-2-portalother@example.test'),
  ('00000000-0000-0000-0000-00000000bb10', 't-gc1-2-platformadmin@example.test'),
  ('00000000-0000-0000-0000-00000000bb11', 't-gc1-2-crossstudio@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-00000000bb01', 't-gc1-2-owner@example.test', null),
  ('00000000-0000-0000-0000-00000000bb02', 't-gc1-2-admin@example.test', null),
  ('00000000-0000-0000-0000-00000000bb03', 't-gc1-2-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-00000000bb04', 't-gc1-2-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-00000000bb05', 't-gc1-2-instructor-b@example.test', null),
  ('00000000-0000-0000-0000-00000000bb06', 't-gc1-2-hybrid@example.test', null),
  ('00000000-0000-0000-0000-00000000bb07', 't-gc1-2-indepinstructor@example.test', null),
  ('00000000-0000-0000-0000-00000000bb08', 't-gc1-2-portalself@example.test', null),
  ('00000000-0000-0000-0000-00000000bb09', 't-gc1-2-portalother@example.test', null),
  ('00000000-0000-0000-0000-00000000bb10', 't-gc1-2-platformadmin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-00000000bb11', 't-gc1-2-crossstudio@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000ba01', 'studio_owner', true),
  ('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-00000000ba01', 'studio_admin', true),
  ('00000000-0000-0000-0000-00000000bb03', '00000000-0000-0000-0000-00000000ba01', 'front_desk', true),
  ('00000000-0000-0000-0000-00000000bb04', '00000000-0000-0000-0000-00000000ba01', 'instructor', true),
  ('00000000-0000-0000-0000-00000000bb05', '00000000-0000-0000-0000-00000000ba01', 'instructor', true),
  ('00000000-0000-0000-0000-00000000bb06', '00000000-0000-0000-0000-00000000ba01', 'instructor', true),
  ('00000000-0000-0000-0000-00000000bb07', '00000000-0000-0000-0000-00000000ba01', 'independent_instructor', true),
  ('00000000-0000-0000-0000-00000000bb11', '00000000-0000-0000-0000-00000000ba02', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-00000000bc01', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bb04', 'Instructor', 'A', true),
  ('00000000-0000-0000-0000-00000000bc02', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bb05', 'Instructor', 'B', true),
  ('00000000-0000-0000-0000-00000000bc03', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bb06', 'Hybrid', 'Teacher', true),
  ('00000000-0000-0000-0000-00000000bc04', '00000000-0000-0000-0000-00000000ba02', '00000000-0000-0000-0000-00000000bb11', 'CrossStudio', 'Instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor) values
  ('00000000-0000-0000-0000-00000000bd01', '00000000-0000-0000-0000-00000000ba01', 'Valid', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-00000000bd02', '00000000-0000-0000-0000-00000000ba01', 'CancelledBefore', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-00000000bd03', '00000000-0000-0000-0000-00000000ba01', 'CancelledAfter', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-00000000bd04', '00000000-0000-0000-0000-00000000ba01', 'NonEnrolled', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-00000000bd05', '00000000-0000-0000-0000-00000000ba02', 'CrossStudio', 'Client', 'active', false),
  ('00000000-0000-0000-0000-00000000bd06', '00000000-0000-0000-0000-00000000ba01', 'Portal', 'Self', 'active', false),
  ('00000000-0000-0000-0000-00000000bd07', '00000000-0000-0000-0000-00000000ba01', 'Portal', 'Other', 'active', false),
  ('00000000-0000-0000-0000-00000000bd08', '00000000-0000-0000-0000-00000000ba01', 'Package', 'One', 'active', false),
  ('00000000-0000-0000-0000-00000000bd09', '00000000-0000-0000-0000-00000000ba01', 'Package', 'Two', 'active', false),
  ('00000000-0000-0000-0000-00000000bd0a', '00000000-0000-0000-0000-00000000ba01', 'Membership', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-00000000bd0b', '00000000-0000-0000-0000-00000000ba01', 'Payg', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-00000000bd0c', '00000000-0000-0000-0000-00000000ba01', 'Free', 'Attendee', 'active', false),
  ('00000000-0000-0000-0000-00000000bd0d', '00000000-0000-0000-0000-00000000ba01', 'Rebook', 'Attendee', 'active', false);

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, initiated_by) values
  ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bd06', '00000000-0000-0000-0000-00000000bb08', 'linked', 'self', 'studio'),
  ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bd07', '00000000-0000-0000-0000-00000000bb09', 'linked', 'self', 'studio');

insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000ba01', null, '00000000-0000-0000-0000-00000000bc01', 'group_class', 'scheduled', '2026-09-01T10:00:00+00', '2026-09-01T11:00:00+00'),
  ('00000000-0000-0000-0000-00000000be02', '00000000-0000-0000-0000-00000000ba02', null, '00000000-0000-0000-0000-00000000bc04', 'group_class', 'scheduled', '2026-09-01T10:00:00+00', '2026-09-01T11:00:00+00'),
  ('00000000-0000-0000-0000-00000000be03', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bd01', '00000000-0000-0000-0000-00000000bc01', 'private_lesson', 'scheduled', '2026-09-01T12:00:00+00', '2026-09-01T13:00:00+00'),
  ('00000000-0000-0000-0000-00000000be04', '00000000-0000-0000-0000-00000000ba01', null, '00000000-0000-0000-0000-00000000bc03', 'group_class', 'scheduled', '2026-09-01T14:00:00+00', '2026-09-01T15:00:00+00'),
  ('00000000-0000-0000-0000-00000000be05', '00000000-0000-0000-0000-00000000ba01', null, '00000000-0000-0000-0000-00000000bc02', 'group_class', 'scheduled', '2026-09-01T16:00:00+00', '2026-09-01T17:00:00+00');

-- Aliases:
-- CLASS_A       = ...be01  Instructor A's main test class (studio A)
-- CLASS_CROSS   = ...be02  Studio B class
-- PRIVATE_A     = ...be03  Instructor A's private lesson, single-client model (client bd01)
-- CLASS_HYBRID  = ...be04  Hybrid's own class
-- CLASS_B       = ...be05  Instructor B's class (colleague, for unassigned-instructor test)

insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, cancelled_at) values
  ('00000000-0000-0000-0000-00000000bf01', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd01', 'booked', 'staff', null),
  ('00000000-0000-0000-0000-00000000bf02', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd02', 'cancelled', 'staff', '2026-08-25T00:00:00+00'),
  ('00000000-0000-0000-0000-00000000bf03', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd03', 'cancelled', 'staff', '2026-09-02T00:00:00+00'),
  ('00000000-0000-0000-0000-00000000bf07', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0b', 'booked', 'staff', null),
  ('00000000-0000-0000-0000-00000000bf08', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0c', 'booked', 'staff', null),
  ('00000000-0000-0000-0000-00000000bf09', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd06', 'booked', 'staff', null),
  ('00000000-0000-0000-0000-00000000bf0a', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd07', 'booked', 'staff', null),
  ('00000000-0000-0000-0000-00000000bf0b', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0d', 'cancelled', 'staff', '2026-08-20T00:00:00+00'),
  ('00000000-0000-0000-0000-00000000bf0d', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be04', '00000000-0000-0000-0000-00000000bd01', 'booked', 'staff', null),
  ('00000000-0000-0000-0000-00000000bf0e', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be05', '00000000-0000-0000-0000-00000000bd01', 'booked', 'staff', null);

-- bd08/bd09 (package attendees) get their appointment_attendees rows inserted just before their
-- test blocks below, once client_package_id is known.

insert into public.membership_plans (id, studio_id, name) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000ba01', 'GC-1.2 Test Plan');

insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, starts_on, current_period_start, current_period_end,
  auto_renew, cancel_at_period_end, name_snapshot, price_snapshot, billing_interval_snapshot
) values
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bd0a', '00000000-0000-0000-0000-00000000d001', 'active', current_date, current_date, current_date + 30, false, false, 'GC-1.2 Membership', 0, 'monthly');

insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type, client_membership_id) values
  ('00000000-0000-0000-0000-00000000bf0c', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0a', 'booked', 'staff', 'membership', '00000000-0000-0000-0000-00000000d101')
on conflict (id) do update set billing_type = excluded.billing_type, client_membership_id = excluded.client_membership_id;

update public.appointment_attendees set billing_type = 'pay_as_you_go' where id = '00000000-0000-0000-0000-00000000bf07';
update public.appointment_attendees set billing_type = 'free_comped' where id = '00000000-0000-0000-0000-00000000bf08';

-- Packages: bd01 (private-lesson package, for legacy-billing regression), bd08, bd09 (class package attendees).
insert into public.client_packages (id, studio_id, client_id, name_snapshot, purchase_date, is_shareable, active) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bd01', 'Private Lesson Package', current_date, false, true),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bd08', 'Class Package One', current_date, false, true),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000bd09', 'Class Package Two', current_date, false, true);

insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000c001', 'private_lesson', 2, 0, 2, false),
  ('00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000c002', 'group_class', 3, 0, 3, false),
  ('00000000-0000-0000-0000-00000000c103', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000c003', 'group_class', 5, 0, 5, false);

update public.appointments set client_package_id = '00000000-0000-0000-0000-00000000c001', billing_type = 'package_credit'
  where id = '00000000-0000-0000-0000-00000000be03';

insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source, billing_type, client_package_id) values
  ('00000000-0000-0000-0000-00000000bf04', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd08', 'booked', 'staff', 'package_credit', '00000000-0000-0000-0000-00000000c002'),
  ('00000000-0000-0000-0000-00000000bf05', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd09', 'booked', 'staff', 'package_credit', '00000000-0000-0000-0000-00000000c003');

-- ============================================================================
-- 1-2. Valid enrolled attendee attendance succeeds; non-enrolled client rejected.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd01', 'attended');

  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-00000000c201'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-2-valid-attendee: valid enrolled attendee attendance was not recorded'; end if;

  v_errored := false;
  begin
    insert into public.attendance_records (studio_id, appointment_id, client_id, status)
    values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd04', 'attended');
  exception when others then
    v_errored := true;
    if sqlerrm is distinct from 'Invalid class attendance record.' then
      raise exception 'FAIL T-gc1-2-nonenrolled-msg: got %', sqlerrm;
    end if;
  end;
  if not v_errored then raise exception 'FAIL T-gc1-2-nonenrolled: non-enrolled client attendance was not rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-2-valid-nonenrolled: valid attendee succeeds, non-enrolled client rejected with uniform message';
end $$;

-- ============================================================================
-- 3. Cross-studio rejected.
-- ============================================================================
do $$
declare
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  v_errored := false;
  begin
    insert into public.attendance_records (studio_id, appointment_id, client_id, status)
    values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd05', 'attended');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-2-crossstudio: cross-studio client attendance was not rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-2-crossstudio: cross-studio client attendance rejected';
end $$;

-- ============================================================================
-- 4-5. Cancelled before class start rejected; cancelled after class start accepted.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  v_errored := false;
  begin
    insert into public.attendance_records (studio_id, appointment_id, client_id, status)
    values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd02', 'attended');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-2-cancelled-before: enrollment cancelled before class start was not rejected'; end if;

  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd03', 'attended');

  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-2-cancelled-after: enrollment cancelled after class start was rejected, should have been accepted'; end if;

  reset role;
  raise notice 'PASS T-gc1-2-cancellation-timing: cancelled-before rejected, cancelled-after accepted';
end $$;

-- ============================================================================
-- 6-8. no_show -> attended; registered -> attended; attended -> no_show.
-- ============================================================================
do $$
declare
  v_status text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  update public.attendance_records set status = 'no_show' where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  update public.attendance_records set status = 'attended' where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  select status into v_status from public.attendance_records where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  if v_status is distinct from 'attended' then raise exception 'FAIL T-gc1-2-noshow-to-attended: transition did not persist'; end if;

  update public.attendance_records set status = 'registered' where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  update public.attendance_records set status = 'attended' where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  select status into v_status from public.attendance_records where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  if v_status is distinct from 'attended' then raise exception 'FAIL T-gc1-2-registered-to-attended: transition did not persist'; end if;

  update public.attendance_records set status = 'no_show' where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  select status into v_status from public.attendance_records where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  if v_status is distinct from 'no_show' then raise exception 'FAIL T-gc1-2-attended-to-noshow: transition did not persist'; end if;

  reset role;
  raise notice 'PASS T-gc1-2-status-transitions: no_show<->attended and registered->attended all succeed for a legitimately (post-class-cancelled) enrolled attendee';
end $$;

-- ============================================================================
-- 9. Notes/update after valid post-class cancellation.
-- ============================================================================
do $$
declare
  v_notes text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  update public.attendance_records set notes = 'corrected after cancellation' where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  select notes into v_notes from public.attendance_records where id = '00000000-0000-0000-0000-00000000c202'::uuid;
  if v_notes is distinct from 'corrected after cancellation' then raise exception 'FAIL T-gc1-2-note-edit: note-only update after legitimate post-class cancellation was rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-2-note-edit: note-only correction after a legitimate (cancelled-after-start) enrollment succeeds';
end $$;

-- ============================================================================
-- 10. Rebook after cancellation.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  -- Before rebooking: attendance for the cancelled-before-class-start enrollee is rejected.
  v_errored := false;
  begin
    insert into public.attendance_records (studio_id, appointment_id, client_id, status)
    values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0d', 'attended');
  exception when others then v_errored := true; end;
  if not v_errored then raise exception 'FAIL T-gc1-2-rebook-precondition: pre-rebooking attendance for a cancelled enrollee was not rejected'; end if;

  -- Rebook: a fresh 'booked' appointment_attendees row for the same (appointment, client).
  insert into public.appointment_attendees (id, studio_id, appointment_id, client_id, status, source)
  values ('00000000-0000-0000-0000-00000000bf0f', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0d', 'booked', 'staff');

  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c203', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0d', 'attended');

  select count(*) into v_count from public.attendance_records where id = '00000000-0000-0000-0000-00000000c203'::uuid;
  if v_count <> 1 then raise exception 'FAIL T-gc1-2-rebook: attendance after rebooking was rejected'; end if;

  reset role;
  raise notice 'PASS T-gc1-2-rebook: attendance correctly denied before rebooking, accepted after';
end $$;

-- ============================================================================
-- 11-12. Package deduction exactly once; repeated attended save no double deduction.
-- ============================================================================
do $$
declare
  v_count int;
  v_remaining numeric;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c204', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd08', 'attended');

  select count(*) into v_count from public.lesson_transactions
    where appointment_id = '00000000-0000-0000-0000-00000000be01'::uuid
      and client_id = '00000000-0000-0000-0000-00000000bd08'::uuid
      and transaction_type::text = 'lesson_deduction';
  if v_count <> 1 then raise exception 'FAIL T-gc1-2-package-deduct: expected exactly 1 lesson_transactions row, got %', v_count; end if;

  select quantity_remaining into v_remaining from public.client_package_items where id = '00000000-0000-0000-0000-00000000c102'::uuid;
  if v_remaining <> 2 then raise exception 'FAIL T-gc1-2-package-deduct-balance: expected quantity_remaining=2, got %', v_remaining; end if;

  -- Repeated save: no_show then back to attended (a genuine re-transition) must still not
  -- double-deduct, since the lesson_transactions idempotency check already found a prior row.
  update public.attendance_records set status = 'no_show' where id = '00000000-0000-0000-0000-00000000c204'::uuid;
  update public.attendance_records set status = 'attended' where id = '00000000-0000-0000-0000-00000000c204'::uuid;

  select count(*) into v_count from public.lesson_transactions
    where appointment_id = '00000000-0000-0000-0000-00000000be01'::uuid
      and client_id = '00000000-0000-0000-0000-00000000bd08'::uuid
      and transaction_type::text = 'lesson_deduction';
  if v_count <> 1 then raise exception 'FAIL T-gc1-2-no-double-deduct: expected still exactly 1 lesson_transactions row after re-transition, got %', v_count; end if;

  select quantity_remaining into v_remaining from public.client_package_items where id = '00000000-0000-0000-0000-00000000c102'::uuid;
  if v_remaining <> 2 then raise exception 'FAIL T-gc1-2-no-double-deduct-balance: expected quantity_remaining still 2, got %', v_remaining; end if;

  reset role;
  raise notice 'PASS T-gc1-2-package-deduction: exactly one deduction, no double-deduction on repeated attended transitions';
end $$;

-- ============================================================================
-- 13. Two students on the same class each deduct their own package exactly once.
-- ============================================================================
do $$
declare
  v_count numeric;
  v_remaining_1 numeric;
  v_remaining_2 numeric;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c205', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd09', 'attended');

  select quantity_remaining into v_remaining_1 from public.client_package_items where id = '00000000-0000-0000-0000-00000000c102'::uuid; -- bd08's package
  select quantity_remaining into v_remaining_2 from public.client_package_items where id = '00000000-0000-0000-0000-00000000c103'::uuid; -- bd09's package

  if v_remaining_1 <> 2 then raise exception 'FAIL T-gc1-2-multistudent-1: bd08 package balance changed unexpectedly, got %', v_remaining_1; end if;
  if v_remaining_2 <> 4 then raise exception 'FAIL T-gc1-2-multistudent-2: bd09 package balance wrong, expected 4 got %', v_remaining_2; end if;

  select count(*) into v_count from public.lesson_transactions
    where appointment_id = '00000000-0000-0000-0000-00000000be01'::uuid and transaction_type::text = 'lesson_deduction';
  if v_count <> 2 then raise exception 'FAIL T-gc1-2-multistudent-count: expected exactly 2 deduction rows for the shared class so far, got %', v_count; end if;

  reset role;
  raise notice 'PASS T-gc1-2-multistudent: two attendees on the same shared class each deduct their own distinct package exactly once';
end $$;

-- ============================================================================
-- 14-16. Membership attendee: no deduction. PAYG attendee: no deduction/payment.
--        Free/comped attendee: no deduction.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c206', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0a', 'attended');
  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c207', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0b', 'attended');
  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c208', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd0c', 'attended');

  select count(*) into v_count from public.lesson_transactions
    where appointment_id = '00000000-0000-0000-0000-00000000be01'::uuid
      and client_id in ('00000000-0000-0000-0000-00000000bd0a'::uuid, '00000000-0000-0000-0000-00000000bd0b'::uuid, '00000000-0000-0000-0000-00000000bd0c'::uuid);
  if v_count <> 0 then raise exception 'FAIL T-gc1-2-nonpackage-billing: membership/PAYG/free_comped attendees produced % unexpected deduction rows', v_count; end if;

  select count(*) into v_count from public.payments where appointment_id = '00000000-0000-0000-0000-00000000be01'::uuid;
  if v_count <> 0 then raise exception 'FAIL T-gc1-2-payg-no-payment: PAYG class attendance created a payment row unexpectedly'; end if;

  reset role;
  raise notice 'PASS T-gc1-2-nonpackage-billing: membership/PAYG/free_comped class attendees validate enrollment only, zero deduction or payment side effects';
end $$;

-- ============================================================================
-- 17. Private lesson billing unchanged (legacy path still fires normally).
-- ============================================================================
do $$
declare
  v_count int;
  v_remaining numeric;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  update public.appointments set status = 'attended' where id = '00000000-0000-0000-0000-00000000be03'::uuid;

  select count(*) into v_count from public.lesson_transactions
    where appointment_id = '00000000-0000-0000-0000-00000000be03'::uuid and transaction_type::text = 'lesson_deduction';
  if v_count <> 1 then raise exception 'FAIL T-gc1-2-private-lesson-unchanged: expected exactly 1 legacy deduction row, got %', v_count; end if;

  select quantity_remaining into v_remaining from public.client_package_items where id = '00000000-0000-0000-0000-00000000c101'::uuid;
  if v_remaining <> 1 then raise exception 'FAIL T-gc1-2-private-lesson-balance: expected quantity_remaining=1, got %', v_remaining; end if;

  reset role;
  raise notice 'PASS T-gc1-2-private-lesson-unchanged: legacy lesson/appointment billing trigger fires normally and correctly for a private lesson';
end $$;

-- ============================================================================
-- 18. Event branch unaffected -- structural proof via deployed source, since
--     the new triggers' first check for both is appointment_id IS NULL /
--     IS NOT NULL, never reaching any group_class logic for event-linked rows.
-- ============================================================================
do $$
declare
  v_eligibility_src text;
  v_billing_trigger_when text;
begin
  select pg_get_functiondef(oid) into v_eligibility_src
    from pg_proc where proname = 'enforce_class_attendance_eligibility';
  if v_eligibility_src not ilike '%if new.appointment_id is null then%return new%' then
    raise exception 'FAIL T-gc1-2-event-isolation-eligibility: eligibility trigger function does not exempt appointment_id IS NULL as its first check';
  end if;

  select pg_get_triggerdef(oid) into v_billing_trigger_when
    from pg_trigger
    where tgname = 'attendance_records_deduct_package_credit_for_class'
      and tgrelid = 'public.attendance_records'::regclass;
  if v_billing_trigger_when not ilike '%new.appointment_id IS NOT NULL%' then
    raise exception 'FAIL T-gc1-2-event-isolation-billing: billing trigger WHEN clause does not require appointment_id IS NOT NULL';
  end if;

  raise notice 'PASS T-gc1-2-event-isolation: both new triggers structurally exempt event-linked (appointment_id IS NULL) rows before any group_class logic is reached';
end $$;

-- ============================================================================
-- 19-22. RLS personas, unchanged: assigned instructor, unassigned instructor,
--        broad roles, floor-rental-only, hybrid, portal (no attendance_records
--        visibility at all -- unchanged from D2c-0B).
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_count int;
begin
  -- Assigned instructor (A) can write attendance for their own class, for an enrolled client.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb04')::text, true);
  insert into public.attendance_records (id, studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000c209', '00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd01', 'checked_in')
  on conflict do nothing;
  reset role;

  -- Unassigned instructor: Instructor A cannot write attendance for Instructor B's class,
  -- even for a legitimately enrolled attendee there (RLS denial, unchanged).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb04')::text, true);
  v_errored := false;
  begin
    insert into public.attendance_records (studio_id, appointment_id, client_id, status)
    values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be05', '00000000-0000-0000-0000-00000000bd01', 'attended');
  exception when others then v_errored := true; end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-2-unassigned-instructor: instructor A was able to write attendance for colleague''s class'; end if;

  -- Broad role (front_desk) can write attendance for any class at the studio.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb03')::text, true);
  insert into public.attendance_records (studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be05', '00000000-0000-0000-0000-00000000bd01', 'attended');
  reset role;

  -- Floor-rental-only / independent instructor: cannot write attendance at all.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb07')::text, true);
  v_errored := false;
  begin
    insert into public.attendance_records (studio_id, appointment_id, client_id, status)
    values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd01', 'attended');
  exception when others then v_errored := true; end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-2-floor-rental-only: independent instructor was able to write class attendance'; end if;

  -- Hybrid: can write attendance for their own assigned class.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb06')::text, true);
  insert into public.attendance_records (studio_id, appointment_id, client_id, status)
  values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be04', '00000000-0000-0000-0000-00000000bd01', 'checked_in');
  reset role;

  -- Hybrid: cannot write attendance for a colleague's class.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb06')::text, true);
  v_errored := false;
  begin
    insert into public.attendance_records (studio_id, appointment_id, client_id, status)
    values ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-00000000be01', '00000000-0000-0000-0000-00000000bd01', 'attended');
  exception when others then v_errored := true; end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-2-hybrid-colleague: hybrid was able to write attendance for a colleague''s class'; end if;

  -- Portal: zero attendance_records visibility at all (unchanged from D2c-0B -- attendance_records
  -- was never portal-exposed, unlike appointment_attendees).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb08')::text, true);
  select count(*) into v_count from public.attendance_records where appointment_id = '00000000-0000-0000-0000-00000000be01'::uuid;
  reset role;
  if v_count <> 0 then raise exception 'FAIL T-gc1-2-portal-visibility: portal client unexpectedly saw % attendance_records rows', v_count; end if;

  raise notice 'PASS T-gc1-2-rls-personas: assigned instructor and broad roles succeed, unassigned instructor/floor-rental-only/hybrid-colleague denied, portal has zero visibility -- all unchanged from D2c-0B';
end $$;

-- ============================================================================
-- 23. Direct execution privileges denied for the three new functions.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_grantee_count int;
begin
  select count(*) into v_grantee_count
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name in ('class_enrollment_covers_participation', 'enforce_class_attendance_eligibility', 'deduct_package_credit_for_class_attendee')
    and grantee in ('PUBLIC', 'anon', 'authenticated');
  if v_grantee_count <> 0 then
    raise exception 'FAIL T-gc1-2-function-grants: found % unexpected grantee(s) among the three new functions', v_grantee_count;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bb01')::text, true);

  v_errored := false;
  begin
    perform public.class_enrollment_covers_participation('00000000-0000-0000-0000-00000000be01'::uuid, '00000000-0000-0000-0000-00000000bd01'::uuid, '00000000-0000-0000-0000-00000000ba01'::uuid);
  exception when insufficient_privilege then v_errored := true;
  when others then null;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-gc1-2-direct-call-denied: authenticated role was not blocked by insufficient_privilege calling the shared predicate directly'; end if;

  raise notice 'PASS T-gc1-2-function-privileges: no PUBLIC/anon/authenticated grant exists on any of the three new functions, direct invocation as authenticated is blocked';
end $$;

-- ============================================================================
-- 24. Index definitions: both new/widened indexes exist and are valid.
-- ============================================================================
do $$
declare
  v_lesson_idx_valid boolean;
  v_membership_idx_valid boolean;
  v_membership_idx_def text;
begin
  select indisvalid into v_lesson_idx_valid
    from pg_index where indexrelid = 'public.uq_lesson_transactions_appointment_client_deduction'::regclass;
  if v_lesson_idx_valid is distinct from true then
    raise exception 'FAIL T-gc1-2-lesson-index: uq_lesson_transactions_appointment_client_deduction missing or invalid';
  end if;

  select indisvalid into v_membership_idx_valid
    from pg_index where indexrelid = 'public.client_membership_usage_appointment_unique_idx'::regclass;
  if v_membership_idx_valid is distinct from true then
    raise exception 'FAIL T-gc1-2-membership-index: client_membership_usage_appointment_unique_idx missing or invalid';
  end if;

  select indexdef into v_membership_idx_def from pg_indexes
    where schemaname='public' and indexname='client_membership_usage_appointment_unique_idx';
  if v_membership_idx_def not ilike '%client_membership_id%' then
    raise exception 'FAIL T-gc1-2-membership-index-widened: canonical index name does not carry the widened (reference_type, reference_id, client_membership_id) key';
  end if;

  raise notice 'PASS T-gc1-2-indexes: both new/widened unique indexes exist, are valid, and the membership index carries the widened key under its canonical name';
end $$;

rollback;
