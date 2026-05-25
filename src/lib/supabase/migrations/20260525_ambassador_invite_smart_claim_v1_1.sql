begin;

alter table public.platform_invites
add column if not exists claimed_studio_id uuid references public.studios(id) on delete set null;

drop function if exists public.claim_platform_invite(text, text, text);
drop function if exists public.claim_platform_invite(text, text, text, uuid);

create or replace function public.claim_platform_invite(
  p_token_hash text,
  p_workspace_name text default null,
  p_timezone text default 'America/New_York',
  p_existing_studio_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  v_invite public.platform_invites%rowtype;
  v_base_slug text;
  v_slug text;
  v_suffix text;
  v_studio_id uuid;
  v_workspace_name text := nullif(trim(coalesce(p_workspace_name, '')), '');
  v_timezone text := coalesce(nullif(trim(p_timezone), ''), 'America/New_York');
  v_existing_role text;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to claim this invite.';
  end if;

  select *
  into v_invite
  from public.platform_invites
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'This invite is not valid.';
  end if;

  if not v_invite.active then
    raise exception 'This invite is no longer active.';
  end if;

  if v_invite.used_at is not null then
    raise exception 'This invite has already been used.';
  end if;

  if v_invite.expires_at < now() then
    raise exception 'This invite has expired.';
  end if;

  if lower(trim(v_invite.email)) <> v_user_email then
    raise exception 'This invite was sent to a different email address. Please sign in with the invited email.';
  end if;

  if p_existing_studio_id is not null then
    select usr.role::text
    into v_existing_role
    from public.user_studio_roles usr
    where usr.user_id = v_user_id
      and usr.studio_id = p_existing_studio_id
      and usr.active = true
      and usr.role in (
        'studio_owner',
        'studio_admin',
        'independent_instructor',
        'organizer_owner',
        'organizer_admin'
      )
    limit 1;

    if v_existing_role is null then
      raise exception 'You do not have permission to apply this invite to that workspace.';
    end if;

    update public.studios
    set
      billing_plan = v_invite.granted_plan,
      subscription_status = 'active',
      active = true,
      trial_ends_at = null,
      billing_override_enabled = true,
      billing_override_reason = v_invite.billing_override_reason,
      billing_override_expires_at = now() + make_interval(months => v_invite.duration_months),
      billing_override_notes = coalesce(nullif(v_invite.notes, ''), 'DanceFlow Ambassador Pro Pilot'),
      billing_override_created_at = now(),
      billing_override_created_by = v_user_id
    where id = p_existing_studio_id
    returning id into v_studio_id;

    if v_studio_id is null then
      raise exception 'Workspace could not be found.';
    end if;
  else
    if v_workspace_name is null then
      raise exception 'Workspace name is required.';
    end if;

    v_base_slug := lower(regexp_replace(v_workspace_name, '[^a-zA-Z0-9]+', '-', 'g'));
    v_base_slug := trim(both '-' from v_base_slug);

    if v_base_slug is null or v_base_slug = '' then
      v_base_slug := 'ambassador-workspace';
    end if;

    v_suffix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    v_slug := left(v_base_slug, 48) || '-' || v_suffix;

    insert into public.studios (
      name,
      slug,
      email,
      timezone,
      billing_plan,
      subscription_status,
      active,
      trial_ends_at,
      billing_override_enabled,
      billing_override_reason,
      billing_override_expires_at,
      billing_override_notes,
      billing_override_created_at,
      billing_override_created_by
    )
    values (
      v_workspace_name,
      v_slug,
      v_user_email,
      v_timezone,
      v_invite.granted_plan,
      'active',
      true,
      null,
      true,
      v_invite.billing_override_reason,
      now() + make_interval(months => v_invite.duration_months),
      coalesce(nullif(v_invite.notes, ''), 'DanceFlow Ambassador Pro Pilot'),
      now(),
      v_user_id
    )
    returning id into v_studio_id;

    insert into public.user_studio_roles (
      user_id,
      studio_id,
      role,
      active
    )
    values (
      v_user_id,
      v_studio_id,
      'studio_owner',
      true
    );
  end if;

  update public.platform_invites
  set
    used_at = now(),
    used_by_user_id = v_user_id,
    claimed_studio_id = v_studio_id
  where id = v_invite.id;

  return v_studio_id;
end;
$$;

grant execute on function public.claim_platform_invite(text, text, text, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
