-- 20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases.sql
-- TW-4F-3b-pay: prepaid SMS credit purchases through Stripe (platform account). Database side only; NO Stripe call is made by anything in this file.
--   * a purchase is a Stripe Checkout Session (packs of $25 / $50 / $100, cards): its id is the topup provider_ref, registered as PENDING (not spendable) with a
--     short expiry; the $500 balance ceiling counts the balance plus every LIVE pending payment (balance + pending + new pack), serialized by the account lock
--   * only a SETTLED payment becomes credit: tw4_credit_settle_topup (webhook) requires a pending registration of this very business/location/amount (an unknown
--     session credits nothing), binds the PaymentIntent, and is idempotent per payment
--   * refunds (cumulative, order-independent) and disputes (withdrawn / reinstated, once per dispute id) are applied by the payment, never by an amount the caller
--     picks freely; together they can never reverse more than the payment; the split is kept in refunded_cents / disputed_cents
--   * tw4_credit_checkout_context authorizes a purchase at the database too (owner or administrator of the location, verified legal business)
-- The ConfiDance pilot ceiling is untouched: purchased credit and the ceiling stay separate (a reservation's funding is chosen per authorization).
-- Replaces tw4_credit_topup_pending (adds the expiry), tw4_credit_settle_topup (adds PaymentIntent + require-pending), removes the free-amount
-- tw4_credit_reverse_topup, and replaces the topups guard and sms_credit_overview.
-- Rollback: rollback/20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases_rollback.sql (application first; refuses once any purchase evidence exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_credit_topups') is null or to_regprocedure('public.tw4_credit_settle_topup(uuid,uuid,text,integer,text)') is null then
    raise exception 'TW-4F-3b-pay precondition failed: TW-4F-3b-0 is not applied';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_sms_credit_topups' and column_name = 'payment_intent_ref') then
    raise exception 'TW-4F-3b-pay precondition failed: already applied';
  end if;
end $$;

alter table public.studio_sms_credit_topups
  add column payment_intent_ref text null check (payment_intent_ref is null or char_length(payment_intent_ref) between 3 and 200),
  add column expires_at timestamptz null,
  add column refunded_cents int not null default 0 check (refunded_cents >= 0),
  add column disputed_cents int not null default 0 check (disputed_cents >= 0);
update public.studio_sms_credit_topups set refunded_cents = reversed_cents where reversed_cents > 0;
alter table public.studio_sms_credit_topups add constraint studio_sms_credit_topups_split check (reversed_cents = refunded_cents + disputed_cents);
create unique index studio_sms_credit_topups_payment_intent on public.studio_sms_credit_topups (payment_intent_ref) where payment_intent_ref is not null;

create or replace function public._tw4c_immutable_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_table_name = 'studio_sms_price_list' and tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
       or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.created_at is distinct from old.created_at
       or (old.active = false and new.active = true) then
      raise exception 'a published price is never edited: retire it and publish a new one' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'studio_sms_credit_reservations' and tg_op = 'UPDATE' then
    if old.status <> 'reserved' or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id or new.kind is distinct from old.kind
       or new.amount_cents is distinct from old.amount_cents or new.reservation_key is distinct from old.reservation_key or new.created_at is distinct from old.created_at
       or new.funding is distinct from old.funding or new.status = 'reserved' then
      raise exception 'a closed reservation is final' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'studio_sms_credit_topups' and tg_op = 'UPDATE' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.paid_by_studio_id is distinct from old.paid_by_studio_id or new.provider is distinct from old.provider
       or new.provider_ref is distinct from old.provider_ref or new.amount_cents is distinct from old.amount_cents or new.created_at is distinct from old.created_at
       or new.expires_at is distinct from old.expires_at
       or (old.payment_intent_ref is not null and new.payment_intent_ref is distinct from old.payment_intent_ref)
       or new.refunded_cents < old.refunded_cents
       or (old.status = 'settled' and new.status is distinct from old.status) or (new.status = 'pending' and old.status <> 'pending') then
      raise exception 'a funding payment is not edited' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'studio_sms_credit_accounts' and tg_op = 'UPDATE' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.created_at is distinct from old.created_at then
      raise exception 'a credit account is not re-assigned' using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;

create or replace function public.sms_credit_overview(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_entity uuid;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('legal_business', false, 'balance_cents', 0, 'reserved_cents', 0, 'available_cents', 0, 'on_hold', false, 'low_balance', false, 'pending_topups_cents', 0, 'this_location_net_charges_cents', 0);
  end if;
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  return jsonb_build_object(
    'legal_business', true,
    'balance_cents', coalesce(a.balance_cents, 0), 'reserved_cents', coalesce(a.reserved_cents, 0),
    'available_cents', greatest(coalesce(a.balance_cents, 0) - coalesce(a.reserved_cents, 0), 0),
    'on_hold', coalesce(a.hold, false), 'low_balance', a.low_balance_flagged_at is not null, 'low_balance_threshold_cents', coalesce(a.low_balance_threshold_cents, 1000),
    'pending_topups_cents', coalesce((select sum(t.amount_cents) from public.studio_sms_credit_topups t where t.legal_entity_id = v_entity and t.status = 'pending' and (t.expires_at is null or t.expires_at > now())), 0),
    'this_location_net_charges_cents', coalesce((select -sum(l.balance_delta_cents) from public.studio_sms_credit_ledger l
        where l.legal_entity_id = v_entity and l.studio_id = p_studio_id and l.kind in ('capture', 'usage_charge', 'usage_refund')), 0),
    'pilot_ceiling_cents', (select x.ceiling_cents from public.studio_sms_pilot_exceptions x where x.legal_entity_id = v_entity),
    'pilot_used_cents', coalesce((select sum(r.amount_cents) from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured')), 0));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- authorization of a purchase at the database: owner or administrator of the location, verified legal business
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_checkout_context(p_studio_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_entity uuid;
begin
  if p_user_id is null or p_studio_id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = p_studio_id and r.active = true and r.role in ('studio_owner', 'studio_admin')) then
    raise exception 'not authorized to buy SMS credit for this studio' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'this studio has no verified legal business yet' using errcode = 'TW010';
  end if;
  return jsonb_build_object('legal_entity_id', v_entity);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- checkout registration (pending): packs, the $500 ceiling over balance + LIVE pending + the new pack, short expiry
-- ---------------------------------------------------------------------------------------------------------------
drop function public.tw4_credit_topup_pending(uuid, uuid, text, int);
create or replace function public.tw4_credit_topup_pending(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents int, p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  t public.studio_sms_credit_topups;
  v_pending bigint;
begin
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '24 hours') then
    raise exception 'a checkout must expire within the next 24 hours' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref;
  if t.id is not null then
    if t.legal_entity_id <> p_entity_id or t.amount_cents <> p_amount_cents then
      raise exception 'this payment belongs to another legal business or amount' using errcode = '23505';
    end if;
    return jsonb_build_object('topup_id', t.id, 'status', t.status);
  end if;
  if p_amount_cents not in (2500, 5000, 10000) then
    raise exception 'top-ups are $25, $50 or $100 packs' using errcode = '22023';
  end if;
  select coalesce(sum(x.amount_cents), 0) into v_pending from public.studio_sms_credit_topups x
   where x.legal_entity_id = p_entity_id and x.status = 'pending' and (x.expires_at is null or x.expires_at > now());
  if a.balance_cents + v_pending + p_amount_cents > 50000 then
    raise exception 'this top-up would exceed the $500 balance ceiling' using errcode = 'TW009';
  end if;
  insert into public.studio_sms_credit_topups (legal_entity_id, paid_by_studio_id, provider, provider_ref, amount_cents, expires_at)
  values (p_entity_id, p_paid_by_studio_id, 'stripe', p_provider_ref, p_amount_cents, p_expires_at) returning * into t;
  return jsonb_build_object('topup_id', t.id, 'status', t.status);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- settlement: the webhook passes the checkout session id, the PaymentIntent and require_pending = true (an unknown session credits nothing)
-- ---------------------------------------------------------------------------------------------------------------
drop function public.tw4_credit_settle_topup(uuid, uuid, text, int, text);
create or replace function public.tw4_credit_settle_topup(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents int, p_event_id text,
  p_payment_intent text default null, p_require_pending boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  r jsonb;
begin
  perform public._tw4c_lock(p_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref for update;
  if t.id is null then
    if p_require_pending then
      raise exception 'unknown checkout: no pending payment was registered for it' using errcode = '22023';
    end if;
    insert into public.studio_sms_credit_topups (legal_entity_id, paid_by_studio_id, provider, provider_ref, amount_cents) values (p_entity_id, p_paid_by_studio_id, 'stripe', p_provider_ref, p_amount_cents) returning * into t;
  elsif t.legal_entity_id <> p_entity_id or t.amount_cents <> p_amount_cents or (p_require_pending and t.paid_by_studio_id is distinct from p_paid_by_studio_id) then
    raise exception 'this payment belongs to another legal business, location or amount' using errcode = '23505';
  end if;
  if p_payment_intent is not null then
    if t.payment_intent_ref is null then
      update public.studio_sms_credit_topups set payment_intent_ref = p_payment_intent where id = t.id;
    elsif t.payment_intent_ref <> p_payment_intent then
      raise exception 'this checkout was already settled by another payment' using errcode = '23505';
    end if;
  end if;
  r := public._tw4c_post(p_entity_id, t.paid_by_studio_id, 'topup_settled', p_amount_cents, 0, 'topup:' || p_provider_ref, null, p_provider_ref, null, 'event=' || coalesce(p_event_id, ''));
  if t.status <> 'settled' then
    update public.studio_sms_credit_topups set status = 'settled', settled_at = now() where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(p_entity_id), null, 'system', null, 'credit_topup', left('cents=' || p_amount_cents || ';ref=' || p_provider_ref, 300));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- finding a payment by checkout session or PaymentIntent (the webhook decides whether an event is a credit purchase from the DATABASE, not from metadata)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_topup_lookup(p_payment_ref text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare t public.studio_sms_credit_topups;
begin
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and (x.provider_ref = p_payment_ref or x.payment_intent_ref = p_payment_ref) limit 1;
  if t.id is null then
    return null;
  end if;
  return jsonb_build_object('topup_id', t.id, 'legal_entity_id', t.legal_entity_id, 'paid_by_studio_id', t.paid_by_studio_id, 'status', t.status,
    'amount_cents', t.amount_cents, 'provider_ref', t.provider_ref, 'payment_intent_ref', t.payment_intent_ref);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- refunds: the CUMULATIVE refunded amount of the charge (Stripe's own figure); out-of-order and repeated events change nothing
-- ---------------------------------------------------------------------------------------------------------------
drop function public.tw4_credit_reverse_topup(text, int, text, text);
create or replace function public.tw4_credit_apply_refund(p_payment_ref text, p_cumulative_refunded_cents int, p_event_id text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  r jsonb;
  v_delta int;
  v_debit int;
begin
  if p_event_id is null or char_length(btrim(p_event_id)) < 3 or p_cumulative_refunded_cents is null or p_cumulative_refunded_cents <= 0 then
    raise exception 'a refund needs the provider event id and a positive cumulative amount' using errcode = '22023';
  end if;
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and (x.provider_ref = p_payment_ref or x.payment_intent_ref = p_payment_ref) limit 1;
  if t.id is null or t.status <> 'settled' then
    raise exception 'no settled payment to refund' using errcode = '22023';
  end if;
  perform public._tw4c_lock(t.legal_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.id = t.id for update;
  if p_cumulative_refunded_cents <= t.refunded_cents then
    return jsonb_build_object('replayed', true, 'noop', true);
  end if;
  v_delta := p_cumulative_refunded_cents - t.refunded_cents;
  if p_cumulative_refunded_cents > t.amount_cents then
    raise exception 'more than the payment was reversed' using errcode = '22023';
  end if;
  -- a dispute may already have taken back what this refund also returns (the refund event can arrive late): only the still-unreversed part is debited,
  -- and the excess moves from the dispute's share to the refund's share so a later reinstatement cannot return money that was refunded
  v_debit := least(v_delta, t.amount_cents - t.refunded_cents - t.disputed_cents);
  if v_debit > 0 then
    r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'topup_reversed', -v_debit, 0, 'refund:' || t.id || ':' || p_cumulative_refunded_cents, null, t.provider_ref, null,
           left('refund;event=' || p_event_id || ';' || coalesce(p_reason, ''), 280));
  else
    r := jsonb_build_object('replayed', false);
  end if;
  update public.studio_sms_credit_topups
     set refunded_cents = p_cumulative_refunded_cents, disputed_cents = disputed_cents - (v_delta - v_debit), reversed_cents = reversed_cents + v_debit
   where id = t.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_reversal', left('refund;cents=' || v_delta || ';debited=' || v_debit || ';ref=' || t.provider_ref, 300));
  return r || jsonb_build_object('noop', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- disputes: withdrawn (funds taken) once per dispute id; reinstated (won) gives back exactly what that dispute withdrew, once
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_apply_dispute(p_payment_ref text, p_dispute_id text, p_amount_cents int, p_action text, p_event_id text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  w public.studio_sms_credit_ledger;
  r jsonb;
  v_amount int;
begin
  if p_dispute_id is null or char_length(btrim(p_dispute_id)) < 3 or p_event_id is null or char_length(btrim(p_event_id)) < 3 or p_action not in ('withdrawn', 'reinstated') then
    raise exception 'invalid dispute event' using errcode = '22023';
  end if;
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and (x.provider_ref = p_payment_ref or x.payment_intent_ref = p_payment_ref) limit 1;
  if t.id is null or t.status <> 'settled' then
    raise exception 'no settled payment for this dispute' using errcode = '22023';
  end if;
  perform public._tw4c_lock(t.legal_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.id = t.id for update;
  if p_action = 'withdrawn' then
    if p_amount_cents is null or p_amount_cents <= 0 then
      raise exception 'invalid dispute amount' using errcode = '22023';
    end if;
    select * into w from public.studio_sms_credit_ledger l where l.legal_entity_id = t.legal_entity_id and l.idempotency_key = 'dispute_w:' || t.id || ':' || p_dispute_id;
    if w.id is not null then
      return jsonb_build_object('replayed', true);
    end if;
    -- never take back more than is still unreversed (a refunded payment can also be disputed): the debit is capped, never an error that retries forever
    v_amount := least(p_amount_cents, t.amount_cents - t.refunded_cents - t.disputed_cents);
    if v_amount <= 0 then
      if not exists (select 1 from public.studio_sms_onboarding_audit au where au.note = left('dispute_nothing_left;payment=' || t.id || ';dispute=' || p_dispute_id, 300)) then
        insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
        values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_reversal', left('dispute_nothing_left;payment=' || t.id || ';dispute=' || p_dispute_id, 300));
      end if;
      return jsonb_build_object('replayed', false, 'capped_to_zero', true);
    end if;
    r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'topup_reversed', -v_amount, 0, 'dispute_w:' || t.id || ':' || p_dispute_id, null, t.provider_ref, null,
           left('dispute withdrawn;event=' || p_event_id, 280));
    update public.studio_sms_credit_topups set disputed_cents = disputed_cents + v_amount, reversed_cents = reversed_cents + v_amount where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_reversal', left('dispute;cents=' || v_amount || ';ref=' || t.provider_ref, 300));
    return r;
  end if;
  -- reinstated: only what THIS dispute withdrew, only once
  select * into w from public.studio_sms_credit_ledger l where l.legal_entity_id = t.legal_entity_id and l.idempotency_key = 'dispute_w:' || t.id || ':' || p_dispute_id;
  if w.id is null and exists (select 1 from public.studio_sms_onboarding_audit au where au.note = left('dispute_nothing_left;payment=' || t.id || ';dispute=' || p_dispute_id, 300)) then
    return jsonb_build_object('replayed', true, 'capped_to_zero', true); -- the withdrawal was capped to nothing, so there is nothing to give back
  end if;
  if w.id is null then
    raise exception 'this dispute withdrew nothing from the payment' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = t.legal_entity_id and l.idempotency_key = 'dispute_r:' || t.id || ':' || p_dispute_id) then
    return jsonb_build_object('replayed', true); -- already reinstated; a replay must not recompute against a changed balance of the dispute
  end if;
  v_amount := least(-w.balance_delta_cents, t.disputed_cents); -- never more than the dispute still holds (a later refund may have taken part of it)
  if v_amount <= 0 then
    return jsonb_build_object('replayed', true, 'capped_to_zero', true);
  end if;
  r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'adjustment', v_amount, 0, 'dispute_r:' || t.id || ':' || p_dispute_id, null, t.provider_ref, null,
         left('dispute reinstated;event=' || p_event_id, 280));
  if not (r->>'replayed')::boolean then
    update public.studio_sms_credit_topups set disputed_cents = disputed_cents - v_amount, reversed_cents = reversed_cents - v_amount where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_adjustment', left('dispute reinstated;cents=' || v_amount || ';ref=' || t.provider_ref, 300));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- grants (the dropped and replaced functions are new objects: privileges are set explicitly)
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public.tw4_credit_checkout_context(uuid, uuid), public.tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz),
  public.tw4_credit_settle_topup(uuid, uuid, text, int, text, text, boolean), public.tw4_credit_topup_lookup(text),
  public.tw4_credit_apply_refund(text, int, text, text), public.tw4_credit_apply_dispute(text, text, int, text, text) from public, anon, authenticated;
grant execute on function public.tw4_credit_checkout_context(uuid, uuid), public.tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz),
  public.tw4_credit_settle_topup(uuid, uuid, text, int, text, text, boolean), public.tw4_credit_topup_lookup(text),
  public.tw4_credit_apply_refund(text, int, text, text), public.tw4_credit_apply_dispute(text, text, int, text, text) to service_role;

commit;
