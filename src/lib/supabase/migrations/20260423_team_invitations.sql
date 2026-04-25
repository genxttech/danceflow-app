-- DanceFlow / DanceStudioAdmin
-- Team invitations
-- Purpose:
--   Let owners invite team members by email instead of requiring a user UUID.

begin;

create table if not exists public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  email text not null,
  role public.app_role not null,
  invited_by uuid not null,
  accepted_by uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint team_invitations_email_check
    check (position('@' in email) > 1),

  constraint team_invitations_role_check
    check (
      role in (
        'studio_admin',
        'front_desk',
        'instructor',
        'independent_instructor',
        'organizer_admin'
      )
    )
);

create unique index if not exists team_invitations_one_active_invite_idx
  on public.team_invitations (studio_id, lower(email), role)
  where revoked_at is null and accepted_at is null;

create index if not exists team_invitations_studio_id_idx
  on public.team_invitations (studio_id);

create index if not exists team_invitations_email_idx
  on public.team_invitations (lower(email));

create index if not exists team_invitations_created_at_idx
  on public.team_invitations (created_at desc);

create or replace function public.set_team_invitations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_team_invitations_updated_at
  on public.team_invitations;

create trigger trg_team_invitations_updated_at
before update on public.team_invitations
for each row
execute function public.set_team_invitations_updated_at();

alter table public.team_invitations enable row level security;

drop policy if exists team_invitations_owner_select
  on public.team_invitations;
drop policy if exists team_invitations_owner_insert
  on public.team_invitations;
drop policy if exists team_invitations_owner_update
  on public.team_invitations;

create policy team_invitations_owner_select
on public.team_invitations
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = team_invitations.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
);

create policy team_invitations_owner_insert
on public.team_invitations
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = team_invitations.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
);

create policy team_invitations_owner_update
on public.team_invitations
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = team_invitations.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = team_invitations.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner')
  )
);

commit;