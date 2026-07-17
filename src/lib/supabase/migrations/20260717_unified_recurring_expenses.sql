-- DanceFlow Unified Recurring Expenses V1
-- Apply before deploying the accompanying expenses page/actions.
-- Recurring schedules are forecasts only. Accounting entries are created only
-- when an occurrence is recorded into public.expenses.

begin;

create extension if not exists pgcrypto;

create table if not exists public.recurring_expense_schedules (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  created_by uuid null references auth.users(id) on delete set null,
  vendor_name text not null,
  category text not null,
  accounting_category text not null,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'USD',
  payment_method text not null,
  related_event_id uuid null references public.events(id) on delete set null,
  notes text null,
  frequency text not null,
  next_due_date date not null,
  end_date date null,
  status text not null default 'active',
  last_recorded_expense_id uuid null references public.expenses(id) on delete set null,
  last_recorded_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recurring_expense_schedules_frequency_check
    check (frequency in ('weekly', 'monthly', 'quarterly', 'annually')),
  constraint recurring_expense_schedules_status_check
    check (status in ('active', 'paused', 'completed')),
  constraint recurring_expense_schedules_date_check
    check (end_date is null or end_date >= next_due_date)
);

alter table public.expenses
  add column if not exists recurring_schedule_id uuid null
    references public.recurring_expense_schedules(id) on delete set null;

create index if not exists idx_recurring_expense_schedules_studio_due
  on public.recurring_expense_schedules (studio_id, status, next_due_date);

create index if not exists idx_expenses_recurring_schedule
  on public.expenses (recurring_schedule_id)
  where recurring_schedule_id is not null;

alter table public.recurring_expense_schedules enable row level security;

drop policy if exists "Studio users can read recurring expense schedules"
  on public.recurring_expense_schedules;
create policy "Studio users can read recurring expense schedules"
on public.recurring_expense_schedules
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = recurring_expense_schedules.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
  )
);

drop policy if exists "Studio managers can create recurring expense schedules"
  on public.recurring_expense_schedules;
create policy "Studio managers can create recurring expense schedules"
on public.recurring_expense_schedules
for insert
to authenticated
with check (
  created_by = auth.uid()
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = recurring_expense_schedules.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
      and usr.role::text in (
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin',
        'independent_instructor'
      )
  )
);

drop policy if exists "Studio managers can update recurring expense schedules"
  on public.recurring_expense_schedules;
create policy "Studio managers can update recurring expense schedules"
on public.recurring_expense_schedules
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = recurring_expense_schedules.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
      and usr.role::text in (
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin',
        'independent_instructor'
      )
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = recurring_expense_schedules.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
      and usr.role::text in (
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin',
        'independent_instructor'
      )
  )
);

commit;
