-- 20261217090000_twilio_r2b_rfl_lifecycle_integration.sql
-- TW-4F: R2b / recurring-fee-lifecycle financial integration (dark; Git-only until separately authorized).
--   1. A provider-confirmed number is registered in the recurring-fee inventory IN THE SAME TRANSACTION as the ownership observation (tw4_num_observe), from the number
--      ledger's own rows. tw4_rfl_register keeps its administrator signature but, for a location the number ledger manages, accepts only the ledger's facts.
--      A registration that fails never discards the provider evidence: it is audited, alerted (inventory_gap, critical) and retryable (tw4_num_registration_retry).
--   2. tw4_recurring_charge holds number rent (never charges it) while the ledger's rent basis is indeterminate, absent or not registered in the lifecycle inventory.
--   3. A confirmed number cancellation retires the ledger's purchase in the same transaction; tw4_num_retire no longer releases an owned number on a note.
--   4. Lock order: location link, business row, credit account, onboarding row, ledger rows, lifecycle rows (tw4_num_observe previously inverted it).
-- Pilot ceiling, per-period written approvals, cover, grace and limits are untouched. Requires 20261208..20261214.
-- Rollback: rollback/20261217090000_twilio_r2b_rfl_lifecycle_integration_rollback.sql (restores the five replaced bodies byte-exactly).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_num_rent_basis(uuid)') is null or to_regprocedure('public._tw4num_rent_basis_core(uuid)') is null or to_regprocedure('public.tw4_rfl_register(uuid,uuid,text,text,text,text,text,uuid,uuid)') is null
     or to_regprocedure('public._tw4rfl_mark_cancelled(public.studio_sms_provider_resources,uuid,text,uuid,timestamptz)') is null or to_regprocedure('public.tw4_num_inventory_status(uuid,uuid)') is null
     or to_regprocedure('public.tw4_rfl_alerts_claim(integer)') is null or to_regprocedure('public._tw4num_health(uuid)') is null then
    raise exception 'lifecycle-integration precondition failed: 20261208 .. 20261214 are not all applied';
  end if;
  if to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is not null then
    raise exception 'lifecycle-integration precondition failed: already applied';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_recurring_charge(uuid,text,uuid)'::regprocedure), chr(13), '')), 8) <> '7b4c944b' then
    raise exception 'lifecycle-integration precondition failed: public.tw4_recurring_charge(uuid,text,uuid) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_mark_cancelled(public.studio_sms_provider_resources,uuid,text,uuid,timestamptz)'::regprocedure), chr(13), '')), 8) <> 'fbe51c14' then
    raise exception 'lifecycle-integration precondition failed: public._tw4rfl_mark_cancelled(public.studio_sms_provider_resources,uuid,text,uuid,timestamptz) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_register(uuid,uuid,text,text,text,text,text,uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '063014be' then
    raise exception 'lifecycle-integration precondition failed: public.tw4_rfl_register(uuid,uuid,text,text,text,text,text,uuid,uuid) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_observe(uuid,text,uuid,jsonb,text,text)'::regprocedure), chr(13), '')), 8) <> '5666c675' then
    raise exception 'lifecycle-integration precondition failed: public.tw4_num_observe(uuid,text,uuid,jsonb,text,text) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_retire(uuid,uuid,text)'::regprocedure), chr(13), '')), 8) <> 'b8bde38d' then
    raise exception 'lifecycle-integration precondition failed: public.tw4_num_retire(uuid,uuid,text) differs from its main definition';
  end if;
end $$;


-- does the number ledger manage this location (any purchase attempt or number selection)? A location it has never touched keeps today's behavior.
create or replace function public._tw4num_ledger_active(p_studio_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select exists (select 1 from public.studio_sms_num_operations o where o.studio_id = p_studio_id)
         or exists (select 1 from public.studio_sms_number_selections s where s.studio_id = p_studio_id); $$;

-- the pilot reservation that pays a purchase's first period ('prov:<operation>:number'), or null: credit businesses are covered by their standing authorization, a
-- released reservation pays nothing, and a purchase from an EARLIER month never pays the month it happens to be registered in (that month needs its own written approval)
create or replace function public._tw4num_ledger_reservation(p_op uuid)
returns uuid language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select cr.id from public.studio_sms_num_operations o join public.studio_sms_credit_reservations cr on cr.reservation_key = 'prov:' || o.id::text || ':number'
        where o.id = p_op and cr.funding = 'pilot' and cr.status in ('reserved', 'captured')
          and public._tw4ml_month_key(o.legal_entity_id, o.started_at) = public._tw4ml_month_key(o.legal_entity_id, clock_timestamp()); $$;

-- registers the location's provider-confirmed number from the LEDGER'S rows (never from caller-typed identifiers), as the system, under the caller's locks
create or replace function public._tw4num_register_owned(p_op uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  p public.studio_sms_num_operations;
begin
  select * into p from public.studio_sms_num_operations x where x.id = p_op and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
     and x.twilio_account_sid = public._tw4num_account(x.studio_id) and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'owned');
  if p.id is null then
    raise exception 'there is no live, provider-confirmed number purchase to register' using errcode = 'TW032';
  end if;
  return public._tw4rfl_register_core(p.studio_id, p.started_by, 'number', p.provider_sid, p.twilio_account_sid, p.e164, 'r2b', p.id, public._tw4num_ledger_reservation(p.id), true);
end $$;

-- Why number rent cannot be charged now (null = nothing blocks it). Reads the provider-confirmed basis and the lifecycle inventory; writes nothing.
create or replace function public._tw4num_rent_hold(p_studio_id uuid, p_entity uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  b jsonb;
  v_any boolean;
  v_live boolean;
begin
  if not public._tw4num_ledger_active(p_studio_id) then
    return null;
  end if;
  b := public._tw4num_rent_basis_core(p_studio_id);
  select exists (select 1 from public.studio_sms_provider_resources r where r.studio_id = p_studio_id and r.legal_entity_id = p_entity and r.resource_kind = 'number') into v_any;
  select exists (select 1 from public.studio_sms_provider_resources r where r.studio_id = p_studio_id and r.legal_entity_id = p_entity and r.resource_kind = 'number'
                  and r.provider_state = 'active' and r.provider_sid = b ->> 'phone_number_sid') into v_live;
  return case b ->> 'state'
    when 'indeterminate' then 'number rent held: ' || coalesce(b ->> 'reason', 'indeterminate')
    -- no purchase is live in the ledger: a registered (and since cancelled) number is judged per period by the lifecycle; otherwise there was nothing to rent
    when 'not_billable' then case when v_any then null else 'number rent held: no confirmed number purchase' end
    when 'billable' then case when v_live then null else 'number rent held: the owned number is not registered in the recurring-fee inventory' end
    else 'number rent held: unreadable rent basis' end;
end $$;

-- confirmed number cancellation -> the ledger's purchase and attachment are retired (same transaction as the lifecycle's evidence). Idempotent. The caller holds the
-- location link, the business row and the credit account, i.e. the OPPOSITE of the number runner's order (onboarding row first): this function therefore never WAITS for an
-- onboarding or ledger row. If a runner holds one, the retirement is deferred with a warning alert; rent stays held (the registry says cancelled, the ledger still says live)
-- and tw4_num_retire accepts the cancelled registry state as its evidence.
create or replace function public._tw4num_on_number_cancelled(p_studio_id uuid, p_provider_sid text, p_op uuid, p_actor uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_ops uuid[];
  v_live int;
  v_number text;
  v_from_state text;
  v_busy boolean := false;
begin
  select count(*) into v_live from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind in ('number_purchase', 'number_attach')
     and x.status = 'succeeded' and x.superseded_at is null and x.provider_sid = p_provider_sid;
  if v_live = 0 then
    return;
  end if;
  -- the retirement is ALL OR NOTHING and has the same guards as tw4_num_retire: the onboarding row must be lockable without waiting, no run may hold the lease, and no
  -- operation of the location may be in flight or unknown (it could still finish against the number being retired). Otherwise it is deferred, never half done.
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update skip locked;
  if o.id is null and exists (select 1 from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled') then
    v_busy := true;
  elsif o.id is not null and o.lease_owner is not null and o.lease_expires_at > now() then
    v_busy := true;
  elsif exists (select 1 from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null) then
    v_busy := true;
  else
    select array_agg(q.id), max(q.e164) into v_ops, v_number from (select x.id, x.e164 from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind in ('number_purchase', 'number_attach')
       and x.status = 'succeeded' and x.superseded_at is null and x.provider_sid = p_provider_sid for update skip locked) q;
    v_busy := coalesce(cardinality(v_ops), 0) < v_live;
  end if;
  if v_busy then
    perform public._tw4rfl_alert((select es.legal_entity_id from public.studio_sms_entity_studios es where es.studio_id = p_studio_id), p_studio_id, null, 'inventory_gap', 'cancel_ledger:' || p_op, 'admin', 'warning',
      'A phone number was cancelled at the provider while the number runner was working on this location: release its sender row, then retire it from the number ledger (tw4_num_retire). Rent stays held until then.');
    return;
  end if;
  update public.studio_sms_num_operations set superseded_at = clock_timestamp() where id = any (v_ops);
  if o.id is not null then
    perform public._tw4_r1_audit(o, p_actor, 'num_retired', o.state, o.state, 'number=' || v_number || ';cancelled through the recurring-fee lifecycle (operation ' || p_op || ')');
    if o.state in ('ready_for_activation', 'active', 'suspended') then
      v_from_state := o.state;
      update public.studio_sms_onboarding set state = 'exception', step = 'N9', last_error_code = 'num_retired', last_error_field = null where id = o.id returning * into o;
      perform public._tw4_r1_audit(o, p_actor, 'state_changed', v_from_state, 'exception', 'number cancelled at the provider');
    end if;
  end if;
end $$;

-- administrator retry of a registration that could not be made at observation: takes NO identifiers, only the location
create or replace function public.tw4_num_registration_retry(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_op uuid;
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4rfl_lock(public._tw4sr_lock(p_studio_id));
  select x.id into v_op from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null;
  if v_op is null then
    raise exception 'there is no live number purchase to register' using errcode = 'TW032';
  end if;
  return public._tw4num_register_owned(v_op);
end $$;

-- provider-confirmed numbers that the lifecycle inventory does not hold (their provider cost is exposed)
create or replace function public.tw4_num_registration_gaps(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object('studio_id', x.studio_id, 'operation_id', x.id, 'phone_number_sid', x.provider_sid, 'observed_at', nr.observed_at) order by nr.observed_at)
    from public.studio_sms_num_operations x join public.studio_sms_num_resources nr on nr.operation_id = x.id and nr.status = 'owned'
   where x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
     and not exists (select 1 from public.studio_sms_provider_resources r where r.provider_sid = x.provider_sid)), '[]'::jsonb);
end $$;

create or replace function public._tw4rfl_register_core(p_studio_id uuid, p_actor uuid, p_kind text, p_provider_sid text, p_account_sid text, p_e164 text, p_source text,
  p_source_operation uuid, p_initial_reservation uuid, p_system boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_active text;
  v_fee text;
  v_path jsonb;
  r public.studio_sms_provider_resources;
  v_res public.studio_sms_credit_reservations;
  v_key text;
begin
  if p_actor is null then
    raise exception 'a registration records who it was registered by' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('messaging_service', 'campaign', 'number') or p_source is null or p_source not in ('r2a', 'r2b', 'admin')
     or p_provider_sid is null or p_account_sid is null then
    raise exception 'invalid resource' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'the studio is not linked to a verified legal business' using errcode = 'TW010';
  end if;
  perform public._tw4rfl_lock(v_entity);
  select t.twilio_account_sid into v_active from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status = 'active';
  if v_active is null or v_active <> p_account_sid then
    raise exception 'the resource is not on the business''s active subaccount' using errcode = 'TW040';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.provider_sid = p_provider_sid;
  if r.id is not null then
    if r.legal_entity_id <> v_entity or r.studio_id <> p_studio_id or r.resource_kind <> p_kind or r.twilio_account_sid <> p_account_sid or r.e164 is distinct from p_e164 then
      raise exception 'this provider resource is already registered with different facts' using errcode = 'TW040';
    end if;
    return jsonb_build_object('resource_id', r.id, 'replayed', true);
  end if;
  if exists (select 1 from public.studio_sms_provider_resources x where x.studio_id = p_studio_id and x.resource_kind = p_kind and x.provider_state = 'active') then
    raise exception 'this location already has a live % registered: cancel it (with evidence) before registering a replacement', p_kind using errcode = 'TW040';
  end if;
  if p_kind = 'number' then
    v_fee := 'number';
    if p_e164 is null then
      raise exception 'a number is registered with its E.164' using errcode = '22023';
    end if;
  elsif p_kind = 'campaign' then
    v_path := public.tw4_location_fee_kinds(p_studio_id);
    v_fee := v_path ->> 'campaign_monthly_kind';
    if v_fee is null then
      raise exception 'the location''s registration path is not verified: the campaign''s monthly kind is unknown' using errcode = 'TW040';
    end if;
  else
    v_fee := null;
  end if;
  insert into public.studio_sms_provider_resources (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, source_operation_id, registered_by)
  values (v_entity, p_studio_id, p_account_sid, p_kind, p_provider_sid, p_e164, v_fee, p_source, p_source_operation, p_actor) returning * into r;
  if p_initial_reservation is not null then
    if v_fee is null then
      raise exception 'a free resource has no fee to cover' using errcode = '22023';
    end if;
    -- only the pilot business funds a registration period from a one-off reservation. Every other business's registration period is covered by its standing
    -- authorization (the first-month commitment, then the charge): a SECOND set-aside for the same month would be paid twice (the owner must hold the
    -- authorization BEFORE the resource is registered, as R2a already requires; R2b must not reserve a separate first-month fee for such a business)
    if not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity) then
      raise exception 'a business with standing authorizations is covered by them: no separate initial reservation' using errcode = 'TW040';
    end if;
    select * into v_res from public.studio_sms_credit_reservations x where x.id = p_initial_reservation for share;
    if v_res.id is null or v_res.legal_entity_id <> v_entity or v_res.studio_id <> p_studio_id or v_res.status not in ('reserved', 'captured')
       or v_res.kind <> v_fee or v_res.reservation_key ~ '^(rfl|rec|commit):' then
      raise exception 'the initial reservation does not belong to this resource''s fee' using errcode = 'TW040';
    end if;
    v_key := public._tw4ml_month_key(v_entity, r.registered_at);
    insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
    values (r.id, v_entity, p_studio_id, v_key, 'initial_reservation', v_res.id, p_actor);
  end if;
  perform public._tw4rfl_audit(p_studio_id, case when p_system then null else p_actor end, 'rfl_registered', 'resource=' || r.id || ';system=' || p_system || ';initiated_by=' || p_actor || ';kind=' || p_kind || ';fee=' || coalesce(v_fee, 'none') || ';initial_cover=' || (p_initial_reservation is not null));
  return jsonb_build_object('resource_id', r.id, 'fee_kind', v_fee, 'replayed', false);
end $$;

create or replace function public.tw4_rfl_register(p_studio_id uuid, p_actor uuid, p_kind text, p_provider_sid text, p_account_sid text, p_e164 text, p_source text,
  p_source_operation uuid, p_initial_reservation uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_facts jsonb;
begin
  perform public._tw4c_admin(p_actor);
  -- 20261217: a number of a location the number ledger manages is registered ONLY with the ledger's own provider-confirmed facts: the administrator can retry, never retype
  if p_kind = 'number' and public._tw4num_ledger_active(p_studio_id) then
    v_facts := public.tw4_num_registration_facts(p_studio_id);
    if v_facts ->> 'registrable' is distinct from 'true' or v_facts ->> 'provider_sid' is distinct from p_provider_sid or v_facts ->> 'account_sid' is distinct from p_account_sid
       or v_facts ->> 'e164' is distinct from p_e164 or p_source is distinct from 'r2b' or v_facts ->> 'source_operation' is distinct from p_source_operation::text
       or p_initial_reservation is distinct from public._tw4num_ledger_reservation(p_source_operation) then
      raise exception 'this location''s number is registered from the number ledger''s provider-confirmed facts only' using errcode = 'TW040';
    end if;
  end if;
  return public._tw4rfl_register_core(p_studio_id, p_actor, p_kind, p_provider_sid, p_account_sid, p_e164, p_source, p_source_operation, p_initial_reservation, false);
end $$;

create or replace function public._tw4rfl_mark_cancelled(r public.studio_sms_provider_resources, p_actor uuid, p_evidence text, p_op uuid, p_not_before timestamptz default null)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v_at timestamptz;
  v_month text;
  v_late int;
begin
  -- the provider removed it when the operation STARTED, not when someone got round to recording the evidence
  -- (an operation first abandoned on evidence that the resource was still PRESENT cannot be backdated to before that finding: p_not_before)
  select least(now(), greatest(r.registered_at, coalesce(o.started_at, now()), coalesce(p_not_before, '-infinity'::timestamptz))) into v_at from (select 1) q left join public.studio_sms_provider_cancel_ops o on o.id = p_op;
  v_month := public._tw4ml_month_key(r.legal_entity_id, v_at);
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = v_at, cancel_evidence_digest = p_evidence where id = r.id;
  -- accruing rows after the cancellation month with no bill evidence stop accruing; earlier uncovered periods are real provider cost and stay open for an
  -- administrator's disposition, as does any recorded provider bill
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = 'provider_resource_cancelled'
   where resource_id = r.id and state = 'open' and provider_billed_cents = 0 and period_key > v_month;
  -- any other operation still open on this resource is superseded by this one's evidence (it can never close otherwise)
  update public.studio_sms_provider_cancel_ops set status = case when status = 'authorized' then 'withdrawn' else 'abandoned' end, finished_at = now(), resolved_by = p_actor, resolved_at = now(),
         resolution_note = 'superseded: the resource was confirmed cancelled by operation ' || p_op
   where resource_id = r.id and id <> p_op and status in ('authorized', 'in_flight', 'unknown_outcome');
  perform set_config('tw4.rfl_write', 'off', true);
  -- charges taken for months after the cancellation month (while the outcome was open or unknown) are the administrators' to review and refund
  select count(*) into v_late from public.studio_sms_recurring_charges c
   where c.legal_entity_id = r.legal_entity_id and c.studio_id = r.studio_id and c.kind = any (public._tw4rfl_charge_kinds(r.fee_kind)) and c.status = 'charged' and c.period_key > v_month;
  if v_late > 0 then
    perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'charged_after_cancellation', 'late:' || r.id, 'admin', 'warning',
      'Recurring charges were taken for months after a provider resource was cancelled: review and refund them through the credit adjustment path.');
  end if;
  -- the owner's authorization for this fee stays until THEY revoke it; no further charge is taken for the retired resource
  if r.fee_kind is not null and exists (select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = r.legal_entity_id and a.studio_id = r.studio_id and a.status = 'active'
              and a.kind = any (public._tw4rfl_charge_kinds(r.fee_kind))) then
    perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'cancelled_authorization_active', 'cancelled:' || r.id, 'both', 'info',
      'A provider resource was cancelled. The recurring authorization for it stays until you revoke it, and no further charge will be taken for it.');
  end if;
  -- 20261217: a confirmed number cancellation retires the number ledger's purchase in the same transaction (idempotent), so rent and the replacement flow follow the evidence
  if r.resource_kind = 'number' then
    perform public._tw4num_on_number_cancelled(r.studio_id, r.provider_sid, p_op, p_actor);
  end if;
  -- DanceFlow must not keep sending through a resource Twilio no longer has
  select * into s from public.studio_sms_billed_senders x where x.studio_id = r.studio_id order by x.seq desc limit 1;
  if s.id is not null and s.status in ('approved', 'pending') and (s.phone_number_sid = r.provider_sid or s.campaign_sid = r.provider_sid or s.messaging_service_sid = r.provider_sid) then
    perform public.tw4_sender_revoke(r.studio_id, p_actor, 'provider resource cancelled (operation ' || p_op || ')', false);
  end if;
end $$;

create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_recurring_authorizations;
  acct public.studio_sms_credit_accounts;
  p public.studio_sms_price_list;
  c public.studio_sms_recurring_charges;
  cr public.studio_sms_credit_reservations;
  v_cur text;
  v_spent bigint;
  v_status text;
  v_reason text;
  v_res uuid;
  v_key text;
  v_hold text;
begin
  if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id;
  if a.id is null then
    raise exception 'unknown authorization' using errcode = '22023';
  end if;
  -- entity row first (the order tw4_spend_reserve / tw4_spend_authorize use), then the account row
  perform 1 from public.studio_sms_legal_entities le where le.id = a.legal_entity_id for no key update;
  acct := public._tw4c_lock(a.legal_entity_id);   -- the one lock every credit mutation takes: charges, top-ups, holds, limit changes and revocations are serialized
  -- a scheduler run is fenced by its lease and by the kill switch, checked AFTER the locks
  if p_run_id is not null and not exists (select 1 from public.studio_sms_recurring_runs r where r.id = p_run_id and r.status = 'running' and r.lease_expires_at > clock_timestamp()) then
    raise exception 'the scheduler run is not active' using errcode = '22023';
  end if;
  if p_run_id is not null and not coalesce((select l.enabled from public.studio_sms_recurring_switch_log l order by l.changed_at desc, l.id desc limit 1), false) then
    raise exception 'the scheduler is switched off' using errcode = '22023';
  end if;
  perform public._tw4ml_ensure_tz(a.legal_entity_id);
  v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
  -- only the current or the previous service month (in the business's timezone) can be charged: never the future, never ancient history
  if p_period_key <> v_cur and p_period_key <> public._tw4ml_key_add(v_cur, -1) then
    raise exception 'this period cannot be charged now' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id for update;
  select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = p_period_key for update;
  if c.id is not null and c.status = 'charged' then
    return jsonb_build_object('outcome', 'charged', 'replayed', true);
  end if;

  v_status := null;
  -- 20261217: number rent follows the number ledger's provider-confirmed basis (indeterminate, unregistered or unconfirmed rent is held, never charged)
  v_hold := case when a.kind = 'number' then public._tw4num_rent_hold(a.studio_id, a.legal_entity_id) end;
  select coalesce(sum(x.amount_cents), 0) into v_spent from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.status = 'charged';
  select * into p from public.studio_sms_price_list x where x.kind = a.kind and x.active;
  -- the first month's set-aside funds, if still held, are what this charge captures (no second reservation); they are already counted in the month they were set aside in, so capturing them needs no new room
  if a.commitment_reservation_id is not null then
    select * into cr from public.studio_sms_credit_reservations x where x.id = a.commitment_reservation_id for update;
    if cr.id is not null and cr.status = 'reserved' then
    else
      cr := null;
    end if;
  end if;
  if a.status <> 'active' then
    v_status := 'refused'; v_reason := 'revoked';
  elsif a.expires_at <= now() or public._tw4ml_month_start(a.legal_entity_id, p_period_key) >= a.expires_at or p_period_key < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) then
    v_status := 'refused'; v_reason := 'outside the authorized term';
  elsif p.id is null or p.customer_price_cents <> a.price_cents then
    v_status := 'refused'; v_reason := 'price changed: the owner must authorize again';
  elsif exists (select 1 from public.studio_sms_provider_cancel_ops co join public.studio_sms_provider_resources cr2 on cr2.id = co.resource_id
                 where co.studio_id = a.studio_id and co.legal_entity_id = a.legal_entity_id and co.status in ('authorized', 'in_flight', 'unknown_outcome')
                   and cr2.fee_kind = any (public._tw4rfl_charge_kinds(a.kind))) then
    v_status := 'held'; v_reason := 'a cancellation of this location''s provider resource is open';   -- 20261209: retried once it is resolved; nothing is taken for a resource being removed
  elsif public._tw4rfl_retired(a.legal_entity_id, a.studio_id, public._tw4rfl_charge_kinds(a.kind), p_period_key) then
    v_status := 'held'; v_reason := 'no provider resource of this fee was live in that period: nothing left to charge for';   -- 20261209: never charge for a retired resource; held (not refused) so a later replacement is charged
  elsif exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id) then
    v_status := 'refused'; v_reason := 'pilot business: each recurring operation needs its own approval';   -- the pilot ceiling is never consumed by a schedule
  elsif v_hold is not null then
    v_status := 'held'; v_reason := v_hold;   -- 20261217: retried by the scheduler once the basis is confirmed; nothing is captured meanwhile
  elsif exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = p_period_key and x.status = 'charged' and x.authorization_id <> a.id) then
    v_status := 'refused'; v_reason := 'this period was already charged under another authorization';   -- revoke + authorize again never charges one period twice
  elsif v_spent + a.price_cents > a.total_limit_cents then
    v_status := 'refused'; v_reason := 'authorized spending limit reached';
  -- owner decision (PR 248): an authorized recurring fee is checked against the month's spending WITHOUT inbound texts, so inbound volume (which can
  -- never be refused) cannot hold the business's phone number or messaging service; inbound still counts for everything else
  elsif cr.id is null and public._tw4in_spend_without_inbound(a.legal_entity_id, v_cur) + a.price_cents > public._tw4ml_effective_limit(a.legal_entity_id, v_cur) then
    v_status := 'held'; v_reason := 'monthly spending limit reached';   -- retried: next month, or when the owner raises the limit
  elsif acct.hold then
    v_status := 'held'; v_reason := 'the credit account is on hold';
  elsif (cr.id is null and (acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < a.price_cents))
     or (cr.id is not null and (acct.balance_cents < 0 or acct.balance_cents < cr.amount_cents)) then
    v_status := 'unfunded'; v_reason := 'insufficient settled credit';   -- settled credit only: a refunded or reversed top-up can leave a set-aside with nothing behind it; there is no fallback funding of any kind
  end if;

  if v_status is not null then
    if c.id is null then
      insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason, run_id)
      values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, v_status, v_reason, p_run_id);
    else
      update public.studio_sms_recurring_charges set status = v_status, reason = v_reason, attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
    end if;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (a.studio_id, null, 'system', null, 'recurring_' || v_status, left('authorization=' || a.id || ';period=' || p_period_key || ';' || v_reason, 300));
    return jsonb_build_object('outcome', v_status, 'reason', v_reason, 'replayed', false);
  end if;

  if cr.id is not null then
    -- capture the funds that were set aside when the owner authorized
    v_res := cr.id;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -cr.amount_cents, -cr.amount_cents, 'capture:' || cr.reservation_key, cr.id, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = cr.id;
  else
    -- funded and within the authorization: reserve and capture in one transaction (no reservation is ever left open by a charge)
    v_key := 'rec:' || a.id || ':' || p_period_key;
    insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
    values (a.legal_entity_id, a.studio_id, a.kind, a.price_cents, 'credit', v_key) returning id into v_res;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'reserve', 0, a.price_cents, 'reserve:' || v_key, v_res, 'recurring=' || a.id, null, null);
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -a.price_cents, -a.price_cents, 'capture:' || v_key, v_res, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = v_res;
  end if;
  if c.id is null then
    insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, charged_at, run_id)
    values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, 'charged', v_res, clock_timestamp(), p_run_id);
  else
    update public.studio_sms_recurring_charges set status = 'charged', reason = null, reservation_id = v_res, charged_at = clock_timestamp(), attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'system', null, 'recurring_charged', left('authorization=' || a.id || ';period=' || p_period_key || ';cents=' || a.price_cents, 300));
  return jsonb_build_object('outcome', 'charged', 'replayed', false, 'amount_cents', a.price_cents);
end $$;

create or replace function public.tw4_num_observe(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_num_operations;
  v_purchase public.studio_sms_num_operations;
  v_ms public.studio_sms_prov_operations;
  v_prev public.studio_sms_num_resources;
  v_status text;
  v_code text := null;
  v_kind text;
  v_from_state text;
  v_sender public.studio_sms_billed_senders;
  v_reg_error text := null;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or pg_column_size(p_facts) > 8192 then
    raise exception 'invalid observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null or r.status <> 'succeeded' or r.superseded_at is not null then
    raise exception 'only a live, succeeded operation can be observed' using errcode = '22023';
  end if;
  select * into v_prev from public.studio_sms_num_resources x where x.operation_id = r.id;

  if r.op_kind = 'number_purchase' then
    v_kind := 'number';
    if (p_facts ->> 'sid') is distinct from r.provider_sid then
      v_status := 'mismatch'; v_code := 'sid_mismatch';
    elsif (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
      v_status := 'mismatch'; v_code := 'account_mismatch';
    elsif (p_facts ->> 'phone_number') is distinct from r.e164 then
      v_status := 'mismatch'; v_code := 'number_mismatch';
    elsif (p_facts ->> 'sms_capable') is distinct from 'true' then
      v_status := 'mismatch'; v_code := 'not_sms_capable';
    else
      v_status := 'owned';
    end if;
  else
    v_kind := 'service_number';
    v_ms := public._tw4num_service(r.studio_id);
    select * into v_purchase from public.studio_sms_num_operations x where x.studio_id = r.studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null;
    if v_ms.id is null or v_purchase.id is null or v_purchase.provider_sid is distinct from r.provider_sid then
      v_status := 'mismatch'; v_code := 'ledger_mismatch';
    elsif (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
      v_status := 'mismatch'; v_code := 'account_mismatch';
    elsif (p_facts ->> 'service_sid') is distinct from v_ms.provider_sid then
      v_status := 'mismatch'; v_code := 'service_mismatch';
    elsif jsonb_typeof(p_facts -> 'number_sids') is distinct from 'array' or not (p_facts -> 'number_sids') ? r.provider_sid then
      v_status := 'mismatch'; v_code := 'number_not_in_service';
    else
      v_status := 'attached';
    end if;
  end if;

  if v_prev.id is null then
    insert into public.studio_sms_num_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, messaging_service_sid, status, mismatch_code,
                                                source, evidence_digest, verified_at)
    values (r.id, r.legal_entity_id, r.studio_id, r.twilio_account_sid, v_kind, r.provider_sid, r.e164, case when v_kind = 'service_number' then v_ms.provider_sid end, v_status, v_code,
            p_source, p_digest, case when v_status <> 'mismatch' then clock_timestamp() end);
  else
    update public.studio_sms_num_resources set status = v_status, mismatch_code = v_code, source = p_source, evidence_digest = p_digest, observed_at = clock_timestamp(),
      messaging_service_sid = coalesce(case when v_kind = 'service_number' then v_ms.provider_sid end, messaging_service_sid),
      verified_at = case when v_status <> 'mismatch' then coalesce(verified_at, clock_timestamp()) else null end
    where id = v_prev.id;
  end if;

  -- the fee follows provider evidence: captured once a provider read of THIS account confirms the number is owned
  if r.op_kind = 'number_purchase' and v_status = 'owned' then
    perform public._tw4num_settle_if_held(r.id, 'captured', r.provider_sid);
    -- 20261217: the number is registered in the recurring-fee inventory in THIS transaction, from the ledger's own provider-confirmed facts (the caller names nothing).
    -- A registration that cannot be made never discards the provider's evidence: the observation stays, the failure is audited and alerted, rent stays held and the
    -- location stays unready until tw4_num_registration_retry succeeds. Lock and serialization failures are not business refusals and propagate.
    begin
      perform public._tw4num_register_owned(r.id);
    exception when others then
      -- only the registration's own business refusals are recorded; anything else (a missing function, a privilege, a serialization or lock failure, a bug) aborts the observation
      if SQLSTATE not in ('TW010', 'TW032', 'TW040', '22023', '23505', '23514') then
        raise;
      end if;
      v_reg_error := SQLSTATE || ':' || left(SQLERRM, 80);
      perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, null, 'inventory_gap', 'unregistered:' || r.id, 'admin', 'critical',
        'A phone number is owned at the provider but could not be registered in the recurring-fee inventory. Provider cost is exposed: retry the registration from the number ledger.');
    end;
  end if;
  if v_status = 'mismatch' and public._sms_onb_transition_allowed(o.state, 'exception') then
    v_from_state := o.state;
    -- a location that was ready, active or suspended stops sending at once: the sender is revoked (the exception state alone would not stop PR #249 readiness)
    perform public._tw4sr_lock(r.studio_id);
    v_sender := public._tw4sr_latest(r.studio_id);
    if v_sender.id is not null and v_sender.status in ('pending', 'approved') then
      perform public._tw4sr_append(v_sender, 'revoked', null, 'number read-back mismatch', null);
      perform public._tw4sr_audit(r.studio_id, null, 'sender_revoked', 'sender=' || v_sender.id || ';number read-back mismatch');
    end if;
    update public.studio_sms_onboarding set state = 'exception', step = 'N9', last_error_code = 'num_mismatch', last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, null, 'state_changed', v_from_state, 'exception', 'number read-back mismatch');
  elsif v_status = 'owned' and o.state = 'campaign_pending' then
    update public.studio_sms_onboarding set step = 'N2', last_error_code = null where id = o.id returning * into o;
  elsif v_status = 'attached' and o.state = 'campaign_pending' then
    update public.studio_sms_onboarding set step = 'N3', last_error_code = null where id = o.id returning * into o;
  end if;
  perform public._tw4_r1_audit(o, null, 'num_observed', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';status=' || v_status || coalesce(';code=' || v_code, '') || ';src=' || p_source || coalesce(';registration_failed=' || v_reg_error, ''));
  return jsonb_build_object('status', v_status, 'code', v_code, 'state', o.state);
end $$;

create or replace function public.tw4_num_retire(p_studio_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_purchase public.studio_sms_num_operations;
  v_latest public.studio_sms_billed_senders;
  v_from_state text;
  v_rfl_state text;
  v_entity uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a written reason that confirms the number was released at the provider (10-300 characters) is required' using errcode = '22023';
  end if;
  -- the lock order every lifecycle function uses: location link, then the legal business, then (below) the onboarding and ledger rows
  -- 20261217: onboarding row first (the order the number runner's functions take), then the location link and the business row
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  v_entity := public._tw4sr_lock(p_studio_id);
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for no key update;
  if o.id is null then
    raise exception 'there is no onboarding' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null) then
    raise exception 'resolve the unknown outcome first' using errcode = 'TW034';
  end if;
  select * into v_purchase from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null for update;
  if v_purchase.id is null then
    raise exception 'there is no live number purchase to retire' using errcode = '22023';
  end if;
  v_latest := public._tw4sr_latest(p_studio_id);
  if v_latest.id is not null and v_latest.status <> 'released' and v_latest.phone_number_sid = v_purchase.provider_sid then
    raise exception 'release the sender row first (tw4_sender_revoke with release)' using errcode = 'TW022';
  end if;
  -- the recurring provider-fee lifecycle holds the cancellation evidence: while it still lists this number as live at the provider, the ledger does not retire it
  if to_regclass('public.studio_sms_provider_resources') is not null then
    execute format('select r.provider_state from public.studio_sms_provider_resources r where r.provider_sid = %L', v_purchase.provider_sid) into v_rfl_state;
    -- registered and not cancelled: refused. Not registered at all but ever an approved sender: also refused (register it and cancel it with evidence; a ledger retire must not hide a number
    -- the lifecycle never saw)
    if (v_rfl_state is not null and v_rfl_state <> 'cancelled')
       or (v_rfl_state is null and exists (select 1 from public.studio_sms_billed_senders s where s.studio_id = p_studio_id and s.phone_number_sid = v_purchase.provider_sid and s.status = 'approved')) then
      raise exception 'cancel this number through the recurring-fee lifecycle (with evidence) before retiring it' using errcode = 'TW034';
    end if;
  end if;
  -- 20261217: an unregistered number is retired only when the PROVIDER's own read contradicted ownership; an owned (or never confirmed) number is exposure: register it
  -- from the ledger and cancel it through the lifecycle, with evidence. An administrator's sentence alone never releases it.
  if v_rfl_state is null and not exists (select 1 from public.studio_sms_num_resources nr where nr.operation_id = v_purchase.id and nr.status = 'mismatch' and nr.mismatch_code in ('sid_mismatch', 'account_mismatch')) then
    raise exception 'register this number from the ledger and cancel it through the recurring-fee lifecycle: a note alone does not retire it' using errcode = 'TW034';
  end if;
  v_from_state := o.state;
  update public.studio_sms_num_operations set superseded_at = clock_timestamp() where studio_id = p_studio_id and op_kind in ('number_purchase', 'number_attach') and status = 'succeeded' and superseded_at is null;
  perform public._tw4_r1_audit(o, p_actor, 'num_retired', o.state, o.state, 'op=' || v_purchase.id || ';number=' || v_purchase.e164 || ';' || left(btrim(p_note), 150));
  -- a location that was ready, active or suspended cannot take the number steps again from there: it goes back through exception (tw4_num_reopen returns it to the number step)
  if o.state in ('ready_for_activation', 'active', 'suspended') then
    update public.studio_sms_onboarding set state = 'exception', step = 'N9', last_error_code = 'num_retired', last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, p_actor, 'state_changed', v_from_state, 'exception', 'number retired');
  end if;
  return jsonb_build_object('retired', v_purchase.provider_sid);
end $$;

revoke all on function public._tw4rfl_register_core(uuid, uuid, text, text, text, text, text, uuid, uuid, boolean), public._tw4num_ledger_active(uuid), public._tw4num_ledger_reservation(uuid),
  public._tw4num_register_owned(uuid), public._tw4num_rent_hold(uuid, uuid), public._tw4num_on_number_cancelled(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.tw4_num_registration_retry(uuid, uuid), public.tw4_num_registration_gaps(uuid) from public, anon, authenticated, service_role;
grant execute on function public.tw4_num_registration_retry(uuid, uuid), public.tw4_num_registration_gaps(uuid) to service_role;

commit;
