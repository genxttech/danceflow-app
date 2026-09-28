-- PAY-DC-2C: Stripe dispute tracking for studio-client payments.
-- Stores scalar dispute facts and ids only: no evidence, metadata, card details,
-- customer identity or raw Stripe payloads. Written only by the service role
-- (Stripe webhook); readable by the studio's owner/admin and platform admins.
-- stripe_scope = 'connect': dispute on a studio's connected account (acct_… required).
-- stripe_scope = 'platform': historical platform-scoped dispute proven to one studio
-- by an exact persisted charge/PaymentIntent reference (no account stored).
-- No historical backfill.

create table if not exists public.payment_disputes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  payment_id uuid null references public.payments(id) on delete set null,
  event_payment_id uuid null references public.event_payments(id) on delete set null,
  stripe_scope text not null check (stripe_scope in ('platform', 'connect')),
  stripe_account_id text null,
  stripe_dispute_id text not null unique check (stripe_dispute_id ~ '^(du|dp)_[A-Za-z0-9]+$'),
  stripe_charge_id text null,
  stripe_payment_intent_id text null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null,
  reason text null,
  status text not null,
  evidence_due_by timestamptz null,
  closed_at timestamptz null,
  funds_withdrawn_at timestamptz null,
  funds_reinstated_at timestamptz null,
  last_stripe_event_id text not null,
  last_stripe_event_type text not null,
  last_stripe_event_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_disputes_one_payment_link
    check (payment_id is null or event_payment_id is null),
  -- Connect disputes carry the connected account; platform disputes never carry an
  -- account (the platform account is not represented as a connected-account value).
  constraint payment_disputes_scope_account check (
    (stripe_scope = 'connect' and stripe_account_id ~ '^acct_[A-Za-z0-9]+$')
    or (stripe_scope = 'platform' and stripe_account_id is null)
  )
);

create index if not exists payment_disputes_studio_created_idx
  on public.payment_disputes (studio_id, created_at desc);
create index if not exists payment_disputes_payment_idx
  on public.payment_disputes (payment_id) where payment_id is not null;
create index if not exists payment_disputes_event_payment_idx
  on public.payment_disputes (event_payment_id) where event_payment_id is not null;
create index if not exists payment_disputes_charge_idx
  on public.payment_disputes (stripe_charge_id) where stripe_charge_id is not null;
create index if not exists payment_disputes_payment_intent_idx
  on public.payment_disputes (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

-- Identity is immutable once created: a dispute can never be re-pointed to another
-- studio, scope, account or dispute id. A payment link may be set once (NULL -> id)
-- and cleared (id -> NULL, e.g. ON DELETE SET NULL), but never re-pointed to a
-- different id.
create or replace function public.guard_payment_dispute_identity_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.studio_id is distinct from old.studio_id
     or new.stripe_scope is distinct from old.stripe_scope
     or new.stripe_account_id is distinct from old.stripe_account_id
     or new.stripe_dispute_id is distinct from old.stripe_dispute_id then
    raise exception 'payment_disputes identity is immutable'
      using errcode = 'check_violation';
  end if;

  if (old.payment_id is not null and new.payment_id is not null
      and new.payment_id is distinct from old.payment_id)
     or (old.event_payment_id is not null and new.event_payment_id is not null
         and new.event_payment_id is distinct from old.event_payment_id) then
    raise exception 'payment_disputes payment link cannot be re-pointed'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_payment_disputes_identity_immutable on public.payment_disputes;
create trigger trg_payment_disputes_identity_immutable
  before update on public.payment_disputes
  for each row execute function public.guard_payment_dispute_identity_immutable();

drop trigger if exists trg_payment_disputes_set_updated_at on public.payment_disputes;
create trigger trg_payment_disputes_set_updated_at
  before update on public.payment_disputes
  for each row execute function public.set_updated_at();

alter table public.payment_disputes enable row level security;

drop policy if exists "payment_disputes_select" on public.payment_disputes;
create policy "payment_disputes_select"
  on public.payment_disputes
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = payment_disputes.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in ('platform_admin', 'studio_owner', 'studio_admin')
    )
  );
-- No INSERT, UPDATE, or DELETE policy for any role: writes are service-role only.
