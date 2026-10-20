-- Rollback of 20261202090000_twilio_tw4f_financial_integrity.sql. Roll the APPLICATION back first (the runner, panel and settings page call the new reads
-- and the low-volume kinds). Refuses once a low-volume fee kind has been priced, approved, reserved, charged or authorized (evidence). The approval-
-- reference registry is dropped: every reference stays on its spend event / pilot exception, so the registry can be rebuilt from them.
-- After this rollback a withdrawn or released approval's reference can again be reused (the pre-20261202 behaviour).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_approval_refs') is null then
    raise exception 'rollback refused: 20261202090000 is not applied';
  end if;
  -- 20261203090000 (inbound usage recording) widens the price-kind list again and builds on this migration: roll it back first
  if to_regclass('public.studio_sms_inbound_usage') is not null then
    raise exception 'rollback refused: roll back 20261203090000 (inbound usage recording) first';
  end if;
  if exists (select 1 from public.studio_sms_price_list where kind in ('brand_low_volume', 'monthly_low_volume'))
     or exists (select 1 from public.studio_sms_spend_events where kind in ('brand_low_volume', 'monthly_low_volume'))
     or exists (select 1 from public.studio_sms_credit_reservations where kind in ('brand_low_volume', 'monthly_low_volume'))
     or exists (select 1 from public.studio_sms_provider_charges where kind in ('brand_low_volume', 'monthly_low_volume'))
     or exists (select 1 from public.studio_sms_recurring_authorizations where kind = 'monthly_low_volume')
     or exists (select 1 from public.studio_sms_recurring_charges where kind = 'monthly_low_volume') then
    raise exception 'rollback refused: a Low-Volume Standard fee kind has been used (evidence)';
  end if;
end $$;

drop trigger studio_sms_spend_events_30_approval_ref on public.studio_sms_spend_events;
drop trigger studio_sms_pilot_exceptions_30_approval_ref on public.studio_sms_pilot_exceptions;
drop trigger studio_sms_limit_ceilings_30_approval_ref on public.studio_sms_limit_ceilings;
drop trigger studio_sms_credit_reservations_30_path on public.studio_sms_credit_reservations;
drop trigger studio_sms_spend_events_20_path on public.studio_sms_spend_events;
drop function public.tw4_approval_ref_trace(text, uuid);
drop function public.sms_location_fee_kinds(uuid);
drop function public.tw4_runner_fee_kinds(uuid, text);
drop function public.tw4_location_fee_kinds(uuid);
drop function public._tw4fi_spend_ref_trigger();
drop function public._tw4fi_pilot_ref_trigger();
drop function public._tw4fi_ceiling_ref_trigger();
drop function public._tw4fi_register(text, text, uuid, uuid, uuid, text, int, text, uuid);
drop function public._tw4fi_reservation_path_trigger();
drop function public._tw4fi_spend_path_trigger();
drop table public.studio_sms_approval_refs;
drop function public._tw4fi_append_only();

alter table public.studio_sms_price_list drop constraint studio_sms_price_list_kind_check;
alter table public.studio_sms_price_list add constraint studio_sms_price_list_kind_check check (kind in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage'));
alter table public.studio_sms_credit_reservations drop constraint studio_sms_credit_reservations_kind_check;
alter table public.studio_sms_credit_reservations add constraint studio_sms_credit_reservations_kind_check check (kind in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage'));
alter table public.studio_sms_provider_charges drop constraint studio_sms_provider_charges_kind_check;
alter table public.studio_sms_provider_charges add constraint studio_sms_provider_charges_kind_check check (kind in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage'));
alter table public.studio_sms_spend_events drop constraint studio_sms_spend_events_kind_check;
alter table public.studio_sms_spend_events add constraint studio_sms_spend_events_kind_check check (kind in ('brand', 'campaign_vetting', 'number', 'monthly'));
alter table public.studio_sms_recurring_authorizations drop constraint studio_sms_recurring_authorizations_kind_check;
alter table public.studio_sms_recurring_authorizations add constraint studio_sms_recurring_authorizations_kind_check check (kind in ('number', 'monthly'));
alter table public.studio_sms_recurring_charges drop constraint studio_sms_recurring_charges_kind_check;
alter table public.studio_sms_recurring_charges add constraint studio_sms_recurring_charges_kind_check check (kind in ('number', 'monthly'));

-- the replaced functions, back to their previous definitions (same signatures: grants are kept)
-- tw4_spend_authorize, tw4_spend_reserve, tw4_spend_settle: 20261122090000
create or replace function public.tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid, p_funding text default 'credit', p_studio_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  p public.studio_sms_price_list;
  v_id uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id for update;
  if e.id is null or p_kind is null or p_amount_cents is null or p_amount_cents <= 0 or p_funding is null or p_funding not in ('credit', 'pilot') then
    raise exception 'invalid authorization' using errcode = '22023';
  end if;
  -- a pilot-funded operation is approved for ONE location, with a written approval reference (10+ characters), and only while the exception exists
  if p_funding = 'pilot' then
    if p_studio_id is null or p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10
       or not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = e.id) then
      raise exception 'a pilot-funded authorization needs the pilot exception, a location and a written approval reference' using errcode = '22023';
    end if;
  end if;
  -- the authorized amount IS the published customer price: no price, no authorization; no other amount
  select * into p from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  if p.id is null then
    raise exception 'no published price for %', p_kind using errcode = 'TW008';
  end if;
  if p.customer_price_cents <> p_amount_cents then
    raise exception 'the amount must equal the published price' using errcode = 'TW008';
  end if;
  if public._tw4f3a_committed(e.id) + p_amount_cents > e.spend_cap_cents then
    raise exception 'this authorization would exceed the spend cap' using errcode = 'TW004';
  end if;
  insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by, funding, studio_id)
  values (e.id, p_kind, p_amount_cents, p_approval_ref, p_actor, p_funding, p_studio_id) returning id into v_id;
  perform public._tw4f3a_audit(public._tw4c_any_location(e.id), p_actor, 'spend_authorized', 'entity=' || e.id || ';kind=' || p_kind || ';cents=' || p_amount_cents || ';funding=' || p_funding);
  return jsonb_build_object('spend_event_id', v_id);
end $$;

create or replace function public.tw4_spend_reserve(p_onboarding_id uuid, p_lease_owner text, p_kind text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  e public.studio_sms_legal_entities;
  s public.studio_sms_spend_events;
  a public.studio_sms_credit_accounts;
  v_entity uuid;
  v_base text;
  v_key text;
  v_n int;
  v_res uuid;
  v_funding text;
  v_pilot_used bigint;
  pe public.studio_sms_pilot_exceptions;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_kind is null or p_kind not in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage') then
    raise exception 'unknown fee kind' using errcode = '22023';
  end if;
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  if v_entity is null then
    raise exception 'the studio has no legal entity' using errcode = 'TW004';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = v_entity for no key update;
  v_base := o.id || ':' || o.submission_seq || ':' || p_kind;
  -- the newest authorization already bound to this operation: reserved = idempotent replay; void (released) = needs a fresh authorization
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%' order by x.reserved_at desc limit 1;
  if s.id is not null and s.status = 'reserved' then
    return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', s.credit_reservation_id, 'replayed', true);
  end if;
  v_n := (select count(*) from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%') + 1;
  v_key := v_base || ':' || v_n;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.kind = p_kind and x.status = 'authorized' and (x.studio_id is null or x.studio_id = o.studio_id) order by (x.studio_id is null), x.authorized_at limit 1 for update;
  if s.id is null then
    raise exception 'no authorized spend for % within the cap', p_kind using errcode = 'TW004';
  end if;
  -- The funding source is the one the APPROVER chose on this authorization (no fallback), checked in the same transaction as the authorization is bound,
  -- under the entity and account locks (so concurrent operations and retries cannot both pass). 'credit': the legal business's settled credit.
  -- 'pilot': the founder-authorized ceiling, cumulative over outstanding reservations AND captured ones (a released one frees its share); never while the
  -- account is on hold or negative.
  a := public._tw4c_lock(v_entity);
  v_funding := s.funding;
  if v_funding = 'credit' then
    perform public._tw4c_require_funds(a, s.amount_cents);
  else
    select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity;
    if pe.legal_entity_id is null or a.hold or a.balance_cents < 0 then
      raise exception 'the pilot exception cannot fund this operation' using errcode = 'TW007';
    end if;
    select coalesce(sum(r.amount_cents), 0) into v_pilot_used from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured');
    if v_pilot_used + s.amount_cents > pe.ceiling_cents then
      raise exception 'the pilot ceiling would be exceeded' using errcode = 'TW007';
    end if;
  end if;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key) values (v_entity, o.studio_id, p_kind, s.amount_cents, v_funding, v_key) returning id into v_res;
  if v_funding = 'credit' then
    perform public._tw4c_post(v_entity, o.studio_id, 'reserve', 0, s.amount_cents, 'reserve:' || v_key, v_res, 'spend_event=' || s.id, null, null);
  end if;
  update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_key, reserved_at = now(), credit_reservation_id = v_res where id = s.id;
  perform public._tw4f3a_audit(o.studio_id, null, 'spend_reserved', 'entity=' || v_entity || ';kind=' || p_kind || ';cents=' || s.amount_cents || ';funding=' || v_funding);
  return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', v_res, 'funding', v_funding, 'replayed', false);
end $$;

create or replace function public.tw4_spend_settle(p_onboarding_id uuid, p_lease_owner text, p_kind text, p_outcome text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  s public.studio_sms_spend_events;
  r public.studio_sms_credit_reservations;
  v_entity uuid;
  v_base text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_outcome not in ('captured', 'released') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage') then
    raise exception 'unknown fee kind' using errcode = '22023';
  end if;
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  v_base := o.id || ':' || o.submission_seq || ':' || p_kind;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%' order by x.reserved_at desc limit 1;
  if s.id is null or s.credit_reservation_id is null then
    raise exception 'no reservation for this operation' using errcode = 'TW004';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id;
  perform public._tw4c_lock(r.legal_entity_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id for update;
  if r.status = 'captured' and p_outcome = 'captured' then
    return jsonb_build_object('status', 'captured', 'replayed', true);
  end if;
  if r.status = 'released' and p_outcome = 'released' then
    return jsonb_build_object('status', 'released', 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, p_ref, null, null);
    end if;
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
    perform public._tw4f3a_audit(o.studio_id, null, 'credit_captured', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  else
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, p_ref, null, null);
    end if;
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    perform set_config('tw4.credit_settle', 'on', true);
    update public.studio_sms_spend_events set status = 'void' where id = s.id;
    perform set_config('tw4.credit_settle', 'off', true);
    perform public._tw4f3a_audit(o.studio_id, null, 'credit_released', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  end if;
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

-- tw4_onboarding_decide_tier, tw4_onboarding_set_tier: 20261130090000
create or replace function public.tw4_onboarding_decide_tier(p_studio_id uuid, p_actor uuid, p_tier text, p_reason text, p_eligibility jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_tier is null or p_tier not in ('standard', 'low_volume_standard') then
    raise exception 'unknown tier' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  if p_eligibility is not null and (jsonb_typeof(p_eligibility) <> 'object' or char_length(p_eligibility::text) > 1000) then
    raise exception 'invalid eligibility record' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'no active onboarding' using errcode = '22023';
  end if;
  if p_tier = 'low_volume_standard' then
    if not public._tw4p_lvs_checklist_complete(p_eligibility) then
      raise exception 'Low-Volume Standard needs every eligibility check confirmed' using errcode = '22023';
    end if;
    select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
    -- EIN-registered: the location is linked to a legal business AND the studio's own submitted EIN agrees with that business's EIN last four
    if v_entity is null or o.ein_last4 is null
       or not exists (select 1 from public.studio_sms_legal_entities e where e.id = v_entity and e.ein_last4 = o.ein_last4) then
      raise exception 'Low-Volume Standard needs the location''s legal business on file, with an EIN matching the studio''s submitted setup' using errcode = '22023';
    end if;
    -- an open owner approval for a brand fee was made at the STANDARD price: switching would leave it standing at the wrong price
    if exists (select 1 from public.studio_sms_spend_events se where se.legal_entity_id = v_entity and se.kind = 'brand' and se.status in ('authorized', 'reserved')
               and (se.studio_id = p_studio_id or se.studio_id is null)) then
      raise exception 'an open brand fee approval exists (Standard price): withdraw it before choosing Low-Volume Standard' using errcode = '55000';
    end if;
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a runner holds this onboarding' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.step_key = 'B1') then
    raise exception 'the tier is frozen once a brand attempt exists' using errcode = '55000';
  end if;
  if o.tier is not distinct from p_tier then
    return jsonb_build_object('tier', o.tier, 'changed', false);
  end if;
  insert into public.studio_sms_tier_decisions (onboarding_id, studio_id, tier, previous_tier, reason, decided_by, eligibility)
  values (o.id, o.studio_id, p_tier, o.tier, btrim(p_reason), p_actor, case when p_tier = 'low_volume_standard' then p_eligibility end);
  update public.studio_sms_onboarding set tier = p_tier where id = o.id;
  return jsonb_build_object('tier', p_tier, 'changed', true);
end $$;

create or replace function public.tw4_onboarding_set_tier(p_studio_id uuid, p_actor uuid, p_tier text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_tier is null or p_tier not in ('standard', 'low_volume_standard') then
    raise exception 'unknown tier' using errcode = '22023';
  end if;
  if p_tier = 'low_volume_standard' then
    raise exception 'Low-Volume Standard needs the eligibility checklist (tw4_onboarding_decide_tier)' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 300 then
    raise exception 'a reason (3-300 characters) is required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'no active onboarding' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a runner holds this onboarding' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.step_key = 'B1') then
    raise exception 'the tier is frozen once a brand attempt exists' using errcode = '55000';
  end if;
  if o.tier is not distinct from p_tier then
    return jsonb_build_object('tier', o.tier, 'changed', false);
  end if;
  insert into public.studio_sms_tier_decisions (onboarding_id, studio_id, tier, previous_tier, reason, decided_by)
  values (o.id, o.studio_id, p_tier, o.tier, btrim(p_reason), p_actor);
  update public.studio_sms_onboarding set tier = p_tier where id = o.id;
  return jsonb_build_object('tier', p_tier, 'changed', true);
end $$;

-- tw4_recurring_authorize: 20261128090000
create or replace function public.tw4_recurring_authorize(p_studio_id uuid, p_user_id uuid, p_kind text, p_acknowledged_price_cents int, p_term_months int, p_total_limit_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_price public.studio_sms_price_list;
  v_limit int;
  v_id uuid := gen_random_uuid();
  v_statement text;
  v_cur text;
  v_res uuid;
  v_obligations bigint;
  acct public.studio_sms_credit_accounts;
begin
  if p_user_id is null or p_studio_id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'only the studio owner can authorize recurring charges' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'this studio has no verified legal business yet' using errcode = 'TW010';
  end if;
  if p_kind is null or p_kind not in ('number', 'monthly') or p_term_months is null or p_term_months not between 1 and 12 then
    raise exception 'invalid recurring authorization' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;   -- serialized with pilot-exception creation (entity lock first, then the account lock)
  acct := public._tw4c_lock(v_entity);   -- one decision at a time per legal business
  perform public._tw4ml_ensure_tz(v_entity);
  -- the founder-authorized pilot business: every recurring fee-bearing operation needs its own explicit approval, so a standing authorization is refused outright
  if exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity) then
    raise exception 'pilot business: each recurring operation needs its own approval' using errcode = 'TW011';
  end if;
  select * into v_price from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  if v_price.id is null then
    raise exception 'no published price for %', p_kind using errcode = 'TW008';
  end if;
  if p_acknowledged_price_cents is distinct from v_price.customer_price_cents then
    raise exception 'the price changed: review and authorize again' using errcode = 'TW008';   -- the owner must have seen the CURRENT price
  end if;
  -- the term IS the spending control: the total limit is the price times the months, so every month of the term can be charged and none beyond it
  v_limit := v_price.customer_price_cents * p_term_months;
  if p_total_limit_cents is not null and p_total_limit_cents <> v_limit then
    raise exception 'the total limit must be the price times the term' using errcode = '22023';
  end if;
  -- an authorization whose term has ended can never charge again: close it (and release anything it set aside) so it neither blocks this renewal nor counts as active
  perform public._tw4rc_release_commitment(x.id) from public.studio_sms_recurring_authorizations x
   where x.legal_entity_id = v_entity and x.studio_id = p_studio_id and x.kind = p_kind and x.status = 'active' and x.expires_at <= now();
  with closed as (
    update public.studio_sms_recurring_authorizations x set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_user_id
     where x.legal_entity_id = v_entity and x.studio_id = p_studio_id and x.kind = p_kind and x.status = 'active' and x.expires_at <= now()
    returning x.id, x.studio_id, x.kind)
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  select c.studio_id, null, 'system', p_user_id, 'recurring_revoked', left('authorization=' || c.id || ';kind=' || c.kind || ';term ended', 300) from closed c;
  if exists (select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = v_entity and a.studio_id = p_studio_id and a.kind = p_kind and a.status = 'active') then
    raise exception 'this charge is already authorized for this location' using errcode = '23505';
  end if;
  v_cur := public._tw4ml_month_key(v_entity, now());
  -- the monthly limit must be configured and must leave room: this month's spending plus the first month's commitment has to fit (and so do the standing obligations)
  select coalesce(sum(a.price_cents), 0) into v_obligations from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = v_entity and a.status = 'active' and a.expires_at > now();
  if v_obligations + v_price.customer_price_cents > public._tw4ml_effective_limit(v_entity, v_cur) then
    raise exception 'set a monthly spending limit that covers your recurring charges first' using errcode = 'TW012';
  end if;
  perform public._tw4ml_require_room(v_entity, v_price.customer_price_cents);
  -- the first month's charge is set aside now from settled credit, so setup spending cannot consume it; the first charge captures this very reservation
  select * into acct from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;   -- re-read: closing an ended term above may have released funds
  if acct.hold or acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < v_price.customer_price_cents then
    raise exception 'not enough settled credit to set aside the first month' using errcode = 'TW007';
  end if;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (v_entity, p_studio_id, p_kind, v_price.customer_price_cents, 'credit', 'commit:' || v_id) returning id into v_res;
  perform public._tw4c_post(v_entity, p_studio_id, 'reserve', 0, v_price.customer_price_cents, 'reserve:commit:' || v_id, v_res, 'commitment=' || v_id, null, null);
  -- the acknowledgement is built HERE from the validated numbers (never taken from a caller); the application shows the identical text before the owner agrees
  v_statement := 'I authorize DanceFlow to deduct ' || public._tw4rc_usd(v_price.customer_price_cents) || ' per month for '
    || case p_kind when 'number' then 'texting phone number rent' else 'monthly texting service' end
    || ' from my legal business''s prepaid texting credit, for up to ' || p_term_months || ' month' || case when p_term_months = 1 then '' else 's' end
    || ' and no more than ' || public._tw4rc_usd(v_limit) || ' in total, whichever comes first. '
    || 'The first month''s charge is set aside from my prepaid credit now. '
    || 'The charge is taken only if enough settled credit is available and it fits within my business''s monthly spending limit. No card is charged, no credit is added automatically, and I can revoke this at any time. '
    || 'Final prices and terms are pending approval.';
  -- the term is N whole calendar months in the business's timezone, the month of authorization first: N charges fit exactly and the term ends on a month boundary
  insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, expires_at, authorized_by, statement, commitment_reservation_id)
  values (v_id, v_entity, p_studio_id, p_kind, v_price.customer_price_cents, p_term_months, v_limit,
          public._tw4ml_month_start(v_entity, public._tw4ml_key_add(v_cur, p_term_months)), p_user_id, v_statement, v_res);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'system', p_user_id, 'recurring_authorized', left('authorization=' || v_id || ';kind=' || p_kind || ';cents=' || v_price.customer_price_cents || ';months=' || p_term_months || ';limit=' || v_limit, 300));
  return jsonb_build_object('authorization_id', v_id, 'price_cents', v_price.customer_price_cents, 'total_limit_cents', v_limit);
end $$;

-- used by the functions above until here; dropped last
drop function public._tw4fi_open_path_commitments(uuid, text[]);
drop function public._tw4fi_require_path_kind(uuid, text);
drop function public._tw4fi_location_path_nolock(uuid);
drop function public._tw4fi_ref_norm(text);

commit;
