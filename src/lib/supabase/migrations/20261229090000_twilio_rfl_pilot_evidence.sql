-- 20261229090000_twilio_rfl_pilot_evidence.sql
-- TW-4F pilot approval evidence (owner decision U-4) and approval-reference length consistency (Git-only until separately authorized; dark).
--   U-4: an approval reference points to a DATED, EXPLICIT written owner authorization. The reference alone is not authorization. tw4_rfl_pilot_cover now records, WITH the cover, structured
--        evidence in a new append-only table studio_sms_provider_cover_evidence (1:1 with the cover row): the authorization date, the authorizing role as stated (founder_written | owner_written,
--        the cancel-path vocabulary), the scope (pilot_period_cover), the amount in cents (must EQUAL the published price of the fee covered), the period (must equal the cover's period), a
--        reference to the retained written authorization (an opaque document id or a plain https link) and the sha256 of the retained text. The TEXT is never stored: only its hash and the reference.
--   Length: the reference is 10..200 characters in every layer. studio_sms_spend_events.approval_ref was CHECK 3..120 (20261121), so a 121..200 character reference passed the UI and the other
--        approval tables and failed with a raw check violation. The table CHECK is WIDENED (upper bound only: 3..200, the floor stays 3 so no row can ever be invalidated); the RPC refuses
--        anything outside 10..200 with errcode 22023 and a clear message BEFORE any state is touched.
--   tw4_rfl_pilot_cover gets a NEW signature (eleven arguments). The old four-argument signature is DROPPED in this migration, so no evidence-free overload stays callable. Everything else is the
--        20261225 body: current/next period only, no retroactive approval, platform admin only, hold/negative refusal, the $150 ceiling (TW007), one reference per use (TW019), D5 supersede
--        semantics (TW043), the lock order (legal business row -> credit account, via _tw4rfl_lock) and the tw4.rfl_write flag pattern.
--   Refusals (errcode): out-of-range reference or malformed input 22023; evidence missing/invalid/inconsistent TW052 (NEW: documented in docs/twilio/TW-4F_RFL_Pilot_Approval_Evidence.md);
--        amount differs from the published price TW008; reference reused TW019; ceiling/hold TW007; not the pilot business / period window TW042; period already covered TW043; not a platform admin 42501.
-- Requires 20261209..20261226 (the 20261225 D5 body is fingerprint-checked). Rollback: rollback/20261229090000_twilio_rfl_pilot_evidence_rollback.sql (refuses while any evidence row exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_def text;
  v_n int;
begin
  if to_regprocedure('public.tw4_rfl_pilot_cover(uuid,text,text,uuid)') is null or to_regclass('public.studio_sms_provider_cover') is null
     or to_regprocedure('public._tw4rfl_lock(uuid)') is null or to_regprocedure('public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid)') is null
     or to_regprocedure('public._tw4c_truncate_guard()') is null then
    raise exception 'pilot-evidence precondition failed: 20261209 .. 20261225 are not all applied';
  end if;
  if to_regclass('public.studio_sms_provider_cover_evidence') is not null or to_regprocedure('public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)') is not null then
    raise exception 'pilot-evidence precondition failed: already applied';
  end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = 'public.studio_sms_provider_cover'::regclass and a.attname = 'superseded_at' and not a.attisdropped) then
    raise exception 'pilot-evidence precondition failed: 20261225090000 (D5 cover) is not applied';
  end if;
  -- the predecessor body (20261225) must be exactly the one this migration replaces and the rollback restores
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_rfl_pilot_cover(uuid,text,text,uuid)'::regprocedure), chr(13), '')) is distinct from '00e9bff4d2ce4e0cca135317216541fb' then
    raise exception 'pilot-evidence precondition failed: public.tw4_rfl_pilot_cover(uuid,text,text,uuid) differs from its main (20261225) definition';
  end if;
  -- the approval-reference column check: discover its live name, require exactly the 3..120 shape (or an already wider one), never guess
  select count(*) into v_n from pg_constraint c where c.conrelid = 'public.studio_sms_spend_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%char_length(btrim(approval_ref))%';
  if v_n <> 1 then
    raise exception 'pilot-evidence precondition failed: expected exactly one approval_ref length check on studio_sms_spend_events, found %', v_n;
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_spend_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%char_length(btrim(approval_ref))%';
  if v_def not like '%>= 3)%' or (v_def not like '%<= 120)%' and v_def not like '%<= 200)%') then
    raise exception 'pilot-evidence precondition failed: the approval_ref check is not the 3..120 shape: %', v_def;
  end if;
end $$;

-- 1. widen the reference length check (upper bound only; the floor stays 3, so no existing row can be invalidated). The new check is added BEFORE the old one is dropped.
do $$
declare
  v_old text;
begin
  select c.conname into v_old from pg_constraint c where c.conrelid = 'public.studio_sms_spend_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%char_length(btrim(approval_ref))%';
  alter table public.studio_sms_spend_events add constraint studio_sms_spend_events_approval_ref_len check (char_length(btrim(approval_ref)) between 3 and 200);
  execute format('alter table public.studio_sms_spend_events drop constraint %I', v_old);
end $$;

-- 2. the evidence table: append-only, 1:1 with the cover, no API grants, RLS on. NEVER the text of the authorization: only the document reference and its sha256.
create table public.studio_sms_provider_cover_evidence (
  id uuid primary key default gen_random_uuid(),
  cover_id uuid not null unique references public.studio_sms_provider_cover(id) on delete restrict,
  resource_id uuid not null references public.studio_sms_provider_resources(id) on delete restrict,
  legal_entity_id uuid not null,
  studio_id uuid not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  authorized_on date not null,
  authorized_by_role text not null check (authorized_by_role in ('founder_written', 'owner_written')),
  scope text not null check (scope in ('pilot_period_cover')),
  amount_cents int not null check (amount_cents > 0),
  document_ref text not null check (char_length(document_ref) between 6 and 500 and ((document_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#=+-]{5,119}$' and document_ref !~ '://') or document_ref ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&''()*+,;=:@/-]*)?$')),
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_provider_cover_evidence_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_provider_cover_evidence_resource on public.studio_sms_provider_cover_evidence (resource_id, period_key);
revoke all on public.studio_sms_provider_cover_evidence from public, anon, authenticated, service_role;
alter table public.studio_sms_provider_cover_evidence enable row level security;

-- its own append-only trigger (the shared _tw4rfl_guard body is NOT touched): rows are inserted only by tw4_rfl_pilot_cover (flag), only for the cover they describe, and never change
create or replace function public._tw4rfl_evid_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c public.studio_sms_provider_cover;
begin
  if tg_op <> 'INSERT' then
    raise exception 'studio_sms_provider_cover_evidence: approval evidence is permanent' using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.rflevid_write', true), '') <> 'on' then
    raise exception 'studio_sms_provider_cover_evidence: evidence is recorded only with its cover, by tw4_rfl_pilot_cover' using errcode = '42501';
  end if;
  select * into c from public.studio_sms_provider_cover x where x.id = new.cover_id;
  if c.id is null or c.basis <> 'pilot_approval' or c.resource_id <> new.resource_id or c.legal_entity_id <> new.legal_entity_id or c.studio_id <> new.studio_id
     or c.period_key <> new.period_key or c.recorded_by <> new.recorded_by then
    raise exception 'studio_sms_provider_cover_evidence: the evidence must describe its own pilot_approval cover (resource, business, location, period, recorder)' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._tw4rfl_evid_guard() from public, anon, authenticated, service_role;
create trigger studio_sms_provider_cover_evidence_guard before insert or update or delete on public.studio_sms_provider_cover_evidence for each row execute function public._tw4rfl_evid_guard();
create trigger studio_sms_provider_cover_evidence_truncate before truncate on public.studio_sms_provider_cover_evidence for each statement execute function public._tw4c_truncate_guard();
alter table public.studio_sms_provider_cover_evidence enable always trigger studio_sms_provider_cover_evidence_guard;

-- 3. the replaced function: the old signature is dropped (no evidence-free overload remains)
drop function public.tw4_rfl_pilot_cover(uuid, text, text, uuid);

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
  -- not in the future (a business may already be on the next calendar day in UTC: one day of slack) and not older than 400 days
  if p_authorized_on > v_today + 1 then
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
     or not ((p_document_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/#=+-]{5,119}$' and p_document_ref !~ '://') or p_document_ref ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&''()*+,;=:@/-]*)?$') then
    raise exception 'pilot approval evidence: the retained document needs an opaque id or a plain https link (no query string, no credentials)' using errcode = 'TW052';
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

-- privileges: service_role only, exactly like the function it replaces
revoke all on function public.tw4_rfl_pilot_cover(uuid, text, text, uuid, date, text, text, int, text, text, text) from public, anon, authenticated;
grant execute on function public.tw4_rfl_pilot_cover(uuid, text, text, uuid, date, text, text, int, text, text, text) to service_role;

commit;
