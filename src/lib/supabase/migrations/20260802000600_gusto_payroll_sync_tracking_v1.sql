begin;

create table if not exists public.studio_gusto_payroll_syncs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  pay_period_id uuid not null references public.payroll_pay_periods(id) on delete cascade,
  transmission_id uuid not null references public.studio_gusto_time_sheet_transmissions(id) on delete cascade,
  gusto_pay_schedule_uuid uuid not null,
  pay_period_start date not null,
  pay_period_end date not null,
  gusto_payroll_sync_uuid uuid not null,
  gusto_payroll_uuid uuid,
  status text not null check (
    status in ('pending','processing','completed','succeeded','failed','cancelled','unknown')
  ),
  response_snapshot jsonb not null default '{}'::jsonb,
  initiated_by uuid references auth.users(id),
  initiated_at timestamptz not null default now(),
  last_checked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (transmission_id),
  unique (gusto_payroll_sync_uuid)
);

create index if not exists studio_gusto_payroll_syncs_period_idx
  on public.studio_gusto_payroll_syncs(studio_id, pay_period_id, initiated_at desc);

alter table public.studio_gusto_payroll_syncs enable row level security;

create policy "Studio payroll managers read Gusto payroll syncs"
on public.studio_gusto_payroll_syncs for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

commit;
