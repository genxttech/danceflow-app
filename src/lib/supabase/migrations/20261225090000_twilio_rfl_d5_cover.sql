-- 20261225090000_twilio_rfl_d5_cover.sql
-- TW-4F RFL decision D5 (Git-only until separately authorized; dark): a resource's own pilot reservation counts as the REGISTRATION period's cover only while it is
-- reserved/captured AND was made in the registration month. Otherwise the resource registers with NO cover and the period needs its own written approval.
--   1. _tw4rfl_register_core: a reservation from another month no longer binds a cover (the resource still registers; an audit row says the binding was skipped).
--   2. tw4_rfl_pilot_cover: a written approval may SUPERSEDE an initial_reservation cover that no longer counts (month mismatch or released reservation). The old row is
--      kept and marked (superseded_at/by/reason/by_cover_id); a counting cover or a pilot_approval cover is never superseded (TW043). Ceiling, hold, window,
--      single-use reference, admin-only, tw4.rfl_write and lock order are unchanged.
--   3. _tw4rfl_cover (and so readiness, gate, scan, reports) counts only a live (not superseded), counting cover: the same predicate F1 uses (_tw4act_pilot_funding).
--   4. _tw4rfl_guard (the 20261211 body): the only cover UPDATE allowed is the supersede mark, under tw4.rfl_write.
--   5. Additive schema: four nullable supersede columns, an all-or-none check, and the one-cover-per-period uniqueness now applies to live (not superseded) rows.
-- Requires 20261209..20261217. Rollback: rollback/20261225090000_twilio_rfl_d5_cover_rollback.sql (refuses while any superseded evidence exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is null or to_regprocedure('public.tw4_rfl_pilot_cover(uuid,text,text,uuid)') is null
     or to_regprocedure('public._tw4rfl_cover(public.studio_sms_provider_resources,text)') is null or to_regprocedure('public._tw4rfl_guard()') is null
     or to_regclass('public.studio_sms_provider_cover') is null then
    raise exception 'd5-cover precondition failed: 20261209 .. 20261217 are not all applied';
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.studio_sms_provider_cover'::regclass and a.attname = 'superseded_at' and not a.attisdropped) then
    raise exception 'd5-cover precondition failed: already applied';
  end if;
  if not exists (select 1 from pg_constraint k where k.conrelid = 'public.studio_sms_provider_cover'::regclass and k.conname = 'studio_sms_provider_cover_period' and k.contype = 'u') then
    raise exception 'd5-cover precondition failed: the period uniqueness constraint is missing';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_guard()'::regprocedure), chr(13), '')) is distinct from 'db1928a789c9a24fb07a9ad6a6732567' then
    raise exception 'd5-cover precondition failed: public._tw4rfl_guard() differs from its main definition';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_cover(public.studio_sms_provider_resources,text)'::regprocedure), chr(13), '')) is distinct from 'db542ea12ce833285da512e6e7966faa' then
    raise exception 'd5-cover precondition failed: public._tw4rfl_cover(public.studio_sms_provider_resources,text) differs from its main definition';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)'::regprocedure), chr(13), '')) is distinct from 'feefceac32fef820221db3356ab9c9af' then
    raise exception 'd5-cover precondition failed: public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean) differs from its main definition';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid)'::regprocedure), chr(13), '')) is distinct from '7f2a5d2b1ff748d3b916e60229999278' then
    raise exception 'd5-cover precondition failed: public.tw4_rfl_pilot_cover(uuid,text,text,uuid) differs from its main definition';
  end if;
end $$;

-- audit vocabulary: the live list plus the two D5 actions (extended, not replaced; a rollback leaves the two actions allowed, because audit rows may already use them)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text';
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['rfl_cover_superseded', 'rfl_initial_cover_skipped']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- additive supersede evidence (a superseded cover is history, never deleted)
alter table public.studio_sms_provider_cover
  add column superseded_at timestamptz null,
  add column superseded_by uuid null,
  add column superseded_reason text null check (superseded_reason in ('reservation_month_differs', 'reservation_not_counting')),
  add column superseded_by_cover_id uuid null,
  add constraint studio_sms_provider_cover_superseded_shape check ((superseded_at is null) = (superseded_by is null and superseded_reason is null and superseded_by_cover_id is null)
    and (superseded_at is null or basis = 'initial_reservation'));
-- one LIVE cover per resource period (the old row keeps its reservation uniqueness)
alter table public.studio_sms_provider_cover drop constraint studio_sms_provider_cover_period;
create unique index studio_sms_provider_cover_period_live on public.studio_sms_provider_cover (resource_id, period_key) where superseded_at is null;

create or replace function public._tw4rfl_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%: lifecycle evidence is never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_provider_resources' then
    if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.twilio_account_sid is distinct from old.twilio_account_sid or new.resource_kind is distinct from old.resource_kind or new.provider_sid is distinct from old.provider_sid
       or new.e164 is distinct from old.e164 or new.fee_kind is distinct from old.fee_kind or new.source is distinct from old.source
       or new.source_operation_id is distinct from old.source_operation_id or new.registered_by is distinct from old.registered_by or new.registered_at is distinct from old.registered_at then
      raise exception 'studio_sms_provider_resources: the identity of a resource is fixed' using errcode = '42501';
    end if;
    if old.provider_state = 'cancelled' and new is distinct from old then
      raise exception 'studio_sms_provider_resources: a cancelled resource is final' using errcode = '42501';
    end if;
    if new.provider_state is distinct from old.provider_state and coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_resources: the provider state changes only through the cancellation functions' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_provider_cover' then
    -- 20261225: cover records are still permanent; the ONE allowed change is the supersede mark on an initial_reservation cover that no longer counts (D5), made by
    -- tw4_rfl_pilot_cover under tw4.rfl_write, setting the supersede evidence once and changing nothing else
    if not (coalesce(current_setting('tw4.rfl_write', true), '') = 'on' and old.superseded_at is null and new.superseded_at is not null and old.basis = 'initial_reservation'
            and new.superseded_by is not null and new.superseded_reason is not null and new.superseded_by_cover_id is not null
            and (to_jsonb(new) - 'superseded_at' - 'superseded_by' - 'superseded_reason' - 'superseded_by_cover_id')
                = (to_jsonb(old) - 'superseded_at' - 'superseded_by' - 'superseded_reason' - 'superseded_by_cover_id')) then
      raise exception 'studio_sms_provider_cover: cover records are permanent' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_provider_exposure' then
    if new.id is distinct from old.id or new.resource_id is distinct from old.resource_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.period_key is distinct from old.period_key or new.first_detected_at is distinct from old.first_detected_at
       or new.provider_billed_cents < old.provider_billed_cents or coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_exposure: identity is fixed, billed evidence never decreases, rows change only through the lifecycle functions' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_provider_cancel_ops' then
    if new.id is distinct from old.id or new.resource_id is distinct from old.resource_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.decided_by is distinct from old.decided_by or new.approval_ref is distinct from old.approval_ref
       or new.ref_norm is distinct from old.ref_norm or new.reason is distinct from old.reason or new.irreversible_ack is distinct from old.irreversible_ack
       or new.authorized_by is distinct from old.authorized_by or new.authorized_at is distinct from old.authorized_at or coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_cancel_ops: the decision is fixed' using errcode = '42501';
    end if;
    if (old.status in ('confirmed', 'refused', 'withdrawn') or (old.status = 'abandoned' and new.status <> 'confirmed')) and new.status is distinct from old.status then
      raise exception 'studio_sms_provider_cancel_ops: % is final', old.status using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'authorized' and new.status in ('in_flight', 'withdrawn')) or (old.status = 'in_flight' and new.status in ('confirmed', 'refused', 'unknown_outcome'))
         or (old.status = 'unknown_outcome' and new.status in ('confirmed', 'abandoned')) or (old.status = 'in_flight' and new.status = 'abandoned')
         or (old.status = 'abandoned' and new.status = 'confirmed')) then
      raise exception 'studio_sms_provider_cancel_ops: % -> % is not a legal transition', old.status, new.status using errcode = '42501';
    end if;
  else
    -- alerts: identity and text are fixed; only the delivery fields move
    if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.resource_id is distinct from old.resource_id or new.kind is distinct from old.kind or new.dedupe_key is distinct from old.dedupe_key
       or new.audience is distinct from old.audience or new.severity is distinct from old.severity or new.summary is distinct from old.summary
       or new.created_at is distinct from old.created_at or (new.attempts < old.attempts and not (coalesce(current_setting('tw4.rflops_write', true), '') = 'on' and old.status = 'sending' and new.status = 'pending' and new.attempts = old.attempts - 1)) or (old.status = 'delivered' and new is distinct from old) then
      raise exception 'studio_sms_provider_alerts: only delivery fields change, and a delivered alert is final' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public._tw4rfl_cover(r public.studio_sms_provider_resources, p_key text)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_kinds text[] := public._tw4rfl_charge_kinds(r.fee_kind);
  v_start timestamptz;
  v_repl boolean;
  a public.studio_sms_recurring_authorizations;
  c public.studio_sms_recurring_charges;
begin
  if r.fee_kind is null then
    return 'covered:free';
  end if;
  v_start := public._tw4ml_month_start(r.legal_entity_id, p_key);
  -- a charge pays ONE resource's period: a replacement registered after its predecessor was cancelled inside the same period is a second bill Twilio sends
  v_repl := public._tw4rfl_replacement(r, p_key);
  if not v_repl and exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds)
              and x.period_key = p_key and x.status = 'charged') then
    return 'covered:charge';
  end if;
  if exists (select 1 from public.studio_sms_provider_cover pc join public.studio_sms_credit_reservations cr on cr.id = pc.reservation_id
              where pc.resource_id = r.id and pc.period_key = p_key and pc.superseded_at is null and cr.status in ('reserved', 'captured')
                -- 20261225 (D5): a registration-time reservation covers only the month its money was set aside in; an approval's own reservation is for its period
                and (pc.basis = 'pilot_approval' or public._tw4ml_month_key(r.legal_entity_id, cr.created_at) = pc.period_key)) then
    return 'covered:' || (select pc.basis from public.studio_sms_provider_cover pc where pc.resource_id = r.id and pc.period_key = p_key and pc.superseded_at is null);
  end if;
  -- the authorization's first month is set aside from settled credit when the owner authorizes (the commitment), until the scheduler's charge takes its place
  if exists (select 1 from public.studio_sms_recurring_authorizations x join public.studio_sms_credit_reservations cr on cr.id = x.commitment_reservation_id
              where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds) and x.status = 'active' and x.expires_at > now()
                and cr.status = 'reserved' and public._tw4ml_month_key(r.legal_entity_id, x.starts_at) = p_key
                and not exists (select 1 from public.studio_sms_recurring_charges ch where ch.authorization_id = x.id and ch.period_key = p_key and ch.status <> 'charged')
                and not v_repl) then
    return 'covered:commitment';
  end if;
  if exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = r.legal_entity_id) then
    return 'uncovered:no_pilot_approval';   -- the pilot business has no standing authorization: every period needs its own written approval
  end if;
  if v_repl then
    return 'uncovered:replacement_unfunded';   -- the predecessor's charge paid the predecessor; the owner never authorized a second fee for this period
  end if;
  select * into a from public.studio_sms_recurring_authorizations x
   where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds) and x.status = 'active' and x.expires_at > now()
   order by x.created_at desc limit 1;
  if a.id is not null then
    if a.expires_at <= v_start then
      return 'uncovered:authorization_expired';
    end if;
    if a.starts_at >= public._tw4ml_month_start(r.legal_entity_id, public._tw4ml_key_add(p_key, 1)) then
      return 'uncovered:not_authorized_period';
    end if;
    select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = p_key;
    if c.id is null then
      return 'uncovered:awaiting_charge';
    end if;
    return 'uncovered:' || case c.status when 'unfunded' then 'charge_unfunded' when 'held' then 'charge_held' when 'refused' then 'charge_refused' else 'awaiting_charge' end;
  end if;
  if exists (select 1 from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds)
              and x.status = 'revoked') and not exists (select 1 from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id
              and x.studio_id = r.studio_id and x.kind = any (v_kinds) and x.status = 'active') then
    return 'uncovered:authorization_revoked';
  end if;
  if exists (select 1 from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds)) then
    return 'uncovered:authorization_expired';
  end if;
  return 'uncovered:no_authorization';
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
  v_bound boolean := false;
  v_skipped boolean := false;
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
    -- 20261225 (D5): the reservation covers the registration period only when it was made in the registration month. A reservation from another month registers the
    -- resource WITHOUT cover (refusing would leave a provider resource out of the inventory); that period then needs its own written approval (tw4_rfl_pilot_cover).
    if public._tw4ml_month_key(v_entity, v_res.created_at) = v_key then
      insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
      values (r.id, v_entity, p_studio_id, v_key, 'initial_reservation', v_res.id, p_actor);
      v_bound := true;
    else
      v_skipped := true;
    end if;
  end if;
  perform public._tw4rfl_audit(p_studio_id, case when p_system then null else p_actor end, 'rfl_registered', 'resource=' || r.id || ';system=' || p_system || ';initiated_by=' || p_actor || ';kind=' || p_kind || ';fee=' || coalesce(v_fee, 'none') || ';initial_cover=' || v_bound);
  if v_skipped then
    perform public._tw4rfl_audit(p_studio_id, case when p_system then null else p_actor end, 'rfl_initial_cover_skipped', 'resource=' || r.id || ';period=' || v_key || ';reason=reservation_month_differs_from_registration_month;reservation=' || v_res.id);
  end if;
  return jsonb_build_object('resource_id', r.id, 'fee_kind', v_fee, 'replayed', false) || case when v_skipped then jsonb_build_object('initial_cover_skipped', 'month_mismatch') else '{}'::jsonb end;
end $$;

create or replace function public.tw4_rfl_pilot_cover(p_resource_id uuid, p_period_key text, p_approval_ref text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  pc public.studio_sms_provider_cover;
  a public.studio_sms_credit_accounts;
  pe public.studio_sms_pilot_exceptions;
  p public.studio_sms_price_list;
  v_cur text;
  v_spend uuid;
  v_res uuid;
  v_used bigint;
  v_rkey text;
  v_old public.studio_sms_provider_cover;
  v_new uuid := gen_random_uuid();
  v_sup boolean := false;
begin
  perform public._tw4c_admin(p_actor);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null or p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_approval_ref is null then
    raise exception 'invalid pilot approval' using errcode = '22023';
  end if;
  a := public._tw4rfl_lock(r.legal_entity_id);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id for update;
  if r.provider_state <> 'active' or r.fee_kind is null then
    raise exception 'only a live recurring-fee resource needs a period approval' using errcode = 'TW041';
  end if;
  select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = r.legal_entity_id;
  if pe.legal_entity_id is null then
    raise exception 'period approvals are for the pilot business; every other business authorizes recurring charges itself' using errcode = 'TW042';
  end if;
  v_cur := public._tw4ml_month_key(r.legal_entity_id, now());
  if p_period_key < v_cur or p_period_key > public._tw4ml_key_add(v_cur, 1) then
    raise exception 'a period approval covers the current or the next service period only' using errcode = 'TW042';
  end if;
  select * into pc from public.studio_sms_provider_cover x where x.resource_id = r.id and x.period_key = p_period_key and x.superseded_at is null;
  if pc.id is not null then
    if pc.basis = 'pilot_approval' and pc.approval_ref = btrim(p_approval_ref) and pc.recorded_by = p_actor then
      return jsonb_build_object('cover_id', pc.id, 'replayed', true);
    end if;
    -- 20261225 (D5): ONLY a registration-time (initial_reservation) cover that no longer counts may be superseded by a written approval: its reservation was released,
    -- or it was made in another month than the registration month. A cover that counts, or any approval, is never superseded.
    if pc.basis = 'initial_reservation' and not exists (
         select 1 from public.studio_sms_credit_reservations cr where cr.id = pc.reservation_id and cr.status in ('reserved', 'captured')
            and public._tw4ml_month_key(r.legal_entity_id, cr.created_at) = pc.period_key) then
      v_old := pc;
      v_sup := true;
    else
      raise exception 'this period is already covered' using errcode = 'TW043';
    end if;
  end if;
  if a.hold or a.balance_cents < 0 then
    raise exception 'the pilot exception cannot fund this period while the account is on hold or negative' using errcode = 'TW007';
  end if;
  select * into p from public.studio_sms_price_list x where x.kind = r.fee_kind and x.active;
  if p.id is null then
    raise exception 'no published price for %', r.fee_kind using errcode = 'TW008';
  end if;
  select coalesce(sum(cr.amount_cents), 0) into v_used from public.studio_sms_credit_reservations cr where cr.legal_entity_id = r.legal_entity_id and cr.funding = 'pilot' and cr.status in ('reserved', 'captured');
  if v_used + p.customer_price_cents > pe.ceiling_cents then
    raise exception 'the pilot ceiling would be exceeded' using errcode = 'TW007';
  end if;
  -- the permanent, location-attributed approval (replay-safe, price-checked, cap-checked, one written approval = one operation)
  v_spend := (public.tw4_spend_authorize(r.legal_entity_id, r.fee_kind, p.customer_price_cents, p_approval_ref, p_actor, 'pilot', r.studio_id) ->> 'spend_event_id')::uuid;
  v_rkey := 'rfl:' || r.id || ':' || p_period_key;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (r.legal_entity_id, r.studio_id, r.fee_kind, p.customer_price_cents, 'pilot', v_rkey) returning id into v_res;
  update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_rkey, reserved_at = now(), credit_reservation_id = v_res where id = v_spend;
  update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = v_res;   -- a recurring period fee is committed once approved
  if v_sup then
    -- the old row and its history stay (never deleted); it only stops being the period's live cover
    perform set_config('tw4.rfl_write', 'on', true);
    update public.studio_sms_provider_cover set superseded_at = clock_timestamp(), superseded_by = p_actor, superseded_by_cover_id = v_new,
           superseded_reason = case when exists (select 1 from public.studio_sms_credit_reservations cr where cr.id = v_old.reservation_id and cr.status in ('reserved', 'captured'))
                                    then 'reservation_month_differs' else 'reservation_not_counting' end
     where id = v_old.id and superseded_at is null;
    perform set_config('tw4.rfl_write', 'off', true);
    perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cover_superseded', 'resource=' || r.id || ';period=' || p_period_key || ';old_cover=' || v_old.id || ';new_cover=' || v_new);
  end if;
  insert into public.studio_sms_provider_cover (id, resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, spend_event_id, approval_ref, recorded_by)
  values (v_new, r.id, r.legal_entity_id, r.studio_id, p_period_key, 'pilot_approval', v_res, v_spend, btrim(p_approval_ref), p_actor) returning * into pc;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = 'covered_by_pilot_approval'
   where resource_id = r.id and period_key = p_period_key and state = 'open' and reason <> 'billed_after_cancellation';
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cover_recorded', 'resource=' || r.id || ';period=' || p_period_key || ';cents=' || p.customer_price_cents);
  return jsonb_build_object('cover_id', pc.id, 'amount_cents', p.customer_price_cents, 'replayed', false);
end $$;

commit;
