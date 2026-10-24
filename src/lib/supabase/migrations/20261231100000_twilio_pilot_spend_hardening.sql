-- 20261231100000_twilio_pilot_spend_hardening.sql
-- TW-4F Blocker 9: pilot spend approval hardening (tracker 0.1; Git-only until separately authorized; dark; SQL only, the application needs no change: every public signature is unchanged).
--   1230 (#316) made every pilot spend approval carry structured written-authorization evidence, but (a) a direct tw4_spend_authorize call could still use the pilot_period_cover scope with ANY
--   period, and (b) nothing proved at COMMIT that every pilot-funded spend event and every pilot exception has its evidence.
--   1. tw4_spend_authorize (public, 14 arguments, unchanged signature, service_role only) becomes a thin wrapper: it REFUSES the pilot_period_cover scope (TW053, case and space insensitive)
--      and delegates to the new internal function public._tw4psh_spend_authorize (the 1230 body plus items 2 and 4), revoked from public, anon, authenticated AND service_role. Only
--      security-definer functions owned by the migration owner can call it: tw4_spend_authorize and tw4_rfl_pilot_cover (redefined: the 1230 body calling the internal function).
--      No session setting, flag or argument selects the privileged path (a GUC would be spoofable); the privilege IS the function's ACL.
--   2. The internal function accepts a period cover only for the current or the next billing month of the business, in the business's timezone (_tw4ml_month_key / _tw4ml_key_add), else TW052.
--   3. Two DEFERRABLE INITIALLY DEFERRED constraint triggers, ENABLE ALWAYS (they fire under session_replication_role = replica too; the table owner alone can disable them):
--      studio_sms_spend_events: every pilot-funded row inserted or changed (funding, business, kind, amount, location, approver) must have, at COMMIT, its studio_sms_pilot_spend_evidence row with
--        the same business, location, kind, amount and approver and a scope that allows the kind; a pilot_period_cover event must also have the 1229 cover (basis pilot_approval, this event) and its
--        studio_sms_provider_cover_evidence row carrying the SAME date, role, scope, amount, period, document and hash.
--      studio_sms_pilot_exceptions: every pilot exception inserted or changed must have, at commit, its exception evidence row with an amount at least the ceiling and the same approver
--        (a ceiling may be LOWERED, never raised above what was authorized in writing).
--   4. One retained document authorizes one approval, once: a document id (case-insensitive) or sha256 already recorded in the spend or cover evidence is refused (TW019) and the spend evidence
--      table gets unique indexes on both. An identical replay still returns before the check.
--   5. Apply safeguards: requires 20261230 applied; md5 of the three 1230 bodies (tw4_spend_authorize daee5a70.., tw4_pilot_exception_create 171b2d12.., tw4_rfl_pilot_cover f5dffdaa..; CRLF
--      normalized like the hosted manifest) and refuses if any pilot-funded spend event (any status) or any pilot exception lacks evidence, if any recorded period cover lacks its cover evidence,
--      or if a document id / hash is already recorded twice. The 1230 apply-order gate is untouched (apply 1230 before the first pilot action).
--   tw4_pilot_exception_create (171b2d12..) is NOT redefined. Rollback: rollback/20261231100000_twilio_pilot_spend_hardening_rollback.sql (1230 bodies restored byte for byte; refuses if any
--   body was redefined since or any pilot evidence was recorded after this migration was applied). 20261230's own rollback refuses while this migration is applied (its body md5 check): roll this one back FIRST.
-- Requires 20261230. NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

-- nothing is authorized between the precheck below and the end of this migration
lock table public.studio_sms_spend_events in share row exclusive mode;
lock table public.studio_sms_pilot_exceptions in share row exclusive mode;
lock table public.studio_sms_pilot_spend_evidence in share row exclusive mode;
lock table public.studio_sms_provider_cover_evidence in share row exclusive mode;

do $$
begin
  if to_regclass('public.studio_sms_pilot_spend_evidence') is null or to_regclass('public.studio_sms_provider_cover_evidence') is null or to_regclass('public.studio_sms_provider_cover') is null
     or to_regprocedure('public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)') is null or to_regprocedure('public.tw4_pilot_exception_create(uuid,integer,text,uuid,date,text,text,integer,text,text)') is null
     or to_regprocedure('public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)') is null or to_regprocedure('public._tw4pse_guard()') is null
     or to_regprocedure('public._tw4ml_month_key(uuid,timestamp with time zone)') is null or to_regprocedure('public._tw4ml_key_add(text,integer)') is null then
    raise exception 'pilot-spend-hardening precondition failed: 20261230 is not applied';
  end if;
  if to_regprocedure('public._tw4psh_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)') is not null or to_regprocedure('public._tw4psh_event_evidence_check()') is not null
     or to_regprocedure('public._tw4psh_exception_evidence_check()') is not null then
    raise exception 'pilot-spend-hardening precondition failed: already applied';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'daee5a70b4c7fe97cc35e9f172ef78fb' then
    raise exception 'pilot-spend-hardening precondition failed: public.tw4_spend_authorize (fourteen arguments) differs from its 20261230 definition';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_pilot_exception_create(uuid,integer,text,uuid,date,text,text,integer,text,text)'::regprocedure), chr(13), '')) is distinct from '171b2d12a7476290b3e3efcdab71cef8' then
    raise exception 'pilot-spend-hardening precondition failed: public.tw4_pilot_exception_create differs from its 20261230 definition';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'f5dffdaa3062febef97fa2ce9b0fa422' then
    raise exception 'pilot-spend-hardening precondition failed: public.tw4_rfl_pilot_cover differs from its 20261230 definition';
  end if;
  -- nothing pilot-funded may exist without its evidence (any status: history is not grandfathered silently; hosted DEV and PROD hold none)
  if exists (select 1 from public.studio_sms_spend_events se where se.funding = 'pilot' and not exists (select 1 from public.studio_sms_pilot_spend_evidence ev where ev.spend_event_id = se.id)) then
    raise exception 'pilot-spend-hardening precondition failed: a pilot-funded spend approval without evidence exists';
  end if;
  if exists (select 1 from public.studio_sms_pilot_exceptions pe where not exists (select 1 from public.studio_sms_pilot_spend_evidence ev where ev.subject = 'pilot_exception' and ev.legal_entity_id = pe.legal_entity_id
                                                                                   and ev.amount_cents >= pe.ceiling_cents and ev.recorded_by = pe.approved_by)) then
    raise exception 'pilot-spend-hardening precondition failed: a pilot exception without matching evidence exists';
  end if;
  if exists (select 1 from public.studio_sms_pilot_spend_evidence ev where ev.scope = 'pilot_period_cover' and not exists (
        select 1 from public.studio_sms_provider_cover c join public.studio_sms_provider_cover_evidence ce on ce.cover_id = c.id
         where c.spend_event_id = ev.spend_event_id and ce.document_sha256 = ev.document_sha256 and ce.period_key = ev.period_key and ce.amount_cents = ev.amount_cents)) then
    raise exception 'pilot-spend-hardening precondition failed: a period-cover approval without its cover evidence exists';
  end if;
  if exists (select 1 from public.studio_sms_pilot_spend_evidence group by lower(document_ref) having count(*) > 1)
     or exists (select 1 from public.studio_sms_pilot_spend_evidence group by document_sha256 having count(*) > 1) then
    raise exception 'pilot-spend-hardening precondition failed: a retained document id or hash is recorded for more than one approval';
  end if;
end $$;

-- one retained document, one approval (the function check gives the clear message; the indexes are the backstop)
create unique index studio_sms_pilot_spend_evidence_doc_sha on public.studio_sms_pilot_spend_evidence (document_sha256);
create unique index studio_sms_pilot_spend_evidence_doc_ref on public.studio_sms_pilot_spend_evidence (lower(document_ref));

-- the internal function: the 1230 body plus the period window and the document-reuse check. Reachable ONLY by owner-run security-definer functions (ACL below).
create or replace function public._tw4psh_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid, p_funding text default 'credit', p_studio_id uuid default null,
  p_evidence_authorized_on date default null, p_evidence_role text default null, p_evidence_scope text default null, p_evidence_amount_cents int default null,
  p_evidence_period_key text default null, p_evidence_document_ref text default null, p_evidence_sha256 text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  p public.studio_sms_price_list;
  r public.studio_sms_approval_refs;
  s public.studio_sms_spend_events;
  ev public.studio_sms_pilot_spend_evidence;
  v_id uuid;
  v_cur text;
  v_today date := (now() at time zone 'UTC')::date;
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
  -- 20261230 (U-4): a pilot-funded approval needs the owner's dated written authorization as structured evidence; a credit-funded one takes none. Nothing is recorded until every field is consistent.
  if p_funding = 'credit' then
    if p_evidence_authorized_on is not null or p_evidence_role is not null or p_evidence_scope is not null or p_evidence_amount_cents is not null or p_evidence_period_key is not null
       or p_evidence_document_ref is not null or p_evidence_sha256 is not null then
      raise exception 'pilot approval evidence: a credit-funded authorization takes no pilot evidence' using errcode = 'TW052';
    end if;
  else
    if p_evidence_authorized_on is null then
      raise exception 'pilot approval evidence: the date of the owner''s written authorization is required' using errcode = 'TW052';
    end if;
    if p_evidence_authorized_on > v_today then
      raise exception 'pilot approval evidence: the authorization date is in the future' using errcode = 'TW052';
    end if;
    if p_evidence_authorized_on < v_today - 400 then
      raise exception 'pilot approval evidence: the authorization is older than 400 days' using errcode = 'TW052';
    end if;
    if p_evidence_role is null or p_evidence_role not in ('founder_written', 'owner_written') then
      raise exception 'pilot approval evidence: the authorizing role must be founder_written or owner_written' using errcode = 'TW052';
    end if;
    -- the scope must be one of the four spend scopes AND allow this fee kind: the map is exhaustive, a kind outside it is refused (fail closed, never defaulted)
    if p_evidence_scope is null or not (case p_evidence_scope
         when 'pilot_onboarding_fee' then p_kind in ('brand', 'brand_low_volume')
         when 'pilot_campaign_fee' then p_kind in ('campaign_vetting', 'monthly', 'monthly_low_volume')
         when 'pilot_number_purchase' then p_kind = 'number'
         when 'pilot_period_cover' then p_kind in ('number', 'monthly', 'monthly_low_volume')
         else false end) then
      raise exception 'pilot approval evidence: the scope is missing, unknown or does not allow this fee' using errcode = 'TW052';
    end if;
    if p_evidence_amount_cents is null or p_evidence_amount_cents <> p_amount_cents then
      raise exception 'pilot approval evidence: the authorized amount must equal the amount being approved' using errcode = 'TW052';
    end if;
    if (p_evidence_scope = 'pilot_period_cover') <> (p_evidence_period_key is not null) or (p_evidence_period_key is not null and p_evidence_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$') then
      raise exception 'pilot approval evidence: a period cover names its period (YYYY-MM) and no other scope does' using errcode = 'TW052';
    end if;
    -- 20261231100000: a period cover is accepted only for the current or the next billing month of THIS business (its timezone), never for any other YYYY-MM
    if p_evidence_scope = 'pilot_period_cover' then
      v_cur := public._tw4ml_month_key(e.id, now());
      if p_evidence_period_key < v_cur or p_evidence_period_key > public._tw4ml_key_add(v_cur, 1) then
        raise exception 'pilot approval evidence: a period cover is accepted for the current or the next billing month only' using errcode = 'TW052';
      end if;
    end if;
    if p_evidence_document_ref is null or char_length(p_evidence_document_ref) not between 6 and 500
       or not (p_evidence_document_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/#+-]{5,119}$' or p_evidence_document_ref ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~!$''()*+,:@/-]*)?$') then
      raise exception 'pilot approval evidence: the retained document needs an opaque id or a plain https link (no query string, fragment, credentials, percent-escapes, semicolons, ampersands or equals signs)' using errcode = 'TW052';
    end if;
    if p_evidence_sha256 is null or p_evidence_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception 'pilot approval evidence: the sha256 of the retained text must be 64 lowercase hex characters' using errcode = 'TW052';
    end if;
  end if;
  -- the reference is permanent: an identical retry of a still-unused authorization returns it; anything else that reuses it is refused
  perform pg_advisory_xact_lock(hashtextextended('tw4fi_ref:' || public._tw4fi_ref_norm(p_approval_ref), 0));
  select * into r from public.studio_sms_approval_refs x where x.ref_norm = public._tw4fi_ref_norm(p_approval_ref);
  if r.ref_norm is not null then
    select * into s from public.studio_sms_spend_events x where x.id = r.spend_event_id;
    if r.source = 'spend_authorization' and s.id is not null and s.status = 'authorized' and s.legal_entity_id = e.id and s.kind = p_kind
       and s.amount_cents = p_amount_cents and s.funding = p_funding and s.studio_id is not distinct from p_studio_id and s.authorized_by = p_actor then
      if p_funding = 'pilot' then
        -- a replay must carry the SAME evidence; the same reference with different evidence is a different claim and is refused
        select * into ev from public.studio_sms_pilot_spend_evidence x where x.spend_event_id = s.id;
        if ev.id is null or ev.authorized_on <> p_evidence_authorized_on or ev.authorized_by_role <> p_evidence_role or ev.scope <> p_evidence_scope or ev.amount_cents <> p_evidence_amount_cents
           or ev.period_key is distinct from p_evidence_period_key or ev.document_ref <> p_evidence_document_ref or ev.document_sha256 <> p_evidence_sha256 then
          raise exception 'this approval reference was already recorded with different evidence' using errcode = 'TW019';
        end if;
      end if;
      return jsonb_build_object('spend_event_id', s.id, 'replayed', true);
    end if;
    raise exception 'this approval reference was already used: one written approval authorizes one operation, once' using errcode = 'TW019';
  end if;
  -- 20261231100000: one retained document authorizes one approval, once. A document id or sha256 already recorded (spend or period-cover evidence) is never reused. A replay returned above.
  if p_funding = 'pilot' and (exists (select 1 from public.studio_sms_pilot_spend_evidence x where x.document_sha256 = p_evidence_sha256 or lower(x.document_ref) = lower(p_evidence_document_ref))
     or exists (select 1 from public.studio_sms_provider_cover_evidence x where x.document_sha256 = p_evidence_sha256 or lower(x.document_ref) = lower(p_evidence_document_ref))) then
    raise exception 'pilot approval evidence: this retained document was already used for another approval' using errcode = 'TW019';
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
  if p_funding = 'pilot' then
    -- the evidence is written WITH the approval (same transaction), by hash and reference only
    perform set_config('tw4.pilotev_write', 'on', true);
    insert into public.studio_sms_pilot_spend_evidence (subject, spend_event_id, legal_entity_id, studio_id, fee_kind, scope, period_key, authorized_on, authorized_by_role, amount_cents, document_ref, document_sha256, recorded_by)
    values ('spend_event', v_id, e.id, p_studio_id, p_kind, p_evidence_scope, p_evidence_period_key, p_evidence_authorized_on, p_evidence_role, p_amount_cents, p_evidence_document_ref, p_evidence_sha256, p_actor)
    returning * into ev;
    perform set_config('tw4.pilotev_write', 'off', true);
  end if;
  perform public._tw4f3a_audit(public._tw4c_any_location(e.id), p_actor, 'spend_authorized', 'entity=' || e.id || ';kind=' || p_kind || ';cents=' || p_amount_cents || ';funding=' || p_funding
    || case when p_funding = 'pilot' then ';evidence=' || ev.id || ';scope=' || p_evidence_scope || ';role=' || p_evidence_role || ';doc_sha=' || left(p_evidence_sha256, 12) else '' end);
  return jsonb_build_object('spend_event_id', v_id, 'replayed', false);
end $$;

create or replace function public.tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid, p_funding text default 'credit', p_studio_id uuid default null,
  p_evidence_authorized_on date default null, p_evidence_role text default null, p_evidence_scope text default null, p_evidence_amount_cents int default null,
  p_evidence_period_key text default null, p_evidence_document_ref text default null, p_evidence_sha256 text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- 20261231100000 (Blocker 9): the public function can never record a period-cover approval; only tw4_rfl_pilot_cover (security definer, same owner) reaches the internal function
  -- that accepts that scope, together with its own evidence row. Nothing here is a flag or a setting a caller could set.
  if p_evidence_scope is not null and lower(btrim(p_evidence_scope)) = 'pilot_period_cover' then
    raise exception 'pilot approval evidence: a period cover is recorded only by tw4_rfl_pilot_cover' using errcode = 'TW053';
  end if;
  return public._tw4psh_spend_authorize(p_entity_id, p_kind, p_amount_cents, p_approval_ref, p_actor, p_funding, p_studio_id,
    p_evidence_authorized_on, p_evidence_role, p_evidence_scope, p_evidence_amount_cents, p_evidence_period_key, p_evidence_document_ref, p_evidence_sha256);
end $$;

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
  v_spend := (public._tw4psh_spend_authorize(r.legal_entity_id, r.fee_kind, p.customer_price_cents, p_approval_ref, p_actor, 'pilot', r.studio_id,
    p_authorized_on, p_authorized_by_role, p_scope, p_amount_cents, p_period_key, p_document_ref, p_document_sha256) ->> 'spend_event_id')::uuid;
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

-- the commit-time evidence integrity checks. Security definer: they read the evidence tables, which no API role can.
create or replace function public._tw4psh_event_evidence_check()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_spend_events;
  ev public.studio_sms_pilot_spend_evidence;
  ce public.studio_sms_provider_cover_evidence;
begin
  -- the CURRENT row at commit (a later statement of the transaction may have changed it)
  select * into s from public.studio_sms_spend_events x where x.id = new.id;
  if s.id is null or s.funding <> 'pilot' then
    return null;
  end if;
  select * into ev from public.studio_sms_pilot_spend_evidence x where x.spend_event_id = s.id;
  if ev.id is null or ev.subject <> 'spend_event' or ev.legal_entity_id <> s.legal_entity_id or ev.studio_id is distinct from s.studio_id or ev.fee_kind <> s.kind
     or ev.amount_cents <> s.amount_cents or ev.recorded_by <> s.authorized_by then
    raise exception 'pilot spend event %: no matching written-authorization evidence at commit', s.id using errcode = 'TW052';
  end if;
  if not (case ev.scope
            when 'pilot_onboarding_fee' then s.kind in ('brand', 'brand_low_volume')
            when 'pilot_campaign_fee' then s.kind in ('campaign_vetting', 'monthly', 'monthly_low_volume')
            when 'pilot_number_purchase' then s.kind = 'number'
            when 'pilot_period_cover' then s.kind in ('number', 'monthly', 'monthly_low_volume')
            else false end) then
    raise exception 'pilot spend event %: the evidence scope does not allow this fee at commit', s.id using errcode = 'TW052';
  end if;
  if ev.scope = 'pilot_period_cover' then
    select e2.* into ce from public.studio_sms_provider_cover c join public.studio_sms_provider_cover_evidence e2 on e2.cover_id = c.id
     where c.spend_event_id = s.id and c.basis = 'pilot_approval' limit 1;
    if ce.id is null or ce.legal_entity_id <> s.legal_entity_id or ce.studio_id is distinct from s.studio_id or ce.period_key is distinct from ev.period_key or ce.authorized_on <> ev.authorized_on
       or ce.authorized_by_role <> ev.authorized_by_role or ce.scope <> ev.scope or ce.amount_cents <> ev.amount_cents or ce.document_ref <> ev.document_ref or ce.document_sha256 <> ev.document_sha256 then
      raise exception 'pilot spend event %: a period-cover approval has no matching cover evidence at commit', s.id using errcode = 'TW052';
    end if;
  end if;
  return null;
end $$;

create or replace function public._tw4psh_exception_evidence_check()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  pe public.studio_sms_pilot_exceptions;
begin
  select * into pe from public.studio_sms_pilot_exceptions x where x.legal_entity_id = new.legal_entity_id;
  if pe.legal_entity_id is null then
    return null;
  end if;
  -- the ceiling may be lowered, never raised above the written authorization
  if not exists (select 1 from public.studio_sms_pilot_spend_evidence ev where ev.subject = 'pilot_exception' and ev.legal_entity_id = pe.legal_entity_id and ev.scope = 'pilot_exception'
                  and ev.amount_cents >= pe.ceiling_cents and ev.recorded_by = pe.approved_by) then
    raise exception 'pilot exception %: no matching written-authorization evidence at commit', pe.legal_entity_id using errcode = 'TW052';
  end if;
  return null;
end $$;

create constraint trigger studio_sms_spend_events_pilot_evidence after insert or update of funding, legal_entity_id, kind, amount_cents, studio_id, authorized_by on public.studio_sms_spend_events
  deferrable initially deferred for each row when (new.funding = 'pilot') execute function public._tw4psh_event_evidence_check();
create constraint trigger studio_sms_pilot_exceptions_evidence after insert or update of legal_entity_id, ceiling_cents, approved_by on public.studio_sms_pilot_exceptions
  deferrable initially deferred for each row execute function public._tw4psh_exception_evidence_check();
alter table public.studio_sms_spend_events enable always trigger studio_sms_spend_events_pilot_evidence;
alter table public.studio_sms_pilot_exceptions enable always trigger studio_sms_pilot_exceptions_evidence;

-- privileges: the internal function and the trigger functions are private (not even service_role); the public wrapper keeps its service_role-only grant (create or replace keeps it; restated)
revoke all on function public._tw4psh_spend_authorize(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public._tw4psh_event_evidence_check() from public, anon, authenticated, service_role;
revoke all on function public._tw4psh_exception_evidence_check() from public, anon, authenticated, service_role;
revoke all on function public.tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text) from public, anon, authenticated;
grant execute on function public.tw4_spend_authorize(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text) to service_role;

-- the apply time, read by the rollback: pilot evidence recorded after it is permanent
do $$
begin
  execute format('comment on function public._tw4psh_spend_authorize(uuid, text, int, text, uuid, text, uuid, date, text, text, int, text, text, text) is %L', 'tw4psh applied_at=' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

do $$
begin
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4psh_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'd6d35f4275021093f5f210b3f3502d18' then
    raise exception 'pilot-spend-hardening failed: the internal function body is not the expected one';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from 'ee611846696989bf27ba8066d8bae67f' then
    raise exception 'pilot-spend-hardening failed: public.tw4_spend_authorize is not the expected wrapper';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)'::regprocedure), chr(13), '')) is distinct from '6998d1d65926c09abafd50abc60b822f' then
    raise exception 'pilot-spend-hardening failed: public.tw4_rfl_pilot_cover is not the expected body';
  end if;
end $$;

commit;
