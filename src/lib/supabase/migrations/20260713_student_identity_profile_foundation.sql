-- DanceFlow Student Identity and Profile Unification foundation.
-- Adds a user-owned dancer profile and an auditable account-to-client relationship.
-- Keeps clients.portal_user_id as a temporary compatibility mirror.

create extension if not exists pgcrypto;

create table if not exists public.dancer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_name text,
  last_name text,
  preferred_name text,
  phone text,
  birthday date,
  photo_url text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text,
  dance_interests text,
  dance_goals text[] not null default '{}',
  skill_level text,
  bio text,
  profile_visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dancer_profiles_visibility_check
    check (profile_visibility in ('private', 'connected_studios', 'public')),
  constraint dancer_profiles_skill_level_check
    check (
      skill_level is null
      or skill_level in (
        'newcomer',
        'beginner',
        'social',
        'intermediate',
        'advanced',
        'competitive',
        'professional'
      )
    )
);

create table if not exists public.client_account_links (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'unclaimed',
  relationship_type text not null default 'self',
  initiated_by text not null default 'system',
  invited_email text,
  linked_at timestamptz,
  claimed_at timestamptz,
  disconnected_at timestamptz,
  disconnected_by uuid references auth.users(id) on delete set null,
  disconnect_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_account_links_status_check
    check (
      status in (
        'unclaimed',
        'invited',
        'claim_pending',
        'linked',
        'disconnected',
        'former_client',
        'rejected',
        'conflict'
      )
    ),
  constraint client_account_links_relationship_check
    check (
      relationship_type in (
        'self',
        'guardian',
        'billing_contact',
        'dependent'
      )
    ),
  constraint client_account_links_initiated_by_check
    check (
      initiated_by in (
        'system',
        'legacy_backfill',
        'legacy_email_repair',
        'studio',
        'dancer',
        'guardian'
      )
    )
);

create unique index if not exists client_account_links_client_user_unique
  on public.client_account_links(client_id, user_id);

create index if not exists client_account_links_user_status_idx
  on public.client_account_links(user_id, status);

create index if not exists client_account_links_studio_status_idx
  on public.client_account_links(studio_id, status);

create index if not exists client_account_links_client_status_idx
  on public.client_account_links(client_id, status);

create unique index if not exists client_account_links_one_linked_self_per_client
  on public.client_account_links(client_id)
  where status = 'linked' and relationship_type = 'self';

create or replace function public.set_student_identity_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists dancer_profiles_set_updated_at on public.dancer_profiles;
create trigger dancer_profiles_set_updated_at
before update on public.dancer_profiles
for each row execute function public.set_student_identity_updated_at();

drop trigger if exists client_account_links_set_updated_at on public.client_account_links;
create trigger client_account_links_set_updated_at
before update on public.client_account_links
for each row execute function public.set_student_identity_updated_at();

-- Backfill the canonical dancer profile from existing auth metadata.
insert into public.dancer_profiles (
  user_id,
  first_name,
  last_name,
  preferred_name,
  phone,
  birthday,
  address_line1,
  address_line2,
  city,
  state,
  postal_code,
  country,
  dance_interests,
  updated_at
)
select
  u.id,
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'first_name',
    u.raw_user_meta_data ->> 'firstName',
    split_part(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', ''), ' ', 1)
  )), ''),
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'last_name',
    u.raw_user_meta_data ->> 'lastName',
    case
      when position(' ' in coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')) > 0
      then regexp_replace(
        coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', ''),
        '^[^ ]+\s*',
        ''
      )
      else ''
    end
  )), ''),
  nullif(trim(u.raw_user_meta_data ->> 'preferred_name'), ''),
  nullif(trim(u.raw_user_meta_data ->> 'phone'), ''),
  case
    when (u.raw_user_meta_data ->> 'birthday') ~ '^\d{4}-\d{2}-\d{2}$'
    then (u.raw_user_meta_data ->> 'birthday')::date
    else null
  end,
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'address_line1',
    u.raw_user_meta_data ->> 'addressLine1'
  )), ''),
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'address_line2',
    u.raw_user_meta_data ->> 'addressLine2'
  )), ''),
  nullif(trim(u.raw_user_meta_data ->> 'city'), ''),
  nullif(trim(u.raw_user_meta_data ->> 'state'), ''),
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'postal_code',
    u.raw_user_meta_data ->> 'postalCode'
  )), ''),
  nullif(trim(u.raw_user_meta_data ->> 'country'), ''),
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'dance_interests',
    u.raw_user_meta_data ->> 'danceInterests'
  )), ''),
  now()
from auth.users u
on conflict (user_id) do nothing;

-- Preserve all currently linked portal relationships.
insert into public.client_account_links (
  studio_id,
  client_id,
  user_id,
  status,
  relationship_type,
  initiated_by,
  invited_email,
  linked_at,
  claimed_at,
  created_at,
  updated_at
)
select
  c.studio_id,
  c.id,
  c.portal_user_id,
  'linked',
  'self',
  'legacy_backfill',
  lower(nullif(trim(c.email), '')),
  coalesce(c.updated_at, c.created_at, now()),
  coalesce(c.updated_at, c.created_at, now()),
  coalesce(c.created_at, now()),
  now()
from public.clients c
where c.portal_user_id is not null
on conflict (client_id, user_id)
do update set
  studio_id = excluded.studio_id,
  status = 'linked',
  relationship_type = 'self',
  linked_at = coalesce(public.client_account_links.linked_at, excluded.linked_at),
  claimed_at = coalesce(public.client_account_links.claimed_at, excluded.claimed_at),
  disconnected_at = null,
  disconnect_reason = null,
  updated_at = now();

-- Continue mirroring direct legacy portal_user_id changes into the new relationship table.
create or replace function public.sync_client_portal_user_to_account_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.portal_user_id is distinct from old.portal_user_id then
    if old.portal_user_id is not null then
      update public.client_account_links
      set
        status = 'disconnected',
        disconnected_at = now(),
        disconnect_reason = 'Legacy portal link removed.',
        updated_at = now()
      where client_id = new.id
        and user_id = old.portal_user_id
        and status = 'linked';
    end if;

    if new.portal_user_id is not null then
      insert into public.client_account_links (
        studio_id,
        client_id,
        user_id,
        status,
        relationship_type,
        initiated_by,
        invited_email,
        linked_at,
        claimed_at
      )
      values (
        new.studio_id,
        new.id,
        new.portal_user_id,
        'linked',
        'self',
        'legacy_email_repair',
        lower(nullif(trim(new.email), '')),
        now(),
        now()
      )
      on conflict (client_id, user_id)
      do update set
        studio_id = excluded.studio_id,
        status = 'linked',
        relationship_type = 'self',
        initiated_by = excluded.initiated_by,
        invited_email = excluded.invited_email,
        linked_at = coalesce(public.client_account_links.linked_at, excluded.linked_at),
        claimed_at = coalesce(public.client_account_links.claimed_at, excluded.claimed_at),
        disconnected_at = null,
        disconnected_by = null,
        disconnect_reason = null,
        updated_at = now();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists clients_sync_portal_user_to_account_link on public.clients;
create trigger clients_sync_portal_user_to_account_link
after update of portal_user_id on public.clients
for each row execute function public.sync_client_portal_user_to_account_link();

alter table public.dancer_profiles enable row level security;
alter table public.client_account_links enable row level security;

drop policy if exists dancer_profiles_self_select on public.dancer_profiles;
create policy dancer_profiles_self_select
on public.dancer_profiles
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists dancer_profiles_self_insert on public.dancer_profiles;
create policy dancer_profiles_self_insert
on public.dancer_profiles
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists dancer_profiles_self_update on public.dancer_profiles;
create policy dancer_profiles_self_update
on public.dancer_profiles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists client_account_links_self_select on public.client_account_links;
create policy client_account_links_self_select
on public.client_account_links
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists client_account_links_studio_staff_select on public.client_account_links;
create policy client_account_links_studio_staff_select
on public.client_account_links
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_account_links.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

-- The mobile app must stop directly updating public.clients.
drop policy if exists "portal users can update own student profile" on public.clients;

comment on table public.dancer_profiles is
  'Canonical dancer-owned profile shared across DanceFlow surfaces and studios.';

comment on table public.client_account_links is
  'Auditable relationship between a DanceFlow account and a studio-owned client record.';
