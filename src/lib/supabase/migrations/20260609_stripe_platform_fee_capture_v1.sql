-- 20260609_stripe_platform_fee_capture_v1.sql
-- Adds stored Stripe fee fields used by the accounting source-of-truth helper.
-- Amounts are stored in major currency units to match existing payments.amount/event_payments.amount.

alter table public.payments
  add column if not exists stripe_processing_fee_amount numeric(12, 2) not null default 0,
  add column if not exists stripe_application_fee_amount numeric(12, 2) not null default 0,
  add column if not exists platform_fee_amount numeric(12, 2) not null default 0,
  add column if not exists stripe_balance_transaction_id text;

alter table public.event_payments
  add column if not exists stripe_charge_id text,
  add column if not exists stripe_processing_fee_amount numeric(12, 2) not null default 0,
  add column if not exists stripe_application_fee_amount numeric(12, 2) not null default 0,
  add column if not exists platform_fee_amount numeric(12, 2) not null default 0,
  add column if not exists stripe_balance_transaction_id text;

create index if not exists idx_payments_stripe_charge_id
  on public.payments(stripe_charge_id)
  where stripe_charge_id is not null;

create index if not exists idx_payments_stripe_balance_transaction_id
  on public.payments(stripe_balance_transaction_id)
  where stripe_balance_transaction_id is not null;

create index if not exists idx_event_payments_stripe_charge_id
  on public.event_payments(stripe_charge_id)
  where stripe_charge_id is not null;

create index if not exists idx_event_payments_stripe_balance_transaction_id
  on public.event_payments(stripe_balance_transaction_id)
  where stripe_balance_transaction_id is not null;
