-- Rollback of 20261229090000_twilio_rfl_pilot_evidence.sql: restores the 20261225 four-argument tw4_rfl_pilot_cover EXACTLY (fingerprint-checked), drops the eleven-argument
-- function, the evidence table and its guard, and narrows the spend-events approval_ref check back to 3..120. REFUSES while any evidence row exists (permanent evidence: dropping the
-- table would lose it) and while any approval reference longer than 120 characters exists (the restored check could not hold it). Roll back the migrations that depend on the
-- evidence signature (none in this repo) first.
begin;
set local lock_timeout = '5s';
-- nothing is recorded between the refusal checks and the restore
lock table public.studio_sms_provider_cover_evidence in access exclusive mode;
lock table public.studio_sms_spend_events in share row exclusive mode;
do $$
declare
  v_old text;
begin
  if to_regclass('public.studio_sms_provider_cover_evidence') is null
     or to_regprocedure('public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)') is null then
    raise exception 'pilot-evidence rollback precondition failed: the migration is not applied';
  end if;
  if to_regprocedure('public.tw4_rfl_pilot_cover(uuid,text,text,uuid)') is not null then
    raise exception 'pilot-evidence rollback precondition failed: the four-argument signature already exists';
  end if;
  -- the live eleven-argument body must be exactly the one 20261229 created (a later migration that redefined it must be rolled back first)
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'deffc1b878778dced134334260d62512' then
    raise exception 'pilot-evidence rollback precondition failed: public.tw4_rfl_pilot_cover (eleven arguments) differs from its 20261229 definition; roll back the later migration first';
  end if;
  if exists (select 1 from public.studio_sms_provider_cover_evidence) then
    raise exception 'pilot-evidence rollback refused: approval evidence exists and is permanent';
  end if;
  if exists (select 1 from public.studio_sms_spend_events where char_length(btrim(approval_ref)) > 120) then
    raise exception 'pilot-evidence rollback refused: an approval reference longer than 120 characters exists';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.studio_sms_spend_events'::regclass and c.conname = 'studio_sms_spend_events_approval_ref_len') then
    raise exception 'pilot-evidence rollback precondition failed: the widened approval_ref check is missing';
  end if;
end $$;

drop function public.tw4_rfl_pilot_cover(uuid, text, text, uuid, date, text, text, int, text, text, text);
drop table public.studio_sms_provider_cover_evidence;
drop function public._tw4rfl_evid_guard();

alter table public.studio_sms_spend_events add constraint studio_sms_spend_events_approval_ref_check check (char_length(btrim(approval_ref)) between 3 and 120);
alter table public.studio_sms_spend_events drop constraint studio_sms_spend_events_approval_ref_len;

-- the 20261225 body, byte for byte
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
    -- it was not a pilot reservation of this business, location and fee, or it was made in another month than the registration month. A cover that counts, or any approval, is never superseded.
    if pc.basis = 'initial_reservation' and not exists (
         select 1 from public.studio_sms_credit_reservations cr where cr.id = pc.reservation_id and cr.status in ('reserved', 'captured')
            and cr.legal_entity_id = r.legal_entity_id and cr.studio_id = r.studio_id and cr.funding = 'pilot' and cr.kind = r.fee_kind
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
           superseded_reason = case when not exists (select 1 from public.studio_sms_credit_reservations cr where cr.id = v_old.reservation_id and cr.status in ('reserved', 'captured'))
                                    then 'reservation_not_counting'
                                    when not exists (select 1 from public.studio_sms_credit_reservations cr where cr.id = v_old.reservation_id and cr.legal_entity_id = r.legal_entity_id
                                                      and cr.studio_id = r.studio_id and cr.funding = 'pilot' and cr.kind = r.fee_kind)
                                    then 'reservation_not_pilot_funded' else 'reservation_month_differs' end
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

revoke all on function public.tw4_rfl_pilot_cover(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.tw4_rfl_pilot_cover(uuid, text, text, uuid) to service_role;

do $$
begin
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid)'::regprocedure), chr(13), '')) is distinct from '00e9bff4d2ce4e0cca135317216541fb' then
    raise exception 'pilot-evidence rollback failed: public.tw4_rfl_pilot_cover(uuid,text,text,uuid) was not restored byte-exactly';
  end if;
end $$;

commit;
