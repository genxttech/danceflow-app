-- 20260709_platform_sales_opportunities_v1.sql
-- Platform Sales Pipeline / Trial CRM foundation.
-- Run in both dev and production before deploying /platform/sales.

create table if not exists public.platform_sales_opportunities (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete set null,
  company_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  source text not null default 'manual',
  stage text not null default 'new_lead',
  plan_interest text,
  estimated_value numeric(12, 2) not null default 0 check (estimated_value >= 0),
  trial_started_at date,
  trial_ends_at date,
  next_follow_up_at date,
  lost_reason text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_sales_opportunities_stage_check check (
    stage in (
      'new_lead',
      'demo_scheduled',
      'trial_started',
      'onboarding',
      'won',
      'lost'
    )
  ),
  constraint platform_sales_opportunities_source_check check (
    source in (
      'manual',
      'referral',
      'website',
      'founder_outreach',
      'social_media',
      'event',
      'partner',
      'other'
    )
  )
);

create index if not exists platform_sales_opportunities_stage_idx
  on public.platform_sales_opportunities (stage);

create index if not exists platform_sales_opportunities_next_follow_up_at_idx
  on public.platform_sales_opportunities (next_follow_up_at);

create index if not exists platform_sales_opportunities_studio_id_idx
  on public.platform_sales_opportunities (studio_id);

create index if not exists platform_sales_opportunities_created_at_idx
  on public.platform_sales_opportunities (created_at desc);

create or replace function public.set_platform_sales_opportunities_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_platform_sales_opportunities_updated_at
  on public.platform_sales_opportunities;

create trigger set_platform_sales_opportunities_updated_at
before update on public.platform_sales_opportunities
for each row
execute function public.set_platform_sales_opportunities_updated_at();

alter table public.platform_sales_opportunities enable row level security;

drop policy if exists "Platform admins can read platform sales opportunities"
  on public.platform_sales_opportunities;
drop policy if exists "Platform admins can insert platform sales opportunities"
  on public.platform_sales_opportunities;
drop policy if exists "Platform admins can update platform sales opportunities"
  on public.platform_sales_opportunities;
drop policy if exists "Platform admins can delete platform sales opportunities"
  on public.platform_sales_opportunities;

create policy "Platform admins can read platform sales opportunities"
on public.platform_sales_opportunities
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

create policy "Platform admins can insert platform sales opportunities"
on public.platform_sales_opportunities
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

create policy "Platform admins can update platform sales opportunities"
on public.platform_sales_opportunities
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

create policy "Platform admins can delete platform sales opportunities"
on public.platform_sales_opportunities
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);
