-- 20261007093000_launchsec1c0r_prod_compatible_auth_closure.sql
--
-- LAUNCH-SEC-1C-0-R: PROD-compatible revision of LAUNCH-SEC-1C-0.
--
-- SUPERSEDES 20261007090000_launchsec1c0_emergency_auth_closure.sql FOR PROD
-- APPLICATION. That migration is preserved unchanged (it is applied in DEV).
-- The isolated PROD preflight showed that PROD's
-- public.accept_pending_team_invitations(text) body is identical to the
-- reviewed source except that it is stored with CRLF line endings, so the
-- original exact raw-prosrc fingerprint rejected PROD. This revision compares
-- that one function body after removing carriage returns only
-- (md5(replace(prosrc, E'\r', ''))). Every other check is exact.
--
-- Trigger/index classification (catalog evidence only):
--   DEV:  sync_client_portal_user_to_account_link() uses
--         ON CONFLICT (client_id, user_id) without the partial-index
--         predicate, so a synthetic link_portal_client_by_email call fails
--         with 42P10 there.
--   PROD: the same trigger function uses
--         ON CONFLICT (client_id, user_id) WHERE user_id IS NOT NULL, which
--         matches the partial unique index client_account_links_client_user_unique.
--   Catalog inspection indicates the legacy RPC path is functional in the
--   current PROD schema; the 42P10 behavior seen in DEV does not apply there.
--   No PROD call was made and no historical exploitation has been
--   established. This revision does not modify that trigger or index.
--
-- Accepted starting states (anything else fails closed):
--   STATE A (reviewed vulnerable baseline): link_portal_client_by_email
--     executable by anon/authenticated (+ postgres, service_role; not
--     PUBLIC); accept_pending_team_invitations executable by PUBLIC, anon,
--     authenticated (+ postgres, service_role); client_account_ledger has the
--     email-based "Clients can read their own account ledger" policy plus the
--     three staff policies.
--   STATE B (already hardened, e.g. DEV after 20261007090000): link RPC
--     postgres + service_role only; team RPC postgres + authenticated +
--     service_role only; ledger has "Linked portal users can read their
--     account ledger" plus the three staff policies. STATE B is an exact no-op.
-- From STATE A the migration applies exactly the reviewed 1C-0 hardening.
-- No function body, trigger, index, business row or other policy changes.

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

drop function pg_temp.launchsec1c0r_state();

commit;
