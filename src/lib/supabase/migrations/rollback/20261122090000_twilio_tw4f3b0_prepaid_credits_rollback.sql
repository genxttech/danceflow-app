-- Rollback for 20261122090000_twilio_tw4f3b0_prepaid_credits.sql (TW-4F-3b-0).
-- Refuses once any price, credit account, ledger entry, reservation, funding payment or provider charge exists: that is financial evidence and must not
-- be dropped silently. Restores the TW-4F-3a versions of the functions and constraint (lifted verbatim from 20261121090000). Order: application first.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_credit_ledger') is null then
    raise exception 'TW-4F-3b-0 rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_price_list) or exists (select 1 from public.studio_sms_credit_accounts) or exists (select 1 from public.studio_sms_credit_ledger)
     or exists (select 1 from public.studio_sms_credit_reservations) or exists (select 1 from public.studio_sms_credit_topups) or exists (select 1 from public.studio_sms_provider_charges)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set')) then
    raise exception 'TW-4F-3b-0 rollback refused: prices, credit accounts, ledger entries, reservations, payments or provider charges exist' using errcode = '55000';
  end if;
end $$;

alter table public.studio_sms_spend_events drop constraint studio_sms_spend_events_reserved;
alter table public.studio_sms_spend_events drop column credit_reservation_id;
alter table public.studio_sms_spend_events add constraint studio_sms_spend_events_reserved check ((status = 'reserved') = (reservation_key is not null and reserved_at is not null));
alter table public.studio_sms_legal_entities drop column funding_studio_id;

create or replace function public._tw4f3a_evidence_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- cascade from a deleted studio only
    if tg_table_name = 'studio_sms_entity_studios' or tg_table_name = 'studio_sms_location_requests' then
      if not exists (select 1 from public.studios s where s.id = old.studio_id) then return old; end if;
    end if;
    raise exception '% rows are not deleted', tg_table_name using errcode = '42501';
  end if;
  -- (nested on purpose: PL/pgSQL may resolve every field of a boolean expression, and NEW only has the fields of its own table)
  if tg_table_name = 'studio_sms_subaccount_confirmations' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.confirmed_by is distinct from old.confirmed_by
       or new.confirmed_at is distinct from old.confirmed_at or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at) then
      raise exception 'a subaccount confirmation can only be consumed, once' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_entity_studios' then
    raise exception 'a location link is not edited' using errcode = '42501';
  elsif tg_table_name = 'studio_sms_twilio_accounts' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.created_by is distinct from old.created_by
       or (old.twilio_account_sid is not null and new.twilio_account_sid is distinct from old.twilio_account_sid) then
      raise exception 'the subaccount sid is final' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_spend_events' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.kind is distinct from old.kind
       or new.amount_cents is distinct from old.amount_cents or new.approval_ref is distinct from old.approval_ref or new.authorized_by is distinct from old.authorized_by
       or (old.status = 'reserved' and (new.status is distinct from old.status or new.reservation_key is distinct from old.reservation_key or new.reserved_at is distinct from old.reserved_at)) then
      raise exception 'a spend authorization cannot be edited; a reserved one is final' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public._tw4f3a_committed(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce(sum(amount_cents), 0) from public.studio_sms_spend_events where legal_entity_id = p_entity and status in ('authorized', 'reserved'); $$;

create or replace function public.tw4_entity_create_for_studio(p_studio_id uuid, p_actor uuid, p_verification_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_id uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if exists (select 1 from public.studio_sms_entity_studios where studio_id = p_studio_id) then
    raise exception 'this studio already belongs to a legal entity' using errcode = '23505';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null or o.legal_name is null or o.ein_last4 is null or o.attested_at is null or o.state in ('draft', 'cancelled') then
    raise exception 'the studio has no submitted onboarding with a legal name and EIN' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps st where st.studio_id = p_studio_id) then
    raise exception 'the studio has registration steps from before subaccounts; start a fresh setup' using errcode = '22023';
  end if;
  begin
    insert into public.studio_sms_legal_entities (legal_name, ein_last4, created_by) values (o.legal_name, o.ein_last4, p_actor) returning id into v_id;
  exception when unique_violation then
    raise exception 'a legal entity with this name and EIN already exists: link this location to it instead of registering again' using errcode = '23505';
  end;
  insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, supporting_checks)
  values (p_studio_id, v_id, 'founding', p_actor, p_verification_note, jsonb_build_object('from_attested_onboarding', true));
  perform public._tw4f3a_audit(p_studio_id, p_actor, 'entity_created', 'entity=' || v_id);
  return jsonb_build_object('legal_entity_id', v_id);
end $$;

create or replace function public.tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  v_id uuid;
  v_studio uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id for update;
  if e.id is null or p_kind is null or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid authorization' using errcode = '22023';
  end if;
  if public._tw4f3a_committed(e.id) + p_amount_cents > e.spend_cap_cents then
    raise exception 'this authorization would exceed the spend cap' using errcode = 'TW004';
  end if;
  insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by)
  values (e.id, p_kind, p_amount_cents, p_approval_ref, p_actor) returning id into v_id;
  select studio_id into v_studio from public.studio_sms_entity_studios where legal_entity_id = e.id order by linked_at limit 1;
  perform public._tw4f3a_audit(v_studio, p_actor, 'spend_authorized', 'entity=' || e.id || ';kind=' || p_kind || ';cents=' || p_amount_cents);
  return jsonb_build_object('spend_event_id', v_id);
end $$;

create or replace function public.tw4_spend_reserve(p_onboarding_id uuid, p_lease_owner text, p_kind text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_key text;
  s public.studio_sms_spend_events;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  if v_entity is null then
    raise exception 'the studio has no legal entity' using errcode = 'TW004';
  end if;
  perform 1 from public.studio_sms_legal_entities where id = v_entity for update;
  v_key := o.id || ':' || o.submission_seq || ':' || p_kind;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key = v_key;
  if s.id is null then
    select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.kind = p_kind and x.status = 'authorized' order by x.authorized_at limit 1 for update;
    if s.id is null then
      raise exception 'no authorized spend for % within the cap', p_kind using errcode = 'TW004';
    end if;
    update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_key, reserved_at = now() where id = s.id;
    perform public._tw4f3a_audit(o.studio_id, null, 'spend_reserved', 'entity=' || v_entity || ';kind=' || p_kind || ';cents=' || s.amount_cents);
  end if;
  return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents);
end $$;

drop function public.tw4_credit_resolve_reservation(uuid, text, uuid, text), public.tw4_credit_open_reservations(uuid, uuid), public.tw4_spend_withdraw(uuid, uuid, text), public.tw4_credit_topup_failed(text, text),
  public.tw4_spend_settle(uuid, text, text, text, text), public.sms_credit_overview(uuid), public.sms_credit_history(uuid, int, bigint), public.sms_price_list(),
  public.tw4_price_set(text, int, int, text, uuid), public.tw4_credit_topup_pending(uuid, text, int), public.tw4_credit_settle_topup(uuid, text, int, text),
  public.tw4_credit_reverse_topup(text, int, text, text), public.tw4_credit_adjust(uuid, bigint, text, text, uuid), public.tw4_credit_set_hold(uuid, boolean, text, uuid),
  public.tw4_credit_set_threshold(uuid, int, uuid), public.tw4_credit_debit_usage(uuid, int, text, text), public.tw4_credit_refund_usage(uuid, int, text, text),
  public.tw4_credit_record_provider_charge(uuid, text, text, int, uuid), public.tw4_credit_verify(uuid);

drop function public._tw4c_require_funds(public.studio_sms_credit_accounts, bigint);
drop function public._tw4c_post(uuid, text, bigint, bigint, text, uuid, text, uuid, text), public._tw4c_lock(uuid);
drop table public.studio_sms_credit_ledger, public.studio_sms_credit_reservations, public.studio_sms_credit_topups, public.studio_sms_provider_charges,
  public.studio_sms_credit_accounts, public.studio_sms_price_list;


drop function public._tw4c_admin(uuid), public._tw4c_immutable_guard(), public._tw4c_truncate_guard();

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount'));

commit;
