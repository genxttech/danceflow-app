-- Stripe Terminal memberships foundation V1
-- Run in development and production before deploying the matching application files.

create table if not exists public.stripe_connected_customers (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  stripe_account_id text not null,
  stripe_customer_id text not null,
  email_snapshot text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, client_id, stripe_account_id),
  unique (stripe_account_id, stripe_customer_id)
);

create table if not exists public.membership_connected_prices (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  membership_plan_id uuid not null references public.membership_plans(id) on delete cascade,
  stripe_account_id text not null,
  stripe_product_id text not null,
  stripe_price_id text not null,
  currency text not null default 'usd',
  unit_amount_cents integer not null check (unit_amount_cents >= 0),
  billing_interval text not null check (billing_interval in ('monthly', 'quarterly', 'yearly')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (membership_plan_id, stripe_account_id),
  unique (stripe_account_id, stripe_price_id)
);

alter table public.stripe_subscriptions
  add column if not exists stripe_account_id text;

create index if not exists stripe_subscriptions_stripe_account_idx
  on public.stripe_subscriptions(stripe_account_id);

alter table public.client_memberships
  drop constraint if exists client_memberships_status_check;

alter table public.client_memberships
  add constraint client_memberships_status_check
  check (status in ('active', 'paused', 'cancelled', 'expired', 'pending', 'past_due', 'unpaid'));

alter table public.stripe_connected_customers enable row level security;
alter table public.membership_connected_prices enable row level security;

create policy stripe_connected_customers_studio_access
on public.stripe_connected_customers
for all to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_connected_customers.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_connected_customers.studio_id
      and usr.active = true
  )
);

create policy membership_connected_prices_studio_access
on public.membership_connected_prices
for all to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = membership_connected_prices.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = membership_connected_prices.studio_id
      and usr.active = true
  )
);

