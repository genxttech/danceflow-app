-- 20260608_aria_goals_foundation_v1.sql
-- ARIA Goals Foundation V1
-- Lets studios define goal/timeline records for ARIA-guided growth plans.

create table if not exists public.aria_goals (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  title text not null,
  goal_type text not null,
  focus_area text not null,
  target_value numeric,
  target_unit text not null default 'count',
  timeline_days integer not null default 60,
  starts_at date not null default current_date,
  target_date date not null default (current_date + 60),
  status text not null default 'active',
  baseline_notes text,
  plan_summary text,
  weekly_milestones jsonb not null default '[]'::jsonb,
  kpi_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint aria_goals_goal_type_check check (
    goal_type in (
      'revenue',
      'private_lessons',
      'memberships',
      'group_classes',
      'retention',
      'events',
      'custom'
    )
  ),
  constraint aria_goals_focus_area_check check (
    focus_area in (
      'package_renewals',
      'rebooking',
      'lead_conversion',
      'memberships',
      'group_classes',
      'events',
      'retention',
      'overall_growth',
      'custom'
    )
  ),
  constraint aria_goals_target_unit_check check (
    target_unit in ('dollars', 'clients', 'bookings', 'memberships', 'attendees', 'percent', 'count')
  ),
  constraint aria_goals_status_check check (
    status in ('active', 'paused', 'completed', 'archived')
  ),
  constraint aria_goals_timeline_days_check check (timeline_days between 7 and 365)
);

create index if not exists idx_aria_goals_studio_status
  on public.aria_goals (studio_id, status, created_at desc);

create index if not exists idx_aria_goals_studio_goal_type
  on public.aria_goals (studio_id, goal_type);

alter table public.aria_goals enable row level security;

drop policy if exists "aria_goals_select" on public.aria_goals;
drop policy if exists "aria_goals_insert" on public.aria_goals;
drop policy if exists "aria_goals_update" on public.aria_goals;
drop policy if exists "aria_goals_delete" on public.aria_goals;

create policy "aria_goals_select"
on public.aria_goals
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = aria_goals.studio_id
      and usr.user_id = auth.uid()
      and usr.role in (
        'studio_owner'::app_role,
        'studio_admin'::app_role,
        'front_desk'::app_role,
        'independent_instructor'::app_role
      )
  )
);

create policy "aria_goals_insert"
on public.aria_goals
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = aria_goals.studio_id
      and usr.user_id = auth.uid()
      and usr.role in (
        'studio_owner'::app_role,
        'studio_admin'::app_role,
        'independent_instructor'::app_role
      )
  )
);

create policy "aria_goals_update"
on public.aria_goals
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = aria_goals.studio_id
      and usr.user_id = auth.uid()
      and usr.role in (
        'studio_owner'::app_role,
        'studio_admin'::app_role,
        'independent_instructor'::app_role
      )
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = aria_goals.studio_id
      and usr.user_id = auth.uid()
      and usr.role in (
        'studio_owner'::app_role,
        'studio_admin'::app_role,
        'independent_instructor'::app_role
      )
  )
);

create policy "aria_goals_delete"
on public.aria_goals
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = aria_goals.studio_id
      and usr.user_id = auth.uid()
      and usr.role in (
        'studio_owner'::app_role,
        'studio_admin'::app_role,
        'independent_instructor'::app_role
      )
  )
);

create or replace function public.set_aria_goals_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_aria_goals_updated_at
on public.aria_goals;

create trigger trg_aria_goals_updated_at
before update on public.aria_goals
for each row
execute function public.set_aria_goals_updated_at();
