begin;

create table if not exists public.studio_gusto_time_sheet_transmissions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid not null references public.studio_gusto_connections(id) on delete cascade,
  pay_period_id uuid not null references public.payroll_pay_periods(id) on delete cascade,
  preview_id uuid not null references public.studio_gusto_time_sheet_previews(id) on delete cascade,
  status text not null check (status in ('sending','succeeded','partial','failed')),
  item_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  initiated_by uuid references auth.users(id),
  initiated_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (preview_id)
);

create table if not exists public.studio_gusto_time_sheet_transmission_items (
  id uuid primary key default gen_random_uuid(),
  transmission_id uuid not null references public.studio_gusto_time_sheet_transmissions(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  preview_item_id uuid not null references public.studio_gusto_time_sheet_preview_items(id) on delete cascade,
  earning_id uuid not null references public.instructor_earnings(id) on delete cascade,
  status text not null check (status in ('sending','succeeded','failed','reconciled')),
  request_fingerprint text not null,
  gusto_time_sheet_uuid uuid,
  gusto_response jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  first_attempted_at timestamptz,
  last_attempted_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (preview_item_id)
);

create index if not exists studio_gusto_time_sheet_transmissions_period_idx
  on public.studio_gusto_time_sheet_transmissions(studio_id, pay_period_id, initiated_at desc);

create index if not exists studio_gusto_time_sheet_transmission_items_tx_idx
  on public.studio_gusto_time_sheet_transmission_items(transmission_id, status);

alter table public.studio_gusto_time_sheet_transmissions enable row level security;
alter table public.studio_gusto_time_sheet_transmission_items enable row level security;

create policy "Studio payroll managers read Gusto transmissions"
on public.studio_gusto_time_sheet_transmissions for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

create policy "Studio payroll managers read Gusto transmission items"
on public.studio_gusto_time_sheet_transmission_items for select to authenticated
using (public.can_manage_studio_gusto(studio_id));

commit;
