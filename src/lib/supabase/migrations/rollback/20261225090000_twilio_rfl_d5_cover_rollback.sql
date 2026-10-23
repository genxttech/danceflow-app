-- Rollback of 20261225090000_twilio_rfl_d5_cover.sql: restores the four replaced bodies exactly as on main (20261211 guard, 20261209 cover and pilot_cover, 20261217
-- register_core), then removes the supersede columns and restores the 20261209 period uniqueness constraint. REFUSES while any superseded cover exists: that is permanent
-- evidence and dropping it would lose it (and restoring the constraint could not hold both rows). Registrations made without cover while live stay valid rows.
begin;
set local lock_timeout = '5s';
do $$
begin
  if not exists (select 1 from pg_attribute a where a.attrelid = 'public.studio_sms_provider_cover'::regclass and a.attname = 'superseded_at' and not a.attisdropped) then
    raise exception 'd5-cover rollback precondition failed: the migration is not applied';
  end if;
  if exists (select 1 from public.studio_sms_provider_cover where superseded_at is not null) then
    raise exception 'd5-cover rollback refused: superseded cover evidence exists and is permanent';
  end if;
  if position('20261225' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_guard()'::regprocedure)) = 0
     or position('20261225' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_cover(public.studio_sms_provider_resources,text)'::regprocedure)) = 0
     or position('20261225' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)'::regprocedure)) = 0
     or position('20261225' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid)'::regprocedure)) = 0 then
    raise exception 'd5-cover rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)';
  end if;
end $$;

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
    raise exception 'studio_sms_provider_cover: cover records are permanent' using errcode = '42501';
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
              where pc.resource_id = r.id and pc.period_key = p_key and cr.status in ('reserved', 'captured')) then
    return 'covered:' || (select pc.basis from public.studio_sms_provider_cover pc where pc.resource_id = r.id and pc.period_key = p_key);
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
  select * into pc from public.studio_sms_provider_cover x where x.resource_id = r.id and x.period_key = p_period_key;
  if pc.id is not null then
    if pc.basis = 'pilot_approval' and pc.approval_ref = btrim(p_approval_ref) and pc.recorded_by = p_actor then
      return jsonb_build_object('cover_id', pc.id, 'replayed', true);
    end if;
    raise exception 'this period is already covered' using errcode = 'TW043';
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
  insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, spend_event_id, approval_ref, recorded_by)
  values (r.id, r.legal_entity_id, r.studio_id, p_period_key, 'pilot_approval', v_res, v_spend, btrim(p_approval_ref), p_actor) returning * into pc;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = 'covered_by_pilot_approval'
   where resource_id = r.id and period_key = p_period_key and state = 'open' and reason <> 'billed_after_cancellation';
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cover_recorded', 'resource=' || r.id || ';period=' || p_period_key || ';cents=' || p.customer_price_cents);
  return jsonb_build_object('cover_id', pc.id, 'amount_cents', p.customer_price_cents, 'replayed', false);
end $$;

drop index public.studio_sms_provider_cover_period_live;
alter table public.studio_sms_provider_cover add constraint studio_sms_provider_cover_period unique (resource_id, period_key);
alter table public.studio_sms_provider_cover drop constraint studio_sms_provider_cover_superseded_shape;
alter table public.studio_sms_provider_cover drop column superseded_by_cover_id, drop column superseded_reason, drop column superseded_by, drop column superseded_at;

do $$
begin
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_guard()'::regprocedure), chr(13), '')) is distinct from 'db1928a789c9a24fb07a9ad6a6732567' then
    raise exception 'd5-cover rollback failed: public._tw4rfl_guard() was not restored byte-exactly';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_cover(public.studio_sms_provider_resources,text)'::regprocedure), chr(13), '')) is distinct from 'db542ea12ce833285da512e6e7966faa' then
    raise exception 'd5-cover rollback failed: public._tw4rfl_cover(public.studio_sms_provider_resources,text) was not restored byte-exactly';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)'::regprocedure), chr(13), '')) is distinct from 'feefceac32fef820221db3356ab9c9af' then
    raise exception 'd5-cover rollback failed: public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean) was not restored byte-exactly';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid)'::regprocedure), chr(13), '')) is distinct from '7f2a5d2b1ff748d3b916e60229999278' then
    raise exception 'd5-cover rollback failed: public.tw4_rfl_pilot_cover(uuid,text,text,uuid) was not restored byte-exactly';
  end if;
end $$;

commit;
