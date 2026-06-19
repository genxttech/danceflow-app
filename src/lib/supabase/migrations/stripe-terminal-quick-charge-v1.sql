-- Stripe Terminal Quick Charge V1
-- Run in dev first, then production before deploying the Quick Charge page.

alter table public.payments
  alter column client_id drop not null;

alter table public.payments
  add column if not exists quick_charge_category text,
  add column if not exists guest_name text;

create index if not exists payments_quick_charge_category_idx
  on public.payments(quick_charge_category);

create index if not exists payments_guest_name_idx
  on public.payments(guest_name);
