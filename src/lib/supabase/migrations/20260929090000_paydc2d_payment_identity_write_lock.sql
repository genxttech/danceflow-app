-- PAY-DC-2D: payment identity write-lock.
--
-- Stripe identity fields decide which Stripe account and object a refund,
-- webhook reconciliation or ticket fulfilment acts on. Before this migration
-- ordinary tenant roles could write them directly through PostgREST:
--   * studio owner/admin/front desk could INSERT or UPDATE payments and
--     event_payments with any stripe_account_id / PaymentIntent / charge id
--     (the PAY-DC-2A trigger only blocks changing a non-NULL owner), which a
--     later refund would treat as authoritative;
--   * any active studio role could set event_registrations Stripe ids, which
--     the event refund uses as its target PaymentIntent;
--   * studio owners/admins could rewrite studios.stripe_connected_account_id,
--     the account every Connect charge, refund proof and webhook mapping uses;
--   * any active studio role could INSERT/UPDATE stripe_subscriptions and
--     stripe_customers rows that the membership webhooks trust;
--   * anyone could INSERT event_registrations / event_registration_attendees
--     rows (a confirmed "ticket" with a caller-chosen ticket code).
--
-- Fix (minimal; no data change, no backfill):
--   1. SECURITY INVOKER guard triggers that decide only on current_user (the DB
--      role PostgREST sets from the verified JWT), exactly like the platform
--      role / entitlement / capability guards. For anon and authenticated:
--        INSERT with any protected column non-NULL  -> rejected;
--        UPDATE changing any protected column (NULL->value, value->other,
--        value->NULL)                                -> rejected.
--      Updates that leave the protected columns unchanged (status, accounting,
--      refund bookkeeping) are unaffected. service_role (webhook and server
--      admin client), postgres/supabase_admin (SQL, migrations) and SECURITY
--      DEFINER owner contexts pass.
--      Review rule: a tenant-callable SECURITY DEFINER function that writes a
--      protected column would pass the guard and must be code-reviewed.
--   2. Drop tenant write policies on stripe_subscriptions / stripe_customers
--      (their SELECT policies stay) and the two anonymous registration INSERT
--      policies. RLS then denies those writes by default; the server writes
--      with the service role, which bypasses RLS.
--
-- The PAY-DC-2A stripe_account_id immutability triggers are left unchanged.

begin;

-- payments --------------------------------------------------------------------

create or replace function public._guard_payments_stripe_identity()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.stripe_account_id is not null
         or new.stripe_payment_intent_id is not null
         or new.stripe_charge_id is not null
         or new.stripe_checkout_session_id is not null
         or new.stripe_invoice_id is not null
         or new.stripe_refund_id is not null
         or new.stripe_balance_transaction_id is not null then
        raise exception 'payments Stripe identity fields cannot be set by this role.'
          using errcode = '42501';
      end if;
    elsif new.stripe_account_id is distinct from old.stripe_account_id
       or new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id
       or new.stripe_charge_id is distinct from old.stripe_charge_id
       or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
       or new.stripe_invoice_id is distinct from old.stripe_invoice_id
       or new.stripe_refund_id is distinct from old.stripe_refund_id
       or new.stripe_balance_transaction_id is distinct from old.stripe_balance_transaction_id then
      raise exception 'payments Stripe identity fields cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_payments_stripe_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_payments_stripe_identity_guard on public.payments;
create trigger trg_payments_stripe_identity_guard
before insert or update on public.payments
for each row
execute function public._guard_payments_stripe_identity();

-- event_payments --------------------------------------------------------------

create or replace function public._guard_event_payments_stripe_identity()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.stripe_account_id is not null
         or new.stripe_payment_intent_id is not null
         or new.stripe_charge_id is not null
         or new.stripe_checkout_session_id is not null
         or new.stripe_refund_id is not null then
        raise exception 'event_payments Stripe identity fields cannot be set by this role.'
          using errcode = '42501';
      end if;
    elsif new.stripe_account_id is distinct from old.stripe_account_id
       or new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id
       or new.stripe_charge_id is distinct from old.stripe_charge_id
       or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
       or new.stripe_refund_id is distinct from old.stripe_refund_id then
      raise exception 'event_payments Stripe identity fields cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_event_payments_stripe_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_event_payments_stripe_identity_guard on public.event_payments;
create trigger trg_event_payments_stripe_identity_guard
before insert or update on public.event_payments
for each row
execute function public._guard_event_payments_stripe_identity();

-- event_registrations ---------------------------------------------------------

create or replace function public._guard_event_registrations_stripe_identity()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.stripe_payment_intent_id is not null
         or new.stripe_checkout_session_id is not null then
        raise exception 'event_registrations Stripe identity fields cannot be set by this role.'
          using errcode = '42501';
      end if;
    elsif new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id
       or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id then
      raise exception 'event_registrations Stripe identity fields cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_event_registrations_stripe_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_event_registrations_stripe_identity_guard on public.event_registrations;
create trigger trg_event_registrations_stripe_identity_guard
before insert or update on public.event_registrations
for each row
execute function public._guard_event_registrations_stripe_identity();

-- studios.stripe_connected_account_id -----------------------------------------

create or replace function public._guard_studios_connected_account()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.stripe_connected_account_id is not null then
        raise exception 'studios connected Stripe account cannot be set by this role.'
          using errcode = '42501';
      end if;
    elsif new.stripe_connected_account_id is distinct from old.stripe_connected_account_id then
      raise exception 'studios connected Stripe account cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_studios_connected_account()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_studios_connected_account on public.studios;
create trigger guard_studios_connected_account
before insert or update of stripe_connected_account_id on public.studios
for each row
execute function public._guard_studios_connected_account();

-- Tenant write policies -------------------------------------------------------

drop policy if exists stripe_subscriptions_staff_insert on public.stripe_subscriptions;
drop policy if exists stripe_subscriptions_staff_update on public.stripe_subscriptions;

drop policy if exists stripe_customers_staff_insert on public.stripe_customers;
drop policy if exists stripe_customers_staff_update on public.stripe_customers;

drop policy if exists event_registrations_public_insert on public.event_registrations;
drop policy if exists event_registration_attendees_public_insert on public.event_registration_attendees;

commit;
