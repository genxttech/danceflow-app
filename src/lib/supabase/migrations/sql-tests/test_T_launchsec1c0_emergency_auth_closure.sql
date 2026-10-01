-- LAUNCH-SEC-1C-0 -- emergency authorization closure, live-Postgres
-- regression suite.
--
-- Proves that after 20261007090000_launchsec1c0_emergency_auth_closure.sql:
--   - link_portal_client_by_email(uuid, text) is not executable by PUBLIC,
--     anon or authenticated (an authenticated call is rejected);
--   - client_account_ledger is no longer readable just because the caller's
--     JWT email equals clients.email; a `linked` portal user still reads
--     exactly their own client's ledger; disconnected, former-client and
--     unrelated users read nothing;
--   - accept_pending_team_invitations is not executable by PUBLIC or anon
--     (an anon call is rejected) and is still executable by authenticated;
--   - the three staff ledger policies are unchanged.
-- Entire script runs in one transaction and is rolled back -- nothing
-- persists. Run via `supabase db query --linked --file <this file>` against
-- DEV, AFTER 20261007090000 has been applied. Against the pre-1C-0 state this
-- suite fails -- that is its negative control.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000fdXXXX

begin;

-- ============================================================================
-- PRIVILEGES AND POLICY SHAPE
-- ============================================================================

do $$
declare
  v_names text;
begin
  if has_function_privilege('public', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE') then
    raise exception 'FAIL T-launchsec1c0-link-rpc-not-executable';
  end if;

  if has_function_privilege('public', 'public.accept_pending_team_invitations(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.accept_pending_team_invitations(text)', 'EXECUTE') then
    raise exception 'FAIL T-launchsec1c0-team-rpc-no-anon';
  end if;
  if not has_function_privilege('authenticated', 'public.accept_pending_team_invitations(text)', 'EXECUTE') then
    raise exception 'FAIL T-launchsec1c0-team-rpc-authenticated-kept';
  end if;

  select string_agg(p.policyname || ':' || p.cmd, '|' order by p.policyname) into v_names
  from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'client_account_ledger';
  if v_names is distinct from
    'Linked portal users can read their account ledger:SELECT|'
    || 'Studio users can insert client account ledger:INSERT|'
    || 'Studio users can read client account ledger:SELECT|'
    || 'Studio users can update client account ledger:UPDATE'
  then
    raise exception 'FAIL T-launchsec1c0-ledger-policy-set: %', v_names;
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
      and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~* 'email'
  ) then
    raise exception 'FAIL T-launchsec1c0-ledger-no-email-policy';
  end if;

  raise notice 'PASS T-launchsec1c0-privileges-and-policies';
end $$;

-- ============================================================================
-- FIXTURES (as the migration owner)
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000fd0001', 'LAUNCH-SEC-1C-0 Studio A', 't-launchsec1c0-a'),
  ('00000000-0000-0000-0000-000000fd0002', 'LAUNCH-SEC-1C-0 Studio B', 't-launchsec1c0-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000fd1001', 't-launchsec1c0-linked@example.test'),
  ('00000000-0000-0000-0000-000000fd1002', 't-launchsec1c0-disconnected@example.test'),
  ('00000000-0000-0000-0000-000000fd1003', 't-launchsec1c0-former@example.test'),
  ('00000000-0000-0000-0000-000000fd1004', 't-launchsec1c0-emailmatch@example.test'),
  ('00000000-0000-0000-0000-000000fd1005', 't-launchsec1c0-unrelated@example.test');

insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-000000fd2001', '00000000-0000-0000-0000-000000fd0001', 'T', 'Linked', 't-launchsec1c0-linked@example.test', 'active'),
  ('00000000-0000-0000-0000-000000fd2002', '00000000-0000-0000-0000-000000fd0001', 'T', 'Disconnected', 't-launchsec1c0-disconnected@example.test', 'active'),
  ('00000000-0000-0000-0000-000000fd2003', '00000000-0000-0000-0000-000000fd0001', 'T', 'Former', 't-launchsec1c0-former@example.test', 'active'),
  ('00000000-0000-0000-0000-000000fd2004', '00000000-0000-0000-0000-000000fd0001', 'T', 'EmailMatch', 't-launchsec1c0-emailmatch@example.test', 'active'),
  ('00000000-0000-0000-0000-000000fd2005', '00000000-0000-0000-0000-000000fd0002', 'T', 'EmailMatchB', 't-launchsec1c0-emailmatch@example.test', 'active');

insert into public.client_account_links
  (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email,
   linked_at, claimed_at, disconnected_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000fd3001', '00000000-0000-0000-0000-000000fd0001', '00000000-0000-0000-0000-000000fd2001',
   '00000000-0000-0000-0000-000000fd1001', 'linked', 'self', true, 'studio', 't-launchsec1c0-linked@example.test',
   '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', null, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000fd3002', '00000000-0000-0000-0000-000000fd0001', '00000000-0000-0000-0000-000000fd2002',
   '00000000-0000-0000-0000-000000fd1002', 'disconnected', 'self', false, 'studio', 't-launchsec1c0-disconnected@example.test',
   '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000fd3003', '00000000-0000-0000-0000-000000fd0001', '00000000-0000-0000-0000-000000fd2003',
   '00000000-0000-0000-0000-000000fd1003', 'former_client', 'self', false, 'studio', 't-launchsec1c0-former@example.test',
   '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z');

insert into public.client_account_ledger (id, studio_id, client_id, entry_type, direction, amount, description) values
  ('00000000-0000-0000-0000-000000fd4001', '00000000-0000-0000-0000-000000fd0001', '00000000-0000-0000-0000-000000fd2001', 'credit_added', 'credit', 10, 't-launchsec1c0 linked'),
  ('00000000-0000-0000-0000-000000fd4002', '00000000-0000-0000-0000-000000fd0001', '00000000-0000-0000-0000-000000fd2002', 'credit_added', 'credit', 10, 't-launchsec1c0 disconnected'),
  ('00000000-0000-0000-0000-000000fd4003', '00000000-0000-0000-0000-000000fd0001', '00000000-0000-0000-0000-000000fd2003', 'credit_added', 'credit', 10, 't-launchsec1c0 former'),
  ('00000000-0000-0000-0000-000000fd4004', '00000000-0000-0000-0000-000000fd0001', '00000000-0000-0000-0000-000000fd2004', 'credit_added', 'credit', 10, 't-launchsec1c0 emailmatch A'),
  ('00000000-0000-0000-0000-000000fd4005', '00000000-0000-0000-0000-000000fd0002', '00000000-0000-0000-0000-000000fd2005', 'credit_added', 'credit', 10, 't-launchsec1c0 emailmatch B');

-- ============================================================================
-- LEDGER READ AUTHORIZATION
-- ============================================================================

set local role authenticated;

-- Caller whose JWT email matches two clients' email but who has no link.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fd1004","role":"authenticated","email":"t-launchsec1c0-emailmatch@example.test"}', true);
do $$
declare v integer;
begin
  select count(*) into v from public.client_account_ledger where description like 't-launchsec1c0%';
  if v <> 0 then raise exception 'FAIL T-launchsec1c0-email-match-ledger-read: % visible', v; end if;
  raise notice 'PASS T-launchsec1c0-email-match-denied';
end $$;

-- Established linked portal user keeps access to exactly their own client.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fd1001","role":"authenticated","email":"t-launchsec1c0-linked@example.test"}', true);
do $$
declare v_ids text;
begin
  select string_agg(id::text, ',' order by id) into v_ids
  from public.client_account_ledger where description like 't-launchsec1c0%';
  if v_ids is distinct from '00000000-0000-0000-0000-000000fd4001' then
    raise exception 'FAIL T-launchsec1c0-linked-user-ledger-read: %', v_ids;
  end if;
  raise notice 'PASS T-launchsec1c0-linked-user-keeps-access';
end $$;

-- Disconnected, former-client and unrelated users read nothing (even though
-- the first two have a matching JWT email for their own former client).
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fd1002","role":"authenticated","email":"t-launchsec1c0-disconnected@example.test"}', true);
do $$
declare v integer;
begin
  select count(*) into v from public.client_account_ledger where description like 't-launchsec1c0%';
  if v <> 0 then raise exception 'FAIL T-launchsec1c0-disconnected-ledger-read: % visible', v; end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fd1003","role":"authenticated","email":"t-launchsec1c0-former@example.test"}', true);
do $$
declare v integer;
begin
  select count(*) into v from public.client_account_ledger where description like 't-launchsec1c0%';
  if v <> 0 then raise exception 'FAIL T-launchsec1c0-former-ledger-read: % visible', v; end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fd1005","role":"authenticated","email":"t-launchsec1c0-unrelated@example.test"}', true);
do $$
declare v integer;
begin
  select count(*) into v from public.client_account_ledger where description like 't-launchsec1c0%';
  if v <> 0 then raise exception 'FAIL T-launchsec1c0-unrelated-ledger-read: % visible', v; end if;
  raise notice 'PASS T-launchsec1c0-disconnected-former-unrelated-denied';
end $$;

-- ============================================================================
-- RPC EXECUTION
-- ============================================================================

-- An authenticated caller can no longer link itself to the email-match clients.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fd1005","role":"authenticated","email":"t-launchsec1c0-unrelated@example.test"}', true);
do $$
begin
  begin
    perform public.link_portal_client_by_email(
      '00000000-0000-0000-0000-000000fd1005', 't-launchsec1c0-emailmatch@example.test');
    raise exception 'FAIL T-launchsec1c0-authenticated-link-rpc: call succeeded';
  exception
    when insufficient_privilege then null;
  end;

  -- authenticated still reaches the team RPC (it returns the number of
  -- invitations accepted; there are none for this user).
  if public.accept_pending_team_invitations(null) <> 0 then
    raise exception 'FAIL T-launchsec1c0-authenticated-team-rpc';
  end if;

  raise notice 'PASS T-launchsec1c0-authenticated-rpc-boundaries';
end $$;

reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  begin
    perform public.link_portal_client_by_email(
      '00000000-0000-0000-0000-000000fd1005', 't-launchsec1c0-emailmatch@example.test');
    raise exception 'FAIL T-launchsec1c0-anon-link-rpc: call succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.accept_pending_team_invitations(null);
    raise exception 'FAIL T-launchsec1c0-anon-team-rpc: call succeeded';
  exception
    when insufficient_privilege then null;
  end;

  raise notice 'PASS T-launchsec1c0-anon-rpc-denied';
end $$;

reset role;

-- No client was linked by the rejected calls.
do $$
begin
  if exists (
    select 1 from public.clients
    where id in ('00000000-0000-0000-0000-000000fd2004', '00000000-0000-0000-0000-000000fd2005')
      and portal_user_id is not null
  ) or exists (
    select 1 from public.client_account_links
    where client_id in ('00000000-0000-0000-0000-000000fd2004', '00000000-0000-0000-0000-000000fd2005')
  ) then
    raise exception 'FAIL T-launchsec1c0-no-link-created';
  end if;
  raise notice 'PASS T-launchsec1c0-no-link-created';
end $$;

do $$
begin
  raise notice 'ALL T-launchsec1c0 TESTS PASSED';
end $$;

rollback;
