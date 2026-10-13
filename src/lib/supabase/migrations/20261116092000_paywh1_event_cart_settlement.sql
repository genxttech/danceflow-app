-- PAY-WH-1 M2 -- Atomic, idempotent event-cart settlement and an explicit order lifecycle.
--
-- Requires 20261116090000 (webhook claims) and 20261116091000 (settlement outbox).
--
-- What it fixes (verified against main 733a20c0):
--   * Settlement was a chain of separate PostgREST writes with no state guard: a released/expired/refunded order
--     (and its cancelled registrations) was set back to paid, a capacity failure part-way left the order paid with
--     unconfirmed registrations, and both checkout.session.completed and payment_intent.succeeded re-ran it,
--     rewriting paid_at. Now one locked transaction validates the stored payment attempt, connected account,
--     amount, currency and order state, then applies every write or none.
--   * Resume flows overwrote the stored Session / PaymentIntent. Every Stripe object created for an order is now an
--     immutable row in event_order_payment_attempts; settlement binds the attempt that actually paid.
--   * Late payments after release are recorded as actionable exceptions (never auto-refunded, never resurrected).
--   * The capacity trigger added the NEW row's admissions even when that row was being cancelled.
--
-- Lifecycle (event_orders.settlement_state; status / payment_status stay the compatibility contract):
--   pending     status pending,   payment pending  -- holds capacity until expires_at
--   processing  status pending,   payment pending  -- delayed payment in flight; hold extended (bounded)
--   releasing   status pending,   payment pending  -- cancel/expiry in progress; hold kept until Stripe is reconciled
--   paid        status confirmed, payment paid      -- terminal for settlement
--   released    status cancelled, payment failed    -- buyer cancel / cleanup / payment ruled out
--   failed      status cancelled, payment failed    -- final payment failure
--   expired     status expired,   payment failed    -- hold expired with no payment
-- The effective state is derived from status/payment_status first, so writes by the pre-PAY-WH-1 application
-- (which never sets settlement_state) are still interpreted correctly.
--
-- Rollback: rollback/20261116092000_paywh1_event_cart_settlement_rollback.sql (see its header for limits).

begin;

-- ---------------------------------------------------------------------------------------------------------------
-- Preflight: a PaymentIntent must identify at most one order before it can be made unique.
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (
    select stripe_payment_intent_id from public.event_orders
    where stripe_payment_intent_id is not null
    group by stripe_payment_intent_id having count(*) > 1
  ) then
    raise exception 'paywh1 preflight: duplicate event_orders.stripe_payment_intent_id values exist; resolve before applying';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Order lifecycle columns + PaymentIntent uniqueness
-- ---------------------------------------------------------------------------------------------------------------
alter table public.event_orders
  add column if not exists settlement_state text null,
  add column if not exists settlement_state_changed_at timestamptz null,
  add column if not exists release_requested_at timestamptz null,
  add column if not exists released_at timestamptz null,
  add column if not exists processing_since timestamptz null,
  add column if not exists settled_by_event_id text null;

alter table public.event_orders drop constraint if exists event_orders_settlement_state_check;
alter table public.event_orders add constraint event_orders_settlement_state_check
  check (settlement_state is null or settlement_state in ('pending', 'processing', 'releasing', 'paid', 'released', 'failed', 'expired'));

create unique index if not exists event_orders_stripe_payment_intent_id_uidx
  on public.event_orders (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- Payment attempts: every Stripe Checkout Session / PaymentIntent created for an order
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.event_order_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.event_orders(id) on delete cascade,
  studio_id uuid not null,
  stripe_account_id text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  kind text not null check (kind in ('checkout_session', 'payment_intent')),
  stripe_checkout_session_id text null,
  stripe_payment_intent_id text null,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null,
  surface text null,
  status text not null default 'open' check (status in ('open', 'processing', 'succeeded', 'failed', 'closed', 'superseded')),
  last_error text null,
  expires_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_order_payment_attempts_identity check (
    (kind = 'checkout_session' and stripe_checkout_session_id is not null)
    or (kind = 'payment_intent' and stripe_payment_intent_id is not null and stripe_checkout_session_id is null)
  )
);
create unique index if not exists event_order_payment_attempts_session_uidx
  on public.event_order_payment_attempts (stripe_checkout_session_id) where stripe_checkout_session_id is not null;
create unique index if not exists event_order_payment_attempts_pi_uidx
  on public.event_order_payment_attempts (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists event_order_payment_attempts_order_idx on public.event_order_payment_attempts (order_id);

alter table public.event_order_payment_attempts enable row level security;
revoke all on public.event_order_payment_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.event_order_payment_attempts to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Settlement exceptions: actionable, auditable, deduplicated
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.event_order_settlement_exceptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid null references public.event_orders(id) on delete set null,
  studio_id uuid null,
  event_id uuid null,
  kind text not null,
  stripe_event_id text null,
  stripe_account_id text null,
  stripe_checkout_session_id text null,
  stripe_payment_intent_id text null,
  amount_cents bigint null,
  currency text null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  occurrences integer not null default 1,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolved_by uuid null,
  resolution_note text null
);
create unique index if not exists event_order_settlement_exceptions_dedupe_uidx
  on public.event_order_settlement_exceptions (
    kind, coalesce(order_id::text, ''), coalesce(stripe_payment_intent_id, ''), coalesce(stripe_checkout_session_id, '')
  );
create index if not exists event_order_settlement_exceptions_open_idx
  on public.event_order_settlement_exceptions (studio_id, created_at) where status = 'open';

-- Is the CURRENT caller (auth.uid()) a manager of the event? No user parameter, so client roles cannot use it to
-- probe other users' roles.
create or replace function public._paywh1_actor_can_manage_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with actor as (select auth.uid() as p_user_id)
  select actor.p_user_id is not null and p_event_id is not null and exists (
    select 1 from public.events e
    where e.id = p_event_id
      and (
        exists (select 1 from public.profiles p where p.id = p_user_id and p.platform_role = 'platform_admin')
        or exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = e.studio_id and usr.user_id = p_user_id and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin'))
        or exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = e.organizer_id and ou.user_id = p_user_id and ou.active = true
            and ou.role in ('organizer_owner', 'organizer_admin'))
      )
  )
  from actor;
$$;
revoke all on function public._paywh1_actor_can_manage_event(uuid) from public, anon;
grant execute on function public._paywh1_actor_can_manage_event(uuid) to authenticated, service_role;

alter table public.event_order_settlement_exceptions enable row level security;
revoke all on public.event_order_settlement_exceptions from public, anon, authenticated;
grant select on public.event_order_settlement_exceptions to authenticated;
grant select, insert, update, delete on public.event_order_settlement_exceptions to service_role;
drop policy if exists event_order_settlement_exceptions_manager_select on public.event_order_settlement_exceptions;
create policy event_order_settlement_exceptions_manager_select
  on public.event_order_settlement_exceptions for select to authenticated
  using (public._paywh1_actor_can_manage_event(event_id));

create or replace function public._paywh1_record_exception(
  p_order_id uuid, p_kind text, p_event_id text, p_account text, p_session text, p_pi text,
  p_amount_cents bigint, p_currency text, p_details jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_studio uuid;
  v_event uuid;
begin
  select studio_id, event_id into v_studio, v_event from public.event_orders where id = p_order_id;
  insert into public.event_order_settlement_exceptions as x (
    order_id, studio_id, event_id, kind, stripe_event_id, stripe_account_id, stripe_checkout_session_id,
    stripe_payment_intent_id, amount_cents, currency, details
  )
  values (p_order_id, v_studio, v_event, p_kind, p_event_id, p_account, p_session, p_pi, p_amount_cents,
          lower(p_currency), coalesce(p_details, '{}'::jsonb))
  on conflict (kind, coalesce(order_id::text, ''), coalesce(stripe_payment_intent_id, ''), coalesce(stripe_checkout_session_id, ''))
  do update set occurrences = x.occurrences + 1, last_seen_at = now(),
                stripe_event_id = coalesce(excluded.stripe_event_id, x.stripe_event_id),
                details = x.details || excluded.details
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public._paywh1_record_exception(uuid, text, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;

-- Staff resolution of an exception (after a manual refund decision, re-issued tickets, etc.). Never moves money.
create or replace function public.resolve_event_order_settlement_exception(p_exception_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
begin
  select event_id into v_event from public.event_order_settlement_exceptions where id = p_exception_id for update;
  if not found then
    return false;
  end if;
  if not public._paywh1_actor_can_manage_event(v_event) then
    raise exception 'not authorized to resolve this settlement exception' using errcode = '42501';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'a resolution note is required' using errcode = '22023';
  end if;
  update public.event_order_settlement_exceptions
  set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), resolution_note = left(p_note, 2000)
  where id = p_exception_id and status = 'open';
  return found;
end;
$$;
revoke all on function public.resolve_event_order_settlement_exception(uuid, text) from public, anon;
grant execute on function public.resolve_event_order_settlement_exception(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Lifecycle helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._paywh1_effective_state(p_status text, p_payment_status text, p_settlement_state text)
returns text
language sql
immutable
as $$
  select case
    when p_payment_status = 'paid' then 'paid'
    when p_payment_status in ('refunded', 'partially_refunded') then 'refunded'
    when p_status = 'expired' then 'expired'
    when p_status = 'cancelled' or p_payment_status = 'failed' then
      case when p_settlement_state in ('failed', 'expired') then p_settlement_state else 'released' end
    when p_status = 'pending' and p_payment_status = 'pending' then
      case when p_settlement_state in ('processing', 'releasing') then p_settlement_state else 'pending' end
    when p_status = 'confirmed' then 'confirmed_unpaid'
    else 'other'
  end;
$$;

-- Frees everything the order holds, exactly once (caller holds the order lock and has checked the state).
create or replace function public._paywh1_release_order(p_order_id uuid, p_final_state text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_final_state not in ('released', 'failed', 'expired') then
    raise exception '_paywh1_release_order: invalid final state %', p_final_state;
  end if;

  update public.event_registrations
  set status = 'cancelled', payment_status = 'failed', cancelled_at = coalesce(cancelled_at, now())
  where order_id = p_order_id and status = 'pending' and payment_status = 'pending';

  update public.event_private_lesson_slots
  set status = 'available', payment_status = 'unpaid', buyer_name = null, buyer_email = null, buyer_phone = null,
      buyer_notes = null, order_id = null, held_until = null, hold_token = null, stripe_checkout_session_id = null,
      updated_at = now()
  where order_id = p_order_id and status = 'held';

  update public.event_order_payment_attempts
  set status = 'closed', updated_at = now()
  where order_id = p_order_id and status in ('open', 'processing');

  update public.event_orders
  set status = case when p_final_state = 'expired' then 'expired' else 'cancelled' end,
      payment_status = 'failed',
      cancelled_at = coalesce(cancelled_at, now()),
      settlement_state = p_final_state,
      settlement_state_changed_at = now(),
      released_at = now(),
      updated_at = now()
  where id = p_order_id;
end;
$$;
revoke all on function public._paywh1_release_order(uuid, text) from public, anon, authenticated;

-- Resolve the payment attempt + order for Stripe evidence. Attempts are authoritative; for orders created before
-- PAY-WH-1 the legacy order columns are accepted once and converted into an attempt row.
create or replace function public._paywh1_resolve_attempt(p_account text, p_session text, p_pi text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt uuid;
  v_order record;
  v_account text;
begin
  if p_session is not null then
    select id into v_attempt from public.event_order_payment_attempts where stripe_checkout_session_id = p_session;
  end if;
  if v_attempt is null and p_pi is not null then
    select id into v_attempt from public.event_order_payment_attempts where stripe_payment_intent_id = p_pi;
  end if;
  if v_attempt is not null then
    return v_attempt;
  end if;

  -- Legacy (pre-PAY-WH-1) order: identified by its own stored Stripe reference, never by metadata.
  select o.id, o.studio_id, o.total_amount, o.currency, o.stripe_checkout_session_id, o.stripe_payment_intent_id
  into v_order
  from public.event_orders o
  where (p_session is not null and o.stripe_checkout_session_id = p_session)
     or (p_session is null and p_pi is not null and o.stripe_payment_intent_id = p_pi)
  limit 1;
  if not found then
    return null;
  end if;

  -- The attempt records the studio's own connected account (never the caller's), so a wrong-account event cannot
  -- poison the bootstrap; the caller's account is then checked against it like any other attempt.
  select stripe_connected_account_id into v_account from public.studios where id = v_order.studio_id;
  if v_account is null then
    return null;
  end if;
  if p_session is not null then
    insert into public.event_order_payment_attempts (
      order_id, studio_id, stripe_account_id, kind, stripe_checkout_session_id, amount_cents, currency, surface, status
    )
    values (v_order.id, v_order.studio_id, v_account, 'checkout_session', p_session,
            round(v_order.total_amount * 100)::bigint, lower(coalesce(v_order.currency, 'usd')), 'legacy', 'open')
    on conflict (stripe_checkout_session_id) where stripe_checkout_session_id is not null do nothing;
    select id into v_attempt from public.event_order_payment_attempts where stripe_checkout_session_id = p_session;
  else
    insert into public.event_order_payment_attempts (
      order_id, studio_id, stripe_account_id, kind, stripe_payment_intent_id, amount_cents, currency, surface, status
    )
    values (v_order.id, v_order.studio_id, v_account, 'payment_intent', p_pi,
            round(v_order.total_amount * 100)::bigint, lower(coalesce(v_order.currency, 'usd')), 'legacy', 'open')
    on conflict (stripe_payment_intent_id) where stripe_payment_intent_id is not null do nothing;
    select id into v_attempt from public.event_order_payment_attempts where stripe_payment_intent_id = p_pi;
  end if;
  return v_attempt;
end;
$$;
revoke all on function public._paywh1_resolve_attempt(text, text, text) from public, anon, authenticated;

-- Legacy (pre-PAY-WH-1) order still awaiting payment: record its stored Stripe reference as an attempt so release
-- expires/cancels it in Stripe, resume sees it, and its payment still binds. Same identification rules as
-- _paywh1_resolve_attempt (the order's own stored reference + the studio's account). Caller holds the order lock.
create or replace function public._paywh1_bootstrap_legacy_attempts(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_account text;
begin
  select * into v_order from public.event_orders where id = p_order_id;
  if not found or (v_order.stripe_checkout_session_id is null and v_order.stripe_payment_intent_id is null) then
    return;
  end if;
  select stripe_connected_account_id into v_account from public.studios where id = v_order.studio_id;
  if v_account is null then
    return;
  end if;
  if v_order.stripe_checkout_session_id is not null then
    if not exists (select 1 from public.event_order_payment_attempts where stripe_checkout_session_id = v_order.stripe_checkout_session_id) then
      insert into public.event_order_payment_attempts (
        order_id, studio_id, stripe_account_id, kind, stripe_checkout_session_id, amount_cents, currency, surface, status
      )
      values (v_order.id, v_order.studio_id, v_account, 'checkout_session', v_order.stripe_checkout_session_id,
              round(v_order.total_amount * 100)::bigint, lower(coalesce(v_order.currency, 'usd')), 'legacy', 'open')
      on conflict (stripe_checkout_session_id) where stripe_checkout_session_id is not null do nothing;
    end if;
  end if;
  -- A stored PaymentIntent is its own (PaymentSheet) attempt when there is no stored Session, or when the order
  -- records PaymentSheet attempts (the pre-PAY-WH-1 app wrote this column on a pending order only from the
  -- PaymentSheet path, together with metadata.payment_intent_attempt_count). Otherwise it may be the Session's own
  -- PaymentIntent and must not become a separate attempt.
  if v_order.stripe_payment_intent_id is not null
     and (v_order.stripe_checkout_session_id is null
          or case when coalesce(v_order.metadata ->> 'payment_intent_attempt_count', '') ~ '^[0-9]{1,6}$'
                  then (v_order.metadata ->> 'payment_intent_attempt_count')::integer > 0 else false end)
     and not exists (select 1 from public.event_order_payment_attempts where stripe_payment_intent_id = v_order.stripe_payment_intent_id) then
    insert into public.event_order_payment_attempts (
      order_id, studio_id, stripe_account_id, kind, stripe_payment_intent_id, amount_cents, currency, surface, status
    )
    values (v_order.id, v_order.studio_id, v_account, 'payment_intent', v_order.stripe_payment_intent_id,
            round(v_order.total_amount * 100)::bigint, lower(coalesce(v_order.currency, 'usd')), 'legacy', 'open')
    on conflict (stripe_payment_intent_id) where stripe_payment_intent_id is not null do nothing;
  end if;
end;
$$;
revoke all on function public._paywh1_bootstrap_legacy_attempts(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Record a Stripe payment attempt for an order (checkout routes, resume, native PaymentSheet)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.record_event_cart_payment_attempt(
  p_order_id uuid,
  p_stripe_account text,
  p_kind text,
  p_session_id text,
  p_payment_intent_id text,
  p_amount_cents bigint,
  p_currency text,
  p_surface text,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_account text;
  v_existing public.event_order_payment_attempts%rowtype;
  v_attempt uuid;
  v_state text;
begin
  select * into v_order from public.event_orders where id = p_order_id for update;
  if not found then
    raise exception 'paywh1_order_not_found' using errcode = 'P0002';
  end if;

  select stripe_connected_account_id into v_account from public.studios where id = v_order.studio_id;
  if v_account is null or v_account <> p_stripe_account then
    raise exception 'paywh1_attempt_account_mismatch' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <> round(v_order.total_amount * 100)::bigint then
    raise exception 'paywh1_attempt_amount_mismatch' using errcode = '22023';
  end if;
  if lower(coalesce(p_currency, '')) <> lower(coalesce(v_order.currency, 'usd')) then
    raise exception 'paywh1_attempt_currency_mismatch' using errcode = '22023';
  end if;

  -- The compatibility columns are moved to the newest attempt below; keep the legacy reference bound first.
  perform public._paywh1_bootstrap_legacy_attempts(p_order_id);

  -- Re-recording the same Stripe object is idempotent; the same object on another order is refused.
  select * into v_existing from public.event_order_payment_attempts
  where (p_session_id is not null and stripe_checkout_session_id = p_session_id)
     or (p_session_id is null and p_payment_intent_id is not null and stripe_payment_intent_id = p_payment_intent_id)
  limit 1;
  if found then
    if v_existing.order_id <> p_order_id then
      raise exception 'paywh1_attempt_belongs_to_another_order' using errcode = '23505';
    end if;
    return jsonb_build_object('outcome', 'existing', 'attempt_id', v_existing.id);
  end if;

  v_state := public._paywh1_effective_state(v_order.status, v_order.payment_status, v_order.settlement_state);
  if v_state <> 'pending' then
    raise exception 'paywh1_order_not_payable: %', v_state using errcode = '55000';
  end if;

  insert into public.event_order_payment_attempts (
    order_id, studio_id, stripe_account_id, kind, stripe_checkout_session_id, stripe_payment_intent_id,
    amount_cents, currency, surface, expires_at
  )
  values (
    p_order_id, v_order.studio_id, p_stripe_account, p_kind, p_session_id,
    case when p_kind = 'payment_intent' then p_payment_intent_id else null end,
    p_amount_cents, lower(p_currency), p_surface, p_expires_at
  )
  returning id into v_attempt;

  -- Compatibility: the pre-PAY-WH-1 application binds webhooks to these columns, so they name the NEWEST attempt
  -- (the one the buyer was sent to pay) -- after an app-first rollback that attempt still settles. PAY-WH-1 itself
  -- binds through event_order_payment_attempts only; every earlier reference stays bound there.
  update public.event_orders
  set stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id),
      stripe_payment_intent_id = case
        when p_kind = 'payment_intent' then p_payment_intent_id
        else stripe_payment_intent_id end,
      settlement_state = coalesce(settlement_state, 'pending'),
      updated_at = now()
  where id = p_order_id;

  return jsonb_build_object('outcome', 'recorded', 'attempt_id', v_attempt);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Extend a still-valid hold (resume after signing / before creating a new Checkout Session)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.extend_event_cart_order_hold(p_order_id uuid, p_until timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_state text;
begin
  select * into v_order from public.event_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;
  v_state := public._paywh1_effective_state(v_order.status, v_order.payment_status, v_order.settlement_state);
  if v_state <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', v_state);
  end if;
  if p_until is null or p_until > now() + interval '2 hours' then
    raise exception 'extend_event_cart_order_hold: invalid hold end' using errcode = '22023';
  end if;
  -- Resume lists attempts right after this call: make a legacy order's stored Session/PaymentIntent visible to it.
  perform public._paywh1_bootstrap_legacy_attempts(p_order_id);
  if v_order.expires_at is not null and v_order.expires_at >= p_until then
    return jsonb_build_object('ok', true, 'expires_at', v_order.expires_at);
  end if;

  begin
    update public.event_orders set expires_at = p_until, updated_at = now() where id = p_order_id;
    -- Re-run the capacity check for this order's holds (a lapsed hold may have been taken by someone else).
    update public.event_registrations set status = status
    where order_id = p_order_id and status = 'pending' and payment_status = 'pending';
    update public.event_private_lesson_slots set held_until = p_until, updated_at = now()
    where order_id = p_order_id and status = 'held';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'Selected ticket quantity is no longer available%' then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'reason', 'capacity_unavailable');
  end;

  return jsonb_build_object('ok', true, 'expires_at', p_until);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Atomic settlement
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.settle_event_cart_order(
  p_source text,                -- 'webhook' (requires the event claim) | 'reconcile' (Stripe objects retrieved by the server)
  p_stripe_event_id text,
  p_claim_owner uuid,
  p_stripe_account text,
  p_session_id text,
  p_payment_intent_id text,
  p_amount_cents bigint,
  p_currency text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt_id uuid;
  v_attempt public.event_order_payment_attempts%rowtype;
  v_order public.event_orders%rowtype;
  v_studio_account text;
  v_state text;
  v_order_cents bigint;
  v_reg record;
  v_slot record;
  v_existing record;
  v_expected integer;
  v_actual integer;
  v_reg_ids uuid[] := '{}';
  v_method text;
  v_mismatch text;
  v_ex uuid;
begin
  if p_source not in ('webhook', 'reconcile') then
    raise exception 'settle_event_cart_order: invalid source' using errcode = '22023';
  end if;
  if p_payment_intent_id is null then
    return jsonb_build_object('outcome', 'mismatch:missing_payment_intent');
  end if;
  if p_source = 'webhook' then
    perform public._paywh1_require_event_claim(p_stripe_event_id, p_claim_owner);
  end if;

  v_attempt_id := public._paywh1_resolve_attempt(p_stripe_account, p_session_id, p_payment_intent_id);
  if v_attempt_id is null then
    -- Money was captured against a reference no order recorded: keep an actionable record (the delivery also fails).
    v_ex := public._paywh1_record_exception(null, 'unknown_payment_reference', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('source', p_source));
    return jsonb_build_object('outcome', 'mismatch:unknown_payment_reference', 'exception_id', v_ex);
  end if;

  -- Lock order first (all lifecycle functions lock the order before its attempts).
  select o.* into v_order from public.event_orders o
  join public.event_order_payment_attempts a on a.order_id = o.id
  where a.id = v_attempt_id
  for update of o;
  select * into v_attempt from public.event_order_payment_attempts where id = v_attempt_id for update;

  -- Binding: stored attempt + studio connected account + identifiers + amount + currency.
  select stripe_connected_account_id into v_studio_account from public.studios where id = v_order.studio_id;
  v_order_cents := round(v_order.total_amount * 100)::bigint;
  v_mismatch := case
    when v_studio_account is null or v_studio_account <> p_stripe_account or v_attempt.stripe_account_id <> p_stripe_account then 'account'
    when p_session_id is not null and v_attempt.stripe_checkout_session_id is distinct from p_session_id then 'session'
    when v_attempt.kind = 'payment_intent' and p_session_id is not null then 'session'
    when v_attempt.stripe_payment_intent_id is not null and v_attempt.stripe_payment_intent_id <> p_payment_intent_id then 'payment_intent'
    when v_attempt.kind = 'checkout_session' and p_session_id is null and v_attempt.stripe_payment_intent_id is null then 'payment_intent'
    when p_amount_cents is null or p_amount_cents <> v_attempt.amount_cents or p_amount_cents <> v_order_cents then 'amount'
    when lower(coalesce(p_currency, '')) <> v_attempt.currency or lower(coalesce(p_currency, '')) <> lower(coalesce(v_order.currency, 'usd')) then 'currency'
    else null
  end;
  if v_mismatch is null and v_attempt.stripe_payment_intent_id is null and exists (
    select 1 from public.event_order_payment_attempts where stripe_payment_intent_id = p_payment_intent_id and id <> v_attempt.id
  ) then
    v_mismatch := 'payment_intent';
  end if;
  if v_mismatch is not null then
    v_ex := public._paywh1_record_exception(v_order.id, 'mismatch_' || v_mismatch, p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency,
      jsonb_build_object('attempt_id', v_attempt.id, 'order_cents', v_order_cents, 'source', p_source));
    return jsonb_build_object('outcome', 'mismatch:' || v_mismatch, 'order_id', v_order.id, 'exception_id', v_ex);
  end if;

  v_state := public._paywh1_effective_state(v_order.status, v_order.payment_status, v_order.settlement_state);

  if v_state = 'paid' then
    if v_order.stripe_payment_intent_id = p_payment_intent_id then
      update public.event_order_payment_attempts set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
      where id = v_attempt.id and status <> 'succeeded';
      return jsonb_build_object('outcome', 'already_settled', 'order_id', v_order.id);
    end if;
    v_ex := public._paywh1_record_exception(v_order.id, 'duplicate_payment', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency,
      jsonb_build_object('settled_payment_intent', v_order.stripe_payment_intent_id, 'attempt_id', v_attempt.id));
    update public.event_order_payment_attempts set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
    where id = v_attempt.id;
    return jsonb_build_object('outcome', 'duplicate_payment', 'order_id', v_order.id, 'exception_id', v_ex);
  end if;

  if v_state not in ('pending', 'processing', 'releasing') then
    v_ex := public._paywh1_record_exception(v_order.id, 'late_payment_after_release', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('order_state', v_state, 'attempt_id', v_attempt.id));
    update public.event_order_payment_attempts set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
    where id = v_attempt.id;
    return jsonb_build_object('outcome', 'late_payment_after_release', 'order_id', v_order.id, 'exception_id', v_ex);
  end if;

  -- Every registration must still be the pending hold this payment was for; slots must still be held by the order.
  if exists (
    select 1 from public.event_registrations
    where order_id = v_order.id and not (status = 'pending' and payment_status = 'pending')
  ) or exists (
    select 1 from public.event_order_items i
    left join public.event_private_lesson_slots s on s.id = i.coach_slot_id
    where i.order_id = v_order.id and i.item_type = 'coach_slot'
      and (s.id is null or s.order_id is distinct from v_order.id or s.status <> 'held')
  ) then
    v_ex := public._paywh1_record_exception(v_order.id, 'late_payment_after_release', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('order_state', v_state, 'reason', 'holds_released'));
    perform public._paywh1_release_order(v_order.id, 'released');
    update public.event_order_payment_attempts set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
    where id = v_attempt.id;
    return jsonb_build_object('outcome', 'late_payment_after_release', 'order_id', v_order.id, 'exception_id', v_ex);
  end if;

  v_method := case when v_attempt.kind = 'checkout_session' then 'stripe_checkout' else 'stripe_payment_sheet' end;

  begin
    -- Registrations -> confirmed/paid (capacity trigger re-validates; a lapsed hold whose capacity was taken raises P0001).
    for v_reg in
      select er.id, er.quantity, er.total_price, er.currency, er.ticket_type_id,
             greatest(coalesce(ett.attendees_per_ticket, 1), 1) as per_ticket
      from public.event_registrations er
      left join public.event_ticket_types ett on ett.id = er.ticket_type_id
      where er.order_id = v_order.id
      order by er.id
      for update of er
    loop
      v_expected := greatest(coalesce(v_reg.quantity, 1), 1) * v_reg.per_ticket;
      select count(*) into v_actual from public.event_registration_attendees where registration_id = v_reg.id;
      if v_actual <> v_expected then
        raise exception 'paywh1_entitlements_mismatch' using errcode = 'P0003';
      end if;

      update public.event_registrations
      set status = 'confirmed', payment_status = 'paid',
          stripe_payment_intent_id = p_payment_intent_id,
          stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id)
      where id = v_reg.id;

      -- Payment row: an existing row for this registration + Stripe object must match exactly.
      select id, amount, status, stripe_account_id into v_existing
      from public.event_payments
      where registration_id = v_reg.id
        and (stripe_payment_intent_id = p_payment_intent_id or (p_session_id is not null and stripe_checkout_session_id = p_session_id))
      limit 1;
      if found then
        if v_existing.amount <> v_reg.total_price or v_existing.status <> 'paid' or v_existing.stripe_account_id is distinct from p_stripe_account then
          raise exception 'paywh1_payment_row_conflict' using errcode = 'P0003';
        end if;
      else
        insert into public.event_payments (
          registration_id, amount, currency, payment_method, status, source, stripe_checkout_session_id,
          stripe_payment_intent_id, external_reference, notes, stripe_account_id
        )
        values (
          v_reg.id, v_reg.total_price, coalesce(v_reg.currency, upper(p_currency)), v_method, 'paid', 'stripe', p_session_id,
          p_payment_intent_id, coalesce(p_session_id, p_payment_intent_id),
          'Settled by PAY-WH-1 event cart settlement.', p_stripe_account
        );
      end if;
      v_reg_ids := v_reg_ids || v_reg.id;
    end loop;

    for v_slot in
      select s.id from public.event_order_items i
      join public.event_private_lesson_slots s on s.id = i.coach_slot_id
      where i.order_id = v_order.id and i.item_type = 'coach_slot'
      for update of s
    loop
      update public.event_private_lesson_slots
      set status = 'booked', payment_status = 'paid', stripe_checkout_session_id = p_session_id,
          stripe_payment_intent_id = p_payment_intent_id, booked_at = now(), held_until = null, hold_token = null,
          updated_at = now()
      where id = v_slot.id;
    end loop;

    update public.event_orders
    set status = 'confirmed', payment_status = 'paid', settlement_state = 'paid', settlement_state_changed_at = now(),
        paid_at = coalesce(paid_at, now()),
        stripe_payment_intent_id = p_payment_intent_id,
        stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id),
        settled_by_event_id = coalesce(p_stripe_event_id, 'reconcile'),
        updated_at = now()
    where id = v_order.id;

    update public.event_order_payment_attempts
    set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
    where id = v_attempt.id;
    update public.event_order_payment_attempts
    set status = 'superseded', updated_at = now()
    where order_id = v_order.id and id <> v_attempt.id and status in ('open', 'processing');

    -- Transactional side effects (committed with the settlement or not at all).
    insert into public.event_settlement_outbox (order_id, studio_id, effect, subject_id, dedupe_key, payload)
    select v_order.id, v_order.studio_id, 'studio_lead', r, 'studio_lead:' || r::text, '{}'::jsonb
    from unnest(v_reg_ids) r where v_order.organizer_id is null
    on conflict (dedupe_key) do nothing;
    insert into public.event_settlement_outbox (order_id, studio_id, effect, subject_id, dedupe_key, payload)
    select v_order.id, v_order.studio_id, 'organizer_contact', r, 'organizer_contact:' || r::text, '{}'::jsonb
    from unnest(v_reg_ids) r where v_order.organizer_id is not null
    on conflict (dedupe_key) do nothing;
    insert into public.event_settlement_outbox (order_id, studio_id, effect, dedupe_key, payload)
    values
      (v_order.id, v_order.studio_id, 'order_confirmation', 'order_confirmation:' || v_order.id::text, '{}'::jsonb),
      (v_order.id, v_order.studio_id, 'fee_sync', 'fee_sync:' || p_payment_intent_id,
        jsonb_build_object('payment_intent_id', p_payment_intent_id, 'stripe_account_id', p_stripe_account)),
      (v_order.id, v_order.studio_id, 'close_superseded_attempts', 'close_superseded_attempts:' || v_order.id::text, '{}'::jsonb)
    on conflict (dedupe_key) do nothing;
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'Selected ticket quantity is no longer available%' then
        raise;
      end if;
      v_ex := public._paywh1_record_exception(v_order.id, 'paid_capacity_unavailable', p_stripe_event_id, p_stripe_account,
        p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('order_state', v_state, 'detail', sqlerrm));
      perform public._paywh1_release_order(v_order.id, 'released');
      update public.event_order_payment_attempts set status = 'succeeded', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
      where id = v_attempt.id;
      return jsonb_build_object('outcome', 'late_payment_after_release', 'order_id', v_order.id, 'exception_id', v_ex, 'reason', 'capacity_unavailable');
    when sqlstate 'P0003' then
      v_ex := public._paywh1_record_exception(v_order.id, 'settlement_integrity_conflict', p_stripe_event_id, p_stripe_account,
        p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('detail', sqlerrm));
      return jsonb_build_object('outcome', 'mismatch:' || replace(sqlerrm, 'paywh1_', ''), 'order_id', v_order.id, 'exception_id', v_ex);
  end;

  return jsonb_build_object('outcome', 'settled', 'order_id', v_order.id, 'studio_id', v_order.studio_id,
    'organizer_id', v_order.organizer_id, 'registration_ids', to_jsonb(v_reg_ids));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Delayed payment in flight (checkout.session.completed unpaid / payment_intent.processing)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.mark_event_cart_order_processing(
  p_source text, p_stripe_event_id text, p_claim_owner uuid, p_stripe_account text, p_session_id text,
  p_payment_intent_id text, p_amount_cents bigint, p_currency text,
  p_hold_until timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt_id uuid;
  v_attempt public.event_order_payment_attempts%rowtype;
  v_order public.event_orders%rowtype;
  v_state text;
  v_studio_account text;
  v_ex uuid;
begin
  if p_source = 'webhook' then
    perform public._paywh1_require_event_claim(p_stripe_event_id, p_claim_owner);
  end if;
  if p_hold_until is null or p_hold_until <= now() or p_hold_until > now() + interval '15 days' then
    raise exception 'mark_event_cart_order_processing: invalid hold end' using errcode = '22023';
  end if;
  v_attempt_id := public._paywh1_resolve_attempt(p_stripe_account, p_session_id, p_payment_intent_id);
  if v_attempt_id is null then
    v_ex := public._paywh1_record_exception(null, 'unknown_payment_reference', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('source', p_source, 'phase', 'processing'));
    return jsonb_build_object('outcome', 'mismatch:unknown_payment_reference', 'exception_id', v_ex);
  end if;
  select o.* into v_order from public.event_orders o join public.event_order_payment_attempts a on a.order_id = o.id
  where a.id = v_attempt_id for update of o;
  select * into v_attempt from public.event_order_payment_attempts where id = v_attempt_id for update;
  select stripe_connected_account_id into v_studio_account from public.studios where id = v_order.studio_id;
  if v_studio_account is distinct from p_stripe_account or v_attempt.stripe_account_id <> p_stripe_account
     or (p_amount_cents is not null and p_amount_cents <> v_attempt.amount_cents)
     or (p_currency is not null and lower(p_currency) <> v_attempt.currency) then
    v_ex := public._paywh1_record_exception(v_order.id, 'mismatch_processing', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('attempt_id', v_attempt.id));
    return jsonb_build_object('outcome', 'mismatch:processing_binding', 'order_id', v_order.id, 'exception_id', v_ex);
  end if;

  v_state := public._paywh1_effective_state(v_order.status, v_order.payment_status, v_order.settlement_state);
  if v_state = 'paid' then
    return jsonb_build_object('outcome', 'already_settled', 'order_id', v_order.id);
  end if;
  if v_state not in ('pending', 'processing', 'releasing') then
    v_ex := public._paywh1_record_exception(v_order.id, 'processing_after_release', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('order_state', v_state));
    return jsonb_build_object('outcome', 'processing_after_release', 'order_id', v_order.id, 'exception_id', v_ex);
  end if;

  update public.event_order_payment_attempts
  set status = 'processing', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent_id), updated_at = now()
  where id = v_attempt.id;

  -- Keep (never newly create) the hold while the payment is in flight: a hold that already lapsed is not re-taken
  -- here (that could exceed capacity); its settlement then goes through the capacity check.
  if v_order.expires_at is null or v_order.expires_at > now() then
    update public.event_orders
    set settlement_state = 'processing', settlement_state_changed_at = now(),
        processing_since = coalesce(processing_since, now()),
        expires_at = greatest(coalesce(expires_at, p_hold_until), p_hold_until), updated_at = now()
    where id = v_order.id;
    update public.event_private_lesson_slots set held_until = p_hold_until, updated_at = now()
    where order_id = v_order.id and status = 'held';
    return jsonb_build_object('outcome', 'processing', 'order_id', v_order.id, 'hold_until', p_hold_until);
  end if;

  update public.event_orders
  set settlement_state = 'processing', settlement_state_changed_at = now(), processing_since = coalesce(processing_since, now()), updated_at = now()
  where id = v_order.id;
  v_ex := public._paywh1_record_exception(v_order.id, 'processing_hold_lapsed', p_stripe_event_id, p_stripe_account,
    p_session_id, p_payment_intent_id, p_amount_cents, p_currency, jsonb_build_object('expired_at', v_order.expires_at));
  return jsonb_build_object('outcome', 'processing_hold_lapsed', 'order_id', v_order.id, 'exception_id', v_ex);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Payment failure. p_final = the attempt can no longer succeed (async_payment_failed, session expired, PI canceled).
-- A non-final failure (payment_intent.payment_failed: the buyer can retry on the same Session/PI) never releases.
-- A failure can never reverse a paid order.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fail_event_cart_payment_attempt(
  p_source text, p_stripe_event_id text, p_claim_owner uuid, p_stripe_account text, p_session_id text,
  p_payment_intent_id text, p_final boolean, p_final_state text, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt_id uuid;
  v_attempt public.event_order_payment_attempts%rowtype;
  v_order public.event_orders%rowtype;
  v_state text;
  v_studio_account text;
  v_ex uuid;
begin
  if p_source = 'webhook' then
    perform public._paywh1_require_event_claim(p_stripe_event_id, p_claim_owner);
  end if;
  if p_final and p_final_state not in ('failed', 'expired') then
    raise exception 'fail_event_cart_payment_attempt: invalid final state' using errcode = '22023';
  end if;
  v_attempt_id := public._paywh1_resolve_attempt(p_stripe_account, p_session_id, p_payment_intent_id);
  if v_attempt_id is null then
    return jsonb_build_object('outcome', 'mismatch:unknown_payment_reference');
  end if;
  select o.* into v_order from public.event_orders o join public.event_order_payment_attempts a on a.order_id = o.id
  where a.id = v_attempt_id for update of o;
  select * into v_attempt from public.event_order_payment_attempts where id = v_attempt_id for update;
  select stripe_connected_account_id into v_studio_account from public.studios where id = v_order.studio_id;
  if v_studio_account is distinct from p_stripe_account or v_attempt.stripe_account_id <> p_stripe_account then
    v_ex := public._paywh1_record_exception(v_order.id, 'mismatch_failure_account', p_stripe_event_id, p_stripe_account,
      p_session_id, p_payment_intent_id, null, null, jsonb_build_object('attempt_id', v_attempt.id));
    return jsonb_build_object('outcome', 'mismatch:account', 'order_id', v_order.id, 'exception_id', v_ex);
  end if;

  v_state := public._paywh1_effective_state(v_order.status, v_order.payment_status, v_order.settlement_state);

  if v_state = 'paid' then
    if p_final and v_attempt.status = 'succeeded' then
      v_ex := public._paywh1_record_exception(v_order.id, 'failure_after_settlement', p_stripe_event_id, p_stripe_account,
        p_session_id, p_payment_intent_id, null, null, jsonb_build_object('reason', p_reason));
      return jsonb_build_object('outcome', 'ignored_paid', 'order_id', v_order.id, 'exception_id', v_ex);
    end if;
    update public.event_order_payment_attempts set status = case when p_final then 'failed' else status end,
      last_error = left(p_reason, 500), updated_at = now()
    where id = v_attempt.id and status not in ('succeeded');
    return jsonb_build_object('outcome', 'ignored_paid', 'order_id', v_order.id);
  end if;

  if not p_final then
    update public.event_order_payment_attempts set last_error = left(p_reason, 500), updated_at = now() where id = v_attempt.id;
    return jsonb_build_object('outcome', 'recorded', 'order_id', v_order.id);
  end if;

  update public.event_order_payment_attempts
  set status = 'failed', last_error = left(p_reason, 500), updated_at = now()
  where id = v_attempt.id and status in ('open', 'processing');

  if v_state not in ('pending', 'processing', 'releasing') then
    return jsonb_build_object('outcome', 'already_released', 'order_id', v_order.id);
  end if;

  -- A release is in progress (typically it just expired this very Session): its finalize releases the order with the
  -- release's own final state, and the sweeper retries a stalled release, so the webhook only closes the attempt.
  if v_state = 'releasing' then
    return jsonb_build_object('outcome', 'attempt_closed', 'order_id', v_order.id, 'release_in_progress', true);
  end if;

  -- Another live attempt (e.g. a newer Checkout Session) can still pay: keep the order.
  if exists (select 1 from public.event_order_payment_attempts where order_id = v_order.id and status in ('open', 'processing')) then
    return jsonb_build_object('outcome', 'attempt_closed', 'order_id', v_order.id);
  end if;

  perform public._paywh1_release_order(v_order.id, p_final_state);
  return jsonb_build_object('outcome', 'released', 'order_id', v_order.id, 'final_state', p_final_state);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Two-phase release. Phase 1 marks the order 'releasing' (capacity stays held) and returns the live attempts for the
-- server to expire/cancel and read back from Stripe OUTSIDE any database transaction. Phase 2 finalizes from that
-- Stripe evidence under the order lock: paid -> caller settles (reconcile); processing -> processing; still open ->
-- stay releasing (retry); otherwise release exactly once.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.begin_event_cart_order_release(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_state text;
  v_attempts jsonb;
begin
  select * into v_order from public.event_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if coalesce(v_order.metadata ->> 'source', '') = 'competition_registration' then
    return jsonb_build_object('outcome', 'not_applicable');
  end if;
  v_state := public._paywh1_effective_state(v_order.status, v_order.payment_status, v_order.settlement_state);
  if v_state = 'paid' then
    return jsonb_build_object('outcome', 'already_paid');
  end if;
  if v_state = 'processing' then
    return jsonb_build_object('outcome', 'processing');
  end if;
  if v_state not in ('pending', 'releasing') then
    return jsonb_build_object('outcome', 'already_released', 'state', v_state);
  end if;

  if v_state = 'pending' then
    update public.event_orders
    set settlement_state = 'releasing', settlement_state_changed_at = now(), release_requested_at = now(),
        -- keep a still-valid hold while Stripe is reconciled; never re-take a lapsed one
        expires_at = case when expires_at is not null and expires_at > now() then greatest(expires_at, now() + interval '20 minutes') else expires_at end,
        updated_at = now()
    where id = p_order_id;
  end if;

  -- A legacy order's stored Session/PaymentIntent must be expired/cancelled in Stripe like any other attempt.
  perform public._paywh1_bootstrap_legacy_attempts(p_order_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'attempt_id', a.id, 'kind', a.kind, 'stripe_account_id', a.stripe_account_id,
    'stripe_checkout_session_id', a.stripe_checkout_session_id, 'stripe_payment_intent_id', a.stripe_payment_intent_id,
    'status', a.status) order by a.created_at), '[]'::jsonb)
  into v_attempts
  from public.event_order_payment_attempts a
  where a.order_id = p_order_id and a.status in ('open', 'processing');

  return jsonb_build_object('outcome', 'releasing', 'attempts', v_attempts);
end;
$$;

create or replace function public.finalize_event_cart_order_release(p_order_id uuid, p_findings jsonb, p_final_state text default 'released')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_state text;
  v_finding jsonb;
  v_live integer;
begin
  if p_final_state not in ('released', 'expired') then
    raise exception 'finalize_event_cart_order_release: invalid final state' using errcode = '22023';
  end if;
  select * into v_order from public.event_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  v_state := public._paywh1_effective_state(v_order.status, v_order.payment_status, v_order.settlement_state);
  if v_state = 'paid' then
    return jsonb_build_object('outcome', 'already_paid');
  end if;
  if v_state <> 'releasing' then
    return jsonb_build_object('outcome', 'not_releasing', 'state', v_state);
  end if;

  -- Findings are Stripe states read by the server for each live attempt: closed | paid | processing | open.
  for v_finding in select * from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) loop
    if not exists (select 1 from public.event_order_payment_attempts
                   where id = (v_finding ->> 'attempt_id')::uuid and order_id = p_order_id) then
      raise exception 'finalize_event_cart_order_release: finding for an attempt of another order' using errcode = '22023';
    end if;
    if v_finding ->> 'stripe_state' = 'paid' then
      return jsonb_build_object('outcome', 'payment_found', 'attempt_id', v_finding ->> 'attempt_id');
    end if;
  end loop;
  for v_finding in select * from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) loop
    if v_finding ->> 'stripe_state' = 'processing' then
      -- Same bounded hold as mark_event_cart_order_processing, kept only while the hold is still valid.
      update public.event_orders
      set settlement_state = 'processing', settlement_state_changed_at = now(), processing_since = coalesce(processing_since, now()),
          expires_at = case when expires_at is not null and expires_at > now() then greatest(expires_at, now() + interval '7 days') else expires_at end,
          updated_at = now()
      where id = p_order_id;
      update public.event_private_lesson_slots set held_until = now() + interval '7 days', updated_at = now()
      where order_id = p_order_id and status = 'held' and held_until > now();
      update public.event_order_payment_attempts set status = 'processing', updated_at = now()
      where id = (v_finding ->> 'attempt_id')::uuid;
      return jsonb_build_object('outcome', 'processing');
    end if;
    if v_finding ->> 'stripe_state' = 'closed' then
      update public.event_order_payment_attempts set status = 'closed', updated_at = now()
      where id = (v_finding ->> 'attempt_id')::uuid and status in ('open', 'processing');
    end if;
  end loop;

  select count(*) into v_live from public.event_order_payment_attempts where order_id = p_order_id and status in ('open', 'processing');
  if v_live > 0 then
    return jsonb_build_object('outcome', 'retry', 'live_attempts', v_live);
  end if;

  perform public._paywh1_release_order(p_order_id, p_final_state);
  return jsonb_build_object('outcome', 'released', 'final_state', p_final_state);
end;
$$;

-- Orders that never reached Stripe (no attempt, no stored Stripe reference) for the same buyer + event: the only
-- orders a new checkout may clean up without asking Stripe.
create or replace function public.release_unattempted_event_cart_orders(p_event_id uuid, p_buyer_email text, p_exclude_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select o.id from public.event_orders o
    where o.event_id = p_event_id
      and lower(o.buyer_email) = lower(btrim(p_buyer_email))
      and o.id is distinct from p_exclude_order_id
      and o.status = 'pending' and o.payment_status = 'pending'
      and coalesce(o.settlement_state, 'pending') = 'pending'
      and o.stripe_checkout_session_id is null and o.stripe_payment_intent_id is null
      and coalesce(o.metadata ->> 'source', '') <> 'competition_registration'
      and o.created_at < now() - interval '2 minutes'
      and not exists (select 1 from public.event_order_payment_attempts a where a.order_id = o.id)
    order by o.id
    for update of o skip locked
  loop
    perform public._paywh1_release_order(v_id, 'released');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Orders the sweeper must reconcile (expired pending holds, stuck releases, lapsed processing holds).
drop function if exists public.list_event_cart_orders_due_for_reconcile(integer); -- return type is part of the contract
create or replace function public.list_event_cart_orders_due_for_reconcile(p_limit integer default 50)
returns table (order_id uuid, state text, expires_at timestamptz, retry_final_state text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- retry_final_state: a stalled release keeps its own outcome. begin_event_cart_order_release extends a still-valid
  -- hold past the request, so a hold that had already lapsed when the release began was an expiry.
  select o.id, public._paywh1_effective_state(o.status, o.payment_status, o.settlement_state), o.expires_at,
         case when o.expires_at is not null and o.release_requested_at is not null and o.expires_at <= o.release_requested_at
              then 'expired' else 'released' end
  from public.event_orders o
  where o.status = 'pending' and o.payment_status = 'pending'
    and coalesce(o.metadata ->> 'source', '') <> 'competition_registration'
    and (
      (coalesce(o.settlement_state, 'pending') = 'pending' and o.expires_at is not null and o.expires_at <= now())
      or (o.settlement_state = 'processing' and o.expires_at is not null and o.expires_at <= now()
          and not exists (select 1 from public.event_order_settlement_exceptions x
                          where x.order_id = o.id and x.kind = 'processing_hold_lapsed' and x.status = 'open'))
      or (o.settlement_state = 'releasing' and o.release_requested_at <= now() - interval '5 minutes')
    )
  order by o.expires_at nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Capacity trigger: a row that does not reserve capacity must not be blocked by (or counted in) the check.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.enforce_event_ticket_capacity_holds()
returns trigger
language plpgsql
as $$
declare
  ticket_capacity integer;
  reserved_admissions integer;
  requested_admissions integer;
  admits_per_ticket integer;
  new_order_holds boolean;
begin
  if new.ticket_type_id is null then
    return new;
  end if;

  -- PAY-WH-1: does the NEW row reserve or consume capacity at all?
  if not (
    new.payment_status = 'paid'
    or new.status in ('confirmed', 'checked_in', 'attended')
    or (new.status = 'pending' and new.payment_status = 'pending' and new.order_id is not null)
  ) then
    return new;
  end if;
  if new.status = 'pending' and new.payment_status = 'pending' and new.order_id is not null
     and not (new.payment_status = 'paid' or new.status in ('confirmed', 'checked_in', 'attended')) then
    select (eo.status = 'pending' and eo.payment_status = 'pending' and (eo.expires_at is null or eo.expires_at > now()))
    into new_order_holds
    from public.event_orders eo where eo.id = new.order_id;
    if not coalesce(new_order_holds, false) then
      return new;
    end if;
  end if;

  select
    ett.capacity,
    greatest(coalesce(ett.attendees_per_ticket, 1), 1)
  into
    ticket_capacity,
    admits_per_ticket
  from public.event_ticket_types ett
  where ett.id = new.ticket_type_id
  for update;

  if ticket_capacity is null then
    return new;
  end if;

  requested_admissions := greatest(coalesce(new.quantity, 1), 1) * admits_per_ticket;

  select coalesce(
    sum(
      greatest(coalesce(er.quantity, 1), 1)
      * greatest(coalesce(ett.attendees_per_ticket, 1), 1)
    ),
    0
  )
  into reserved_admissions
  from public.event_registrations er
  join public.event_ticket_types ett
    on ett.id = er.ticket_type_id
  left join public.event_orders eo
    on eo.id = er.order_id
  where er.ticket_type_id = new.ticket_type_id
    and er.id is distinct from new.id
    and (
      er.payment_status = 'paid'
      or er.status in ('confirmed', 'checked_in', 'attended')
      or (
        er.status = 'pending'
        and er.payment_status = 'pending'
        and er.order_id is not null
        and eo.status = 'pending'
        and eo.payment_status = 'pending'
        and (eo.expires_at is null or eo.expires_at > now())
      )
    );

  if reserved_admissions + requested_admissions > ticket_capacity then
    raise exception
      'Selected ticket quantity is no longer available. % admission spot(s) remain.',
      greatest(ticket_capacity - reserved_admissions, 0)
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: every lifecycle function is server-only.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public.record_event_cart_payment_attempt(uuid, text, text, text, text, bigint, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.extend_event_cart_order_hold(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.settle_event_cart_order(text, text, uuid, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.mark_event_cart_order_processing(text, text, uuid, text, text, text, bigint, text, timestamptz) from public, anon, authenticated;
revoke all on function public.fail_event_cart_payment_attempt(text, text, uuid, text, text, text, boolean, text, text) from public, anon, authenticated;
revoke all on function public.begin_event_cart_order_release(uuid, text) from public, anon, authenticated;
revoke all on function public.finalize_event_cart_order_release(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.release_unattempted_event_cart_orders(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.list_event_cart_orders_due_for_reconcile(integer) from public, anon, authenticated;
revoke all on function public._paywh1_effective_state(text, text, text) from public, anon, authenticated;

grant execute on function public.record_event_cart_payment_attempt(uuid, text, text, text, text, bigint, text, text, timestamptz) to service_role;
grant execute on function public.extend_event_cart_order_hold(uuid, timestamptz) to service_role;
grant execute on function public.settle_event_cart_order(text, text, uuid, text, text, text, bigint, text) to service_role;
grant execute on function public.mark_event_cart_order_processing(text, text, uuid, text, text, text, bigint, text, timestamptz) to service_role;
grant execute on function public.fail_event_cart_payment_attempt(text, text, uuid, text, text, text, boolean, text, text) to service_role;
grant execute on function public.begin_event_cart_order_release(uuid, text) to service_role;
grant execute on function public.finalize_event_cart_order_release(uuid, jsonb, text) to service_role;
grant execute on function public.release_unattempted_event_cart_orders(uuid, text, uuid) to service_role;
grant execute on function public.list_event_cart_orders_due_for_reconcile(integer) to service_role;
grant execute on function public._paywh1_effective_state(text, text, text) to service_role;

-- Pre-PAY-WH-1 SECURITY DEFINER sweeper (20260704). It expires every lapsed pending order directly -- bypassing the
-- two-phase release, so a still-payable Session/PaymentIntent or an in-flight delayed payment would be orphaned -- and
-- it was callable by any client role. No application code calls it; the event-cart cron replaces it. Owner only.
-- (The rollback deliberately does not restore these grants.)
revoke all on function public.expire_event_ticket_holds() from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
