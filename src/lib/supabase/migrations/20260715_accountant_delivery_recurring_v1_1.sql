begin;

create table if not exists public.studio_accountant_delivery_schedules (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null unique references public.studios(id) on delete cascade,
  accountant_profile_id uuid not null references public.studio_accountant_profiles(id) on delete cascade,
  cadence text not null check (cadence in ('monthly','quarterly','annually')),
  report_types text[] not null default '{}'::text[],
  report_range text not null check (report_range in ('month','quarter','year')),
  enabled boolean not null default false,
  first_send_approved boolean not null default false,
  first_send_approved_at timestamptz,
  first_send_approved_by uuid references auth.users(id) on delete set null,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_delivery_id uuid references public.studio_accountant_deliveries(id) on delete set null,
  last_error text,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  constraint studio_accountant_delivery_schedule_approval_consistent check (
    (first_send_approved = false and first_send_approved_at is null and first_send_approved_by is null)
    or
    (first_send_approved = true and first_send_approved_at is not null and first_send_approved_by is not null)
  )
);

alter table public.studio_accountant_deliveries
  add column if not exists schedule_id uuid references public.studio_accountant_delivery_schedules(id) on delete set null,
  add column if not exists period_key text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz;

create unique index if not exists studio_accountant_deliveries_schedule_period_uidx
  on public.studio_accountant_deliveries(schedule_id, period_key)
  where schedule_id is not null and period_key is not null;

create index if not exists studio_accountant_delivery_schedules_due_idx
  on public.studio_accountant_delivery_schedules(enabled, next_run_at)
  where enabled = true;

alter table public.studio_accountant_delivery_schedules enable row level security;

drop policy if exists studio_accountant_delivery_schedules_select on public.studio_accountant_delivery_schedules;
drop policy if exists studio_accountant_delivery_schedules_insert on public.studio_accountant_delivery_schedules;
drop policy if exists studio_accountant_delivery_schedules_update on public.studio_accountant_delivery_schedules;

create policy studio_accountant_delivery_schedules_select
on public.studio_accountant_delivery_schedules for select to authenticated
using (exists (
  select 1 from public.user_studio_roles usr
  where usr.studio_id = studio_accountant_delivery_schedules.studio_id
    and usr.user_id = auth.uid()
    and usr.active = true
    and usr.role in ('studio_owner','studio_admin')
));

create policy studio_accountant_delivery_schedules_insert
on public.studio_accountant_delivery_schedules for insert to authenticated
with check (exists (
  select 1 from public.user_studio_roles usr
  where usr.studio_id = studio_accountant_delivery_schedules.studio_id
    and usr.user_id = auth.uid()
    and usr.active = true
    and usr.role in ('studio_owner','studio_admin')
));

create policy studio_accountant_delivery_schedules_update
on public.studio_accountant_delivery_schedules for update to authenticated
using (exists (
  select 1 from public.user_studio_roles usr
  where usr.studio_id = studio_accountant_delivery_schedules.studio_id
    and usr.user_id = auth.uid()
    and usr.active = true
    and usr.role in ('studio_owner','studio_admin')
))
with check (exists (
  select 1 from public.user_studio_roles usr
  where usr.studio_id = studio_accountant_delivery_schedules.studio_id
    and usr.user_id = auth.uid()
    and usr.active = true
    and usr.role in ('studio_owner','studio_admin')
));

revoke all on public.studio_accountant_delivery_schedules from anon;
grant select, insert, update on public.studio_accountant_delivery_schedules to authenticated;

commit;
