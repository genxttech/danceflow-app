-- LAUNCH-SEC-1C-0-R -- PROD-compatible authorization closure, live-Postgres
-- regression suite.
--
-- Exercises 20261007093000_launchsec1c0r_prod_compatible_auth_closure.sql's
-- state classifier and apply block (embedded byte-identically below; a
-- Vitest invariant enforces that) against DEV:
--   - DEV (already hardened by 20261007090000) is classified STATE B and the
--     apply block is an exact catalog no-op;
--   - the reviewed vulnerable STATE A is recognized and hardened to a catalog
--     identical to DEV's hardened state;
--   - a CRLF copy of accept_pending_team_invitations still matches, while a
--     real body change (LF or CRLF) does not;
--   - every partial / drifted state fails closed;
--   - in the hardened state, ledger reads are relationship-based only, the
--     link RPC is not executable by anon/authenticated, and the team RPC is
--     executable by authenticated but not anon.
-- Nothing here invokes link_portal_client_by_email successfully, touches real
-- data, or persists anything: the whole script is rolled back. Run via
-- `supabase db query --linked --file <this file>` against DEV.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000feXXXX

begin;

-- >>> LAUNCH-SEC-1C-0-R CLASSIFIER (keep byte-identical in the migration, its rollback and the SQL test)
create or replace function pg_temp.launchsec1c0r_state()
returns text
language plpgsql
as $classifier$
declare
  v_link_acl text;
  v_accept_acl text;
  v_link_state text;
  v_accept_state text;
  v_ledger_state text;
  v_old boolean;
  v_new boolean;
begin
  if (select count(*) from pg_proc where proname = 'link_portal_client_by_email') <> 1
     or (select count(*) from pg_proc where proname = 'accept_pending_team_invitations') <> 1
     or (select count(*) from pg_proc where proname = 'user_has_client_portal_access') <> 1 then
    raise exception 'LAUNCH-SEC-1C-0-R: unexpected function overload';
  end if;

  select (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x)
    into v_link_acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname = 'link_portal_client_by_email'
    and pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_email text'
    and p.prosecdef and l.lanname = 'plpgsql' and p.provolatile = 'v'
    and pg_get_userbyid(p.proowner) = 'postgres'
    and p.proconfig = array['search_path=public']
    and md5(p.prosrc) = '29924b718d74a26328cc54c5664ecf89';
  if not found then
    raise exception 'LAUNCH-SEC-1C-0-R: link_portal_client_by_email is not the reviewed definition';
  end if;

  -- Only carriage returns are removed before fingerprinting this body.
  select (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x)
    into v_accept_acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname = 'accept_pending_team_invitations'
    and pg_get_function_identity_arguments(p.oid) = 'p_email text'
    and p.prosecdef and l.lanname = 'plpgsql' and p.provolatile = 'v'
    and pg_get_userbyid(p.proowner) = 'postgres'
    and p.proconfig = array['search_path=public']
    and md5(replace(p.prosrc, E'\r', '')) = 'ac27bfd4e6ad4d9d38bcd5762747ea90';
  if not found then
    raise exception 'LAUNCH-SEC-1C-0-R: accept_pending_team_invitations is not the reviewed definition';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public'
      and p.proname = 'user_has_client_portal_access'
      and pg_get_function_identity_arguments(p.oid) = 'target_studio_id uuid, target_client_id uuid'
      and p.prosecdef and l.lanname = 'sql' and p.provolatile = 's'
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.proconfig = array['search_path=public']
      and md5(p.prosrc) = 'c0b5901eaad8130f2b6ee6d983687483'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x)
          = 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'
  ) then
    raise exception 'LAUNCH-SEC-1C-0-R: user_has_client_portal_access is not the reviewed definition';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.client_account_ledger'::regclass) then
    raise exception 'LAUNCH-SEC-1C-0-R: client_account_ledger RLS is not enabled';
  end if;

  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'client_account_ledger') <> 4
     or (
       select count(*) from pg_policies p
       where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
         and p.permissive = 'PERMISSIVE' and p.roles = array['authenticated']::name[]
         and (
           (p.policyname = 'Studio users can insert client account ledger' and p.cmd = 'INSERT'
             and p.qual is null and md5(p.with_check) = '7f552e02a161934a62947e7cd562f35d')
           or (p.policyname = 'Studio users can read client account ledger' and p.cmd = 'SELECT'
             and md5(p.qual) = '493593a8cb85e8ee1eb2a59402ed0aca' and p.with_check is null)
           or (p.policyname = 'Studio users can update client account ledger' and p.cmd = 'UPDATE'
             and md5(p.qual) = '31221fbfe83cb563e75f9c05ca87a97a'
             and md5(p.with_check) = '31221fbfe83cb563e75f9c05ca87a97a')
         )
     ) <> 3 then
    raise exception 'LAUNCH-SEC-1C-0-R: client_account_ledger policy set is not the reviewed set';
  end if;

  select exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
      and p.policyname = 'Clients can read their own account ledger'
      and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT'
      and p.roles = array['authenticated']::name[]
      and md5(p.qual) = 'a83e4d10340eea48d15744a10ef2ddf5' and p.with_check is null
  ) into v_old;
  select exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
      and p.policyname = 'Linked portal users can read their account ledger'
      and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT'
      and p.roles = array['authenticated']::name[]
      and md5(p.qual) = 'e110929c652dcb4ae89439a1a1abb39d' and p.with_check is null
  ) into v_new;

  v_link_state := case v_link_acl
    when 'anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then 'A'
    when 'postgres=X/postgres,service_role=X/postgres' then 'B'
  end;
  v_accept_state := case v_accept_acl
    when '=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then 'A'
    when 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then 'B'
  end;
  v_ledger_state := case
    when v_old and not v_new then 'A'
    when v_new and not v_old then 'B'
  end;

  if v_link_state is not null
     and v_link_state = v_accept_state
     and v_link_state = v_ledger_state then
    return v_link_state;
  end if;

  raise exception 'LAUNCH-SEC-1C-0-R: partial or unexpected state (link=%, team=%, ledger=%)',
    coalesce(v_link_state, '?'), coalesce(v_accept_state, '?'), coalesce(v_ledger_state, '?');
end;
$classifier$;
-- <<< LAUNCH-SEC-1C-0-R CLASSIFIER

-- Catalog fingerprint of every object this slice could touch or must not
-- touch: all public functions (sorted ACL, body, security, config, owner),
-- all public/storage policies, the portal-sync trigger and the relevant
-- unique indexes.
create or replace function pg_temp.launchsec1c0r_fp()
returns text
language sql
as $fp$
  select md5(string_agg(line, E'\n' order by line)) from (
    select 'fn|' || p.oid::regprocedure::text || '|'
      || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x), '')
      || '|' || md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '')
      || '|' || pg_get_userbyid(p.proowner) as line
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union all
    select 'policy|' || schemaname || '.' || tablename || '.' || policyname || '|'
      || md5(row(permissive, roles, cmd, qual, with_check)::text)
    from pg_policies where schemaname in ('public', 'storage')
    union all
    select 'trigger|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_get_triggerdef(t.oid)
    from pg_trigger t where t.tgname = 'clients_sync_portal_user_to_account_link'
    union all
    select 'index|' || indexname || '|' || indexdef
    from pg_indexes where schemaname = 'public' and tablename in ('client_account_links', 'clients')
  ) s;
$fp$;

create temporary table launchsec1c0r_baseline (fp text) on commit drop;
insert into launchsec1c0r_baseline select pg_temp.launchsec1c0r_fp();

-- ============================================================================
-- STATE B: DEV is the exact hardened state and the apply block is a no-op
-- ============================================================================

do $$
begin
  if pg_temp.launchsec1c0r_state() <> 'B' then
    raise exception 'FAIL T-launchsec1c0r-dev-is-state-b';
  end if;
  raise notice 'PASS T-launchsec1c0r-dev-is-state-b';
end $$;

do $$
declare
  v_start text := pg_temp.launchsec1c0r_state();
begin
  if v_start = 'A' then
    execute 'revoke execute on function public.link_portal_client_by_email(uuid, text) from public, anon, authenticated';
    execute 'revoke execute on function public.accept_pending_team_invitations(text) from public, anon';
    execute 'drop policy "Clients can read their own account ledger" on public.client_account_ledger';
    execute 'create policy "Linked portal users can read their account ledger" on public.client_account_ledger'
      || ' for select to authenticated using (public.user_has_client_portal_access(studio_id, client_id))';
  end if;

  if pg_temp.launchsec1c0r_state() <> 'B' then
    raise exception 'LAUNCH-SEC-1C-0-R: hardened state was not reached';
  end if;

  raise notice 'LAUNCH-SEC-1C-0-R: starting state %, final state B', v_start;
end $$;

do $$
begin
  if pg_temp.launchsec1c0r_fp() <> (select fp from launchsec1c0r_baseline) then
    raise exception 'FAIL T-launchsec1c0r-state-b-exact-noop';
  end if;
  raise notice 'PASS T-launchsec1c0r-state-b-exact-noop';
end $$;

-- ============================================================================
-- LINE ENDINGS: CRLF accepted, real body change rejected
-- ============================================================================

do $$
declare
  v_def text := pg_get_functiondef('public.accept_pending_team_invitations(text)'::regprocedure);
  v_result text;
begin
  -- CRLF copy of the reviewed body.
  begin
    execute replace(v_def, E'\n', E'\r\n');
    if md5((select prosrc from pg_proc where oid = 'public.accept_pending_team_invitations(text)'::regprocedure))
       = 'ac27bfd4e6ad4d9d38bcd5762747ea90' then
      v_result := 'crlf-not-applied';
    else
      v_result := pg_temp.launchsec1c0r_state();
    end if;
    raise exception 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL';
  exception when others then
    if sqlerrm <> 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL' then v_result := 'error: ' || sqlerrm; end if;
  end;
  if v_result is distinct from 'B' then
    raise exception 'FAIL T-launchsec1c0r-crlf-body-accepted: %', v_result;
  end if;

  -- Real body change, LF.
  v_result := null;
  begin
    execute replace(v_def, 'v_count := v_count + 1;', 'v_count := v_count + 2;');
    v_result := 'accepted:' || pg_temp.launchsec1c0r_state();
    raise exception 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL';
  exception when others then
    if sqlerrm <> 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL' then v_result := sqlerrm; end if;
  end;
  if v_result is distinct from 'LAUNCH-SEC-1C-0-R: accept_pending_team_invitations is not the reviewed definition' then
    raise exception 'FAIL T-launchsec1c0r-lf-body-change-rejected: %', v_result;
  end if;

  -- Real body change, CRLF.
  v_result := null;
  begin
    execute replace(replace(v_def, 'v_count := v_count + 1;', 'v_count := v_count + 2;'), E'\n', E'\r\n');
    v_result := 'accepted:' || pg_temp.launchsec1c0r_state();
    raise exception 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL';
  exception when others then
    if sqlerrm <> 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL' then v_result := sqlerrm; end if;
  end;
  if v_result is distinct from 'LAUNCH-SEC-1C-0-R: accept_pending_team_invitations is not the reviewed definition' then
    raise exception 'FAIL T-launchsec1c0r-crlf-body-change-rejected: %', v_result;
  end if;

  if pg_temp.launchsec1c0r_fp() <> (select fp from launchsec1c0r_baseline) then
    raise exception 'FAIL T-launchsec1c0r-line-ending-tests-left-no-trace';
  end if;
  raise notice 'PASS T-launchsec1c0r-line-endings';
end $$;

-- ============================================================================
-- PARTIAL / DRIFTED STATES FAIL CLOSED (each mutation is undone)
-- ============================================================================

do $$
declare
  v_case record;
  v_result text;
begin
  for v_case in
    select * from (values
      ('link-rpc-old-only',
       'grant execute on function public.link_portal_client_by_email(uuid, text) to anon, authenticated'),
      ('team-rpc-old-only',
       'grant execute on function public.accept_pending_team_invitations(text) to public, anon'),
      ('ledger-old-only',
       'drop policy "Linked portal users can read their account ledger" on public.client_account_ledger;'
       || ' create policy "Clients can read their own account ledger" on public.client_account_ledger for select to authenticated'
       || ' using (exists (select 1 from public.clients c where c.id = client_account_ledger.client_id'
       || ' and c.studio_id = client_account_ledger.studio_id and lower(c.email) = lower(coalesce(auth.jwt() ->> ''email'', ''''))))'),
      ('both-ledger-client-policies',
       'create policy "Clients can read their own account ledger" on public.client_account_ledger for select to authenticated'
       || ' using (exists (select 1 from public.clients c where c.id = client_account_ledger.client_id'
       || ' and c.studio_id = client_account_ledger.studio_id and lower(c.email) = lower(coalesce(auth.jwt() ->> ''email'', ''''))))'),
      ('no-ledger-client-policy',
       'drop policy "Linked portal users can read their account ledger" on public.client_account_ledger'),
      ('extra-email-ledger-policy',
       'create policy "launchsec1c0r extra" on public.client_account_ledger for select to authenticated'
       || ' using (exists (select 1 from public.clients c where c.id = client_account_ledger.client_id'
       || ' and lower(c.email) = lower(coalesce(auth.jwt() ->> ''email'', ''''))))'),
      ('alternate-link-overload',
       'create function public.link_portal_client_by_email(p_email text) returns integer language sql as $f$ select 0 $f$'),
      ('unexpected-public-grant',
       'grant execute on function public.link_portal_client_by_email(uuid, text) to public'),
      ('helper-body-changed',
       'create or replace function public.user_has_client_portal_access(target_studio_id uuid, target_client_id uuid)'
       || ' returns boolean language sql stable security definer set search_path to ''public'' as $f$ select true $f$'),
      ('link-body-changed',
       'create or replace function public.link_portal_client_by_email(p_user_id uuid, p_email text)'
       || ' returns integer language plpgsql security definer set search_path to ''public'' as $f$ begin return 0; end; $f$'),
      ('team-search-path-changed',
       'alter function public.accept_pending_team_invitations(text) set search_path = public, pg_temp')
    ) as t(label, ddl)
  loop
    v_result := null;
    begin
      execute v_case.ddl;
      v_result := 'accepted:' || pg_temp.launchsec1c0r_state();
      raise exception 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL';
    exception when others then
      if sqlerrm <> 'LAUNCH-SEC-1C-0-R-TEST-SENTINEL' then v_result := sqlerrm; end if;
    end;
    if v_result is null or v_result not like 'LAUNCH-SEC-1C-0-R:%' then
      raise exception 'FAIL T-launchsec1c0r-partial-state-rejected (%): %', v_case.label, v_result;
    end if;
  end loop;

  if pg_temp.launchsec1c0r_fp() <> (select fp from launchsec1c0r_baseline) then
    raise exception 'FAIL T-launchsec1c0r-partial-tests-left-no-trace';
  end if;
  raise notice 'PASS T-launchsec1c0r-partial-states-fail-closed (11 cases)';
end $$;

-- ============================================================================
-- STATE A -> hardened: identical to DEV's hardened catalog
-- ============================================================================

grant execute on function public.link_portal_client_by_email(uuid, text) to anon, authenticated;
grant execute on function public.accept_pending_team_invitations(text) to public, anon;
drop policy "Linked portal users can read their account ledger" on public.client_account_ledger;
create policy "Clients can read their own account ledger"
on public.client_account_ledger
for select
to authenticated
using (
  exists (
    select 1
    from public.clients c
    where c.id = client_account_ledger.client_id
      and c.studio_id = client_account_ledger.studio_id
      and lower(c.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

do $$
begin
  if pg_temp.launchsec1c0r_state() <> 'A' then
    raise exception 'FAIL T-launchsec1c0r-state-a-recognized';
  end if;
  raise notice 'PASS T-launchsec1c0r-state-a-recognized';
end $$;

do $$
declare
  v_start text := pg_temp.launchsec1c0r_state();
begin
  if v_start = 'A' then
    execute 'revoke execute on function public.link_portal_client_by_email(uuid, text) from public, anon, authenticated';
    execute 'revoke execute on function public.accept_pending_team_invitations(text) from public, anon';
    execute 'drop policy "Clients can read their own account ledger" on public.client_account_ledger';
    execute 'create policy "Linked portal users can read their account ledger" on public.client_account_ledger'
      || ' for select to authenticated using (public.user_has_client_portal_access(studio_id, client_id))';
  end if;

  if pg_temp.launchsec1c0r_state() <> 'B' then
    raise exception 'LAUNCH-SEC-1C-0-R: hardened state was not reached';
  end if;

  raise notice 'LAUNCH-SEC-1C-0-R: starting state %, final state B', v_start;
end $$;

do $$
begin
  if pg_temp.launchsec1c0r_state() <> 'B'
     or pg_temp.launchsec1c0r_fp() <> (select fp from launchsec1c0r_baseline) then
    raise exception 'FAIL T-launchsec1c0r-state-a-hardened-to-dev-target';
  end if;
  if has_function_privilege('public', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.accept_pending_team_invitations(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.accept_pending_team_invitations(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.accept_pending_team_invitations(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.accept_pending_team_invitations(text)', 'EXECUTE') then
    raise exception 'FAIL T-launchsec1c0r-final-grants';
  end if;
  raise notice 'PASS T-launchsec1c0r-state-a-hardened-to-dev-target';
end $$;

-- ============================================================================
-- HARDENED BEHAVIOR (synthetic fixtures only)
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000fe0001', 'LAUNCH-SEC-1C-0-R Studio A', 't-launchsec1c0r-a');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000fe1001', 't-launchsec1c0r-linked@example.test'),
  ('00000000-0000-0000-0000-000000fe1002', 't-launchsec1c0r-disconnected@example.test'),
  ('00000000-0000-0000-0000-000000fe1003', 't-launchsec1c0r-former@example.test'),
  ('00000000-0000-0000-0000-000000fe1004', 't-launchsec1c0r-emailmatch@example.test');

insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-000000fe2001', '00000000-0000-0000-0000-000000fe0001', 'T', 'Linked', 't-launchsec1c0r-linked@example.test', 'active'),
  ('00000000-0000-0000-0000-000000fe2002', '00000000-0000-0000-0000-000000fe0001', 'T', 'Disconnected', 't-launchsec1c0r-disconnected@example.test', 'active'),
  ('00000000-0000-0000-0000-000000fe2003', '00000000-0000-0000-0000-000000fe0001', 'T', 'Former', 't-launchsec1c0r-former@example.test', 'active'),
  ('00000000-0000-0000-0000-000000fe2004', '00000000-0000-0000-0000-000000fe0001', 'T', 'EmailMatch', 't-launchsec1c0r-emailmatch@example.test', 'active');

insert into public.client_account_links
  (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email,
   linked_at, claimed_at, disconnected_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000fe3001', '00000000-0000-0000-0000-000000fe0001', '00000000-0000-0000-0000-000000fe2001',
   '00000000-0000-0000-0000-000000fe1001', 'linked', 'self', true, 'studio', 't-launchsec1c0r-linked@example.test',
   '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', null, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000fe3002', '00000000-0000-0000-0000-000000fe0001', '00000000-0000-0000-0000-000000fe2002',
   '00000000-0000-0000-0000-000000fe1002', 'disconnected', 'self', false, 'studio', 't-launchsec1c0r-disconnected@example.test',
   '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000fe3003', '00000000-0000-0000-0000-000000fe0001', '00000000-0000-0000-0000-000000fe2003',
   '00000000-0000-0000-0000-000000fe1003', 'former_client', 'self', false, 'studio', 't-launchsec1c0r-former@example.test',
   '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z');

insert into public.client_account_ledger (id, studio_id, client_id, entry_type, direction, amount, description) values
  ('00000000-0000-0000-0000-000000fe4001', '00000000-0000-0000-0000-000000fe0001', '00000000-0000-0000-0000-000000fe2001', 'credit_added', 'credit', 10, 't-launchsec1c0r linked'),
  ('00000000-0000-0000-0000-000000fe4002', '00000000-0000-0000-0000-000000fe0001', '00000000-0000-0000-0000-000000fe2002', 'credit_added', 'credit', 10, 't-launchsec1c0r disconnected'),
  ('00000000-0000-0000-0000-000000fe4003', '00000000-0000-0000-0000-000000fe0001', '00000000-0000-0000-0000-000000fe2003', 'credit_added', 'credit', 10, 't-launchsec1c0r former'),
  ('00000000-0000-0000-0000-000000fe4004', '00000000-0000-0000-0000-000000fe0001', '00000000-0000-0000-0000-000000fe2004', 'credit_added', 'credit', 10, 't-launchsec1c0r emailmatch');

set local role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fe1001","role":"authenticated","email":"t-launchsec1c0r-linked@example.test"}', true);
do $$
declare v_ids text;
begin
  select string_agg(id::text, ',' order by id) into v_ids
  from public.client_account_ledger where description like 't-launchsec1c0r%';
  if v_ids is distinct from '00000000-0000-0000-0000-000000fe4001' then
    raise exception 'FAIL T-launchsec1c0r-linked-user-keeps-access: %', v_ids;
  end if;
  raise notice 'PASS T-launchsec1c0r-linked-user-keeps-access';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fe1002","role":"authenticated","email":"t-launchsec1c0r-disconnected@example.test"}', true);
do $$
declare v integer;
begin
  select count(*) into v from public.client_account_ledger where description like 't-launchsec1c0r%';
  if v <> 0 then raise exception 'FAIL T-launchsec1c0r-disconnected-denied: %', v; end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fe1003","role":"authenticated","email":"t-launchsec1c0r-former@example.test"}', true);
do $$
declare v integer;
begin
  select count(*) into v from public.client_account_ledger where description like 't-launchsec1c0r%';
  if v <> 0 then raise exception 'FAIL T-launchsec1c0r-former-denied: %', v; end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fe1004","role":"authenticated","email":"t-launchsec1c0r-emailmatch@example.test"}', true);
do $$
declare v integer;
begin
  select count(*) into v from public.client_account_ledger where description like 't-launchsec1c0r%';
  if v <> 0 then raise exception 'FAIL T-launchsec1c0r-unlinked-email-match-denied: %', v; end if;

  begin
    perform public.link_portal_client_by_email(
      '00000000-0000-0000-0000-000000fe1004', 't-launchsec1c0r-emailmatch@example.test');
    raise exception 'FAIL T-launchsec1c0r-authenticated-link-rpc: call succeeded';
  exception
    when insufficient_privilege then null;
  end;

  if public.accept_pending_team_invitations(null) <> 0 then
    raise exception 'FAIL T-launchsec1c0r-authenticated-team-rpc';
  end if;

  raise notice 'PASS T-launchsec1c0r-unlinked-disconnected-former-denied';
end $$;

reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  begin
    perform public.link_portal_client_by_email(
      '00000000-0000-0000-0000-000000fe1004', 't-launchsec1c0r-emailmatch@example.test');
    raise exception 'FAIL T-launchsec1c0r-anon-link-rpc: call succeeded';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.accept_pending_team_invitations(null);
    raise exception 'FAIL T-launchsec1c0r-anon-team-rpc: call succeeded';
  exception
    when insufficient_privilege then null;
  end;
  raise notice 'PASS T-launchsec1c0r-anon-rpc-denied';
end $$;

reset role;

do $$
begin
  if exists (select 1 from public.clients where id = '00000000-0000-0000-0000-000000fe2004' and portal_user_id is not null)
     or exists (select 1 from public.client_account_links where client_id = '00000000-0000-0000-0000-000000fe2004') then
    raise exception 'FAIL T-launchsec1c0r-no-link-created';
  end if;
  raise notice 'PASS T-launchsec1c0r-no-link-created';
end $$;

do $$
begin
  raise notice 'ALL T-launchsec1c0r TESTS PASSED';
end $$;

rollback;
