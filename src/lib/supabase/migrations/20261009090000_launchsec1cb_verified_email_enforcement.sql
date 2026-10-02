-- 20261009090000_launchsec1cb_verified_email_enforcement.sql
--
-- LAUNCH-SEC-1C-B: verified-email enforcement for email-based claims.
--
-- Depends on LAUNCH-SEC-1C-A (20261008090000). Existing linked relationships
-- are untouched; only NEW email-based claims are gated. No trust is derived
-- from auth.users.email_confirmed_at or the JWT email claim.
--
--   1. public.verified_email_for_user(uuid): service_role-only. The user's
--      CURRENT email when it is bound and bound after the last email change,
--      else NULL. (No session context; app paths also check the caller's live
--      session with public.my_verified_email().)
--   2. claim_client_account_invitation: the existing body is preserved
--      byte-for-byte under the private name
--      _claim_client_account_invitation_unverified (owner-only); the public
--      name becomes a wrapper that claims ONLY when p_email equals the user's
--      bound verified email. The existing body already only claims
--      staff-issued 'invited'/'claim_pending' rows, so disconnected/former
--      relationships are restored only through a fresh staff invitation.
--   3. accept_pending_team_invitations: the invitation email is the caller's
--      verified bound email for this live session (my_verified_email()),
--      replacing the JWT email claim. Nothing else in the body changes.
--   4. link_portal_client_by_email is dropped (no caller, no dependents;
--      already postgres/service_role-only since 1C-0).
-- 1C-0 ledger authorization is not touched.

begin;

-- >>> LAUNCH-SEC-1C-B PRECONDITIONS
do $$
declare
  v_acl text;
begin
  if to_regprocedure('public.my_verified_email()') is null
     or to_regclass('public.verified_email_identities') is null
     or to_regclass('public.auth_email_change_markers') is null then
    raise exception 'LAUNCH-SEC-1C-B: LAUNCH-SEC-1C-A objects are missing';
  end if;

  if to_regprocedure('public.verified_email_for_user(uuid)') is not null
     or to_regprocedure('public._claim_client_account_invitation_unverified(uuid, text, uuid)') is not null then
    raise exception 'LAUNCH-SEC-1C-B: partial 1C-B state present';
  end if;

  if (select count(*) from pg_proc where proname in ('accept_pending_team_invitations', 'claim_client_account_invitation', 'link_portal_client_by_email')) <> 3 then
    raise exception 'LAUNCH-SEC-1C-B: unexpected overloads';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.accept_pending_team_invitations(text)'::regprocedure
      and p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
      and md5(replace(p.prosrc, E'\r', '')) = 'ac27bfd4e6ad4d9d38bcd5762747ea90'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x)
          = 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'
  ) then
    raise exception 'LAUNCH-SEC-1C-B: accept_pending_team_invitations is not the reviewed (1C-0 hardened) definition';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.claim_client_account_invitation(uuid, text, uuid)'::regprocedure
      and p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
      and md5(replace(p.prosrc, E'\r', '')) = '72b7dd2d66b5f79dff27fd0acb447024'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x)
          = 'postgres=X/postgres,service_role=X/postgres'
  ) then
    raise exception 'LAUNCH-SEC-1C-B: claim_client_account_invitation is not the reviewed definition';
  end if;

  select string_agg(x::text, ',' order by x::text) into v_acl
  from pg_proc p, unnest(p.proacl) x
  where p.oid = 'public.link_portal_client_by_email(uuid, text)'::regprocedure;
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception 'LAUNCH-SEC-1C-B: link_portal_client_by_email is not in the 1C-0 hardened state';
  end if;

  if exists (select 1 from pg_depend where refobjid = 'public.link_portal_client_by_email(uuid, text)'::regprocedure)
     or exists (select 1 from pg_proc where prosrc ilike '%link_portal_client_by_email%' and proname <> 'link_portal_client_by_email')
     or exists (select 1 from pg_policy where pg_get_expr(polqual, polrelid) ilike '%link_portal_client_by_email%'
                                         or pg_get_expr(polwithcheck, polrelid) ilike '%link_portal_client_by_email%') then
    raise exception 'LAUNCH-SEC-1C-B: link_portal_client_by_email has dependents';
  end if;
end $$;
-- <<< LAUNCH-SEC-1C-B PRECONDITIONS

create function public.verified_email_for_user(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select v.email
  from public.verified_email_identities v
  join auth.users u on u.id = v.user_id
  left join public.auth_email_change_markers c on c.user_id = u.id
  where v.user_id = p_user_id
    and u.deleted_at is null
    and v.email = nullif(lower(btrim(u.email)), '')
    and v.credential_status = 'bound'
    and v.bound_at is not null
    and (c.last_email_change_at is null or v.bound_at > c.last_email_change_at);
$$;

alter function public.claim_client_account_invitation(uuid, text, uuid)
  rename to _claim_client_account_invitation_unverified;

create function public.claim_client_account_invitation(
  p_user_id uuid,
  p_email text,
  p_studio_id uuid default null
)
returns table(client_id uuid, studio_id uuid, link_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if p_user_id is null or v_email = '' then
    return;
  end if;

  if public.verified_email_for_user(p_user_id) is distinct from v_email then
    return;
  end if;

  return query
    select t.client_id, t.studio_id, t.link_id
    from public._claim_client_account_invitation_unverified(p_user_id, v_email, p_studio_id) as t;
end;
$$;

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

  -- LAUNCH-SEC-1C-B: the target email is the caller's VERIFIED and BOUND
  -- current email for this live session (public.my_verified_email()), never
  -- the JWT email claim and never p_email (ignored; kept for call-site
  -- compatibility). No verified identity -> no invitation is accepted.
  v_email := coalesce(public.my_verified_email(), '');

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

drop function public.link_portal_client_by_email(uuid, text);

alter function public.verified_email_for_user(uuid) owner to postgres;
alter function public._claim_client_account_invitation_unverified(uuid, text, uuid) owner to postgres;
alter function public.claim_client_account_invitation(uuid, text, uuid) owner to postgres;

revoke all on function public.verified_email_for_user(uuid) from public, anon, authenticated, service_role;
revoke all on function public._claim_client_account_invitation_unverified(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_client_account_invitation(uuid, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.verified_email_for_user(uuid) to service_role;
grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to service_role;

commit;
