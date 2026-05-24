-- Organizer Suite access model V1
-- Adds organizer-owned billing/access fields separate from studio plan tiers.
-- Safe to run in dev first, then production after the app patch is tested.

begin;

alter table public.organizers
  add column if not exists billing_plan text not null default 'organizer',
  add column if not exists subscription_status text not null default 'trialing',
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_connected_account_id text,
  add column if not exists stripe_connect_details_submitted boolean not null default false,
  add column if not exists stripe_connect_charges_enabled boolean not null default false,
  add column if not exists stripe_connect_payouts_enabled boolean not null default false,
  add column if not exists stripe_connect_onboarding_complete boolean not null default false,
  add column if not exists platform_fee_bps integer not null default 350;

alter table public.organizers
  drop constraint if exists organizers_billing_plan_check;

alter table public.organizers
  add constraint organizers_billing_plan_check
  check (billing_plan in ('organizer'));

alter table public.organizers
  drop constraint if exists organizers_subscription_status_check;

alter table public.organizers
  add constraint organizers_subscription_status_check
  check (subscription_status in ('trialing', 'active', 'past_due', 'canceled', 'inactive'));

alter table public.organizers
  drop constraint if exists organizers_platform_fee_bps_check;

alter table public.organizers
  add constraint organizers_platform_fee_bps_check
  check (platform_fee_bps >= 0 and platform_fee_bps <= 10000);

-- Existing dev/test organizers should receive access unless intentionally canceled later.
update public.organizers
set
  billing_plan = 'organizer',
  subscription_status = coalesce(nullif(subscription_status, ''), 'trialing'),
  platform_fee_bps = coalesce(platform_fee_bps, 350);

commit;
