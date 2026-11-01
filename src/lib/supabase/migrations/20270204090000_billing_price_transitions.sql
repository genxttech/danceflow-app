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
  -- lifecycle evidence: schedule creation, schedule activation, actual price change and registry reconciliation are separate facts
  schedule_verified_at timestamptz,
  activated_at timestamptz,
  price_changed_at timestamptz,
  reconciled_at timestamptz,
  review_reason text,
  review_evidence jsonb,
  reconcile_evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_transitions_status_check check (status in ('approved', 'scheduled', 'needs_review', 'reconciled', 'failed', 'canceled')),
  constraint price_transitions_sub_id_format check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint price_transitions_scheduled_has_schedule check (status not in ('scheduled', 'needs_review', 'reconciled') or stripe_schedule_id is not null),
  constraint price_transitions_reconciled_evidence check (status <> 'reconciled' or (activated_at is not null and price_changed_at is not null and reconciled_at is not null and reconcile_evidence is not null)),
  constraint price_transitions_review_reason check (status <> 'needs_review' or (review_reason is not null and length(btrim(review_reason)) > 0)),
  constraint price_transitions_notice_same_subscription foreign key (notice_id, protected_subscription_id) references public.price_transition_notices(id, protected_subscription_id) on delete restrict
);

-- At most one open transition per protected subscription.
create unique index if not exists price_transitions_one_open_per_subscription
  on public.price_transitions (protected_subscription_id) where status in ('approved', 'scheduled', 'needs_review');

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
  -- lifecycle: approved -> scheduled | failed | canceled; scheduled -> needs_review | reconciled | canceled; needs_review -> scheduled | reconciled | canceled
  if new.status is distinct from old.status and not (
       (old.status = 'approved' and new.status in ('scheduled', 'failed', 'canceled'))
    or (old.status = 'scheduled' and new.status in ('needs_review', 'reconciled', 'canceled'))
    or (old.status = 'needs_review' and new.status in ('scheduled', 'reconciled', 'canceled'))
  ) then
    raise exception 'illegal price transition status change % -> %', old.status, new.status using errcode = '42501';
  end if;
  if old.status in ('reconciled', 'failed', 'canceled') then
    raise exception 'a finished price transition is immutable' using errcode = '42501';
  end if;
  -- observed facts are write-once
  if (old.schedule_verified_at is not null and new.schedule_verified_at is distinct from old.schedule_verified_at)
     or (old.activated_at is not null and new.activated_at is distinct from old.activated_at)
     or (old.price_changed_at is not null and new.price_changed_at is distinct from old.price_changed_at)
     or (old.reconciled_at is not null and new.reconciled_at is distinct from old.reconciled_at)
     or (old.reconcile_evidence is not null and new.reconcile_evidence is distinct from old.reconcile_evidence) then
    raise exception 'recorded transition milestones are immutable' using errcode = '42501';
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

-- Atomic completion: record the reconciled transition and release the protected-price registry row in ONE transaction.
-- The evidence must restate what the application verified against Stripe; the function re-checks it against the stored plan.
-- Retry-safe: a second call for an already reconciled transition returns 'already_reconciled' and changes nothing.
create or replace function public.complete_price_transition_reconciliation(p_transition_id uuid, p_evidence jsonb)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.price_transitions%rowtype;
  r public.protected_subscriptions%rowtype;
  v_release_reason text;
begin
  select * into t from public.price_transitions where id = p_transition_id for update;
  if not found then
    raise exception 'price transition not found' using errcode = '02000';
  end if;
  if t.status = 'reconciled' then
    return 'already_reconciled';
  end if;
  if t.status not in ('scheduled', 'needs_review') then
    raise exception 'price transition is % and cannot be reconciled', t.status using errcode = '55000';
  end if;
  if p_evidence is null
     or p_evidence->>'subscription_id' is distinct from t.stripe_subscription_id
     or p_evidence->>'price_id' is distinct from t.target_stripe_price_id
     or p_evidence->>'schedule_id' is distinct from t.stripe_schedule_id
     or (p_evidence->>'boundary_at')::timestamptz is distinct from t.boundary_at
     or (p_evidence->>'period_start')::timestamptz is distinct from t.boundary_at
     or p_evidence->>'customer_matches' is distinct from 'true'
     or p_evidence->>'studio_matches' is distinct from 'true'
     or p_evidence->>'phase_entered' is distinct from 'true'
     or p_evidence->>'price_changed' is distinct from 'true'
     or p_evidence->>'amount_matches_notice' is distinct from 'true' then
    raise exception 'reconciliation evidence does not match the approved transition' using errcode = '22023';
  end if;

  select * into r from public.protected_subscriptions where id = t.protected_subscription_id for update;
  v_release_reason := 'price_transition_reconciled:' || t.id::text;
  if r.released_at is not null and r.released_reason is distinct from v_release_reason then
    raise exception 'protected subscription was already released for another reason' using errcode = '55000';
  end if;
  if r.released_at is null then
    update public.protected_subscriptions set released_at = now(), released_reason = v_release_reason where id = r.id;
  end if;

  update public.price_transitions
     set status = 'reconciled',
         activated_at = coalesce(activated_at, now()),
         price_changed_at = coalesce(price_changed_at, now()),
         reconciled_at = now(),
         reconcile_evidence = p_evidence
   where id = t.id;
  return 'reconciled';
end $$;

revoke all on function public.complete_price_transition_reconciliation(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.complete_price_transition_reconciliation(uuid, jsonb) to service_role;

commit;
