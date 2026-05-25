begin;

create table if not exists public.platform_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null unique,
  invite_type text not null default 'ambassador_pro',
  granted_plan billing_plan not null default 'pro',
  billing_override_reason text not null default 'ambassador',
  duration_months integer not null default 12,
  expires_at timestamptz not null default (now() + interval '30 days'),
  used_at timestamptz,
  used_by_user_id uuid references auth.users(id) on delete set null,
  claimed_studio_id uuid references public.studios(id) on delete set null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  notes text,
  active boolean not null default true,
  constraint platform_invites_duration_positive check (duration_months > 0),
  constraint platform_invites_email_lower check (email = lower(trim(email)))
);

create index if not exists idx_platform_invites_email
on public.platform_invites (email);

create index if not exists idx_platform_invites_active_expires
on public.platform_invites (active, expires_at);

alter table public.platform_invites enable row level security;

drop policy if exists "Platform admins can manage platform invites"
on public.platform_invites;

create policy "Platform admins can manage platform invites"
on public.platform_invites
for all
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = 'platform_admin'
  )
);

drop policy if exists "Invited users can read their own active invites"
on public.platform_invites;

create policy "Invited users can read their own active invites"
on public.platform_invites
for select
to authenticated
using (
  active = true
  and used_at is null
  and expires_at >= now()
  and email = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
);

drop function if exists public.claim_platform_invite(text, text, text);

create or replace function public.claim_platform_invite(
  p_token_hash text,
  p_workspace_name text,
  p_timezone text default 'America/New_York'
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
  v_workspace_name text := nullif(trim(p_workspace_name), '');
  v_timezone text := coalesce(nullif(trim(p_timezone), ''), 'America/New_York');
begin
  if v_user_id is null then
    raise exception 'You must be signed in to claim this invite.';
  end if;

  if v_workspace_name is null then
    raise exception 'Workspace name is required.';
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

  update public.platform_invites
  set
    used_at = now(),
    used_by_user_id = v_user_id,
    claimed_studio_id = v_studio_id
  where id = v_invite.id;

  return v_studio_id;
end;
$$;

grant execute on function public.claim_platform_invite(text, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
