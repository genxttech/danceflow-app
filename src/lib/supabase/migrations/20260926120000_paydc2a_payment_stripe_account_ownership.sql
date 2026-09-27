-- PAY-DC-2A: immutable Stripe account ownership for studio-client payments.
-- stripe_account_id = the Stripe connected account ('acct_…') that owns the charge.
-- NULL = not a Stripe charge (manual/external/import) or ownership not yet proven.
-- Never populated from studios.stripe_connected_account_id by this migration.

alter table public.payments
  add column if not exists stripe_account_id text null;
alter table public.event_payments
  add column if not exists stripe_account_id text null;

alter table public.payments
  drop constraint if exists payments_stripe_account_id_format;
alter table public.payments
  add constraint payments_stripe_account_id_format
  check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]+$');
alter table public.event_payments
  drop constraint if exists event_payments_stripe_account_id_format;
alter table public.event_payments
  add constraint event_payments_stripe_account_id_format
  check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]+$');

comment on column public.payments.stripe_account_id is
  'Stripe connected account that owns this charge (acct_…). NULL = non-Stripe or ownership unproven. Immutable once set (PAY-DC-2A).';
comment on column public.event_payments.stripe_account_id is
  'Stripe connected account that owns this charge (acct_…). NULL = non-Stripe or ownership unproven. Immutable once set (PAY-DC-2A).';

create index if not exists payments_stripe_account_pi_idx
  on public.payments (stripe_account_id, stripe_payment_intent_id)
  where stripe_account_id is not null;
create index if not exists event_payments_stripe_account_pi_idx
  on public.event_payments (stripe_account_id, stripe_payment_intent_id)
  where stripe_account_id is not null;

-- Immutability: NULL -> acct_ allowed once; any change of a set value is rejected.
create or replace function public.guard_stripe_account_id_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.stripe_account_id is not null
     and new.stripe_account_id is distinct from old.stripe_account_id then
    raise exception 'stripe_account_id is immutable once set'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payments_stripe_account_immutable on public.payments;
create trigger trg_payments_stripe_account_immutable
  before update of stripe_account_id on public.payments
  for each row execute function public.guard_stripe_account_id_immutable();

drop trigger if exists trg_event_payments_stripe_account_immutable on public.event_payments;
create trigger trg_event_payments_stripe_account_immutable
  before update of stripe_account_id on public.event_payments
  for each row execute function public.guard_stripe_account_id_immutable();

-- Provable backfill (Terminal only): terminal_payment_sessions.stripe_account_id is
-- NOT NULL, written at PaymentIntent creation with the same stripeAccount, and
-- stripe_payment_intent_id is UNIQUE there. event_payments is intentionally not
-- bulk-backfilled (its accounting trigger is not column-scoped).
update public.payments p
   set stripe_account_id = tps.stripe_account_id
  from public.terminal_payment_sessions tps
 where p.stripe_account_id is null
   and p.terminal_payment_session_id = tps.id
   and p.stripe_payment_intent_id is not null
   and tps.stripe_payment_intent_id = p.stripe_payment_intent_id
   and tps.studio_id = p.studio_id
   and tps.stripe_account_id ~ '^acct_[A-Za-z0-9]+$';
