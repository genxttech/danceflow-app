-- ROLLBACK for 20261009090000_launchsec1cb_verified_email_enforcement.sql
--
-- WARNING: RE-OPENS UNVERIFIED EMAIL CLAIMS (team invitations by JWT email,
-- client invitation claims without verified-email proof) and restores the
-- legacy link_portal_client_by_email RPC (postgres/service_role only, as
-- after 1C-0). Roll back the 1C-B APPLICATION first: 1C-B app code calls
-- verified_email_for_user. Never automatic. 1C-A remains in place.

begin;

do $$
begin
  if to_regprocedure('public.verified_email_for_user(uuid)') is null
     or to_regprocedure('public._claim_client_account_invitation_unverified(uuid, text, uuid)') is null
     or to_regprocedure('public.claim_client_account_invitation(uuid, text, uuid)') is null
     or to_regprocedure('public.link_portal_client_by_email(uuid, text)') is not null
     or not exists (select 1 from pg_proc where oid = 'public.accept_pending_team_invitations(text)'::regprocedure
                    and prosrc like '%public.my_verified_email()%') then
    raise exception 'LAUNCH-SEC-1C-B rollback: 1C-B object set is not the reviewed state';
  end if;
  if exists (select 1 from pg_proc where prosrc ilike '%verified_email_for_user%'
             and proname not in ('verified_email_for_user', 'claim_client_account_invitation')) then
    raise exception 'LAUNCH-SEC-1C-B rollback: other functions depend on verified_email_for_user';
  end if;
end $$;

drop function public.claim_client_account_invitation(uuid, text, uuid);
alter function public._claim_client_account_invitation_unverified(uuid, text, uuid)
  rename to claim_client_account_invitation;
revoke all on function public.claim_client_account_invitation(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to service_role;

drop function public.verified_email_for_user(uuid);

CREATE OR REPLACE FUNCTION public.accept_pending_team_invitations(p_email text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_email text;
  v_full_name text;
  v_first_name text;
  v_last_name text;
  v_space_pos integer;
  v_count integer := 0;
  invite_row record;
  existing_role text;
begin
  v_user_id := auth.uid();

  -- SECURITY FIX (Landmark 1A Slice 2): the target email is now derived
  -- exclusively from the caller's own verified JWT claim, never from the
  -- p_email parameter. p_email is intentionally ignored -- kept in the
  -- signature only for call-site compatibility. Matches this codebase's
  -- own established pattern for the identical "claim an invite addressed
  -- to me" scenario (see 20260525_ambassador_invites_v1.sql,
  -- 20260525_ambassador_invite_smart_claim_v1_1.sql).
  v_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));

  if v_user_id is null then
    return 0;
  end if;

  if v_email = '' then
    return 0;
  end if;

  select full_name into v_full_name from public.profiles where id = v_user_id;
  v_full_name := nullif(trim(coalesce(v_full_name, '')), '');

  if v_full_name is null then
    v_first_name := null;
    v_last_name := null;
  else
    v_space_pos := position(' ' in v_full_name);
    if v_space_pos = 0 then
      v_first_name := v_full_name;
      v_last_name := null;
    else
      v_first_name := trim(substring(v_full_name from 1 for v_space_pos - 1));
      v_last_name := trim(substring(v_full_name from v_space_pos + 1));
    end if;
  end if;

  for invite_row in
    select
      id,
      studio_id,
      role
    from public.team_invitations
    where lower(email) = v_email
      and accepted_at is null
      and revoked_at is null
      and expires_at >= now()
    order by created_at asc
  loop
    select usr.role
      into existing_role
    from public.user_studio_roles usr
    where usr.studio_id = invite_row.studio_id
      and usr.user_id = v_user_id
    limit 1;

    if existing_role is null then
      insert into public.user_studio_roles (
        studio_id,
        user_id,
        role,
        active
      )
      values (
        invite_row.studio_id,
        v_user_id,
        invite_row.role,
        true
      )
      on conflict (studio_id, user_id)
      do update set
        role = excluded.role,
        active = true;

    elsif existing_role in ('studio_owner', 'organizer_owner', 'platform_admin') then
      update public.user_studio_roles
      set active = true
      where studio_id = invite_row.studio_id
        and user_id = v_user_id;

    else
      update public.user_studio_roles
      set
        role = invite_row.role,
        active = true
      where studio_id = invite_row.studio_id
        and user_id = v_user_id;
    end if;

    -- Landmark 1A Slice 2: explicit-instructor-invite linkage/auto-create.
    -- can_instruct is never set true here -- Slice 6's seat-gated
    -- boundary owns that transition.
    if invite_row.role = 'instructor' then
      perform public.resolve_or_create_linked_instructor(
        invite_row.studio_id,
        v_user_id,
        v_email,
        v_first_name,
        v_last_name,
        true
      );
    end if;

    update public.team_invitations
    set
      accepted_by = v_user_id,
      accepted_at = now(),
      updated_at = now()
    where id = invite_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.link_portal_client_by_email(p_user_id uuid, p_email text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
begin
  if p_user_id is null or p_email is null or btrim(p_email) = '' then
    return 0;
  end if;

  update public.clients
  set portal_user_id = p_user_id
  where email is not null
    and lower(trim(email)) = lower(trim(p_email))
    and portal_user_id is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

alter function public.link_portal_client_by_email(uuid, text) owner to postgres;
revoke all on function public.link_portal_client_by_email(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.link_portal_client_by_email(uuid, text) to service_role;

commit;
