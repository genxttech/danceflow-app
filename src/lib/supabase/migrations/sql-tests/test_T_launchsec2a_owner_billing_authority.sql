-- LAUNCH-SEC-2A -- organizer self-escalation / organizer billing authority.
--
-- Covers 20261010090000_launchsec2a_owner_billing_authority.sql. One
-- transaction, synthetic fixtures only (UUID block ...0000002a....), rolled
-- back at the end -- nothing persists. Tenant behavior is simulated with
-- `set local role` + request.jwt.claims. Assumes the forward migration has
-- been applied.

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================
--   studio A (...2a0001) with organizer OA (...2a5001)
--   studio B (...2a0002) with organizer OB (...2a5002)
--   studio C (...2a0003) without an organizer
--   ...2a1001 owner A      ...2a1002 instructor A   ...2a1003 front desk A
--   ...2a1004 owner B      ...2a1005 owner C        ...2a1006 victim/target user

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000002a0001', 'LAUNCH-SEC-2A Studio A', 't-launchsec2a-a'),
  ('00000000-0000-0000-0000-0000002a0002', 'LAUNCH-SEC-2A Studio B', 't-launchsec2a-b'),
  ('00000000-0000-0000-0000-0000002a0003', 'LAUNCH-SEC-2A Studio C', 't-launchsec2a-c');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000002a1001', 't-launchsec2a-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000002a1002', 't-launchsec2a-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000002a1003', 't-launchsec2a-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000002a1004', 't-launchsec2a-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000002a1005', 't-launchsec2a-owner-c@example.test'),
  ('00000000-0000-0000-0000-0000002a1006', 't-launchsec2a-target@example.test');

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000002a1001', 't-launchsec2a-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000002a1002', 't-launchsec2a-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000002a1003', 't-launchsec2a-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000002a1004', 't-launchsec2a-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000002a1005', 't-launchsec2a-owner-c@example.test'),
  ('00000000-0000-0000-0000-0000002a1006', 't-launchsec2a-target@example.test');

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000002a1001', '00000000-0000-0000-0000-0000002a0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000002a1002', '00000000-0000-0000-0000-0000002a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000002a1003', '00000000-0000-0000-0000-0000002a0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000002a1004', '00000000-0000-0000-0000-0000002a0002', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000002a1005', '00000000-0000-0000-0000-0000002a0003', 'studio_owner', true);

insert into public.organizers (id, studio_id, name, slug) values
  ('00000000-0000-0000-0000-0000002a5001', '00000000-0000-0000-0000-0000002a0001', 'LAUNCH-SEC-2A Org A', 't-launchsec2a-org-a'),
  ('00000000-0000-0000-0000-0000002a5002', '00000000-0000-0000-0000-0000002a0002', 'LAUNCH-SEC-2A Org B', 't-launchsec2a-org-b');

-- Instructor A already holds a low organizer role (to prove it cannot be raised).
insert into public.organizer_users (organizer_id, user_id, role, active) values
  ('00000000-0000-0000-0000-0000002a5001', '00000000-0000-0000-0000-0000002a1002', 'organizer_staff', true),
  ('00000000-0000-0000-0000-0000002a5002', '00000000-0000-0000-0000-0000002a1004', 'organizer_admin', true);

create function pg_temp.as_user(p_sub text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;

-- ============================================================================
-- S. Shape
-- ============================================================================
do $$
declare v_sec boolean; v_cfg text; v_def text; v_policies text;
begin
  select prosecdef, array_to_string(proconfig, ',') into v_sec, v_cfg
  from pg_proc where oid = 'public._guard_organizers_server_owned_fields()'::regprocedure;
  if v_sec or v_cfg is distinct from 'search_path=public' then
    raise exception 'FAIL T-launchsec2a-S1 guard must be SECURITY INVOKER with search_path=public (%, %)', v_sec, v_cfg;
  end if;

  if has_function_privilege('anon', 'public._guard_organizers_server_owned_fields()', 'execute')
     or has_function_privilege('authenticated', 'public._guard_organizers_server_owned_fields()', 'execute') then
    raise exception 'FAIL T-launchsec2a-S2 guard must not be executable by tenant roles';
  end if;

  select pg_get_triggerdef(oid) into v_def from pg_trigger
  where tgrelid = 'public.organizers'::regclass and tgname = 'guard_organizers_server_owned_fields' and tgenabled = 'O';
  if v_def is null or v_def not like '%BEFORE INSERT OR UPDATE ON public.organizers FOR EACH ROW%' then
    raise exception 'FAIL T-launchsec2a-S3 trigger: %', v_def;
  end if;

  select string_agg(tablename || '.' || policyname || ':' || cmd, ',' order by tablename, policyname) into v_policies
  from pg_policies where schemaname = 'public' and tablename in ('organizers', 'organizer_users');
  if v_policies is distinct from
       'organizer_users.organizer_users_select_by_studio_role_or_self:SELECT,'
    || 'organizers.organizers_public_read_active:SELECT,'
    || 'organizers.organizers_select_by_studio_role:SELECT,'
    || 'organizers.organizers_update_by_studio_role:UPDATE' then
    raise exception 'FAIL T-launchsec2a-S4 policies: %', v_policies;
  end if;

  raise notice 'PASS T-launchsec2a-shape';
end $$;

-- ============================================================================
-- O. organizer_users: no tenant can manufacture organizer authority
-- ============================================================================
do $$
declare v_caller text; v_role text; v_n int;
begin
  -- O1: ordinary members cannot self-assign organizer_owner.
  foreach v_caller in array array['00000000-0000-0000-0000-0000002a1002', '00000000-0000-0000-0000-0000002a1003'] loop
    set local role authenticated;
    perform pg_temp.as_user(v_caller);
    begin
      insert into public.organizer_users (organizer_id, user_id, role, active)
      values ('00000000-0000-0000-0000-0000002a5001', v_caller::uuid, 'organizer_owner', true)
      on conflict (organizer_id, user_id) do update set role = excluded.role;
      raise exception 'FAIL T-launchsec2a-O1 member % self-assigned organizer_owner', v_caller;
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;

  -- O2: a member holding a low organizer role cannot raise it.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1002');
  update public.organizer_users set role = 'organizer_owner'
  where organizer_id = '00000000-0000-0000-0000-0000002a5001'
    and user_id = '00000000-0000-0000-0000-0000002a1002';
  get diagnostics v_n = row_count;
  reset role;
  select role into v_role from public.organizer_users
  where organizer_id = '00000000-0000-0000-0000-0000002a5001' and user_id = '00000000-0000-0000-0000-0000002a1002';
  if v_n <> 0 or v_role <> 'organizer_staff' then
    raise exception 'FAIL T-launchsec2a-O2 instructor raised own organizer role (% rows, role %)', v_n, v_role;
  end if;

  -- O3: ordinary members cannot assign a privileged organizer role to another user.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1002');
  begin
    insert into public.organizer_users (organizer_id, user_id, role, active)
    values ('00000000-0000-0000-0000-0000002a5001', '00000000-0000-0000-0000-0000002a1006', 'organizer_admin', true);
    raise exception 'FAIL T-launchsec2a-O3 instructor granted organizer_admin to another user';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- O4: cross-studio -- owner B cannot insert into or update organizer A's access.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1004');
  begin
    insert into public.organizer_users (organizer_id, user_id, role, active)
    values ('00000000-0000-0000-0000-0000002a5001', '00000000-0000-0000-0000-0000002a1004', 'organizer_owner', true);
    raise exception 'FAIL T-launchsec2a-O4 cross-studio organizer_users insert';
  exception when insufficient_privilege then null;
  end;
  update public.organizer_users set role = 'organizer_owner'
  where organizer_id = '00000000-0000-0000-0000-0000002a5001';
  get diagnostics v_n = row_count;
  reset role;
  if v_n <> 0 then
    raise exception 'FAIL T-launchsec2a-O4 cross-studio organizer_users update touched % rows', v_n;
  end if;

  -- O5: owner B cannot raise its own row on its own organizer by tenant write
  -- either (organizer access is server-managed for every tenant role).
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1004');
  update public.organizer_users set role = 'organizer_owner'
  where organizer_id = '00000000-0000-0000-0000-0000002a5002';
  get diagnostics v_n = row_count;
  reset role;
  if v_n <> 0 then
    raise exception 'FAIL T-launchsec2a-O5 tenant organizer_users update touched % rows', v_n;
  end if;

  -- O6: anon cannot write either table.
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin
    insert into public.organizer_users (organizer_id, user_id, role)
    values ('00000000-0000-0000-0000-0000002a5001', '00000000-0000-0000-0000-0000002a1006', 'organizer_owner');
    raise exception 'FAIL T-launchsec2a-O6 anon organizer_users insert';
  exception when insufficient_privilege then null;
  end;
  update public.organizers set subscription_status = 'active' where id = '00000000-0000-0000-0000-0000002a5001';
  get diagnostics v_n = row_count;
  reset role;
  if v_n <> 0 then
    raise exception 'FAIL T-launchsec2a-O6 anon organizers update touched % rows', v_n;
  end if;

  if (select count(*) from public.organizer_users where organizer_id in (
        '00000000-0000-0000-0000-0000002a5001', '00000000-0000-0000-0000-0000002a5002')) <> 2 then
    raise exception 'FAIL T-launchsec2a-O organizer_users fixture rows changed';
  end if;

  raise notice 'PASS T-launchsec2a-organizer-users';
end $$;

-- ============================================================================
-- N. organizers creation is server-only (it is born with an active trial)
-- ============================================================================
do $$
begin
  -- Even a studio owner cannot create an organizer by tenant write.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1005');
  begin
    insert into public.organizers (studio_id, name, slug)
    values ('00000000-0000-0000-0000-0000002a0003', 'Self-made Org', 't-launchsec2a-org-c');
    raise exception 'FAIL T-launchsec2a-N1 tenant organizer insert';
  exception when insufficient_privilege then null;
  end;
  reset role;

  if exists (select 1 from public.organizers where studio_id = '00000000-0000-0000-0000-0000002a0003') then
    raise exception 'FAIL T-launchsec2a-N1 organizer row created';
  end if;

  raise notice 'PASS T-launchsec2a-organizer-creation';
end $$;

-- ============================================================================
-- F. organizers: server-owned identity/billing/payment fields
-- ============================================================================
do $$
declare v_set text; v_n int; v_desc text;
begin
  foreach v_set in array array[
    'subscription_status = ''active''',
    'platform_fee_bps = 0',
    'stripe_customer_id = ''cus_attacker''',
    'stripe_subscription_id = ''sub_attacker''',
    'stripe_connected_account_id = ''acct_attacker''',
    'stripe_connect_details_submitted = true',
    'stripe_connect_charges_enabled = true',
    'stripe_connect_payouts_enabled = true',
    'stripe_connect_onboarding_complete = true',
    'studio_id = ''00000000-0000-0000-0000-0000002a0002''',
    'id = ''00000000-0000-0000-0000-0000002a5009''',
    -- The guard (BEFORE trigger) runs before the billing_plan check
    -- constraint, so the guard's own error proves it for billing_plan too.
    'billing_plan = ''enterprise'''
  ] loop
    -- F1: instructor (an ordinary member allowed to edit the profile).
    set local role authenticated;
    perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1002');
    begin
      execute format('update public.organizers set %s where id = %L', v_set, '00000000-0000-0000-0000-0000002a5001');
      raise exception 'FAIL T-launchsec2a-F1 instructor changed organizers.%', v_set;
    exception when insufficient_privilege then
      if sqlerrm <> 'organizers billing and payment fields cannot be changed by this role.' then
        raise exception 'FAIL T-launchsec2a-F1 unexpected error for %: %', v_set, sqlerrm;
      end if;
    end;
    reset role;

    -- F2: the studio owner is equally blocked (server-owned, not owner-owned).
    set local role authenticated;
    perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1001');
    begin
      execute format('update public.organizers set %s where id = %L', v_set, '00000000-0000-0000-0000-0000002a5001');
      raise exception 'FAIL T-launchsec2a-F2 owner changed organizers.%', v_set;
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;

  -- F3: profile edits still work for members, including a save that repeats
  -- an unchanged protected value (the guard compares values, not columns).
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1002');
  update public.organizers set billing_plan = 'organizer', description = 'Edited by instructor'
  where id = '00000000-0000-0000-0000-0000002a5001';
  get diagnostics v_n = row_count;
  reset role;
  select description into v_desc from public.organizers where id = '00000000-0000-0000-0000-0000002a5001';
  if v_n <> 1 or v_desc <> 'Edited by instructor' then
    raise exception 'FAIL T-launchsec2a-F3 profile edit by a member no longer works (% rows)', v_n;
  end if;

  -- F4: cross-studio profile edit is still denied by RLS (0 rows).
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1004');
  update public.organizers set description = 'cross-studio' where id = '00000000-0000-0000-0000-0000002a5001';
  get diagnostics v_n = row_count;
  reset role;
  if v_n <> 0 then
    raise exception 'FAIL T-launchsec2a-F4 cross-studio organizer update touched % rows', v_n;
  end if;

  if exists (
    select 1 from public.organizers
    where id = '00000000-0000-0000-0000-0000002a5001'
      and (subscription_status <> 'trialing' or platform_fee_bps <> 350
           or stripe_customer_id is not null or stripe_subscription_id is not null
           or stripe_connected_account_id is not null
           or stripe_connect_details_submitted or stripe_connect_charges_enabled
           or stripe_connect_payouts_enabled or stripe_connect_onboarding_complete
           or studio_id <> '00000000-0000-0000-0000-0000002a0001')
  ) then
    raise exception 'FAIL T-launchsec2a-F protected organizer fields changed';
  end if;

  raise notice 'PASS T-launchsec2a-organizer-protected-fields';
end $$;

-- ============================================================================
-- T. Trusted server paths still work
-- ============================================================================
do $$
declare v_org uuid;
begin
  -- T1: createOrganizerAction's writes (service role).
  set local role service_role;
  insert into public.organizers (studio_id, name, slug, active)
  values ('00000000-0000-0000-0000-0000002a0003', 'Server-made Org C', 't-launchsec2a-org-c', true)
  returning id into v_org;
  insert into public.organizer_users (organizer_id, user_id, role, active)
  values (v_org, '00000000-0000-0000-0000-0000002a1005', 'organizer_admin', true)
  on conflict (organizer_id, user_id) do update set role = excluded.role, active = excluded.active;

  -- T2: server-side billing updates.
  update public.organizers
     set subscription_status = 'active', platform_fee_bps = 250,
         stripe_connected_account_id = 'acct_server', stripe_connect_charges_enabled = true
   where id = v_org;
  reset role;

  if not exists (
    select 1 from public.organizers
    where id = v_org and subscription_status = 'active' and platform_fee_bps = 250
      and stripe_connected_account_id = 'acct_server' and stripe_connect_charges_enabled
  ) or not exists (
    select 1 from public.organizer_users
    where organizer_id = v_org and user_id = '00000000-0000-0000-0000-0000002a1005' and role = 'organizer_admin'
  ) then
    raise exception 'FAIL T-launchsec2a-T1/T2 trusted server writes';
  end if;

  -- T3: the created owner can read it back through tenant RLS.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002a1005');
  if not exists (select 1 from public.organizer_users where organizer_id = v_org)
     or not exists (select 1 from public.organizers where id = v_org) then
    raise exception 'FAIL T-launchsec2a-T3 owner cannot read the server-created organizer';
  end if;
  reset role;

  -- T4: the role allowlist still holds, even for the service role.
  set local role service_role;
  begin
    insert into public.organizer_users (organizer_id, user_id, role)
    values (v_org, '00000000-0000-0000-0000-0000002a1006', 'organizer_superuser');
    raise exception 'FAIL T-launchsec2a-T4 role allowlist not enforced';
  exception when check_violation then null;
  end;
  reset role;

  raise notice 'PASS T-launchsec2a-trusted-paths';
end $$;

do $$
begin
  raise notice 'ALL T-launchsec2a TESTS PASSED';
end $$;

rollback;
