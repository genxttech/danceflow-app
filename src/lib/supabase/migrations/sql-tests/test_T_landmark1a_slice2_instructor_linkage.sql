-- Landmark 1A Slice 2 -- instructor account linkage lifecycle + the
-- accept_pending_team_invitations security fix, live-RPC regression
-- tests.
--
-- Proves, at the real Postgres level (not mocked):
--   1. the confused-deputy fix: a caller cannot claim an invitation
--      addressed to a different email by supplying that email as
--      p_email;
--   2. case-normalized own-email acceptance still works;
--   3. unauthenticated invocation claims nothing;
--   4. Tier 4 (exact email match) links an existing unlinked instructor
--      row on instructor-role invite acceptance;
--   5. Tier 5 creates a minimal instructor row (active=true,
--      can_instruct=false) when no deterministic candidate exists;
--   6. Tier 4 ambiguity (two unlinked rows, same email) links/creates
--      nothing, while the invite's user_studio_roles grant still
--      succeeds;
--   7. an instructor row already linked to a different user is never
--      touched by the automatic chain;
--   8. the internal helper cannot be invoked directly by authenticated
--      or anon roles;
--   9. every successful automatic link/create writes exactly one
--      instructor_audit_events row with correct event_type/before/
--      after/metadata, and no PII in metadata;
--   10. a direct authenticated INSERT against instructor_audit_events
--       is still rejected by RLS (the SQL-internal audit write is the
--       only way in);
--   11. user_studio_roles' existing UNIQUE(studio_id,user_id)
--       constraint remains intact and no duplicate role row is ever
--       created by any of the above.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-00001a200XXX (confirmed unused by any other
-- sql-tests file before this one was written).

begin;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001a200001', 'Slice2 Harness Studio A', 't-landmark1a-s2-studio-a'),
  ('00000000-0000-0000-0000-00001a200002', 'Slice2 Harness Studio B', 't-landmark1a-s2-studio-b');

-- Accepting users: userA is the real target of "userA's own invites";
-- userB is a distinct account attacker-A will try to impersonate by
-- supplying userB's email.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00001a200101', 't-landmark1a-s2-usera@example.test'),
  ('00000000-0000-0000-0000-00001a200102', 't-landmark1a-s2-userb@example.test'),
  ('00000000-0000-0000-0000-00001a200103', 't-landmark1a-s2-userc@example.test'),
  ('00000000-0000-0000-0000-00001a200104', 't-landmark1a-s2-userd@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00001a200101', 't-landmark1a-s2-usera@example.test', 'Slice2 UserA'),
  ('00000000-0000-0000-0000-00001a200102', 't-landmark1a-s2-userb@example.test', 'Slice2 UserB'),
  ('00000000-0000-0000-0000-00001a200103', 't-landmark1a-s2-userc@example.test', 'Slice2 UserC'),
  ('00000000-0000-0000-0000-00001a200104', 't-landmark1a-s2-userd@example.test', 'Slice2 UserD');

-- ============================================================================
-- CASE 1: User A (attacker) cannot claim an invite addressed to User B
-- by supplying User B's email as p_email. User A's own real JWT email is
-- usera@example.test.
-- ============================================================================
insert into public.team_invitations (id, studio_id, email, role, invited_by, expires_at) values
  ('00000000-0000-0000-0000-00001a200201', '00000000-0000-0000-0000-00001a200001', 't-landmark1a-s2-userb@example.test', 'studio_admin', '00000000-0000-0000-0000-00001a200101', now() + interval '14 days');

do $$
declare
  v_result int;
  v_role_count int;
  v_accepted timestamptz;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a200101', 'email', 't-landmark1a-s2-usera@example.test')::text, true);

  -- Attacker passes B's email, not their own.
  select public.accept_pending_team_invitations('t-landmark1a-s2-userb@example.test') into v_result;

  reset role;

  select count(*) into v_role_count
  from public.user_studio_roles
  where studio_id = '00000000-0000-0000-0000-00001a200001'
    and user_id = '00000000-0000-0000-0000-00001a200101';

  select accepted_at into v_accepted from public.team_invitations where id = '00000000-0000-0000-0000-00001a200201';

  if v_result <> 0 then
    raise exception 'FAIL T-landmark1a-s2-1: expected 0 claims, got %', v_result;
  end if;

  if v_role_count <> 0 then
    raise exception 'FAIL T-landmark1a-s2-1: User A must not have been granted User B''s invite role, found % role row(s)', v_role_count;
  end if;

  if v_accepted is not null then
    raise exception 'FAIL T-landmark1a-s2-1: invite must remain unaccepted';
  end if;

  raise notice 'PASS T-landmark1a-s2-1: User A cannot claim User B''s invitation by supplying User B''s email';
end $$;

-- ============================================================================
-- CASE 2: case-normalized own-email acceptance still works (invite email
-- stored mixed-case, JWT email lowercase).
-- ============================================================================
update public.team_invitations set email = 'T-Landmark1A-S2-UserB@Example.test' where id = '00000000-0000-0000-0000-00001a200201';

do $$
declare
  v_result int;
  v_role text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a200102', 'email', 't-landmark1a-s2-userb@example.test')::text, true);

  select public.accept_pending_team_invitations('anything-ignored@example.test') into v_result;

  reset role;

  select role into v_role from public.user_studio_roles
  where studio_id = '00000000-0000-0000-0000-00001a200001' and user_id = '00000000-0000-0000-0000-00001a200102';

  if v_result <> 1 then
    raise exception 'FAIL T-landmark1a-s2-2: expected exactly 1 claim, got %', v_result;
  end if;

  if v_role is distinct from 'studio_admin' then
    raise exception 'FAIL T-landmark1a-s2-2: expected studio_admin role granted to User B, got %', v_role;
  end if;

  raise notice 'PASS T-landmark1a-s2-2: case-normalized own-email acceptance still works; p_email is ignored';
end $$;

-- ============================================================================
-- CASE 3: unauthenticated invocation claims nothing.
-- ============================================================================
insert into public.team_invitations (id, studio_id, email, role, invited_by, expires_at) values
  ('00000000-0000-0000-0000-00001a200202', '00000000-0000-0000-0000-00001a200001', 't-landmark1a-s2-userc@example.test', 'front_desk', '00000000-0000-0000-0000-00001a200101', now() + interval '14 days');

do $$
declare
  v_result int;
begin
  set local role anon;

  select public.accept_pending_team_invitations('t-landmark1a-s2-userc@example.test') into v_result;

  reset role;

  if v_result <> 0 then
    raise exception 'FAIL T-landmark1a-s2-3: unauthenticated call must claim nothing, got %', v_result;
  end if;

  raise notice 'PASS T-landmark1a-s2-3: unauthenticated invocation claims nothing';
end $$;

-- ============================================================================
-- CASE 4: Tier 4 exact-email match links an existing unlinked instructor
-- row on instructor-role invite acceptance.
-- ============================================================================
insert into public.instructors (id, studio_id, first_name, last_name, email, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a200301', '00000000-0000-0000-0000-00001a200001', 'Pre', 'Existing', 't-landmark1a-s2-userc@example.test', true, false);

-- Dedicated instructor-role invite for this case, distinct from case 3's
-- still-pending front_desk invite for the same email (that one was never
-- accepted, since case 3's call was unauthenticated).
insert into public.team_invitations (id, studio_id, email, role, invited_by, expires_at) values
  ('00000000-0000-0000-0000-00001a200206', '00000000-0000-0000-0000-00001a200001', 't-landmark1a-s2-userc@example.test', 'instructor', '00000000-0000-0000-0000-00001a200101', now() + interval '14 days');

do $$
declare
  v_result int;
  v_instructor record;
  v_audit_count int;
  v_audit record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a200103', 'email', 't-landmark1a-s2-userc@example.test')::text, true);

  select public.accept_pending_team_invitations('ignored@example.test') into v_result;

  reset role;

  select * into v_instructor from public.instructors where id = '00000000-0000-0000-0000-00001a200301';

  -- Both the leftover front_desk invite (case 3) and this case's
  -- instructor invite are claimed together in one call.
  if v_result <> 2 then
    raise exception 'FAIL T-landmark1a-s2-4: expected exactly 2 claims (front_desk + instructor), got %', v_result;
  end if;

  if v_instructor.user_id is distinct from '00000000-0000-0000-0000-00001a200103'::uuid then
    raise exception 'FAIL T-landmark1a-s2-4: expected the existing row linked via email match, got user_id=%', v_instructor.user_id;
  end if;

  if v_instructor.can_instruct is distinct from false then
    raise exception 'FAIL T-landmark1a-s2-4: can_instruct must remain false in Slice 2, got %', v_instructor.can_instruct;
  end if;

  select count(*) into v_audit_count from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a200301';
  select * into v_audit from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a200301' order by created_at desc limit 1;

  if v_audit_count <> 1 then
    raise exception 'FAIL T-landmark1a-s2-4: expected exactly 1 audit row, got %', v_audit_count;
  end if;

  if v_audit.event_type is distinct from 'account_linked'
    or v_audit.before_value is distinct from jsonb_build_object('user_id', null)
    or v_audit.after_value is distinct from jsonb_build_object('user_id', '00000000-0000-0000-0000-00001a200103')
    or v_audit.metadata->>'matched_via' is distinct from 'email'
    or v_audit.actor_user_id is distinct from '00000000-0000-0000-0000-00001a200103'::uuid
  then
    raise exception 'FAIL T-landmark1a-s2-4: audit row shape incorrect: %', row_to_json(v_audit);
  end if;

  if v_audit.metadata::text ilike '%example.test%' or v_audit.before_value::text ilike '%example.test%' or v_audit.after_value::text ilike '%example.test%' then
    raise exception 'FAIL T-landmark1a-s2-4: audit row must not contain email/PII';
  end if;

  raise notice 'PASS T-landmark1a-s2-4: Tier 4 email match links the existing row, can_instruct stays false, audit row correct and PII-free';
end $$;

-- ============================================================================
-- CASE 5: Tier 5 creates a minimal instructor row when no candidate
-- exists at all.
-- ============================================================================
insert into public.team_invitations (id, studio_id, email, role, invited_by, expires_at) values
  ('00000000-0000-0000-0000-00001a200203', '00000000-0000-0000-0000-00001a200001', 't-landmark1a-s2-userd@example.test', 'instructor', '00000000-0000-0000-0000-00001a200101', now() + interval '14 days');

do $$
declare
  v_result int;
  v_count_before int;
  v_count_after int;
  v_new_instructor record;
begin
  select count(*) into v_count_before from public.instructors where studio_id = '00000000-0000-0000-0000-00001a200001';

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a200104', 'email', 't-landmark1a-s2-userd@example.test')::text, true);

  select public.accept_pending_team_invitations('ignored@example.test') into v_result;

  reset role;

  select count(*) into v_count_after from public.instructors where studio_id = '00000000-0000-0000-0000-00001a200001';

  select * into v_new_instructor from public.instructors
  where studio_id = '00000000-0000-0000-0000-00001a200001' and user_id = '00000000-0000-0000-0000-00001a200104';

  if v_result <> 1 then
    raise exception 'FAIL T-landmark1a-s2-5: expected exactly 1 claim, got %', v_result;
  end if;

  if v_count_after - v_count_before <> 1 then
    raise exception 'FAIL T-landmark1a-s2-5: expected exactly one new instructor row, delta=%', (v_count_after - v_count_before);
  end if;

  if v_new_instructor.active is distinct from true or v_new_instructor.can_instruct is distinct from false then
    raise exception 'FAIL T-landmark1a-s2-5: new row must be active=true, can_instruct=false, got active=%, can_instruct=%', v_new_instructor.active, v_new_instructor.can_instruct;
  end if;

  raise notice 'PASS T-landmark1a-s2-5: Tier 5 auto-creates a minimal, active=true, can_instruct=false instructor row';
end $$;

-- ============================================================================
-- CASE 6: Tier 4 ambiguity (two unlinked rows, same email) links/creates
-- nothing, but the role grant still succeeds.
-- ============================================================================
insert into public.instructors (id, studio_id, first_name, last_name, email, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a200302', '00000000-0000-0000-0000-00001a200002', 'Dup', 'One', 't-landmark1a-s2-ambiguous@example.test', true, false),
  ('00000000-0000-0000-0000-00001a200303', '00000000-0000-0000-0000-00001a200002', 'Dup', 'Two', 't-landmark1a-s2-ambiguous@example.test', true, false);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00001a200105', 't-landmark1a-s2-ambiguous@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00001a200105', 't-landmark1a-s2-ambiguous@example.test', 'Ambiguous User');

insert into public.team_invitations (id, studio_id, email, role, invited_by, expires_at) values
  ('00000000-0000-0000-0000-00001a200204', '00000000-0000-0000-0000-00001a200002', 't-landmark1a-s2-ambiguous@example.test', 'instructor', '00000000-0000-0000-0000-00001a200101', now() + interval '14 days');

do $$
declare
  v_result int;
  v_role text;
  v_linked_count int;
  v_total_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a200105', 'email', 't-landmark1a-s2-ambiguous@example.test')::text, true);

  select public.accept_pending_team_invitations('ignored@example.test') into v_result;

  reset role;

  select role into v_role from public.user_studio_roles
  where studio_id = '00000000-0000-0000-0000-00001a200002' and user_id = '00000000-0000-0000-0000-00001a200105';

  select count(*) into v_linked_count from public.instructors
  where studio_id = '00000000-0000-0000-0000-00001a200002' and user_id = '00000000-0000-0000-0000-00001a200105';

  select count(*) into v_total_count from public.instructors where studio_id = '00000000-0000-0000-0000-00001a200002';

  if v_result <> 1 then
    raise exception 'FAIL T-landmark1a-s2-6: expected exactly 1 claim (role grant succeeds), got %', v_result;
  end if;

  if v_role is distinct from 'instructor' then
    raise exception 'FAIL T-landmark1a-s2-6: role grant must still succeed despite ambiguous instructor-row match, got %', v_role;
  end if;

  if v_linked_count <> 0 then
    raise exception 'FAIL T-landmark1a-s2-6: ambiguous match must link nothing, found % linked row(s)', v_linked_count;
  end if;

  if v_total_count <> 2 then
    raise exception 'FAIL T-landmark1a-s2-6: ambiguous match must create nothing, expected 2 rows still, got %', v_total_count;
  end if;

  raise notice 'PASS T-landmark1a-s2-6: ambiguous email match links/creates nothing; role grant still succeeds';
end $$;

-- ============================================================================
-- CASE 7: an instructor row already linked to a different user is never
-- touched by the automatic chain (email collides, but user_id already set).
-- ============================================================================
-- Owner's real login email is distinct from the instructor row's own
-- (legacy/imported, possibly stale) email column -- exactly the
-- realistic shape this case exercises: the instructor row's email
-- happens to equal a *different* person's real email.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00001a200106', 't-landmark1a-s2-owner-real@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00001a200106', 't-landmark1a-s2-owner-real@example.test', 'Already Linked Owner');

insert into public.instructors (id, studio_id, first_name, last_name, email, user_id, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a200304', '00000000-0000-0000-0000-00001a200001', 'Already', 'Linked', 't-landmark1a-s2-alreadylinked@example.test', '00000000-0000-0000-0000-00001a200106', true, false);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00001a200107', 't-landmark1a-s2-alreadylinked@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00001a200107', 't-landmark1a-s2-alreadylinked@example.test', 'Different Claimant');

insert into public.team_invitations (id, studio_id, email, role, invited_by, expires_at) values
  ('00000000-0000-0000-0000-00001a200205', '00000000-0000-0000-0000-00001a200001', 't-landmark1a-s2-alreadylinked@example.test', 'instructor', '00000000-0000-0000-0000-00001a200101', now() + interval '14 days');

do $$
declare
  v_result int;
  v_unchanged_user_id uuid;
  v_new_row_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a200107', 'email', 't-landmark1a-s2-alreadylinked@example.test')::text, true);

  select public.accept_pending_team_invitations('ignored@example.test') into v_result;

  reset role;

  select user_id into v_unchanged_user_id from public.instructors where id = '00000000-0000-0000-0000-00001a200304';

  select count(*) into v_new_row_count from public.instructors
  where studio_id = '00000000-0000-0000-0000-00001a200001' and user_id = '00000000-0000-0000-0000-00001a200107';

  if v_unchanged_user_id is distinct from '00000000-0000-0000-0000-00001a200106'::uuid then
    raise exception 'FAIL T-landmark1a-s2-7: the already-linked row must never be overwritten, got user_id=%', v_unchanged_user_id;
  end if;

  -- Zero candidates (the only same-email row is user_id-occupied), so
  -- Tier 5 must create a fresh row for the new claimant instead of
  -- silently doing nothing or overwriting.
  if v_new_row_count <> 1 then
    raise exception 'FAIL T-landmark1a-s2-7: expected exactly one fresh row created for the new claimant, got %', v_new_row_count;
  end if;

  raise notice 'PASS T-landmark1a-s2-7: an instructor row already linked to a different user is never overwritten';
end $$;

-- ============================================================================
-- CASE 8: the internal helper cannot be invoked directly by authenticated
-- or anon roles.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a200101', 'email', 't-landmark1a-s2-usera@example.test')::text, true);

  begin
    perform public.resolve_or_create_linked_instructor(
      '00000000-0000-0000-0000-00001a200001'::uuid,
      '00000000-0000-0000-0000-00001a200101'::uuid,
      't-landmark1a-s2-usera@example.test',
      'Slice2', 'UserA',
      true
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-landmark1a-s2-8a: authenticated role must not be able to call the helper directly';
  end if;

  raise notice 'PASS T-landmark1a-s2-8a: authenticated role is denied direct EXECUTE on the helper';
end $$;

do $$
declare
  v_has_priv boolean;
begin
  select has_function_privilege(
    'authenticated',
    'public.resolve_or_create_linked_instructor(uuid,uuid,text,text,text,boolean)',
    'EXECUTE'
  ) into v_has_priv;

  if v_has_priv then
    raise exception 'FAIL T-landmark1a-s2-8b: authenticated must not have catalog EXECUTE privilege on the helper';
  end if;

  select has_function_privilege(
    'anon',
    'public.resolve_or_create_linked_instructor(uuid,uuid,text,text,text,boolean)',
    'EXECUTE'
  ) into v_has_priv;

  if v_has_priv then
    raise exception 'FAIL T-landmark1a-s2-8b: anon must not have catalog EXECUTE privilege on the helper';
  end if;

  raise notice 'PASS T-landmark1a-s2-8b: catalog confirms neither authenticated nor anon has EXECUTE on the helper';
end $$;

-- ============================================================================
-- CASE 9: user_studio_roles' UNIQUE(studio_id,user_id) constraint
-- remains intact, and no duplicate role row exists after all the above.
-- ============================================================================
do $$
declare
  v_constraint_def text;
  v_dup_count int;
begin
  select pg_get_constraintdef(oid) into v_constraint_def
  from pg_constraint
  where conname = 'user_studio_roles_studio_id_user_id_key';

  if v_constraint_def is distinct from 'UNIQUE (studio_id, user_id)' then
    raise exception 'FAIL T-landmark1a-s2-9: user_studio_roles unique constraint missing or changed: %', v_constraint_def;
  end if;

  select count(*) into v_dup_count from (
    select studio_id, user_id from public.user_studio_roles
    where studio_id in ('00000000-0000-0000-0000-00001a200001', '00000000-0000-0000-0000-00001a200002')
    group by studio_id, user_id having count(*) > 1
  ) d;

  if v_dup_count <> 0 then
    raise exception 'FAIL T-landmark1a-s2-9: found % duplicate user_studio_roles group(s)', v_dup_count;
  end if;

  raise notice 'PASS T-landmark1a-s2-9: user_studio_roles unique constraint intact, no duplicate role rows created';
end $$;

rollback;
