-- 20270115090000_billing_protected_subscriptions.sql
-- D7-4 (R36): registry of SaaS subscriptions that carry protected, grandfathered or contractual terms (the $129/month Pro first).
--   * One row per protected Stripe subscription, keyed by studio and subscription id, never by price alone.
--   * A studio with any unreleased row is "protected": the checkout route refuses to start a new Checkout for it (no new trial, no new Founder price)
--     and routes it to support, whatever the Stripe status (including canceled). Release is explicit and audited (released_at + released_reason); rows are never deleted.
--   * Service role only: RLS on, no policies, no grants to anon or authenticated. Tenants cannot read or write it.
--   * This migration CREATES THE TABLE ONLY. It inserts no row: populating the registry is a separate, owner-approved, audited step that needs the subscriber's original terms (O9).
-- Rollback: rollback/20270115090000_billing_protected_subscriptions_rollback.sql
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studios') is null then
    raise exception 'protected-subscriptions precondition failed: public.studios is missing';
  end if;
end $$;

create table if not exists public.protected_subscriptions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  stripe_subscription_id text not null,
  stripe_customer_id text,
  stripe_price_id text,
  protection_kind text not null,
  terms_reference text not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  released_at timestamptz,
  released_reason text,
  constraint protected_subscriptions_sub_id_format check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint protected_subscriptions_kind_check check (protection_kind in ('grandfathered_founder_legacy', 'contractual_exception')),
  constraint protected_subscriptions_terms_ref_check check (length(btrim(terms_reference)) > 0),
  constraint protected_subscriptions_release_pair check ((released_at is null) = (released_reason is null)),
  constraint protected_subscriptions_release_reason_check check (released_reason is null or length(btrim(released_reason)) > 0),
  constraint protected_subscriptions_sub_unique unique (stripe_subscription_id)
);

create index if not exists protected_subscriptions_studio_active_idx
  on public.protected_subscriptions (studio_id) where released_at is null;

alter table public.protected_subscriptions enable row level security;
revoke all on public.protected_subscriptions from public, anon, authenticated, service_role;
grant select, insert, update on public.protected_subscriptions to service_role;

-- Identity is immutable and rows are permanent evidence: change release fields only, never delete.
create or replace function public.protected_subscriptions_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'protected_subscriptions rows are permanent; release the row instead' using errcode = '42501';
  end if;
  if new.studio_id is distinct from old.studio_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.protection_kind is distinct from old.protection_kind
     or new.terms_reference is distinct from old.terms_reference
     or new.created_at is distinct from old.created_at then
    raise exception 'protected_subscriptions identity and terms fields are immutable' using errcode = '42501';
  end if;
  if old.released_at is not null and (new.released_at is distinct from old.released_at or new.released_reason is distinct from old.released_reason) then
    raise exception 'a released protected subscription cannot be re-released or edited' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists protected_subscriptions_guard_trg on public.protected_subscriptions;
create trigger protected_subscriptions_guard_trg
  before update or delete on public.protected_subscriptions
  for each row execute function public.protected_subscriptions_guard();

create or replace function public.protected_subscriptions_no_truncate()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'protected_subscriptions rows are permanent; truncate is not allowed' using errcode = '42501';
end $$;

drop trigger if exists protected_subscriptions_no_truncate_trg on public.protected_subscriptions;
create trigger protected_subscriptions_no_truncate_trg
  before truncate on public.protected_subscriptions
  for each statement execute function public.protected_subscriptions_no_truncate();

commit;
