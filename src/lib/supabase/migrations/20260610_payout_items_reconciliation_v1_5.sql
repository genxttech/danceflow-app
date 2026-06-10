-- 20260610_payout_items_reconciliation_v1_5.sql
-- Stores Stripe balance transactions that make up a payout so DanceFlow can
-- reconcile payout totals back to payments, event payments, fees, refunds, and adjustments.

create table if not exists public.stripe_payout_items (
  id uuid primary key default gen_random_uuid(),

  stripe_payout_record_id uuid references public.stripe_payouts(id) on delete cascade,
  stripe_payout_id text not null,
  stripe_account_id text,

  stripe_balance_transaction_id text not null,
  stripe_source_id text,
  stripe_source_type text,

  studio_id uuid references public.studios(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  event_payment_id uuid references public.event_payments(id) on delete set null,

  amount numeric(12, 2) not null default 0,
  fee numeric(12, 2) not null default 0,
  net numeric(12, 2) not null default 0,
  currency text not null default 'USD',

  type text,
  reporting_category text,
  description text,
  available_on date,
  balance_transaction_created_at timestamptz,

  fee_details jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_stripe_payout_items_account_balance_txn
  on public.stripe_payout_items (
    coalesce(stripe_account_id, ''),
    stripe_balance_transaction_id
  );

create index if not exists idx_stripe_payout_items_studio_available
  on public.stripe_payout_items(studio_id, available_on desc);

create index if not exists idx_stripe_payout_items_payout
  on public.stripe_payout_items(stripe_payout_id);

create index if not exists idx_stripe_payout_items_payment
  on public.stripe_payout_items(payment_id);

create index if not exists idx_stripe_payout_items_event_payment
  on public.stripe_payout_items(event_payment_id);

create index if not exists idx_stripe_payout_items_source
  on public.stripe_payout_items(stripe_source_id);

alter table public.stripe_payout_items enable row level security;

drop policy if exists stripe_payout_items_studio_select on public.stripe_payout_items;

create policy stripe_payout_items_studio_select on public.stripe_payout_items
for select
using (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = stripe_payout_items.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create or replace function public.touch_stripe_payout_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_stripe_payout_items_touch on public.stripe_payout_items;

create trigger trg_stripe_payout_items_touch
before update on public.stripe_payout_items
for each row
execute function public.touch_stripe_payout_items_updated_at();
