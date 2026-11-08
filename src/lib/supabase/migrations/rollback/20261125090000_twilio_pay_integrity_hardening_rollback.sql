-- Rollback of 20261125090000 (pay-integrity hardening): restores the 20261123090000 function bodies (verbatim) and drops the dispute state table.
-- Refuses once any dispute row exists (financial evidence). Roll the application back first.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_credit_disputes') is null then
    raise exception 'pay-integrity rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_credit_disputes) then
    raise exception 'pay-integrity rollback refused: dispute records exist' using errcode = '55000';
  end if;
end $$;

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

drop table public.studio_sms_credit_disputes;

revoke all on function public.tw4_credit_checkout_context(uuid, uuid), public.tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz),
  public.tw4_credit_apply_dispute(text, text, int, text, text) from public, anon, authenticated;
grant execute on function public.tw4_credit_checkout_context(uuid, uuid), public.tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz),
  public.tw4_credit_apply_dispute(text, text, int, text, text) to service_role;

commit;
