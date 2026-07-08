-- 20260707_platform_expense_ledger_v1.sql

create table if not exists public.platform_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null default current_date,
  vendor_name text not null,
  description text,
  category text not null default 'other',
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null default 'USD',
  payment_method text,
  status text not null default 'draft',
  tax_treatment text not null default 'deductible',
  is_recurring boolean not null default false,
  recurrence_frequency text,
  related_studio_id uuid references public.studios(id) on delete set null,
  source text not null default 'manual',
  external_id text,
  receipt_url text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_expenses_category_check check (
    category in (
      'software_tools',
      'hosting_infrastructure',
      'payment_processing',
      'contractor_payroll',
      'marketing_ads',
      'professional_services',
      'taxes_licenses',
      'office_admin',
      'travel_meals',
      'owner_draw',
      'other'
    )
  ),
  constraint platform_expenses_status_check check (
    status in ('draft', 'reviewed', 'reconciled', 'excluded')
  ),
  constraint platform_expenses_tax_treatment_check check (
    tax_treatment in ('deductible', 'capitalized', 'non_deductible', 'distribution', 'unknown')
  ),
  constraint platform_expenses_recurrence_frequency_check check (
    recurrence_frequency is null
    or recurrence_frequency in ('weekly', 'monthly', 'quarterly', 'annual')
  )
);

create index if not exists platform_expenses_expense_date_idx
  on public.platform_expenses (expense_date desc);

create index if not exists platform_expenses_category_idx
  on public.platform_expenses (category);

create index if not exists platform_expenses_status_idx
  on public.platform_expenses (status);

create index if not exists platform_expenses_related_studio_id_idx
  on public.platform_expenses (related_studio_id);

create or replace function public.set_platform_expenses_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_platform_expenses_updated_at on public.platform_expenses;

create trigger set_platform_expenses_updated_at
before update on public.platform_expenses
for each row
execute function public.set_platform_expenses_updated_at();

alter table public.platform_expenses enable row level security;

drop policy if exists "Platform admins can read platform expenses" on public.platform_expenses;
drop policy if exists "Platform admins can insert platform expenses" on public.platform_expenses;
drop policy if exists "Platform admins can update platform expenses" on public.platform_expenses;
drop policy if exists "Platform admins can delete platform expenses" on public.platform_expenses;

create policy "Platform admins can read platform expenses"
on public.platform_expenses
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

create policy "Platform admins can insert platform expenses"
on public.platform_expenses
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

create policy "Platform admins can update platform expenses"
on public.platform_expenses
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