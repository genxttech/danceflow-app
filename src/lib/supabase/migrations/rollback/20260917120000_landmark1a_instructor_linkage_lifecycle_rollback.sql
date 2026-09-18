-- Rollback for 20260917120000_landmark1a_instructor_linkage_lifecycle.sql
--
-- Restores accept_pending_team_invitations to its exact pre-Slice-2 body
-- (the Landmark-1A-I-era, p_email-trusting definition) and drops the new
-- helper function. Touches no instructors/client_account_links/
-- team_invitations/user_studio_roles row -- schema/function-only.
--
-- NOTE: this rollback also reverts the Slice 2 security fix (§3a) --
-- accept_pending_team_invitations reverts to trusting caller-supplied
-- p_email for invitation lookup. Treat rolling this back as a real
-- regression, not a neutral revert.

begin;

create or replace function public.accept_pending_team_invitations(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text;
  v_count integer := 0;
  invite_row record;
  existing_role text;
begin
  v_user_id := auth.uid();
  v_email := lower(trim(coalesce(p_email, '')));

  if v_user_id is null then
    return 0;
  end if;

  if v_email = '' then
    return 0;
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
$$;

grant execute on function public.accept_pending_team_invitations(text) to authenticated;

drop function if exists public.resolve_or_create_linked_instructor(uuid, uuid, text, text, text, boolean);

commit;
