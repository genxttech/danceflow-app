-- 20270204090000_billing_price_transitions.sql
-- D7 WP-3: records that gate the end of grandfathered pricing (owner policy 2026-10-30/31).
--   * price_transition_notices: the advance notice of a regular-price change, with the rate and effective instant it disclosed and
--     its delivery evidence. No notice, no transition: price_transitions references it.
--   * price_transitions: the owner-approved, dated plan to move one protected subscription to a new Stripe Price at a billing-period boundary.
-- Service role only (RLS on, no policies, no anon/authenticated grants). Rows are permanent evidence (no delete, no truncate).
-- Creates tables only: inserts no row, schedules nothing in Stripe, sends nothing.
-- Rollback: rollback/20270204090000_billing_price_transitions_rollback.sql
-- NOT APPLIED to any shared environment by this file's authoring. Depends on 20270201090000 (protected_subscriptions).

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.protected_subscriptions') is null then
    raise exception 'price-transitions precondition failed: public.protected_subscriptions is missing (apply 20270201090000 first)';
  end if;
end $$;

create table if not exists public.price_transition_notices (
  id uuid primary key default gen_random_uuid(),
  protected_subscription_id uuid not null references public.protected_subscriptions(id) on delete restrict,
  studio_id uuid not null references public.studios(id) on delete restrict,
  effective_at timestamptz not null,
  new_stripe_price_id text not null,
  new_unit_amount_cents integer not null,
  currency text not null default 'usd',
  billing_interval text not null default 'month',
  wording_reference text not null,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  -- delivery evidence (the only fields that change after creation)
  sent_at timestamptz,
  recipient text,
  message_id text,
  delivery_status text not null default 'pending',
  constraint price_transition_notices_price_format check (new_stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  constraint price_transition_notices_amount_check check (new_unit_amount_cents > 0),
  constraint price_transition_notices_interval_check check (billing_interval in ('month', 'year')),
  constraint price_transition_notices_wording_check check (length(btrim(wording_reference)) > 0),
  constraint price_transition_notices_status_check check (delivery_status in ('pending', 'delivered', 'bounced', 'failed')),
  constraint price_transition_notices_delivered_evidence check (
    delivery_status <> 'delivered' or (sent_at is not null and recipient is not null and message_id is not null and approved_at is not null and approved_at <= sent_at and sent_at <= effective_at)
  ),
  constraint price_transition_notices_id_subscription_unique unique (id, protected_subscription_id),
  constraint price_transition_notices_approved_pair check ((approved_by is null) = (approved_at is null))
);

create index if not exists price_transition_notices_subscription_idx
  on public.price_transition_notices (protected_subscription_id, effective_at);

create table if not exists public.price_transitions (
  id uuid primary key default gen_random_uuid(),
  protected_subscription_id uuid not null references public.protected_subscriptions(id) on delete restrict,
  notice_id uuid not null,
  stripe_subscription_id text not null,
  target_stripe_price_id text not null,
  boundary_at timestamptz not null,
  status text not null default 'approved',
  stripe_schedule_id text,
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  dry_run jsonb not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_transitions_status_check check (status in ('approved', 'scheduled', 'applied', 'failed', 'canceled')),
  constraint price_transitions_sub_id_format check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint price_transitions_scheduled_has_schedule check (status not in ('scheduled', 'applied') or stripe_schedule_id is not null),
  constraint price_transitions_notice_same_subscription foreign key (notice_id, protected_subscription_id) references public.price_transition_notices(id, protected_subscription_id) on delete restrict
);

-- At most one open transition per protected subscription.
create unique index if not exists price_transitions_one_open_per_subscription
  on public.price_transitions (protected_subscription_id) where status in ('approved', 'scheduled');

alter table public.price_transition_notices enable row level security;
alter table public.price_transitions enable row level security;
revoke all on public.price_transition_notices from public, anon, authenticated, service_role;
revoke all on public.price_transitions from public, anon, authenticated, service_role;
grant select, insert, update on public.price_transition_notices to service_role;
grant select, insert, update on public.price_transitions to service_role;

create or replace function public.price_transition_notices_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'price_transition_notices rows are permanent' using errcode = '42501';
  end if;
  if new.id is distinct from old.id
     or new.protected_subscription_id is distinct from old.protected_subscription_id
     or new.studio_id is distinct from old.studio_id
     or new.effective_at is distinct from old.effective_at
     or new.new_stripe_price_id is distinct from old.new_stripe_price_id
     or new.new_unit_amount_cents is distinct from old.new_unit_amount_cents
     or new.currency is distinct from old.currency
     or new.billing_interval is distinct from old.billing_interval
     or new.wording_reference is distinct from old.wording_reference
     or new.created_at is distinct from old.created_at then
    raise exception 'the disclosed terms of a price transition notice are immutable; create a new notice' using errcode = '42501';
  end if;
  -- delivery evidence is write-once: once delivered it cannot be backdated, rewritten or withdrawn
  if old.delivery_status = 'delivered' and (new.delivery_status is distinct from old.delivery_status or new.sent_at is distinct from old.sent_at or new.recipient is distinct from old.recipient or new.message_id is distinct from old.message_id) then
    raise exception 'delivered notice evidence is immutable' using errcode = '42501';
  end if;
  if new.sent_at is distinct from old.sent_at and new.sent_at > now() then
    raise exception 'sent_at cannot be in the future' using errcode = '42501';
  end if;
  if old.approved_at is not null and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then
    raise exception 'notice approval is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists price_transition_notices_guard_trg on public.price_transition_notices;
create trigger price_transition_notices_guard_trg
  before update or delete on public.price_transition_notices
  for each row execute function public.price_transition_notices_guard();

create or replace function public.price_transitions_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'price_transitions rows are permanent' using errcode = '42501';
  end if;
  if new.id is distinct from old.id
     or new.protected_subscription_id is distinct from old.protected_subscription_id
     or new.notice_id is distinct from old.notice_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.target_stripe_price_id is distinct from old.target_stripe_price_id
     or new.boundary_at is distinct from old.boundary_at
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at
     or new.dry_run is distinct from old.dry_run then
    raise exception 'an approved price transition is immutable except for status, schedule id and result' using errcode = '42501';
  end if;
  if old.stripe_schedule_id is not null and new.stripe_schedule_id is distinct from old.stripe_schedule_id then
    raise exception 'the recorded Stripe schedule id is immutable' using errcode = '42501';
  end if;
  if old.status = 'scheduled' and new.status = 'approved' then
    raise exception 'a scheduled price transition cannot return to approved' using errcode = '42501';
  end if;
  if old.status in ('applied', 'failed', 'canceled') and new.status is distinct from old.status then
    raise exception 'a finished price transition cannot change status' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists price_transitions_guard_trg on public.price_transitions;
create trigger price_transitions_guard_trg
  before update or delete on public.price_transitions
  for each row execute function public.price_transitions_guard();

create or replace function public.price_transitions_no_truncate()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'price transition records are permanent; truncate is not allowed' using errcode = '42501';
end $$;

drop trigger if exists price_transition_notices_no_truncate_trg on public.price_transition_notices;
create trigger price_transition_notices_no_truncate_trg
  before truncate on public.price_transition_notices
  for each statement execute function public.price_transitions_no_truncate();

drop trigger if exists price_transitions_no_truncate_trg on public.price_transitions;
create trigger price_transitions_no_truncate_trg
  before truncate on public.price_transitions
  for each statement execute function public.price_transitions_no_truncate();

commit;
