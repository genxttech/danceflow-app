-- Partner Search and Now Hiring discovery foundation.
-- Run in dev and production before deploying the related web/mobile discovery routes.

create extension if not exists pgcrypto;

create table if not exists public.dancer_partner_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  display_name text not null,
  headline text,
  bio text,
  city text,
  state text,
  latitude double precision,
  longitude double precision,
  search_radius_miles integer not null default 50,
  lead_follow_role text not null default 'either',
  dance_styles text[] not null default '{}',
  skill_level text not null default 'social',
  goals text[] not null default '{}',
  availability_notes text,
  contact_preference text not null default 'message',
  contact_email text,
  contact_phone text,
  visibility text not null default 'draft',
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dancer_partner_profiles_visibility_check
    check (visibility in ('draft', 'published', 'paused', 'archived')),
  constraint dancer_partner_profiles_role_check
    check (lead_follow_role in ('lead', 'follow', 'either', 'switch')),
  constraint dancer_partner_profiles_skill_check
    check (skill_level in ('newcomer', 'beginner', 'social', 'intermediate', 'advanced', 'professional')),
  constraint dancer_partner_profiles_contact_check
    check (contact_preference in ('message', 'email', 'phone'))
);

create table if not exists public.studio_job_postings (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  title text not null,
  role_type text not null default 'instructor',
  employment_type text not null default 'contract',
  location_type text not null default 'in_person',
  city text,
  state text,
  compensation_summary text,
  dance_styles text[] not null default '{}',
  requirements text,
  description text,
  apply_url text,
  apply_email text,
  contact_name text,
  status text not null default 'draft',
  published_at timestamptz,
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_job_postings_status_check
    check (status in ('draft', 'published', 'paused', 'closed', 'archived')),
  constraint studio_job_postings_role_type_check
    check (role_type in ('instructor', 'front_desk', 'event_staff', 'coach', 'admin', 'other')),
  constraint studio_job_postings_employment_type_check
    check (employment_type in ('employee', 'contract', 'part_time', 'full_time', 'temporary', 'volunteer')),
  constraint studio_job_postings_location_type_check
    check (location_type in ('in_person', 'hybrid', 'remote'))
);

create index if not exists dancer_partner_profiles_public_idx
on public.dancer_partner_profiles (visibility, state, city, skill_level)
where visibility = 'published';

create index if not exists dancer_partner_profiles_styles_idx
on public.dancer_partner_profiles using gin (dance_styles);

create index if not exists studio_job_postings_public_idx
on public.studio_job_postings (status, state, city, role_type)
where status = 'published';

create index if not exists studio_job_postings_styles_idx
on public.studio_job_postings using gin (dance_styles);

alter table public.dancer_partner_profiles enable row level security;
alter table public.studio_job_postings enable row level security;

drop policy if exists "Public can view published partner profiles" on public.dancer_partner_profiles;
create policy "Public can view published partner profiles"
on public.dancer_partner_profiles
for select
using (
  visibility = 'published'
  and (expires_at is null or expires_at >= now())
);

drop policy if exists "Dancers can manage their own partner profile" on public.dancer_partner_profiles;
create policy "Dancers can manage their own partner profile"
on public.dancer_partner_profiles
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Public can view published job postings" on public.studio_job_postings;
create policy "Public can view published job postings"
on public.studio_job_postings
for select
using (
  status = 'published'
  and (expires_at is null or expires_at >= now())
);

drop policy if exists "Job posting creators can manage their postings" on public.studio_job_postings;
create policy "Job posting creators can manage their postings"
on public.studio_job_postings
for all
to authenticated
using (auth.uid() = created_by)
with check (auth.uid() = created_by);
