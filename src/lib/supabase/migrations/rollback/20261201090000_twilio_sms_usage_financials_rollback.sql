-- Rollback of 20261201090000 (SMS usage financials). Restores _tw4ml_month_parts and tw4_credit_resolve_reservation as of 20261128090000 and removes the usage
-- objects. REFUSES once any usage attempt, billed sender, switch row or usage audit row exists (financial evidence): from then on the stance is forward-fix only.
-- Drain first (docs/twilio/TW-4F_Usage_Financials_Design.md section 6); roll the application back before this file.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_usage_attempts') is null then
    raise exception 'usage-financials rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_usage_attempts) or exists (select 1 from public.studio_sms_billed_senders) or exists (select 1 from public.studio_sms_usage_switch_log)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('usage_switch', 'usage_sender_set', 'usage_resolved'))
     or exists (select 1 from public.studio_sms_credit_reservations where reservation_key like 'sms:%') then
    raise exception 'usage-financials rollback refused: usage attempts, billed senders, switch rows or usage reservations exist' using errcode = '55000';
  end if;
end $$;

drop function public.tw4_usage_touch(uuid), public.sms_usage_admin_overview(uuid), public.tw4_usage_due(int), public.tw4_usage_resolve(uuid, uuid, text, int, text), public.tw4_usage_release_unsent(),
  public.tw4_usage_settle(uuid, jsonb), public.tw4_usage_record_callback(uuid, text, text, text, text), public.tw4_usage_uncertain(uuid, text), public.tw4_usage_rejected(uuid, text),
  public.tw4_usage_submitted(uuid, text), public.tw4_usage_dispatching(uuid), public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid),
  public.tw4_usage_studio_mode(uuid), public.tw4_usage_billed_sender_set(uuid, uuid, text, text, text, text), public.tw4_usage_set_switch(boolean, uuid, text),
  public._tw4us_reconciliation_gaps(), public._tw4us_lock_attempt(uuid), public._tw4us_charge(public.studio_sms_usage_attempts, int, text),
  public._tw4us_release_reservation(public.studio_sms_usage_attempts, text), public._tw4us_rank(text), public._tw4us_write(), public._tw4us_switch_on(), public._tw4us_segments(text);
drop table public.studio_sms_usage_attempts;
drop table public.studio_sms_billed_senders;
drop table public.studio_sms_usage_switch_log;
drop function public._tw4us_attempt_guard(), public._tw4us_append_only();

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount',
  'credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set', 'credit_pilot_exception', 'spend_withdrawn',
  'recurring_authorized', 'recurring_revoked', 'recurring_charged', 'recurring_unfunded', 'recurring_held', 'recurring_refused',
  'monthly_limit_set', 'monthly_limit_ceiling', 'entity_timezone_set'));

create or replace function public._tw4ml_month_parts(p_entity uuid, p_key text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s timestamptz := public._tw4ml_month_start(p_entity, p_key);
  e timestamptz := public._tw4ml_month_start(p_entity, public._tw4ml_key_add(p_key, 1));
  v_usage bigint;
  v_recurring bigint;
  v_reserved bigint;
begin
  select coalesce(sum(-l.balance_delta_cents), 0) into v_usage from public.studio_sms_credit_ledger l
   where l.legal_entity_id = p_entity and l.kind in ('usage_charge', 'usage_refund') and l.created_at >= s and l.created_at < e;
  -- a captured recurring fee belongs to the month its funds were reserved in (a set-aside captured by a later month's charge is NOT counted a second time there)
  select coalesce(sum(-l.balance_delta_cents), 0) into v_recurring from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind = 'capture' and (l.idempotency_key like 'capture:rec:%' or l.idempotency_key like 'capture:commit:%')
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  select coalesce(sum(r.amount_cents), 0) into v_reserved from public.studio_sms_credit_reservations r
   where r.legal_entity_id = p_entity and r.status = 'reserved' and (r.reservation_key like 'rec:%' or r.reservation_key like 'commit:%') and r.created_at >= s and r.created_at < e;
  return jsonb_build_object('usage_cents', v_usage, 'recurring_cents', v_recurring, 'reserved_cents', v_reserved, 'total_cents', v_usage + v_recurring + v_reserved,
                            'starts_at', s, 'ends_at', e);
end $$;

create or replace function public.tw4_credit_resolve_reservation(p_reservation_id uuid, p_outcome text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_credit_reservations;
  s public.studio_sms_spend_events;
begin
  perform public._tw4c_admin(p_actor);
  if p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'an outcome and a written reason (10+ characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id;
  if r.id is null then
    raise exception 'unknown reservation' using errcode = '22023';
  end if;
  perform public._tw4c_lock(r.legal_entity_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id for update;
  if r.reservation_key like 'commit:%' then
    raise exception 'a recurring set-aside is captured only by its charge and released by revoking the authorization' using errcode = '22023';
  end if;
  if (r.status = 'captured' and p_outcome = 'captured') or (r.status = 'released' and p_outcome = 'released') then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
  else
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    select * into s from public.studio_sms_spend_events x where x.credit_reservation_id = r.id;
    if s.id is not null then
      perform set_config('tw4.credit_settle', 'on', true);
      update public.studio_sms_spend_events set status = 'void' where id = s.id;
      perform set_config('tw4.credit_settle', 'off', true);
    end if;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (r.studio_id, null, 'platform_admin', p_actor, case when p_outcome = 'captured' then 'credit_captured' else 'credit_released' end, left('reservation=' || r.id || ';admin', 300));
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

create or replace function public.tw4_credit_debit_usage(p_entity_id uuid, p_studio_id uuid, p_cents int, p_key text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
begin
  if p_cents is null or p_cents <= 0 or p_studio_id is null then
    raise exception 'invalid usage amount or location' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  -- a replay of a debit that already happened must succeed even if the account has since run low or the month's limit is used up
  if exists (select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id and l.idempotency_key = 'usage:' || p_key) then
    return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  end if;
  perform public._tw4ml_ensure_tz(p_entity_id);
  perform public._tw4c_require_funds(a, p_cents);
  perform public._tw4ml_require_room(p_entity_id, p_cents);   -- fail closed: funds AND the month's limit
  return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
end $$;

commit;
