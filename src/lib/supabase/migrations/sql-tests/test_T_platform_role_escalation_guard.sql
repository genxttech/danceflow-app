-- Platform Role Escalation Hotfix -- regression suite.
--
-- Covers 20260918060000_platform_role_escalation_guard.sql. One transaction,
-- synthetic fixtures only (UUID block 00000000-0000-0000-0000-00001b0XXXXX),
-- rolled back at the end -- nothing persists and no real profile is touched.
-- Tenant behavior is simulated with `set local role` + request.jwt.claims
-- (the pattern used by the Landmark 1A suites). Assumes the forward
-- migration has been applied.

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================
--   ...b0001  normal user A            ...b0002  normal user B
--   ...b0003  legitimate platform admin (role set by postgres)
--   ...b0004  user C -- auth user, NO profile yet (bootstrap insert)
--   ...b0005  user D -- auth user, NO profile yet (malicious insert)
--   ...b0006  user E -- normal user, used for trusted-caller cases

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00001b000001', 't-pr-a@example.test'),
  ('00000000-0000-0000-0000-00001b000002', 't-pr-b@example.test'),
  ('00000000-0000-0000-0000-00001b000003', 't-pr-admin@example.test'),
  ('00000000-0000-0000-0000-00001b000004', 't-pr-c@example.test'),
  ('00000000-0000-0000-0000-00001b000005', 't-pr-d@example.test'),
  ('00000000-0000-0000-0000-00001b000006', 't-pr-e@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00001b000001', 't-pr-a@example.test', 'User A'),
  ('00000000-0000-0000-0000-00001b000002', 't-pr-b@example.test', 'User B'),
  ('00000000-0000-0000-0000-00001b000006', 't-pr-e@example.test', 'User E');

-- Admin profile created by postgres (a trusted caller) with the role set.
insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-00001b000003', 't-pr-admin@example.test', 'Admin', 'platform_admin');

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001b0f1000', 'PR Test Studio', 't-pr-studio');

-- ============================================================================
-- S. Static definition checks
-- ============================================================================
do $$
declare v_def text; v_sec boolean; v_cfg text;
begin
  select prosecdef, array_to_string(proconfig, ',') into v_sec, v_cfg
  from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_profiles_platform_role';
  assert v_sec = false, 'S1 FAILED: guard function must be SECURITY INVOKER so current_user is the real caller';
  assert v_cfg = 'search_path=public', format('S1 FAILED: search_path config is %s', v_cfg);

  select pg_get_triggerdef(oid) into v_def from pg_trigger
   where tgname = 'guard_profiles_platform_role' and tgrelid = 'public.profiles'::regclass;
  assert v_def like '%BEFORE INSERT OR UPDATE OF platform_role ON public.profiles FOR EACH ROW%',
    format('S2 FAILED: trigger definition: %s', v_def);

  -- No circular authorization: the guard body must not read platform_role of any row.
  select prosrc into v_def from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_profiles_platform_role';
  assert v_def !~* 'select[^;]*platform_role|from\s+(public\.)?profiles', 'S3 FAILED: guard must not consult profiles/platform_role to authorize';
  assert v_def ~ 'current_user in \(''anon'', ''authenticated''\)', 'S3 FAILED: guard must key on the database role';

  assert not has_function_privilege('authenticated', 'public._guard_profiles_platform_role()', 'execute'), 'S4 FAILED: guard function must not be executable by authenticated';
  raise notice 'S1-S4 PASSED: SECURITY INVOKER, search_path, trigger definition, non-circular, privileges';
end $$;

-- ============================================================================
-- T. Tenant UPDATE behavior
-- ============================================================================
do $$
declare v_err text; v_n int; v_role text; v_name text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000001', 'email', 't-pr-a@example.test')::text, true);

  -- T1. Own normal-field update succeeds.
  update public.profiles set full_name = 'User A Renamed' where id = '00000000-0000-0000-0000-00001b000001';
  get diagnostics v_n = row_count;
  assert v_n = 1, 'T1 FAILED: own profile edit should update 1 row';

  -- T2. Own null -> platform_admin fails.
  begin
    update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b000001';
    assert false, 'T2 FAILED: tenant self-escalation was allowed';
  exception when others then
    assert sqlerrm like 'profiles.platform_role cannot be changed%', format('T2 FAILED: unexpected error: %s', sqlerrm);
  end;

  -- T2b. Any other value is rejected too (by the guard or by the CHECK); never persisted.
  begin
    update public.profiles set platform_role = 'super_admin' where id = '00000000-0000-0000-0000-00001b000001';
    assert false, 'T2b FAILED: arbitrary privileged value was allowed';
  exception when others then
    assert sqlerrm like 'profiles.platform_role cannot be changed%' or sqlerrm like '%profiles_platform_role_check%', format('T2b FAILED: unexpected error: %s', sqlerrm);
  end;

  -- T4. Mixed normal-field + role update fails atomically.
  begin
    update public.profiles set full_name = 'Should Not Stick', platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b000001';
    assert false, 'T4 FAILED: mixed update was allowed';
  exception when others then
    assert sqlerrm like 'profiles.platform_role cannot be changed%', format('T4 FAILED: unexpected error: %s', sqlerrm);
  end;

  -- T5. Cross-user update still affects 0 rows.
  update public.profiles set full_name = 'Hijacked' where id = '00000000-0000-0000-0000-00001b000002';
  get diagnostics v_n = row_count;
  assert v_n = 0, 'T5 FAILED: cross-user update touched a row';
  begin
    update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b000002';
    get diagnostics v_n = row_count;
    assert v_n = 0, 'T5 FAILED: cross-user role escalation touched a row';
  exception when others then
    null; -- rejected outright is also acceptable
  end;
  reset role;

  select platform_role, full_name into v_role, v_name from public.profiles where id = '00000000-0000-0000-0000-00001b000001';
  assert v_role is null, 'T2/T4 FAILED: A must remain a normal user';
  assert v_name = 'User A Renamed', format('T4 FAILED: atomicity broken, full_name=%s', v_name);
  assert (select full_name from public.profiles where id = '00000000-0000-0000-0000-00001b000002') = 'User B', 'T5 FAILED: B was modified';

  -- T3. Even the legitimate admin, acting through the tenant role, cannot change platform_role
  -- (removal is a trusted-caller operation), and a failed attempt leaves it intact.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000003', 'email', 't-pr-admin@example.test')::text, true);
  begin
    update public.profiles set platform_role = null where id = '00000000-0000-0000-0000-00001b000003';
    assert false, 'T3 FAILED: tenant-context demotion was allowed';
  exception when others then
    assert sqlerrm like 'profiles.platform_role cannot be changed%', format('T3 FAILED: unexpected error: %s', sqlerrm);
  end;
  -- ...but the admin can still edit ordinary fields.
  update public.profiles set full_name = 'Admin Renamed' where id = '00000000-0000-0000-0000-00001b000003';
  get diagnostics v_n = row_count;
  assert v_n = 1, 'R3 FAILED: admin ordinary edit should work';
  reset role;
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000003') = 'platform_admin', 'T3 FAILED: admin lost the role';

  raise notice 'T1-T5, R3 PASSED: tenant updates (normal ok; escalation/demotion/mixed rejected atomically; cross-user 0 rows)';
end $$;

-- ============================================================================
-- A. anon role
-- ============================================================================
do $$
declare v_n int; v_err text;
begin
  -- A1. anon cannot write via the real policies (no matching policy / no auth.uid()).
  set local role anon;
  perform set_config('request.jwt.claims', '{}', true);
  begin
    update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b000001';
    get diagnostics v_n = row_count;
    assert v_n = 0, 'A1 FAILED: anon update touched a row';
  exception when others then
    null;
  end;
  begin
    insert into public.profiles (id, email, platform_role) values ('00000000-0000-0000-0000-00001b000005', 't-pr-d@example.test', 'platform_admin');
    assert false, 'A1 FAILED: anon insert with platform_admin was allowed';
  exception when others then
    null;
  end;
  reset role;
  assert (select count(*) from public.profiles where id = '00000000-0000-0000-0000-00001b000005') = 0, 'A1 FAILED: anon insert persisted';

  -- A2. Prove the GUARD ITSELF (not just RLS) rejects anon: open the policy in this
  -- rolled-back transaction, then attempt the change as anon.
  create policy t_pr_anon_open on public.profiles for all to anon using (true) with check (true);
  set local role anon;
  begin
    update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b000001';
    assert false, 'A2 FAILED: anon change passed once RLS was opened -- guard missing for anon';
  exception when others then
    assert sqlerrm like 'profiles.platform_role cannot be changed%', format('A2 FAILED: unexpected error: %s', sqlerrm);
  end;
  begin
    insert into public.profiles (id, email, platform_role) values ('00000000-0000-0000-0000-00001b000005', 't-pr-d@example.test', 'platform_admin');
    assert false, 'A2 FAILED: anon insert passed once RLS was opened';
  exception when others then
    assert sqlerrm like 'profiles.platform_role cannot be set%', format('A2 FAILED: unexpected error: %s', sqlerrm);
  end;
  reset role;
  drop policy t_pr_anon_open on public.profiles;

  raise notice 'A1-A2 PASSED: anon rejected by RLS, and by the guard even if RLS were opened';
end $$;

-- ============================================================================
-- I. INSERT / bootstrap / upsert
-- ============================================================================
do $$
declare v_n int; v_role text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000004', 'email', 't-pr-c@example.test')::text, true);

  -- I1. Normal bootstrap (NULL role) succeeds.
  insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00001b000004', 't-pr-c@example.test', 'User C');
  assert (select count(*) from public.profiles where id = '00000000-0000-0000-0000-00001b000004') = 1, 'I1 FAILED: bootstrap insert';

  -- I2. Bootstrap with a privileged value fails (user D, own id).
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000005', 'email', 't-pr-d@example.test')::text, true);
  begin
    insert into public.profiles (id, email, platform_role) values ('00000000-0000-0000-0000-00001b000005', 't-pr-d@example.test', 'platform_admin');
    assert false, 'I2 FAILED: tenant INSERT with platform_admin was allowed';
  exception when others then
    assert sqlerrm like 'profiles.platform_role cannot be set%', format('I2 FAILED: unexpected error: %s', sqlerrm);
  end;

  -- I3. The app's upsertProfile shape (INSERT .. ON CONFLICT DO UPDATE of email/full_name only)
  -- works for a brand-new user, an existing normal user, and the existing admin, and
  -- never changes platform_role.
  insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00001b000005', 't-pr-d@example.test', 'User D')
    on conflict (id) do update set email = excluded.email, full_name = excluded.full_name;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000001', 'email', 't-pr-a@example.test')::text, true);
  insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00001b000001', 't-pr-a@example.test', 'User A Upserted')
    on conflict (id) do update set email = excluded.email, full_name = excluded.full_name;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000003', 'email', 't-pr-admin@example.test')::text, true);
  insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00001b000003', 't-pr-admin@example.test', 'Admin Upserted')
    on conflict (id) do update set email = excluded.email, full_name = excluded.full_name;
  reset role;

  assert (select full_name from public.profiles where id = '00000000-0000-0000-0000-00001b000001') = 'User A Upserted', 'I3 FAILED: normal upsert';
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000003') = 'platform_admin', 'I3 FAILED: admin upsert changed the role';
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000001') is null, 'I3 FAILED: normal upsert changed the role';
  raise notice 'I1-I3 PASSED: bootstrap ok; privileged INSERT rejected; upsertProfile shape works for new/normal/admin without changing role';
end $$;

-- ============================================================================
-- P. Trusted callers
-- ============================================================================
do $$
declare v_n int;
begin
  -- P1. service_role sets and clears (the admin-client path).
  set local role service_role;
  update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b000006';
  reset role;
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000006') = 'platform_admin', 'P1 FAILED: service_role could not set';
  set local role service_role;
  update public.profiles set platform_role = null where id = '00000000-0000-0000-0000-00001b000006';
  reset role;
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000006') is null, 'P1 FAILED: service_role could not clear';

  -- P2. The portal-repair upsert shape (service_role, explicit platform_role: null) still works.
  set local role service_role;
  insert into public.profiles (id, email, full_name, platform_role, updated_at)
  values ('00000000-0000-0000-0000-00001b000006', 't-pr-e@example.test', 'User E Repaired', null, now())
  on conflict (id) do update set email = excluded.email, full_name = excluded.full_name, platform_role = excluded.platform_role, updated_at = excluded.updated_at;
  reset role;
  assert (select full_name from public.profiles where id = '00000000-0000-0000-0000-00001b000006') = 'User E Repaired', 'P2 FAILED: portal-repair upsert';

  -- P3. postgres (migrations / dashboard SQL) sets and clears.
  update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b000006';
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000006') = 'platform_admin', 'P3 FAILED';
  update public.profiles set platform_role = null where id = '00000000-0000-0000-0000-00001b000006';
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000006') is null, 'P3 FAILED';

  -- P4. A SECURITY DEFINER function runs as its owner and passes the guard (documented review
  -- rule: no tenant-callable definer function may write platform_role; none exists today).
  create function public._t_pr_definer_set(p_id uuid, p_role text) returns void
    language sql security definer set search_path = 'public' as $f$ update public.profiles set platform_role = p_role where id = p_id $f$;
  grant execute on function public._t_pr_definer_set(uuid, text) to authenticated;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000006', 'email', 't-pr-e@example.test')::text, true);
  perform public._t_pr_definer_set('00000000-0000-0000-0000-00001b000006', 'platform_admin');
  reset role;
  assert (select platform_role from public.profiles where id = '00000000-0000-0000-0000-00001b000006') = 'platform_admin', 'P4 FAILED: definer owner context should pass';
  drop function public._t_pr_definer_set(uuid, text);
  update public.profiles set platform_role = null where id = '00000000-0000-0000-0000-00001b000006';

  raise notice 'P1-P4 PASSED: service_role set/clear, portal-repair upsert, postgres, definer-owner context';
end $$;

-- ============================================================================
-- R. Regression: the authority the field protects still works for a legitimate admin
-- ============================================================================
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000003', 'email', 't-pr-admin@example.test')::text, true);
  assert public.user_has_studio_access('00000000-0000-0000-0000-00001b0f1000') = true, 'R1 FAILED: legitimate admin lost user_has_studio_access';
  assert public._landmark1a_can_manage_instructors('00000000-0000-0000-0000-00001b0f1000') = true, 'R2 FAILED: legitimate admin lost instructor-management authority';

  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b000001', 'email', 't-pr-a@example.test')::text, true);
  assert public.user_has_studio_access('00000000-0000-0000-0000-00001b0f1000') = false, 'R4 FAILED: normal user must not have cross-studio access';
  assert public._landmark1a_can_manage_instructors('00000000-0000-0000-0000-00001b0f1000') = false, 'R4 FAILED: normal user must not manage instructors';
  assert (select count(*) from public.profiles where platform_role is not null and id in
    ('00000000-0000-0000-0000-00001b000001','00000000-0000-0000-0000-00001b000002','00000000-0000-0000-0000-00001b000004','00000000-0000-0000-0000-00001b000005','00000000-0000-0000-0000-00001b000006')) = 0,
    'R4 FAILED: a normal fixture user became privileged';

  raise notice 'R1-R4 PASSED: legitimate admin keeps its authority; normal users remain non-admin';
  raise notice 'PLATFORM ROLE ESCALATION GUARD SQL REGRESSION: ALL CASE GROUPS PASSED';
end $$;

rollback;
