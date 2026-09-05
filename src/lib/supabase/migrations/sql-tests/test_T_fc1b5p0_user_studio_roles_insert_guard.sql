-- FC-1B5 P0 -- user_studio_roles INSERT privilege-escalation fix.
--
-- Proves, at the real Postgres/RLS level (not mocked), that after dropping
-- "authenticated users can insert user studio roles" (WITH CHECK (true)):
--   1. an ordinary authenticated dancer with zero user_studio_roles rows
--      cannot insert themselves as studio_owner (or any role) anywhere;
--   2. an authenticated instructor/independent_instructor/front_desk
--      cannot promote themselves to a higher role at their own studio;
--   3. cross-studio self-assignment is blocked (not narrower than #1/#2,
--      but verified explicitly since the removed policy had no studio
--      scoping either);
--   4. existing rows are completely unaffected by the policy change;
--   5. the legitimate service_role write path (what
--      upsertTeamMemberRoleAction now uses, and what
--      accept_pending_team_invitations/claim_platform_invite already used
--      as SECURITY DEFINER functions) still succeeds normally.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists. Run as postgres/superuser locally, or via
-- `supabase db query --linked --file <this file>` against a hosted
-- project (query wraps in an implicit transaction; this file's own
-- `begin`/`rollback` make that explicit and self-contained either way).
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000005cXXXX.

begin;

-- ============================================================================
-- Fixtures: two studios, and a handful of users representing each persona.
-- ============================================================================
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000005c0001', 'FC-1B5 P0 Harness Studio A', 't-fc1b5p0-studio-a'),
  ('00000000-0000-0000-0000-0000005c0002', 'FC-1B5 P0 Harness Studio B', 't-fc1b5p0-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000005c1001', 't-fc1b5p0-dancer@example.test'),
  ('00000000-0000-0000-0000-0000005c1002', 't-fc1b5p0-instructor@example.test'),
  ('00000000-0000-0000-0000-0000005c1003', 't-fc1b5p0-independentinstructor@example.test'),
  ('00000000-0000-0000-0000-0000005c1004', 't-fc1b5p0-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000005c1005', 't-fc1b5p0-studioadmin@example.test'),
  ('00000000-0000-0000-0000-0000005c1006', 't-fc1b5p0-serviceroleprobe@example.test');

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000005c1001', 't-fc1b5p0-dancer@example.test'),
  ('00000000-0000-0000-0000-0000005c1002', 't-fc1b5p0-instructor@example.test'),
  ('00000000-0000-0000-0000-0000005c1003', 't-fc1b5p0-independentinstructor@example.test'),
  ('00000000-0000-0000-0000-0000005c1004', 't-fc1b5p0-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000005c1005', 't-fc1b5p0-studioadmin@example.test'),
  ('00000000-0000-0000-0000-0000005c1006', 't-fc1b5p0-serviceroleprobe@example.test');

-- Existing active roles at Studio A for the non-dancer personas (their
-- *current, legitimate* role -- each attempt below tries to grant
-- themselves or someone else a role they should not be able to grant).
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000005c1002', '00000000-0000-0000-0000-0000005c0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000005c1003', '00000000-0000-0000-0000-0000005c0001', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000005c1004', '00000000-0000-0000-0000-0000005c0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000005c1005', '00000000-0000-0000-0000-0000005c0001', 'studio_admin', true);

-- Sentinel row: must remain byte-for-byte untouched by everything below.
insert into public.user_studio_roles (id, user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000005c4001', '00000000-0000-0000-0000-0000005c1005', '00000000-0000-0000-0000-0000005c0002', 'organizer_admin', true);

do $$
declare
  v_sentinel_before jsonb;
begin
  select to_jsonb(t) into v_sentinel_before
  from public.user_studio_roles t
  where t.id = '00000000-0000-0000-0000-0000005c4001';

  create temporary table t_fc1b5p0_before_state (key text primary key, value jsonb) on commit drop;
  insert into t_fc1b5p0_before_state values ('sentinel', v_sentinel_before);
end $$;

-- ============================================================================
-- CASE 1 -- ordinary authenticated dancer, zero user_studio_roles rows,
-- cannot insert themselves as studio_owner anywhere.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005c1001')::text, true);

  begin
    insert into public.user_studio_roles (user_id, studio_id, role, active) values
      ('00000000-0000-0000-0000-0000005c1001', '00000000-0000-0000-0000-0000005c0001', 'studio_owner', true);
  exception when insufficient_privilege or others then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5p0-case1: ordinary dancer was able to insert studio_owner for themselves -- INSERT guard is not in effect';
  end if;

  raise notice 'PASS T-fc1b5p0-case1: ordinary authenticated dancer with zero roles cannot self-insert studio_owner';
end $$;

-- ============================================================================
-- CASE 2 -- ordinary dancer cannot insert ANY role at ANY studio (broader
-- than case 1's specific role/studio choice).
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005c1001')::text, true);

  begin
    insert into public.user_studio_roles (user_id, studio_id, role, active) values
      ('00000000-0000-0000-0000-0000005c1001', '00000000-0000-0000-0000-0000005c0002', 'front_desk', true);
  exception when insufficient_privilege or others then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5p0-case2: ordinary dancer was able to insert front_desk at a different studio -- INSERT guard is not in effect';
  end if;

  raise notice 'PASS T-fc1b5p0-case2: ordinary dancer cannot insert any role at any studio';
end $$;

-- ============================================================================
-- CASE 3 -- instructor cannot promote themselves to studio_owner at their
-- own (real, active-membership) studio.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005c1002')::text, true);

  begin
    insert into public.user_studio_roles (user_id, studio_id, role, active) values
      ('00000000-0000-0000-0000-0000005c1002', '00000000-0000-0000-0000-0000005c0001', 'studio_owner', true)
    on conflict (user_id, studio_id, role) do nothing;
  exception when insufficient_privilege or others then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5p0-case3: instructor was able to self-promote to studio_owner';
  end if;

  raise notice 'PASS T-fc1b5p0-case3: instructor cannot self-promote to studio_owner';
end $$;

-- ============================================================================
-- CASE 4 -- independent_instructor cannot self-promote.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005c1003')::text, true);

  begin
    insert into public.user_studio_roles (user_id, studio_id, role, active) values
      ('00000000-0000-0000-0000-0000005c1003', '00000000-0000-0000-0000-0000005c0001', 'studio_admin', true)
    on conflict (user_id, studio_id, role) do nothing;
  exception when insufficient_privilege or others then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5p0-case4: independent_instructor was able to self-promote to studio_admin';
  end if;

  raise notice 'PASS T-fc1b5p0-case4: independent_instructor cannot self-promote';
end $$;

-- ============================================================================
-- CASE 5 -- front_desk cannot self-promote.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005c1004')::text, true);

  begin
    insert into public.user_studio_roles (user_id, studio_id, role, active) values
      ('00000000-0000-0000-0000-0000005c1004', '00000000-0000-0000-0000-0000005c0001', 'studio_admin', true)
    on conflict (user_id, studio_id, role) do nothing;
  exception when insufficient_privilege or others then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5p0-case5: front_desk was able to self-promote to studio_admin';
  end if;

  raise notice 'PASS T-fc1b5p0-case5: front_desk cannot self-promote';
end $$;

-- ============================================================================
-- CASE 6 -- studio_admin cannot grant a role beyond established app rules
-- (e.g. granting platform_admin to another user) via direct insert.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005c1005')::text, true);

  begin
    insert into public.user_studio_roles (user_id, studio_id, role, active) values
      ('00000000-0000-0000-0000-0000005c1001', '00000000-0000-0000-0000-0000005c0001', 'platform_admin', true);
  exception when insufficient_privilege or others then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5p0-case6: studio_admin was able to grant platform_admin to another user via direct insert';
  end if;

  raise notice 'PASS T-fc1b5p0-case6: studio_admin cannot grant platform_admin (or any role) via direct insert -- all direct authenticated grants now go through the application''s service-role path';
end $$;

-- ============================================================================
-- CASE 7 -- existing rows are completely unaffected by the policy change.
-- ============================================================================
do $$
declare
  v_sentinel_before jsonb;
  v_sentinel_after jsonb;
begin
  select value into v_sentinel_before from t_fc1b5p0_before_state where key = 'sentinel';

  select to_jsonb(t) into v_sentinel_after
  from public.user_studio_roles t
  where t.id = '00000000-0000-0000-0000-0000005c4001';

  if v_sentinel_after is distinct from v_sentinel_before then
    raise exception 'FAIL T-fc1b5p0-case7: sentinel row changed after the policy fix and exploit attempts -- before=%, after=%', v_sentinel_before, v_sentinel_after;
  end if;

  raise notice 'PASS T-fc1b5p0-case7: existing user_studio_roles rows are untouched by the policy change and every denied insert attempt above';
end $$;

-- ============================================================================
-- CASE 8 -- the legitimate service_role write path (what
-- upsertTeamMemberRoleAction now uses) still succeeds normally after the
-- guard is in place, proving this is a targeted fix, not a table lockout.
-- ============================================================================
do $$
declare
  v_role_after text;
  v_active_after boolean;
begin
  set local role service_role;

  insert into public.user_studio_roles (user_id, studio_id, role, active) values
    ('00000000-0000-0000-0000-0000005c1006', '00000000-0000-0000-0000-0000005c0001', 'instructor', true)
  on conflict (user_id, studio_id, role) do update set active = true;

  reset role;

  select role, active into v_role_after, v_active_after
  from public.user_studio_roles
  where user_id = '00000000-0000-0000-0000-0000005c1006'
    and studio_id = '00000000-0000-0000-0000-0000005c0001';

  if v_role_after is distinct from 'instructor' or v_active_after is distinct from true then
    raise exception 'FAIL T-fc1b5p0-case8: expected the service-role insert to succeed with role=instructor/active=true, got role=%, active=%', v_role_after, v_active_after;
  end if;

  raise notice 'PASS T-fc1b5p0-case8: the legitimate service_role write path (what upsertTeamMemberRoleAction, accept_pending_team_invitations, and claim_platform_invite all use) still succeeds normally';
end $$;

-- ============================================================================
-- CASE 9 -- catalog confirms no permissive INSERT policy remains for
-- authenticated/anon/public on this table.
-- ============================================================================
do $$
declare
  v_remaining_insert_policies integer;
begin
  select count(*) into v_remaining_insert_policies
  from pg_policies
  where schemaname = 'public'
    and tablename = 'user_studio_roles'
    and cmd = 'INSERT';

  if v_remaining_insert_policies <> 0 then
    raise exception 'FAIL T-fc1b5p0-case9: expected zero INSERT policies on public.user_studio_roles, found %', v_remaining_insert_policies;
  end if;

  raise notice 'PASS T-fc1b5p0-case9: zero INSERT policies remain on public.user_studio_roles -- catalog confirms the vulnerable policy is gone and was not replaced by a new permissive one';
end $$;

rollback;
