begin;

alter table public.appointments
  add column if not exists client_membership_id uuid null references public.client_memberships(id) on delete set null;

create index if not exists appointments_client_membership_id_idx
  on public.appointments (client_membership_id)
  where client_membership_id is not null;

alter table public.studio_settings
  add column if not exists block_depleted_membership_booking boolean not null default true,
  add column if not exists block_unpaid_membership_booking boolean not null default true;

create table if not exists public.client_membership_periods (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  client_membership_id uuid not null references public.client_memberships(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  amount_due numeric(12,2) not null default 0 check (amount_due >= 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  currency text not null default 'usd',
  payment_status text not null default 'due' check (
    payment_status in ('due','paid','partial','past_due','waived','void')
  ),
  payment_id uuid null references public.payments(id) on delete set null,
  payment_due_at timestamptz null,
  paid_at timestamptz null,
  waived_at timestamptz null,
  waived_by uuid null references auth.users(id) on delete set null,
  waiver_reason text null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_membership_periods_valid_dates check (period_end >= period_start),
  constraint client_membership_periods_amount_paid_not_over_due check (
    payment_status in ('waived','void') or amount_paid <= amount_due
  ),
  constraint client_membership_periods_unique_period unique (client_membership_id, period_start, period_end)
);

create index if not exists client_membership_periods_studio_client_idx
  on public.client_membership_periods (studio_id, client_id, period_start desc);
create index if not exists client_membership_periods_membership_status_idx
  on public.client_membership_periods (client_membership_id, payment_status, period_start desc);
create unique index if not exists client_membership_periods_payment_id_unique_idx
  on public.client_membership_periods (payment_id)
  where payment_id is not null;

alter table public.client_membership_usage
  add column if not exists client_membership_period_id uuid null references public.client_membership_periods(id) on delete set null;

create index if not exists client_membership_usage_period_idx
  on public.client_membership_usage (client_membership_period_id)
  where client_membership_period_id is not null;

-- Historical race conditions could create more than one membership usage row
-- for the same appointment. Keep the newest row as the canonical deduction and
-- remove only older duplicates before enforcing the one-appointment/one-usage rule.
-- This makes the migration safe for existing production data while preventing
-- future duplicate attendance deductions.
with ranked_appointment_usage as (
  select
    id,
    row_number() over (
      partition by reference_type, reference_id
      order by created_at desc, id desc
    ) as duplicate_rank
  from public.client_membership_usage
  where reference_type = 'appointment'
    and reference_id is not null
)
delete from public.client_membership_usage usage
using ranked_appointment_usage ranked
where usage.id = ranked.id
  and ranked.duplicate_rank > 1;

create unique index if not exists client_membership_usage_appointment_unique_idx
  on public.client_membership_usage (reference_type, reference_id)
  where reference_type = 'appointment' and reference_id is not null;

alter table public.client_membership_periods enable row level security;

drop policy if exists "Studio members can view membership periods" on public.client_membership_periods;
create policy "Studio members can view membership periods"
  on public.client_membership_periods for select
  using (
    exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = client_membership_periods.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

drop policy if exists "Authorized studio staff can manage membership periods" on public.client_membership_periods;
create policy "Authorized studio staff can manage membership periods"
  on public.client_membership_periods for all
  using (
    exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = client_membership_periods.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner','studio_admin','front_desk')
    )
  )
  with check (
    exists (
      select 1 from public.user_studio_roles usr
      where usr.studio_id = client_membership_periods.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner','studio_admin','front_desk')
    )
  );

create or replace function public.set_membership_period_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_membership_period_updated_at on public.client_membership_periods;
create trigger set_membership_period_updated_at
before update on public.client_membership_periods
for each row execute function public.set_membership_period_updated_at();

-- Backfill current periods without inventing payment history. Active/trialing rows
-- are marked due and can be reconciled through Stripe invoices or staff entry.
insert into public.client_membership_periods (
  studio_id,
  client_id,
  client_membership_id,
  period_start,
  period_end,
  amount_due,
  amount_paid,
  currency,
  payment_status,
  payment_due_at,
  created_by
)
select
  cm.studio_id,
  cm.client_id,
  cm.id,
  cm.current_period_start,
  cm.current_period_end,
  greatest(coalesce(cm.price_snapshot, 0), 0),
  0,
  lower(coalesce(ss.currency, ss.default_currency, 'usd')),
  case
    when cm.status in ('past_due','unpaid') then 'past_due'
    else 'due'
  end,
  cm.current_period_start::timestamptz,
  cm.created_by
from public.client_memberships cm
left join public.studio_settings ss on ss.studio_id = cm.studio_id
where cm.current_period_start is not null
  and cm.current_period_end is not null
on conflict (client_membership_id, period_start, period_end) do nothing;

commit;
