-- Rollback for 20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases.sql (TW-4F-3b-pay).
-- Refuses once any purchase evidence exists (a payment intent binding, a refund or dispute, or a ledger entry referencing one): that is financial evidence.
-- Restores the TW-4F-3b-0 versions of the functions and the topups guard (lifted verbatim from 20261122090000) and their service-role-only privileges.
-- Order: application first.
begin;

set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_sms_credit_topups' and column_name = 'payment_intent_ref') then
    raise exception 'TW-4F-3b-pay rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_credit_topups where payment_intent_ref is not null or refunded_cents > 0 or disputed_cents > 0
                or (status = 'pending' and expires_at is not null and expires_at > now()))
     or exists (select 1 from public.studio_sms_credit_ledger where idempotency_key like 'refund:%' or idempotency_key like 'dispute\_%') then
    raise exception 'TW-4F-3b-pay rollback refused: purchase bindings, refunds, disputes or live pending checkouts exist' using errcode = '55000';
  end if;
end $$;

drop function public.tw4_credit_checkout_context(uuid, uuid), public.tw4_credit_topup_lookup(text), public.tw4_credit_apply_refund(text, int, text, text),
  public.tw4_credit_apply_dispute(text, text, int, text, text), public.tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz),
  public.tw4_credit_settle_topup(uuid, uuid, text, int, text, text, boolean);

alter table public.studio_sms_credit_topups drop constraint studio_sms_credit_topups_split;
drop index public.studio_sms_credit_topups_payment_intent;

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
       or new.reversed_cents < old.reversed_cents or (old.status = 'settled' and new.status is distinct from old.status) or (new.status = 'pending' and old.status <> 'pending') then
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

alter table public.studio_sms_credit_topups drop column payment_intent_ref, drop column expires_at, drop column refunded_cents, drop column disputed_cents;

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
    'pending_topups_cents', coalesce((select sum(t.amount_cents) from public.studio_sms_credit_topups t where t.legal_entity_id = v_entity and t.status = 'pending'), 0),
    'this_location_net_charges_cents', coalesce((select -sum(l.balance_delta_cents) from public.studio_sms_credit_ledger l
        where l.legal_entity_id = v_entity and l.studio_id = p_studio_id and l.kind in ('capture', 'usage_charge', 'usage_refund')), 0),
    'pilot_ceiling_cents', (select x.ceiling_cents from public.studio_sms_pilot_exceptions x where x.legal_entity_id = v_entity),
    'pilot_used_cents', coalesce((select sum(r.amount_cents) from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured')), 0));
end $$;

create or replace function public.tw4_credit_topup_pending(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  t public.studio_sms_credit_topups;
  v_pending bigint;
begin
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
  select coalesce(sum(x.amount_cents), 0) into v_pending from public.studio_sms_credit_topups x where x.legal_entity_id = p_entity_id and x.status = 'pending';
  if a.balance_cents + v_pending + p_amount_cents > 50000 then
    raise exception 'this top-up would exceed the $500 balance ceiling' using errcode = 'TW009';
  end if;
  insert into public.studio_sms_credit_topups (legal_entity_id, paid_by_studio_id, provider, provider_ref, amount_cents) values (p_entity_id, p_paid_by_studio_id, 'stripe', p_provider_ref, p_amount_cents) returning * into t;
  return jsonb_build_object('topup_id', t.id, 'status', t.status);
end $$;

create or replace function public.tw4_credit_settle_topup(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents int, p_event_id text)
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
    insert into public.studio_sms_credit_topups (legal_entity_id, paid_by_studio_id, provider, provider_ref, amount_cents) values (p_entity_id, p_paid_by_studio_id, 'stripe', p_provider_ref, p_amount_cents) returning * into t;
  elsif t.legal_entity_id <> p_entity_id or t.amount_cents <> p_amount_cents then
    raise exception 'this payment belongs to another legal business or amount' using errcode = '23505';
  end if;
  r := public._tw4c_post(p_entity_id, t.paid_by_studio_id, 'topup_settled', p_amount_cents, 0, 'topup:' || p_provider_ref, null, p_provider_ref, null, 'event=' || coalesce(p_event_id, ''));
  if t.status <> 'settled' then
    update public.studio_sms_credit_topups set status = 'settled', settled_at = now() where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(p_entity_id), null, 'system', null, 'credit_topup', left('cents=' || p_amount_cents || ';ref=' || p_provider_ref, 300));
  end if;
  return r;
end $$;

create or replace function public.tw4_credit_reverse_topup(p_provider_ref text, p_amount_cents int, p_event_id text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  r jsonb;
begin
  if p_event_id is null or char_length(btrim(p_event_id)) < 3 then
    raise exception 'a reversal needs the provider event id' using errcode = '22023';
  end if;
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref;
  if t.id is null or t.status <> 'settled' or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'no settled payment to reverse' using errcode = '22023';
  end if;
  perform public._tw4c_lock(t.legal_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.id = t.id for update;
  r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'topup_reversed', -p_amount_cents, 0, 'reverse:' || p_provider_ref || ':' || p_event_id, null, p_provider_ref, null, left(coalesce(p_reason, ''), 280));
  if not (r->>'replayed')::boolean then
    if t.reversed_cents + p_amount_cents > t.amount_cents then
      raise exception 'more than the payment was reversed' using errcode = '22023';
    end if;
    update public.studio_sms_credit_topups set reversed_cents = reversed_cents + p_amount_cents where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_reversal', left('cents=' || p_amount_cents || ';ref=' || p_provider_ref, 300));
  end if;
  return r;
end $$;

revoke all on function public.tw4_credit_topup_pending(uuid, uuid, text, int), public.tw4_credit_settle_topup(uuid, uuid, text, int, text),
  public.tw4_credit_reverse_topup(text, int, text, text) from public, anon, authenticated;
grant execute on function public.tw4_credit_topup_pending(uuid, uuid, text, int), public.tw4_credit_settle_topup(uuid, uuid, text, int, text),
  public.tw4_credit_reverse_topup(text, int, text, text) to service_role;

commit;
