-- Rollback of 20261230090000_twilio_rfl_pilot_spend_evidence.sql: restores tw4_spend_authorize (20261202 body, seven arguments), tw4_pilot_exception_create (20261122 body, four arguments) and
-- tw4_rfl_pilot_cover (20261229 body) EXACTLY (md5 re-checked), drops the evidence-carrying functions, the evidence table and its guard. REFUSES while any evidence row exists (permanent
-- evidence: dropping the table would lose it) and when a live body is not the one 20261230 created (a later migration must be rolled back first).
begin;
set local lock_timeout = '5s';
lock table public.studio_sms_pilot_spend_evidence in access exclusive mode;
do $$
begin
  if to_regclass('public.studio_sms_pilot_spend_evidence') is null or to_regprocedure('public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)') is null or to_regprocedure('public.tw4_pilot_exception_create(uuid,integer,text,uuid,date,text,text,integer,text,text)') is null then
    raise exception 'pilot-spend-evidence rollback precondition failed: the migration is not applied';
  end if;
  if to_regprocedure('public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid)') is not null or to_regprocedure('public.tw4_pilot_exception_create(uuid,integer,text,uuid)') is not null then
    raise exception 'pilot-spend-evidence rollback precondition failed: an old signature already exists';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'daee5a70b4c7fe97cc35e9f172ef78fb' then
    raise exception 'pilot-spend-evidence rollback precondition failed: public.tw4_spend_authorize (fourteen arguments) differs from its 20261230 definition; roll back the later migration first';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_pilot_exception_create(uuid,integer,text,uuid,date,text,text,integer,text,text)'::regprocedure), chr(13), '')) is distinct from '171b2d12a7476290b3e3efcdab71cef8' then
    raise exception 'pilot-spend-evidence rollback precondition failed: public.tw4_pilot_exception_create (ten arguments) differs from its 20261230 definition; roll back the later migration first';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'f5dffdaa3062febef97fa2ce9b0fa422' then
    raise exception 'pilot-spend-evidence rollback precondition failed: public.tw4_rfl_pilot_cover differs from its 20261230 definition; roll back the later migration first';
  end if;
  if exists (select 1 from public.studio_sms_pilot_spend_evidence) then
    raise exception 'pilot-spend-evidence rollback refused: approval evidence exists and is permanent';
  end if;
end $$;

drop function public.tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text);
drop function public.tw4_pilot_exception_create(uuid, int, text, uuid, date, text, text, int, text, text);
drop table public.studio_sms_pilot_spend_evidence;
drop function public._tw4pse_guard();

-- the 20261202 and 20261122 bodies, byte for byte
create or replace function public.tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid, p_funding text default 'credit', p_studio_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  p public.studio_sms_price_list;
  r public.studio_sms_approval_refs;
  s public.studio_sms_spend_events;
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
  -- the reference is permanent: an identical retry of a still-unused authorization returns it; anything else that reuses it is refused
  perform pg_advisory_xact_lock(hashtextextended('tw4fi_ref:' || public._tw4fi_ref_norm(p_approval_ref), 0));
  select * into r from public.studio_sms_approval_refs x where x.ref_norm = public._tw4fi_ref_norm(p_approval_ref);
  if r.ref_norm is not null then
    select * into s from public.studio_sms_spend_events x where x.id = r.spend_event_id;
    if r.source = 'spend_authorization' and s.id is not null and s.status = 'authorized' and s.legal_entity_id = e.id and s.kind = p_kind
       and s.amount_cents = p_amount_cents and s.funding = p_funding and s.studio_id is not distinct from p_studio_id and s.authorized_by = p_actor then
      return jsonb_build_object('spend_event_id', s.id, 'replayed', true);
    end if;
    raise exception 'this approval reference was already used: one written approval authorizes one operation, once' using errcode = 'TW019';
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
  values (e.id, p_kind, p_amount_cents, btrim(p_approval_ref), p_actor, p_funding, p_studio_id) returning id into v_id;
  perform public._tw4f3a_audit(public._tw4c_any_location(e.id), p_actor, 'spend_authorized', 'entity=' || e.id || ';kind=' || p_kind || ';cents=' || p_amount_cents || ';funding=' || p_funding);
  return jsonb_build_object('spend_event_id', v_id, 'replayed', false);
end $$;

create or replace function public.tw4_pilot_exception_create(p_entity_id uuid, p_ceiling_cents int, p_approval_ref text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  pe public.studio_sms_pilot_exceptions;
begin
  perform public._tw4c_admin(p_actor);
  select * into e from public.studio_sms_legal_entities y where y.id = p_entity_id for no key update;
  if e.id is null or e.legal_name_key <> public._tw4f3a_name_key('ConfiDance Unlimited, LLC') then
    raise exception 'the pilot exception exists only for the verified ConfiDance Unlimited, LLC legal business' using errcode = '22023';
  end if;
  if (select count(*) from public.studio_sms_legal_entities y where y.legal_name_key = e.legal_name_key) <> 1 then
    raise exception 'more than one legal business has this name: resolve the duplicate before creating the pilot exception' using errcode = '22023';
  end if;
  if e.spend_cap_cents > 15000 then
    raise exception 'lower the spend cap to at most $150 before creating the pilot exception' using errcode = '22023';
  end if;
  if p_ceiling_cents is null or p_ceiling_cents <= 0 or p_ceiling_cents > 15000 or p_ceiling_cents > e.spend_cap_cents then
    raise exception 'the pilot ceiling must be positive, within the entity spend cap and at most $150 cumulative' using errcode = '22023';
  end if;
  if p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10 then
    raise exception 'record the founder authorization (10+ characters)' using errcode = '22023';
  end if;
  select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = p_entity_id;
  if pe.legal_entity_id is not null then
    if pe.ceiling_cents <> p_ceiling_cents then
      raise exception 'the pilot exception already exists with another ceiling' using errcode = '23505';
    end if;
    return jsonb_build_object('ceiling_cents', pe.ceiling_cents, 'replayed', true);
  end if;
  insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values (p_entity_id, p_ceiling_cents, btrim(p_approval_ref), p_actor);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(p_entity_id), null, 'platform_admin', p_actor, 'credit_pilot_exception', left('ceiling_cents=' || p_ceiling_cents, 300));
  return jsonb_build_object('ceiling_cents', p_ceiling_cents, 'replayed', false);
end $$;

-- the 20261229 cover body, byte for byte
create or replace function public.tw4_rfl_pilot_cover(p_resource_id uuid, p_period_key text, p_approval_ref text, p_actor uuid, p_authorized_on date, p_authorized_by_role text, p_scope text,
  p_amount_cents int, p_evidence_period_key text, p_document_ref text, p_document_sha256 text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  pc public.studio_sms_provider_cover;
  ev public.studio_sms_provider_cover_evidence;
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
  v_today date := (now() at time zone 'UTC')::date;
begin
  perform public._tw4c_admin(p_actor);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null or p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_approval_ref is null then
    raise exception 'invalid pilot approval' using errcode = '22023';
  end if;
  -- 20261229: ONE reference length in every layer (10..200 characters, counted after trimming), refused here with a clear message before any state is touched
  if char_length(btrim(p_approval_ref)) < 10 or char_length(btrim(p_approval_ref)) > 200 then
    raise exception 'the written approval reference must be 10 to 200 characters' using errcode = '22023';
  end if;
  -- 20261229 (U-4): structured evidence of the owner's dated written authorization. The reference alone is not authorization. Nothing is recorded until every field is present and consistent.
  if p_authorized_on is null then
    raise exception 'pilot approval evidence: the date of the owner''s written authorization is required' using errcode = 'TW052';
  end if;
  -- not in the future (the UTC date: the pilot business is behind UTC, so its local date never exceeds it; a business ahead of UTC dates the authorization by the UTC date) and not older than 400 days
  if p_authorized_on > v_today then
    raise exception 'pilot approval evidence: the authorization date is in the future' using errcode = 'TW052';
  end if;
  if p_authorized_on < v_today - 400 then
    raise exception 'pilot approval evidence: the authorization is older than 400 days' using errcode = 'TW052';
  end if;
  if p_authorized_by_role is null or p_authorized_by_role not in ('founder_written', 'owner_written') then
    raise exception 'pilot approval evidence: the authorizing role must be founder_written or owner_written' using errcode = 'TW052';
  end if;
  if p_scope is null or p_scope <> 'pilot_period_cover' then
    raise exception 'pilot approval evidence: the scope must be pilot_period_cover' using errcode = 'TW052';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'pilot approval evidence: the authorized amount in cents is required' using errcode = 'TW052';
  end if;
  if p_evidence_period_key is null or p_evidence_period_key <> p_period_key then
    raise exception 'pilot approval evidence: the authorized period must equal the period being covered' using errcode = 'TW052';
  end if;
  if p_document_ref is null or char_length(p_document_ref) not between 6 and 500
     or not (p_document_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$' or p_document_ref ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$''()*+,:@/-]*)?$') then
    raise exception 'pilot approval evidence: the retained document needs an opaque id or a plain https link (no query string, fragment, credentials, percent-escapes, semicolons, ampersands or equals signs)' using errcode = 'TW052';
  end if;
  if p_document_sha256 is null or p_document_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'pilot approval evidence: the sha256 of the retained text must be 64 lowercase hex characters' using errcode = 'TW052';
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
      -- a replay must carry the SAME evidence; the same reference with different evidence is a different claim and is refused
      select * into ev from public.studio_sms_provider_cover_evidence x where x.cover_id = pc.id;
      if ev.id is not null and ev.authorized_on = p_authorized_on and ev.authorized_by_role = p_authorized_by_role and ev.scope = p_scope and ev.amount_cents = p_amount_cents
         and ev.document_ref = p_document_ref and ev.document_sha256 = p_document_sha256 then
        return jsonb_build_object('cover_id', pc.id, 'evidence_id', ev.id, 'replayed', true);
      end if;
      raise exception 'this approval reference was already recorded with different evidence' using errcode = 'TW019';
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
  -- the authorized amount IS the published price of the fee being covered: the evidence never states a different amount
  if p_amount_cents <> p.customer_price_cents then
    raise exception 'pilot approval evidence: the authorized amount must equal the published price' using errcode = 'TW008';
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
  -- the evidence is written WITH the cover (same transaction), by hash and reference only
  perform set_config('tw4.rflevid_write', 'on', true);
  insert into public.studio_sms_provider_cover_evidence (cover_id, resource_id, legal_entity_id, studio_id, period_key, authorized_on, authorized_by_role, scope, amount_cents, document_ref, document_sha256, recorded_by)
  values (pc.id, r.id, r.legal_entity_id, r.studio_id, p_period_key, p_authorized_on, p_authorized_by_role, p_scope, p_amount_cents, p_document_ref, p_document_sha256, p_actor) returning * into ev;
  perform set_config('tw4.rflevid_write', 'off', true);
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = 'covered_by_pilot_approval'
   where resource_id = r.id and period_key = p_period_key and state = 'open' and reason <> 'billed_after_cancellation';
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cover_recorded', 'resource=' || r.id || ';period=' || p_period_key || ';cents=' || p.customer_price_cents || ';evidence=' || ev.id
    || ';role=' || p_authorized_by_role || ';authorized_on=' || p_authorized_on || ';doc_sha=' || left(p_document_sha256, 12));
  return jsonb_build_object('cover_id', pc.id, 'evidence_id', ev.id, 'amount_cents', p.customer_price_cents, 'replayed', false);
end $$;

revoke all on function public.tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid) to service_role;
revoke all on function public.tw4_pilot_exception_create(uuid, int, text, uuid) from public, anon, authenticated;
grant execute on function public.tw4_pilot_exception_create(uuid, int, text, uuid) to service_role;

do $$
begin
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid)'::regprocedure), chr(13), '')) is distinct from '6a166997fafa89b0b6c6b0d7054c9a0b' then
    raise exception 'pilot-spend-evidence rollback failed: public.tw4_spend_authorize was not restored byte-exactly';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_pilot_exception_create(uuid,integer,text,uuid)'::regprocedure), chr(13), '')) is distinct from '9a26f8aa67f6d438748de2ce168106c1' then
    raise exception 'pilot-spend-evidence rollback failed: public.tw4_pilot_exception_create was not restored byte-exactly';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'deffc1b878778dced134334260d62512' then
    raise exception 'pilot-spend-evidence rollback failed: public.tw4_rfl_pilot_cover was not restored byte-exactly';
  end if;
end $$;

commit;
