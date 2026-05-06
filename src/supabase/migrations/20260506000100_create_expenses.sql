create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid not null references public.studios(id) on delete cascade,

  recorded_by uuid references auth.users(id) on delete set null,

  expense_date date not null default current_date,

  vendor_name text not null,
  category text not null default 'other',

  amount numeric(10, 2) not null check (amount >= 0),
  currency text not null default 'USD',

  payment_method text not null default 'other',

  notes text,

  related_client_id uuid references public.clients(id) on delete set null,
  related_event_id uuid references public.events(id) on delete set null,
  related_appointment_id uuid references public.appointments(id) on delete set null,

  receipt_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_expenses_studio_id
  on public.expenses(studio_id);

create index if not exists idx_expenses_studio_date
  on public.expenses(studio_id, expense_date desc);

create index if not exists idx_expenses_studio_category
  on public.expenses(studio_id, category);

create index if not exists idx_expenses_related_client_id
  on public.expenses(related_client_id);

create index if not exists idx_expenses_related_event_id
  on public.expenses(related_event_id);

create index if not exists idx_expenses_related_appointment_id
  on public.expenses(related_appointment_id);

create or replace function public.set_expenses_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_expenses_updated_at on public.expenses;

create trigger trg_expenses_updated_at
before update on public.expenses
for each row
execute function public.set_expenses_updated_at();

alter table public.expenses enable row level security;

drop policy if exists "Studio members can view expenses" on public.expenses;
drop policy if exists "Studio owners and admins can insert expenses" on public.expenses;
drop policy if exists "Studio owners and admins can update expenses" on public.expenses;
drop policy if exists "Studio owners and admins can delete expenses" on public.expenses;

create policy "Studio members can view expenses"
on public.expenses
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = expenses.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Studio owners and admins can insert expenses"
on public.expenses
for insert
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = expenses.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin',
        'independent_instructor'
      )
  )
);

create policy "Studio owners and admins can update expenses"
on public.expenses
for update
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = expenses.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
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
    where usr.studio_id = expenses.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin',
        'independent_instructor'
      )
  )
);

create policy "Studio owners and admins can delete expenses"
on public.expenses
for delete
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = expenses.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner',
        'studio_admin',
        'organizer_owner',
        'organizer_admin',
        'independent_instructor'
      )
  )
);