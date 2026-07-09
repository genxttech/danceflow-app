-- 20260709_platform_success_followups_v1.sql
-- Run in dev and production before deploying /platform/success actions.

create table if not exists public.platform_success_followups (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  category text not null default 'onboarding_nudge',
  priority text not null default 'medium',
  status text not null default 'open',
  outcome text,
  note text,
  next_follow_up_at date,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_success_followups_category_check check (
    category in (
      'onboarding_nudge',
      'billing_follow_up',
      'trial_conversion',
      'technical_support',
      'retention_save',
      'upgrade_opportunity'
    )
  ),
  constraint platform_success_followups_priority_check check (
    priority in ('low', 'medium', 'high')
  ),
  constraint platform_success_followups_status_check check (
    status in ('open', 'completed', 'cancelled')
  ),
  constraint platform_success_followups_outcome_check check (
    outcome is null
    or outcome in (
      'contacted',
      'waiting_on_customer',
      'converted',
      'resolved',
      'not_interested',
      'needs_internal_work',
      'other'
    )
  )
);

create index if not exists platform_success_followups_studio_id_idx
  on public.platform_success_followups (studio_id);

create index if not exists platform_success_followups_status_next_follow_up_idx
  on public.platform_success_followups (status, next_follow_up_at);

create index if not exists platform_success_followups_created_at_idx
  on public.platform_success_followups (created_at desc);

create or replace function public.set_platform_success_followups_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_platform_success_followups_updated_at on public.platform_success_followups;

create trigger set_platform_success_followups_updated_at
before update on public.platform_success_followups
for each row
execute function public.set_platform_success_followups_updated_at();

alter table public.platform_success_followups enable row level security;

drop policy if exists "Platform admins can read success followups" on public.platform_success_followups;
drop policy if exists "Platform admins can insert success followups" on public.platform_success_followups;
drop policy if exists "Platform admins can update success followups" on public.platform_success_followups;

create policy "Platform admins can read success followups"
on public.platform_success_followups
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Platform admins can insert success followups"
on public.platform_success_followups
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Platform admins can update success followups"
on public.platform_success_followups
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);
