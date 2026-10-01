-- 20261007090000_launchsec1c0_emergency_auth_closure.sql
--
-- LAUNCH-SEC-1C-0: emergency closure of three authorization paths that do
-- not depend on any LAUNCH-SEC-1C product decision.
--
-- 1. public.link_portal_client_by_email(p_user_id uuid, p_email text)
--    Legacy SECURITY DEFINER RPC (created outside repository migrations, no
--    application caller) executable by anon and authenticated. The caller
--    chooses both the user id and the email; it sets clients.portal_user_id
--    for every unlinked matching client in every studio, and the existing
--    clients_sync_portal_user_to_account_link trigger then creates or revives
--    a `linked` client_account_links row -- i.e. portal access. EXECUTE is
--    revoked from PUBLIC, anon and authenticated (the function and the
--    trigger are kept; no new grant is added).
--
-- 2. client_account_ledger "Clients can read their own account ledger"
--    granted read access when the caller's JWT email equals clients.email,
--    which proves nothing while mailbox ownership is not verified. It is
--    replaced by the established relationship check
--    public.user_has_client_portal_access(studio_id, client_id) (an active
--    `linked` client_account_links row for auth.uid()). Staff policies are
--    unchanged.
--
-- 3. public.accept_pending_team_invitations(text): EXECUTE is revoked from
--    PUBLIC and anon (it was granted to both). authenticated keeps EXECUTE
--    because /callback calls it with the signed-in user's client. This does
--    NOT fix team-invite identity binding; the durable verified-mailbox check
--    is LAUNCH-SEC-1C-A+B.
--
-- No function bodies, triggers, business rows or other policies change.
-- Fails closed unless the live state matches the reviewed baseline exactly.

begin;

do $$
declare
  v_fn record;
begin
  -- link_portal_client_by_email
  select p.oid, p.prosecdef, l.lanname, pg_get_userbyid(p.proowner) as owner,
         p.proconfig, md5(p.prosrc) as src_md5
    into v_fn
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname = 'link_portal_client_by_email'
    and pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_email text';
  if not found then
    raise exception 'LAUNCH-SEC-1C-0: public.link_portal_client_by_email(uuid, text) is missing';
  end if;
  if not v_fn.prosecdef or v_fn.lanname <> 'plpgsql' or v_fn.owner <> 'postgres'
     or v_fn.proconfig is distinct from array['search_path=public']
     or v_fn.src_md5 <> '29924b718d74a26328cc54c5664ecf89' then
    raise exception 'LAUNCH-SEC-1C-0: link_portal_client_by_email is not the reviewed definition';
  end if;
  if not has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
    raise exception 'LAUNCH-SEC-1C-0: link_portal_client_by_email grants are not the reviewed baseline';
  end if;

  -- accept_pending_team_invitations
  select p.oid, p.prosecdef, l.lanname, pg_get_userbyid(p.proowner) as owner,
         p.proconfig, md5(p.prosrc) as src_md5
    into v_fn
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname = 'accept_pending_team_invitations'
    and pg_get_function_identity_arguments(p.oid) = 'p_email text';
  if not found then
    raise exception 'LAUNCH-SEC-1C-0: public.accept_pending_team_invitations(text) is missing';
  end if;
  if not v_fn.prosecdef or v_fn.lanname <> 'plpgsql' or v_fn.owner <> 'postgres'
     or v_fn.proconfig is distinct from array['search_path=public']
     or v_fn.src_md5 <> 'ac27bfd4e6ad4d9d38bcd5762747ea90' then
    raise exception 'LAUNCH-SEC-1C-0: accept_pending_team_invitations is not the reviewed definition';
  end if;
  if not has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     or not has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
    raise exception 'LAUNCH-SEC-1C-0: accept_pending_team_invitations grants are not the reviewed baseline';
  end if;

  -- user_has_client_portal_access (the replacement ledger authorization)
  select p.oid, p.prosecdef, l.lanname, pg_get_userbyid(p.proowner) as owner,
         p.proconfig, md5(p.prosrc) as src_md5
    into v_fn
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname = 'user_has_client_portal_access'
    and pg_get_function_identity_arguments(p.oid) = 'target_studio_id uuid, target_client_id uuid';
  if not found then
    raise exception 'LAUNCH-SEC-1C-0: public.user_has_client_portal_access(uuid, uuid) is missing';
  end if;
  if not v_fn.prosecdef or v_fn.lanname <> 'sql' or v_fn.owner <> 'postgres'
     or v_fn.proconfig is distinct from array['search_path=public']
     or v_fn.src_md5 <> 'c0b5901eaad8130f2b6ee6d983687483'
     or not has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
    raise exception 'LAUNCH-SEC-1C-0: user_has_client_portal_access is not the reviewed definition';
  end if;

  -- client_account_ledger: exactly the reviewed email-based read policy, and
  -- no other policy using an email comparison.
  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
      and p.policyname = 'Clients can read their own account ledger'
      and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT'
      and p.roles = array['authenticated']::name[]
      and p.with_check is null
      and md5(p.qual) = 'a83e4d10340eea48d15744a10ef2ddf5'
  ) then
    raise exception 'LAUNCH-SEC-1C-0: the reviewed client_account_ledger email policy is missing or different';
  end if;
  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
      and p.policyname = 'Linked portal users can read their account ledger'
  ) then
    raise exception 'LAUNCH-SEC-1C-0: target ledger policy already exists (partial state)';
  end if;
  if (
    select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
      and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~* 'email'
  ) <> 1 then
    raise exception 'LAUNCH-SEC-1C-0: unexpected email-based client_account_ledger policy';
  end if;
end $$;

revoke execute on function public.link_portal_client_by_email(uuid, text) from public, anon, authenticated;

revoke execute on function public.accept_pending_team_invitations(text) from public, anon;

drop policy "Clients can read their own account ledger" on public.client_account_ledger;

create policy "Linked portal users can read their account ledger"
  on public.client_account_ledger
  for select
  to authenticated
  using (public.user_has_client_portal_access(studio_id, client_id));

do $$
begin
  if has_function_privilege('anon', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.link_portal_client_by_email(uuid, text)', 'EXECUTE') then
    raise exception 'LAUNCH-SEC-1C-0: link_portal_client_by_email is still executable by an untrusted role';
  end if;

  if has_function_privilege('anon', 'public.accept_pending_team_invitations(text)', 'EXECUTE') then
    raise exception 'LAUNCH-SEC-1C-0: accept_pending_team_invitations is still executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.accept_pending_team_invitations(text)', 'EXECUTE') then
    raise exception 'LAUNCH-SEC-1C-0: accept_pending_team_invitations lost authenticated EXECUTE';
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'client_account_ledger'
      and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~* 'email'
  ) then
    raise exception 'LAUNCH-SEC-1C-0: an email-based client_account_ledger policy remains';
  end if;
end $$;

commit;
