-- FC-1B5D Phase A -- get_teaching_clients_for_instructor /
-- search_bookable_clients_for_instructor live-RLS/RPC regression tests.
--
-- Proves, at the real Postgres level (not mocked):
--   1. the teaching RPC's qualifying predicate (current/future by
--      effective_end_at, historical attended within a strict 14-day
--      window anchored to effective_end_at, no_show/cancelled never
--      qualify, stale-but-still-"scheduled" rows do not grant indefinite
--      access);
--   2. cross-instructor and cross-studio isolation, and that no parameter
--      exists to request another instructor's identity;
--   3. duplicate qualifying appointments do not duplicate a client row;
--   4. the booking-search RPC's hardening (blank/short query rejected,
--      wildcard characters treated literally, hard result cap, stable
--      ordering, archived clients excluded, cross-studio denied);
--   5. hybrid/independent-instructor structural non-interference (a floor
--      rental appointment can never satisfy any instructor's teaching
--      predicate; a hybrid instructor sees only their host-assigned
--      teaching client, never their own floor-rental "client" identity,
--      never an unrelated instructor's roster).
--
--   6. caller conditions: an active instructors row with can_instruct, plus
--      an active studio_owner / studio_admin / front_desk / instructor role in
--      the requested studio; every other combination returns no rows.
--
-- The booking-search cases (companion migration 20260905160100) run only when
-- that function is installed; otherwise each prints SKIP.
--
-- Fixtures are inserted by the privileged session and satisfy the current
-- database rules (studio plan and instructor seats, instructor capability, the
-- shared group class shape). No trigger or row level security is switched off.
-- Every function call is made under the authenticated or anon role with JWT
-- claims.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists. Run with `psql -v ON_ERROR_STOP=1 -f <this file>` against a
-- disposable database, or `supabase db query --linked --file <this file>`
-- against DEV.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000005dXXXX.

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================

-- An active plan with instructor seats (the owner never counts against them).
insert into public.studios (id, name, slug, subscription_status, billing_plan) values
  ('00000000-0000-0000-0000-0000005d0001', 'FC-1B5D Harness Studio A', 't-fc1b5d-studio-a', 'active', 'pro'),
  ('00000000-0000-0000-0000-0000005d0002', 'FC-1B5D Harness Studio B', 't-fc1b5d-studio-b', 'active', 'pro');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000005d1001', 't-fc1b5d-instructor-a1@example.test'),
  ('00000000-0000-0000-0000-0000005d1002', 't-fc1b5d-instructor-a2@example.test');

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000005d1001', 't-fc1b5d-instructor-a1@example.test'),
  ('00000000-0000-0000-0000-0000005d1002', 't-fc1b5d-instructor-a2@example.test');

-- Both instructors also hold an active instructor role at Studio A: the teaching
-- RPC needs the instructors row (identity from `instructors.user_id`, capability)
-- and an allowed studio role.
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000005d1001', '00000000-0000-0000-0000-0000005d0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000005d1002', '00000000-0000-0000-0000-0000005d0001', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-0000005d2001', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1001', 'InstructorA1', 'Test', true, true),
  ('00000000-0000-0000-0000-0000005d2002', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1002', 'InstructorA2', 'Test', true, true);

insert into public.clients (
  id, studio_id, first_name, last_name, status, dance_goals, skill_level, photo_url,
  is_independent_instructor
) values
  ('00000000-0000-0000-0000-0000005d3001', '00000000-0000-0000-0000-0000005d0001', 'FutureAssigned', 'ClientOne', 'active', array['improve technique'], 'beginner', null, false),
  ('00000000-0000-0000-0000-0000005d3002', '00000000-0000-0000-0000-0000005d0001', 'Unrelated', 'ClientTwo', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3003', '00000000-0000-0000-0000-0000005d0001', 'Attended13DaysAgo', 'ClientThree', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3004', '00000000-0000-0000-0000-0000005d0001', 'AttendedExactly14Days', 'ClientFour', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3005', '00000000-0000-0000-0000-0000005d0001', 'AttendedOlderThan14', 'ClientFive', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3006', '00000000-0000-0000-0000-0000005d0001', 'NoShowOnly', 'ClientSix', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3007', '00000000-0000-0000-0000-0000005d0001', 'NoShowPlusFuture', 'ClientSeven', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3008', '00000000-0000-0000-0000-0000005d0001', 'CancelledOnly', 'ClientEight', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3009', '00000000-0000-0000-0000-0000005d0001', 'StaleScheduled', 'ClientNine', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3010', '00000000-0000-0000-0000-0000005d0001', 'GroupClass', 'ClientTen', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3011', '00000000-0000-0000-0000-0000005d0001', 'Substituted', 'ClientEleven', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3012', '00000000-0000-0000-0000-0000005d0001', 'DuplicateQualifying', 'ClientTwelve', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3013', '00000000-0000-0000-0000-0000005d0001', 'Abc', 'Wildcardtest', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3014', '00000000-0000-0000-0000-0000005d0001', 'ArchivedSearch', 'ClientFourteen', 'archived', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3015', '00000000-0000-0000-0000-0000005d0001', 'BelongsToA2', 'ClientFifteen', 'active', null, null, null, false),
  ('00000000-0000-0000-0000-0000005d3016', '00000000-0000-0000-0000-0000005d0001', 'A1OwnFloorRental', 'ClientSixteen', 'active', null, null, null, true);

-- ============================================================================
-- Appointments -- one row per scenario, all at Studio A unless noted.
-- effective_end_at = coalesce(ends_at, starts_at + duration_minutes).
-- All rows here set both starts_at/ends_at explicitly (duration_minutes
-- left null) so effective_end_at is simply ends_at.
-- ============================================================================

insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at
) values
  -- Case: assigned future appointment -> qualifies (current/future).
  ('00000000-0000-0000-0000-0000005d4001', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3001', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),

  -- Case: unrelated client -- appointment exists but for a DIFFERENT
  -- instructor (A2), must not appear in A1's results.
  ('00000000-0000-0000-0000-0000005d4002', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3002', '00000000-0000-0000-0000-0000005d2002', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),

  -- Case: attended 13 days ago (by end time) -> qualifies (< 14 days).
  ('00000000-0000-0000-0000-0000005d4003', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3003', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'attended', now() - interval '13 days 1 hour', now() - interval '13 days'),

  -- Case: attended exactly 14 days ago (by end time) -> must NOT qualify
  -- (strict > boundary).
  ('00000000-0000-0000-0000-0000005d4004', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3004', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'attended', now() - interval '14 days 1 hour', now() - interval '14 days'),

  -- Case: attended older than 14 days -> must NOT qualify.
  ('00000000-0000-0000-0000-0000005d4005', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3005', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'attended', now() - interval '20 days 1 hour', now() - interval '20 days'),

  -- Case: no_show alone (no future appointment) -> must NOT qualify.
  ('00000000-0000-0000-0000-0000005d4006', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3006', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'no_show', now() - interval '5 days 1 hour', now() - interval '5 days'),

  -- Case: no_show historical + a SEPARATE valid future appointment for the
  -- same client -> qualifies, but only because of the future one.
  ('00000000-0000-0000-0000-0000005d4007', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3007', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'no_show', now() - interval '5 days 1 hour', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000005d4008', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3007', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour'),

  -- Case: cancelled only -> must NOT qualify.
  ('00000000-0000-0000-0000-0000005d4009', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3008', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'cancelled', now() + interval '2 days', now() + interval '2 days 1 hour'),

  -- Case: stale "scheduled" appointment whose time has already passed --
  -- must NOT qualify (status alone is insufficient; this is the exact
  -- gap the effective_end_at design closes).
  ('00000000-0000-0000-0000-0000005d4010', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3009', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'scheduled', now() - interval '10 days 1 hour', now() - interval '10 days'),

  -- Case: substitute reassignment -- this row's instructor_id is CURRENTLY
  -- A1 (as if A1 covered/was reassigned this session); qualifies for A1,
  -- and by construction cannot also qualify for A2 (single instructor_id
  -- column, no history).
  ('00000000-0000-0000-0000-0000005d4012', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3011', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'attended', now() - interval '1 day 1 hour', now() - interval '1 day'),

  -- Case: duplicate qualifying appointments for the same client/instructor
  -- -- must appear exactly once in the result set, not twice.
  ('00000000-0000-0000-0000-0000005d4013', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3012', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d4014', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3012', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour'),

  -- Case: A2's own, unrelated client (used to prove A1 cannot see A2's
  -- roster, and vice versa).
  ('00000000-0000-0000-0000-0000005d4015', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3015', '00000000-0000-0000-0000-0000005d2002', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),

  -- Hybrid case: A1's OWN floor-rental appointment, booked against their
  -- own is_independent_instructor=true client identity. instructor_id is
  -- intentionally null (a floor rental has no teaching instructor -- the
  -- renter IS the instructor) -- proves this can never satisfy ANY
  -- instructor's teaching predicate regardless of who rents.
  ('00000000-0000-0000-0000-0000005d4016', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3016', null, 'floor_space_rental', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour');

-- ============================================================================
-- Caller-condition fixtures: one person per combination, each an instructor of
-- Studio A with one client of their own.
-- ============================================================================
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000005d1003', 't-fc1b5d-owner@example.test'),
  ('00000000-0000-0000-0000-0000005d1004', 't-fc1b5d-admin@example.test'),
  ('00000000-0000-0000-0000-0000005d1005', 't-fc1b5d-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000005d1012', 't-fc1b5d-instructor@example.test'),
  ('00000000-0000-0000-0000-0000005d1006', 't-fc1b5d-nocapability@example.test'),
  ('00000000-0000-0000-0000-0000005d1007', 't-fc1b5d-norole@example.test'),
  ('00000000-0000-0000-0000-0000005d1008', 't-fc1b5d-inactiverole@example.test'),
  ('00000000-0000-0000-0000-0000005d1009', 't-fc1b5d-independent@example.test'),
  ('00000000-0000-0000-0000-0000005d1010', 't-fc1b5d-otherstudio@example.test'),
  ('00000000-0000-0000-0000-0000005d1011', 't-fc1b5d-platformadmin@example.test'),
  ('00000000-0000-0000-0000-0000005d1013', 't-fc1b5d-inactiveinstructor@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000005d1003', 't-fc1b5d-owner@example.test', null),
  ('00000000-0000-0000-0000-0000005d1004', 't-fc1b5d-admin@example.test', null),
  ('00000000-0000-0000-0000-0000005d1005', 't-fc1b5d-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-0000005d1012', 't-fc1b5d-instructor@example.test', null),
  ('00000000-0000-0000-0000-0000005d1006', 't-fc1b5d-nocapability@example.test', null),
  ('00000000-0000-0000-0000-0000005d1007', 't-fc1b5d-norole@example.test', null),
  ('00000000-0000-0000-0000-0000005d1008', 't-fc1b5d-inactiverole@example.test', null),
  ('00000000-0000-0000-0000-0000005d1009', 't-fc1b5d-independent@example.test', null),
  ('00000000-0000-0000-0000-0000005d1010', 't-fc1b5d-otherstudio@example.test', null),
  ('00000000-0000-0000-0000-0000005d1011', 't-fc1b5d-platformadmin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-0000005d1013', 't-fc1b5d-inactiveinstructor@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000005d1003', '00000000-0000-0000-0000-0000005d0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000005d1004', '00000000-0000-0000-0000-0000005d0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000005d1005', '00000000-0000-0000-0000-0000005d0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000005d1012', '00000000-0000-0000-0000-0000005d0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000005d1006', '00000000-0000-0000-0000-0000005d0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000005d1008', '00000000-0000-0000-0000-0000005d0001', 'instructor', false),
  ('00000000-0000-0000-0000-0000005d1009', '00000000-0000-0000-0000-0000005d0001', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000005d1010', '00000000-0000-0000-0000-0000005d0002', 'instructor', true),
  ('00000000-0000-0000-0000-0000005d1013', '00000000-0000-0000-0000-0000005d0001', 'instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-0000005d2003', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1003', 'Caller', 'owner', true, true),
  ('00000000-0000-0000-0000-0000005d2004', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1004', 'Caller', 'admin', true, true),
  ('00000000-0000-0000-0000-0000005d2005', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1005', 'Caller', 'frontdesk', true, true),
  ('00000000-0000-0000-0000-0000005d2012', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1012', 'Caller', 'instructor', true, true),
  ('00000000-0000-0000-0000-0000005d2006', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1006', 'Caller', 'nocapability', true, true),
  ('00000000-0000-0000-0000-0000005d2007', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1007', 'Caller', 'norole', true, true),
  ('00000000-0000-0000-0000-0000005d2008', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1008', 'Caller', 'inactiverole', true, true),
  ('00000000-0000-0000-0000-0000005d2009', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1009', 'Caller', 'independent', true, true),
  ('00000000-0000-0000-0000-0000005d2010', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1010', 'Caller', 'otherstudio', true, true),
  ('00000000-0000-0000-0000-0000005d2011', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1011', 'Caller', 'platformadmin', true, true),
  ('00000000-0000-0000-0000-0000005d2013', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d1013', 'Caller', 'inactiveinstructor', true, true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-0000005d6003', '00000000-0000-0000-0000-0000005d0001', 'Own', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000005d6004', '00000000-0000-0000-0000-0000005d0001', 'Own', 'admin', 'active'),
  ('00000000-0000-0000-0000-0000005d6005', '00000000-0000-0000-0000-0000005d0001', 'Own', 'frontdesk', 'active'),
  ('00000000-0000-0000-0000-0000005d6012', '00000000-0000-0000-0000-0000005d0001', 'Own', 'instructor', 'active'),
  ('00000000-0000-0000-0000-0000005d6006', '00000000-0000-0000-0000-0000005d0001', 'Own', 'nocapability', 'active'),
  ('00000000-0000-0000-0000-0000005d6007', '00000000-0000-0000-0000-0000005d0001', 'Own', 'norole', 'active'),
  ('00000000-0000-0000-0000-0000005d6008', '00000000-0000-0000-0000-0000005d0001', 'Own', 'inactiverole', 'active'),
  ('00000000-0000-0000-0000-0000005d6009', '00000000-0000-0000-0000-0000005d0001', 'Own', 'independent', 'active'),
  ('00000000-0000-0000-0000-0000005d6010', '00000000-0000-0000-0000-0000005d0001', 'Own', 'otherstudio', 'active'),
  ('00000000-0000-0000-0000-0000005d6011', '00000000-0000-0000-0000-0000005d0001', 'Own', 'platformadmin', 'active'),
  ('00000000-0000-0000-0000-0000005d6013', '00000000-0000-0000-0000-0000005d0001', 'Own', 'inactiveinstructor', 'active');

insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000005d7003', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6003', '00000000-0000-0000-0000-0000005d2003', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7004', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6004', '00000000-0000-0000-0000-0000005d2004', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7005', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6005', '00000000-0000-0000-0000-0000005d2005', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7012', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6012', '00000000-0000-0000-0000-0000005d2012', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7006', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6006', '00000000-0000-0000-0000-0000005d2006', 'private_lesson', 'attended', now() - interval '1 day 1 hour', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000005d7007', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6007', '00000000-0000-0000-0000-0000005d2007', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7008', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6008', '00000000-0000-0000-0000-0000005d2008', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7009', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6009', '00000000-0000-0000-0000-0000005d2009', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7010', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6010', '00000000-0000-0000-0000-0000005d2010', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour'),
  ('00000000-0000-0000-0000-0000005d7011', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6011', '00000000-0000-0000-0000-0000005d2011', 'private_lesson', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour');

insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000005d7013', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d6013', '00000000-0000-0000-0000-0000005d2013', 'private_lesson', 'attended', now() - interval '1 day 1 hour', now() - interval '1 day');

-- Instructor record deactivated after the lesson was taught (no future work remains).
update public.instructors set active = false where id = '00000000-0000-0000-0000-0000005d2013';

-- Capability removed after the lesson was taught (no future work remains).
update public.instructors set can_instruct = false where id = '00000000-0000-0000-0000-0000005d2006';

-- ============================================================================
-- TEACHING RPC -- CASE 1: assigned future client returned, with only the
-- approved teaching-safe fields.
-- ============================================================================
do $$
declare
  v_found boolean;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3001'
  ) into v_found;

  select * into v_row from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d3001'::uuid);

  reset role;

  if not v_found then
    raise exception 'FAIL T-fc1b5d-teach1: assigned future client was not returned';
  end if;

  if v_row.first_name is distinct from 'FutureAssigned' or v_row.last_name is distinct from 'ClientOne' then
    raise exception 'FAIL T-fc1b5d-teach1: returned row does not match expected client';
  end if;

  raise notice 'PASS T-fc1b5d-teach1: assigned future client returned with correct fields';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 2: unrelated client denied.
-- ============================================================================
do $$
declare
  v_found boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3002'
  ) into v_found;

  reset role;

  if v_found then
    raise exception 'FAIL T-fc1b5d-teach2: unrelated client (A2''s student) leaked into A1''s results';
  end if;

  raise notice 'PASS T-fc1b5d-teach2: unrelated client correctly denied';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 3: cross-studio denied.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select count(*) into v_count
  from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0002'::uuid);

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-teach3: cross-studio call returned % rows, expected 0', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-teach3: cross-studio call returns nothing';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 4: another instructor's roster impossible (no
-- parameter exists to request it -- verified via a second real session).
-- ============================================================================
do $$
declare
  v_found_own boolean;
  v_found_other boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1002')::text, true);

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3015'
  ) into v_found_own;

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3001'
  ) into v_found_other;

  reset role;

  if not v_found_own then
    raise exception 'FAIL T-fc1b5d-teach4: A2 could not see their own assigned client';
  end if;

  if v_found_other then
    raise exception 'FAIL T-fc1b5d-teach4: A2 saw A1''s assigned client -- cross-instructor leak';
  end if;

  raise notice 'PASS T-fc1b5d-teach4: each instructor sees only their own roster';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 5: stale past "scheduled" appointment denied.
-- ============================================================================
do $$
declare
  v_found boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3009'
  ) into v_found;

  reset role;

  if v_found then
    raise exception 'FAIL T-fc1b5d-teach5: stale scheduled-but-elapsed appointment incorrectly granted access';
  end if;

  raise notice 'PASS T-fc1b5d-teach5: stale scheduled appointment correctly denied';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 6/7/8: 14-day boundary (13 days qualifies, exactly
-- 14 does not, older than 14 does not).
-- ============================================================================
do $$
declare
  v_13 boolean;
  v_14 boolean;
  v_older boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3003') into v_13;
  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3004') into v_14;
  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3005') into v_older;

  reset role;

  if not v_13 then
    raise exception 'FAIL T-fc1b5d-teach6: attended 13 days ago should qualify';
  end if;
  if v_14 then
    raise exception 'FAIL T-fc1b5d-teach7: attended exactly 14 days ago should NOT qualify (strict boundary)';
  end if;
  if v_older then
    raise exception 'FAIL T-fc1b5d-teach8: attended older than 14 days should NOT qualify';
  end if;

  raise notice 'PASS T-fc1b5d-teach6/7/8: 14-day boundary semantics correct (13d qualifies, exactly 14d and older do not)';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 9/10: no_show alone denied; no_show + future
-- qualifies only because of the future appointment.
-- ============================================================================
do $$
declare
  v_noshow_only boolean;
  v_noshow_plus_future boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3006') into v_noshow_only;
  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3007') into v_noshow_plus_future;

  reset role;

  if v_noshow_only then
    raise exception 'FAIL T-fc1b5d-teach9: no_show-only client incorrectly qualified';
  end if;
  if not v_noshow_plus_future then
    raise exception 'FAIL T-fc1b5d-teach10: no_show + valid future appointment should qualify via the future appointment';
  end if;

  raise notice 'PASS T-fc1b5d-teach9/10: no_show provides no historical access; a separate future appointment still qualifies';
end $$;

-- Explicit sub-check for case 10: removing the future appointment should
-- remove access (confirms it was ONLY the future row granting it).
do $$
declare
  v_after_removal boolean;
begin
  delete from public.appointments where id = '00000000-0000-0000-0000-0000005d4008';

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3007') into v_after_removal;

  reset role;

  if v_after_removal then
    raise exception 'FAIL T-fc1b5d-teach10b: access should drop once the future appointment is removed, leaving only a bare no_show';
  end if;

  raise notice 'PASS T-fc1b5d-teach10b: removing the future appointment removes access, confirming no_show alone never qualifies';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 11: cancelled denied.
-- ============================================================================
do $$
declare
  v_found boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3008') into v_found;

  reset role;

  if v_found then
    raise exception 'FAIL T-fc1b5d-teach11: cancelled-only client incorrectly qualified';
  end if;

  raise notice 'PASS T-fc1b5d-teach11: cancelled appointment never qualifies';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 12: a group class is shared. It cannot carry a client_id,
-- and being on its roster does not make a dancer a teaching client.
-- ============================================================================
do $$
declare
  v_refused boolean := false;
  v_found boolean;
begin
  begin
    insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at) values
      ('00000000-0000-0000-0000-0000005d4018', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3010', '00000000-0000-0000-0000-0000005d2001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour');
  exception when raise_exception then
    if sqlerrm not like '%shared group class%' then
      raise;
    end if;
    v_refused := true;
  end;

  if not v_refused then
    raise exception 'FAIL T-fc1b5d-teach12: a group class with a client_id was accepted';
  end if;

  insert into public.appointments (id, studio_id, instructor_id, appointment_type, status, starts_at, ends_at, roster_capacity) values
    ('00000000-0000-0000-0000-0000005d4011', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d2001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', 12);
  insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status) values
    ('00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d4011', '00000000-0000-0000-0000-0000005d3010', 'staff', 'booked');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3010') into v_found;

  reset role;

  if v_found then
    raise exception 'FAIL T-fc1b5d-teach12: a group class roster entry granted teaching access';
  end if;

  raise notice 'PASS T-fc1b5d-teach12: a group class cannot carry a client_id and its roster grants no teaching access';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 13: substitute reassignment follows current
-- instructor_id (A1 currently holds instructor_id on this row -> A1
-- qualifies; A2 does not, since the column only ever holds one value).
-- ============================================================================
do $$
declare
  v_a1_found boolean;
  v_a2_found boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);
  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3011') into v_a1_found;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1002')::text, true);
  select exists (select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid) where id = '00000000-0000-0000-0000-0000005d3011') into v_a2_found;
  reset role;

  if not v_a1_found then
    raise exception 'FAIL T-fc1b5d-teach13: instructor currently on instructor_id should qualify';
  end if;
  if v_a2_found then
    raise exception 'FAIL T-fc1b5d-teach13: a different instructor should not qualify for a row they are not currently assigned to';
  end if;

  raise notice 'PASS T-fc1b5d-teach13: qualification follows current instructor_id only, no permanent historical substitute relationship';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 14: duplicate qualifying appointments do not
-- duplicate the client row.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select count(*) into v_count
  from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
  where id = '00000000-0000-0000-0000-0000005d3012';

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d-teach14: client with 2 qualifying appointments returned % rows, expected exactly 1', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-teach14: duplicate qualifying appointments collapse to one client row';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 15: output schema contains only approved fields.
-- ============================================================================
do $$
declare
  v_returns text;
begin
  select pg_get_function_result(p.oid) into v_returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_teaching_clients_for_instructor';

  if v_returns is distinct from 'TABLE(id uuid, first_name text, last_name text, dance_goals text[], skill_level text, photo_url text)' then
    raise exception 'FAIL T-fc1b5d-teach15: unexpected return shape: %', v_returns;
  end if;

  if v_returns like '%notes%' or v_returns like '%referral_source%' or v_returns like '%email%' or v_returns like '%phone%' or v_returns like '%address%' then
    raise exception 'FAIL T-fc1b5d-teach15: return shape contains a field outside the approved teaching-safe set';
  end if;

  raise notice 'PASS T-fc1b5d-teach15: return shape contains only the approved teaching-safe fields';
end $$;

-- ============================================================================
-- BOOKING SEARCH RPC -- CASE 16: first-time client discoverable via search.
-- ============================================================================
do $$
declare
  v_search_found boolean;
begin
  if to_regprocedure('public.search_bookable_clients_for_instructor(uuid,text,integer)') is null then
    raise notice 'SKIP T-fc1b5d-book16: booking search is not installed';
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, 'Abc', 20)
    where id = '00000000-0000-0000-0000-0000005d3013'
  ) into v_search_found;

  reset role;

  if not v_search_found then
    raise exception 'FAIL T-fc1b5d-book16: first-time client not discoverable via booking search';
  end if;

  raise notice 'PASS T-fc1b5d-book16: first-time client discoverable via booking search';
end $$;

-- ============================================================================
-- TEACHING RPC -- CASE 17/18: a client is NOT teaching-visible before an
-- appointment exists, and becomes visible once a qualifying one is created.
-- ============================================================================
do $$
declare
  v_teach_found_before boolean;
  v_teach_found_after boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3013'
  ) into v_teach_found_before;

  reset role;

  if v_teach_found_before then
    raise exception 'FAIL T-fc1b5d-teach17: first-time client should not be teaching-visible before any appointment exists';
  end if;

  insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at) values
    ('00000000-0000-0000-0000-0000005d4017', '00000000-0000-0000-0000-0000005d0001', '00000000-0000-0000-0000-0000005d3013', '00000000-0000-0000-0000-0000005d2001', 'private_lesson', 'scheduled', now() + interval '6 days', now() + interval '6 days 1 hour');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3013'
  ) into v_teach_found_after;

  reset role;

  if not v_teach_found_after then
    raise exception 'FAIL T-fc1b5d-teach18: client should become teaching-visible once a qualifying future appointment exists';
  end if;

  raise notice 'PASS T-fc1b5d-teach17/18: only a qualifying appointment makes a client teaching-visible';
end $$;

-- ============================================================================
-- BOOKING SEARCH RPC -- CASE 19/20: blank and one-character queries
-- return nothing.
-- ============================================================================
do $$
declare
  v_blank_count int;
  v_one_char_count int;
begin
  if to_regprocedure('public.search_bookable_clients_for_instructor(uuid,text,integer)') is null then
    raise notice 'SKIP booking case block 1: booking search is not installed';
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select count(*) into v_blank_count from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '', 20);
  select count(*) into v_one_char_count from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, 'A', 20);

  reset role;

  if v_blank_count <> 0 then
    raise exception 'FAIL T-fc1b5d-book19: blank query returned % rows, expected 0', v_blank_count;
  end if;
  if v_one_char_count <> 0 then
    raise exception 'FAIL T-fc1b5d-book20: one-character query returned % rows, expected 0', v_one_char_count;
  end if;

  raise notice 'PASS T-fc1b5d-book19/20: blank and sub-minimum-length queries return nothing';
end $$;

-- ============================================================================
-- BOOKING SEARCH RPC -- CASE 21: '%' and '_' treated literally, not as
-- SQL wildcards.
-- ============================================================================
do $$
declare
  v_underscore_count int;
  v_percent_count int;
begin
  if to_regprocedure('public.search_bookable_clients_for_instructor(uuid,text,integer)') is null then
    raise notice 'SKIP booking case block 2: booking search is not installed';
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  -- "Abc Wildcardtest" contains no literal underscore or percent. If '_'
  -- or '%' were interpreted as real SQL wildcards, these searches would
  -- incorrectly match it (a_c -> matches "Abc" if _ is a wildcard; a%c ->
  -- also matches "Abc" if % is a wildcard).
  select count(*) into v_underscore_count from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, 'a_c', 20);
  select count(*) into v_percent_count from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, 'a%c', 20);

  reset role;

  if v_underscore_count <> 0 then
    raise exception 'FAIL T-fc1b5d-book21a: "_" was interpreted as a SQL wildcard instead of a literal character';
  end if;
  if v_percent_count <> 0 then
    raise exception 'FAIL T-fc1b5d-book21b: "%%" was interpreted as a SQL wildcard instead of a literal character';
  end if;

  raise notice 'PASS T-fc1b5d-book21: wildcard characters in search input are treated literally';
end $$;

-- ============================================================================
-- BOOKING SEARCH RPC -- CASE 22/23: result count hard-capped and
-- deterministic ordering.
-- ============================================================================
do $$
declare
  v_capped_count int;
  v_arr text[];
  v_sorted_arr text[];
begin
  if to_regprocedure('public.search_bookable_clients_for_instructor(uuid,text,integer)') is null then
    raise notice 'SKIP booking case block 3: booking search is not installed';
    return;
  end if;

  -- Insert 25 clients sharing a common searchable token, request a huge
  -- limit_count, and confirm the server-side ceiling (20) still applies.
  insert into public.clients (id, studio_id, first_name, last_name, status)
  select
    ('00000000-0000-0000-0000-0000005d5' || lpad(i::text, 3, '0'))::uuid,
    '00000000-0000-0000-0000-0000005d0001',
    'CapTest',
    'Client' || i,
    'active'
  from generate_series(1, 25) as i;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select count(*) into v_capped_count from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, 'CapTest', 9999);

  select array_agg(last_name) into v_arr
  from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, 'CapTest', 20);

  reset role;

  select array_agg(x order by x) into v_sorted_arr from unnest(v_arr) as x;

  if v_capped_count <> 20 then
    raise exception 'FAIL T-fc1b5d-book22: result count was %, expected hard cap of 20 regardless of requested limit_count', v_capped_count;
  end if;
  if v_arr is distinct from v_sorted_arr then
    raise exception 'FAIL T-fc1b5d-book23: results are not deterministically ordered by last_name';
  end if;

  raise notice 'PASS T-fc1b5d-book22/23: result count hard-capped at 20, ordering deterministic';
end $$;

-- ============================================================================
-- BOOKING SEARCH RPC -- CASE 24: cross-studio denied.
-- ============================================================================
do $$
declare
  v_count int;
begin
  if to_regprocedure('public.search_bookable_clients_for_instructor(uuid,text,integer)') is null then
    raise notice 'SKIP booking case block 4: booking search is not installed';
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select count(*) into v_count from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0002'::uuid, 'Abc', 20);

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-book24: cross-studio search returned % rows, expected 0', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-book24: cross-studio booking search returns nothing';
end $$;

-- ============================================================================
-- BOOKING SEARCH RPC -- CASE 25: archived clients filtered out.
-- ============================================================================
do $$
declare
  v_found boolean;
begin
  if to_regprocedure('public.search_bookable_clients_for_instructor(uuid,text,integer)') is null then
    raise notice 'SKIP booking case block 5: booking search is not installed';
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, 'ArchivedSearch', 20)
    where id = '00000000-0000-0000-0000-0000005d3014'
  ) into v_found;

  reset role;

  if v_found then
    raise exception 'FAIL T-fc1b5d-book25: archived client should not be returned by booking search';
  end if;

  raise notice 'PASS T-fc1b5d-book25: archived clients excluded from booking search, matching existing product behavior';
end $$;

-- ============================================================================
-- BOOKING SEARCH RPC -- CASE 26: output row shape contains only the
-- approved minimal fields.
-- ============================================================================
do $$
declare
  v_returns text;
begin
  if to_regprocedure('public.search_bookable_clients_for_instructor(uuid,text,integer)') is null then
    raise notice 'SKIP booking case block 6: booking search is not installed';
    return;
  end if;

  select pg_get_function_result(p.oid) into v_returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'search_bookable_clients_for_instructor';

  if v_returns is distinct from 'TABLE(id uuid, first_name text, last_name text)' then
    raise exception 'FAIL T-fc1b5d-book26: unexpected return shape: %', v_returns;
  end if;

  raise notice 'PASS T-fc1b5d-book26: booking-search return shape contains only id/first_name/last_name';
end $$;

-- ============================================================================
-- HYBRID / INDEPENDENT -- CASE 27/28/29: floor-rental-only relationship
-- never creates host teaching access; hybrid instructor (same person, A1)
-- sees only their host-assigned teaching client, never their own
-- floor-rental identity, never an unrelated client.
-- ============================================================================
do $$
declare
  v_floor_rental_leak boolean;
  v_host_assigned boolean;
  v_unrelated boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1001')::text, true);

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3016'
  ) into v_floor_rental_leak;

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3001'
  ) into v_host_assigned;

  select exists (
    select 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid)
    where id = '00000000-0000-0000-0000-0000005d3002'
  ) into v_unrelated;

  reset role;

  if v_floor_rental_leak then
    raise exception 'FAIL T-fc1b5d-hybrid27: A1''s own floor-rental client identity incorrectly appeared in their teaching results';
  end if;
  if not v_host_assigned then
    raise exception 'FAIL T-fc1b5d-hybrid28: hybrid instructor (A1) should still see their host-assigned teaching client';
  end if;
  if v_unrelated then
    raise exception 'FAIL T-fc1b5d-hybrid29: hybrid instructor saw an unrelated host client';
  end if;

  raise notice 'PASS T-fc1b5d-hybrid27/28/29: floor-rental relationship never grants host teaching access; hybrid instructor sees only their own host-assigned teaching client';
end $$;

-- No special "hybrid_instructor" role exists or is required anywhere in
-- this schema or these functions (asserted by construction -- every query
-- above used the ordinary "instructor" role/identity for a user who also
-- happens to have an is_independent_instructor=true clients row; no
-- distinct role string was ever needed).

-- ============================================================================
-- CALLER CONDITIONS: an active, capable instructors row AND an active studio
-- role of an allowed kind in the requested studio.
-- ============================================================================
do $$
declare
  v_ids uuid[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1003')::text, true);
  select array_agg(id) into v_ids from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  reset role;
  if v_ids is distinct from array['00000000-0000-0000-0000-0000005d6003'::uuid] then
    raise exception 'FAIL T-fc1b5d-allow-owner: expected exactly the caller''s own client, got %', v_ids;
  end if;
  raise notice 'PASS T-fc1b5d-allow-owner: gets exactly their own client';
end $$;

do $$
declare
  v_ids uuid[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1004')::text, true);
  select array_agg(id) into v_ids from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  reset role;
  if v_ids is distinct from array['00000000-0000-0000-0000-0000005d6004'::uuid] then
    raise exception 'FAIL T-fc1b5d-allow-admin: expected exactly the caller''s own client, got %', v_ids;
  end if;
  raise notice 'PASS T-fc1b5d-allow-admin: gets exactly their own client';
end $$;

do $$
declare
  v_ids uuid[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1005')::text, true);
  select array_agg(id) into v_ids from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  reset role;
  if v_ids is distinct from array['00000000-0000-0000-0000-0000005d6005'::uuid] then
    raise exception 'FAIL T-fc1b5d-allow-frontdesk: expected exactly the caller''s own client, got %', v_ids;
  end if;
  raise notice 'PASS T-fc1b5d-allow-frontdesk: gets exactly their own client';
end $$;

do $$
declare
  v_ids uuid[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1012')::text, true);
  select array_agg(id) into v_ids from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  reset role;
  if v_ids is distinct from array['00000000-0000-0000-0000-0000005d6012'::uuid] then
    raise exception 'FAIL T-fc1b5d-allow-instructor: expected exactly the caller''s own client, got %', v_ids;
  end if;
  raise notice 'PASS T-fc1b5d-allow-instructor: gets exactly their own client';
end $$;

do $$
declare
  v_count int;
  v_one int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1006')::text, true);
  select count(*) into v_count from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  select count(*) into v_one from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d6006'::uuid);
  reset role;
  if v_count <> 0 or v_one <> 0 then
    raise exception 'FAIL T-fc1b5d-deny-nocapability: expected no rows, got % (and % by client id)', v_count, v_one;
  end if;
  raise notice 'PASS T-fc1b5d-deny-nocapability: no rows';
end $$;

do $$
declare
  v_count int;
  v_one int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1007')::text, true);
  select count(*) into v_count from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  select count(*) into v_one from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d6007'::uuid);
  reset role;
  if v_count <> 0 or v_one <> 0 then
    raise exception 'FAIL T-fc1b5d-deny-norole: expected no rows, got % (and % by client id)', v_count, v_one;
  end if;
  raise notice 'PASS T-fc1b5d-deny-norole: no rows';
end $$;

do $$
declare
  v_count int;
  v_one int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1008')::text, true);
  select count(*) into v_count from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  select count(*) into v_one from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d6008'::uuid);
  reset role;
  if v_count <> 0 or v_one <> 0 then
    raise exception 'FAIL T-fc1b5d-deny-inactiverole: expected no rows, got % (and % by client id)', v_count, v_one;
  end if;
  raise notice 'PASS T-fc1b5d-deny-inactiverole: no rows';
end $$;

do $$
declare
  v_count int;
  v_one int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1009')::text, true);
  select count(*) into v_count from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  select count(*) into v_one from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d6009'::uuid);
  reset role;
  if v_count <> 0 or v_one <> 0 then
    raise exception 'FAIL T-fc1b5d-deny-independent: expected no rows, got % (and % by client id)', v_count, v_one;
  end if;
  raise notice 'PASS T-fc1b5d-deny-independent: no rows';
end $$;

do $$
declare
  v_count int;
  v_one int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1010')::text, true);
  select count(*) into v_count from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  select count(*) into v_one from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d6010'::uuid);
  reset role;
  if v_count <> 0 or v_one <> 0 then
    raise exception 'FAIL T-fc1b5d-deny-otherstudio: expected no rows, got % (and % by client id)', v_count, v_one;
  end if;
  raise notice 'PASS T-fc1b5d-deny-otherstudio: no rows';
end $$;

do $$
declare
  v_count int;
  v_one int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1011')::text, true);
  select count(*) into v_count from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  select count(*) into v_one from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d6011'::uuid);
  reset role;
  if v_count <> 0 or v_one <> 0 then
    raise exception 'FAIL T-fc1b5d-deny-platformadmin: expected no rows, got % (and % by client id)', v_count, v_one;
  end if;
  raise notice 'PASS T-fc1b5d-deny-platformadmin: no rows';
end $$;

do $$
declare
  v_count int;
  v_one int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1013')::text, true);
  select count(*) into v_count from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
  select count(*) into v_one from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid, '00000000-0000-0000-0000-0000005d6013'::uuid);
  reset role;
  if v_count <> 0 or v_one <> 0 then
    raise exception 'FAIL T-fc1b5d-deny-inactiveinstructor: expected no rows, got % (and % by client id)', v_count, v_one;
  end if;
  raise notice 'PASS T-fc1b5d-deny-inactiveinstructor: no rows';
end $$;

do $$
begin
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005d1003', 'role', 'anon')::text, true);
  begin
    perform 1 from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005d0001'::uuid);
    raise exception 'FAIL T-fc1b5d-deny-anon: the anon role was allowed to call the function';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  raise notice 'PASS T-fc1b5d-deny-anon: refused';
end $$;

rollback;
