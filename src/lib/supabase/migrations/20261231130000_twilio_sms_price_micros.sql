-- 20261231130000_twilio_sms_price_micros.sql
-- TW-4F sub-cent per-segment prices (dark; Git-only until separately authorized; NOT applied to any shared environment by this file's authoring).
--   Owner's provisional rates are fractions of a cent ($0.013 per INBOUND segment, $0.017 per OUTBOUND segment). Whole-cent columns cannot hold them and they
--   must NOT be rounded into a published cent price. This migration lets the two PER-SEGMENT kinds ('sms_usage', 'sms_inbound') carry a price and an expected
--   provider cost in MICRO-DOLLARS (1 dollar = 1,000,000; 1 cent = 10,000; $0.013 = 13,000; $0.017 = 17,000), the unit already used by
--   studio_sms_usage_attempts.evidence_price_micros and docs/twilio/TW-4F_Pricing_Recommendation.md section 6. It publishes NO price: no row is inserted.
--
-- THE ONE ROUNDING RULE (single definition: public._tw4pm_cents)
--   * exact amount of a text  = segments x unit_price_micros          (integer, never rounded; recorded as exact_micros / charged_micros)
--   * money moved on the credit ledger is WHOLE CENTS: cents = CEIL(exact_micros / 10000), applied ONCE PER ATTEMPT (one outbound text, one inbound text), NEVER
--     per segment. 1 segment at 17,000 = 2 cents; 3 segments (51,000) = 6 cents; 7 segments (119,000) = 12 cents; 1 inbound segment at 13,000 = 2 cents.
--   * the RESERVATION of an outbound text uses the same rule on the estimated segments, so it is always >= the eventual charge at the same segment count
--     (an actual count above the estimate may charge more than was reserved, exactly as today: the message went out; the balance may go below zero).
--   * a whole-cent price row (unit_price_micros null) is cents x 10,000 micros, so segments x cents is reproduced EXACTLY: nothing changes for existing rows.
--   * the rule favors DanceFlow by less than one cent per text (the sub-cent remainder is not carried). The docs design section 6.3 R2 "carried remainder" would
--     be exact in total but needs a per-business carry register; it is NOT built here (smallest safe change). Replacing the rule later means changing
--     _tw4pm_cents (and adding the register); every caller goes through it.
--   * ceilings, reservations, monthly limits, pilot ceilings, the credit ledger and refunds (tw4_credit_refund_usage, in cents against the posted charge) stay
--     whole cents; refunds are exact in cents and idempotent by their existing keys; they never touch micros.
--
-- CHANGES
--   studio_sms_price_list     + unit_price_micros, unit_cost_micros (both null for fixed-fee kinds and for existing rows). For a micro row customer_price_cents =
--                               ceil(unit_price_micros / 10000) and provider_cost_cents = ceil(unit_cost_micros / 10000) (informational, keeps old readers valid).
--   studio_sms_usage_attempts + unit_price_micros, unit_cost_micros, exact_micros (frozen at begin), charged_micros (set once, only when state = 'settled').
--   studio_sms_inbound_usage  + unit_price_micros, exact_micros (billable_cents = ceil(exact_micros / 10000) is enforced).
--   _tw4pm_cents(bigint)      the rounding rule. _tw4pm_attempt_guard + trigger studio_sms_usage_attempts_micros: frozen price, charged_micros = segments x
--                               unit micros and ceil(charged_micros / 10000) = charged_cents (fails closed otherwise).
--   tw4_price_set_micros      stores a micro price for the two per-segment kinds. EXECUTE IS GRANTED TO NO ROLE: publication needs a path through the price
--                               dual-control migrations (20270210*; propose/approve take cents only today), which is a separate, unbuilt slice. Owner/superuser only.
--   replaced (md5-pinned): _tw4us_charge, tw4_usage_begin (20261218 body), tw4_inbound_record (20261203 body), sms_price_list (adds a 'unit_price_micros' key).
--   unchanged: tw4_usage_settle / tw4_usage_resolve (they call _tw4us_charge), the reconciler, tw4_credit_verify and the reconciliation gap checks (cents), monthly
--   limits, pilot ceilings, price dual control (20270210*, untouched; this applies cleanly before or after it).
-- Rollback: rollback/20261231130000_twilio_sms_price_micros_rollback.sql (refuses if ANY micro-priced row exists in any of the three tables).
-- Requires 20261218090000 (usage reconciler readiness) and its predecessors.

begin;

set local lock_timeout = '5s';

do $$
declare v_acl text;
begin
  if to_regclass('public.studio_sms_price_list') is null or to_regclass('public.studio_sms_usage_attempts') is null or to_regclass('public.studio_sms_inbound_usage') is null
     or to_regprocedure('public._tw4usage_reconciler_ready()') is null then
    raise exception 'price-micros precondition failed: usage billing (20261201..20261218) is not applied';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_sms_price_list' and column_name = 'unit_price_micros')
     or to_regprocedure('public._tw4pm_cents(bigint)') is not null then
    raise exception 'price-micros precondition failed: already applied';
  end if;
  -- the functions replaced below must still be their main versions: another slice must not be clobbered silently
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4us_charge(public.studio_sms_usage_attempts,integer,text)'::regprocedure), chr(13), '')), 8) <> 'fec36e86' then
    raise exception 'price-micros precondition failed: public._tw4us_charge(public.studio_sms_usage_attempts,integer,text) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '7e85d636' then
    raise exception 'price-micros precondition failed: public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text)'::regprocedure), chr(13), '')), 8) <> '8d24953b' then
    raise exception 'price-micros precondition failed: public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.sms_price_list()'::regprocedure), chr(13), '')), 8) <> 'ed9f57d9' then
    raise exception 'price-micros precondition failed: public.sms_price_list() differs from its main definition';
  end if;
  select set_config('tw4pm.acl', (select coalesce(string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, 'default'), ';' order by p.oid::regprocedure::text), '') from pg_proc p where p.oid in ('public._tw4us_charge(public.studio_sms_usage_attempts,integer,text)'::regprocedure, 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure, 'public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text)'::regprocedure, 'public.sms_price_list()'::regprocedure)), true) into v_acl;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. columns and shape checks (nothing is converted: every existing row keeps null micros and its whole-cent behavior)
-- ---------------------------------------------------------------------------------------------------------------
alter table public.studio_sms_price_list
  add column unit_price_micros int null,
  add column unit_cost_micros int null;
alter table public.studio_sms_price_list add constraint studio_sms_price_list_micros check (
  (unit_price_micros is null and unit_cost_micros is null)
  or (kind in ('sms_usage', 'sms_inbound') and unit_price_micros is not null and unit_cost_micros is not null and unit_price_micros > 0 and unit_cost_micros >= 0
      and customer_price_cents = (unit_price_micros + 9999) / 10000 and provider_cost_cents = (unit_cost_micros + 9999) / 10000));

alter table public.studio_sms_usage_attempts
  add column unit_price_micros int null,
  add column unit_cost_micros int null,
  add column exact_micros bigint null,
  add column charged_micros bigint null;
alter table public.studio_sms_usage_attempts add constraint studio_sms_usage_attempts_micros_shape check (
  ((unit_price_micros is null) = (unit_cost_micros is null)) and ((unit_price_micros is null) = (exact_micros is null))
  and (unit_price_micros is null or (unit_price_micros > 0 and unit_cost_micros >= 0 and exact_micros = estimated_segments::bigint * unit_price_micros
                                     and reserved_cents = (exact_micros + 9999) / 10000)));
alter table public.studio_sms_usage_attempts add constraint studio_sms_usage_attempts_micros_charged check (
  (charged_micros is null and not (state = 'settled' and unit_price_micros is not null))
  or (charged_micros >= 0 and state = 'settled' and unit_price_micros is not null and charged_cents = (charged_micros + 9999) / 10000));

alter table public.studio_sms_inbound_usage
  add column unit_price_micros int null,
  add column exact_micros bigint null;
alter table public.studio_sms_inbound_usage add constraint studio_sms_inbound_usage_micros check (
  ((unit_price_micros is null) = (exact_micros is null))
  and (unit_price_micros is null or (unit_price_micros > 0 and exact_micros >= 0 and billable_cents = (exact_micros + 9999) / 10000)));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. the rounding rule, the attempt guard and the (ungranted) micro price setter
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4pm_cents(p_micros bigint)
returns int language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_micros is null or p_micros < 0 then
    raise exception 'an amount in micro-dollars must be zero or more' using errcode = '22023';
  end if;
  return ((p_micros + 9999) / 10000)::int;   -- CEIL(micros / 10000), once per attempt
end $$;

create or replace function public._tw4pm_attempt_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare v_seg int;
begin
  if tg_op = 'INSERT' then
    return new;   -- the table checks hold the insert shape (exact = estimated segments x unit, reserved = ceil)
  end if;
  if new.unit_price_micros is distinct from old.unit_price_micros or new.unit_cost_micros is distinct from old.unit_cost_micros
     or new.exact_micros is distinct from old.exact_micros then
    raise exception 'a usage attempt''s frozen micro-dollar price cannot change' using errcode = '42501';
  end if;
  if old.charged_micros is not null and new.charged_micros is distinct from old.charged_micros then
    raise exception 'a settled micro-dollar charge is final' using errcode = '42501';
  end if;
  if new.state = 'settled' and old.state <> 'settled' and new.unit_price_micros is not null then
    if new.charged_cents = 0 then
      new.charged_micros := 0;
    else
      v_seg := nullif(current_setting('tw4.usage_charged_segments', true), '')::int;
      if v_seg is null or v_seg < 1 then
        raise exception 'a micro-priced attempt settles only through the charge function' using errcode = '42501';
      end if;
      new.charged_micros := v_seg::bigint * new.unit_price_micros;
    end if;
    if public._tw4pm_cents(new.charged_micros) <> new.charged_cents then
      raise exception 'charged cents must be the rounded-up exact amount' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_usage_attempts_micros before insert or update on public.studio_sms_usage_attempts for each row execute function public._tw4pm_attempt_guard();

-- stores a micro-dollar price for a per-segment kind (same shape as tw4_price_set). No role may execute it (see header).
create or replace function public.tw4_price_set_micros(p_kind text, p_price_micros int, p_cost_micros int, p_description text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  perform public._tw4c_admin(p_actor);
  if p_kind is null or p_kind not in ('sms_usage', 'sms_inbound') then
    raise exception 'only the per-segment kinds take a micro-dollar price' using errcode = '22023';
  end if;
  if p_price_micros is null or p_price_micros < 1 or p_cost_micros is null or p_cost_micros < 0 then
    raise exception 'a micro-dollar price must be positive and the cost zero or more' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || p_kind));
  update public.studio_sms_price_list set active = false where kind = p_kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, unit_price_micros, unit_cost_micros, description, created_by)
  values (p_kind, public._tw4pm_cents(p_price_micros), public._tw4pm_cents(p_cost_micros), p_price_micros, p_cost_micros, p_description, p_actor) returning id into v_id;
  return jsonb_build_object('price_id', v_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. replaced functions (bodies identical to main except the marked micro-dollar lines)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4us_charge(a public.studio_sms_usage_attempts, p_segments int, p_ref text)
returns int language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_cents int := case when a.unit_price_micros is null then p_segments * a.unit_price_cents
                            else public._tw4pm_cents(p_segments::bigint * a.unit_price_micros) end;
begin
  -- 20261231130000: a micro-priced attempt is charged ceil(segments x unit micros / 10000) cents ONCE per attempt (the same rule that sized its reservation);
  -- the segment count is handed to the attempt trigger (_tw4pm_attempt_guard), which records charged_micros = segments x unit micros when the attempt settles.
  perform set_config('tw4.usage_charged_segments', p_segments::text, true);
  perform public._tw4us_release_reservation(a, p_ref);
  perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'usage_charge', -v_cents, 0, 'usage:sms:' || a.id, a.reservation_id, p_ref, null, null);
  return v_cents;
end $$;

create or replace function public.tw4_usage_begin(
  p_source_kind text, p_source_id uuid, p_studio_id uuid, p_client_id uuid, p_phone_e164 text, p_body text,
  p_message_type text, p_related_table text, p_related_id uuid, p_sent_by uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  acct public.studio_sms_credit_accounts;
  v_entity uuid;
  v_sender public.studio_sms_billed_senders;
  v_account text;
  v_price public.studio_sms_price_list;
  v_segments int;
  v_amount int;
  v_exact bigint;
  v_id uuid := gen_random_uuid();
  v_log uuid;
  v_res uuid;
  v_ready jsonb;
begin
  if p_source_kind not in ('delivery', 'manual') or p_source_id is null or p_studio_id is null then
    raise exception 'a source and a studio are required' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'the studio is not linked to a verified legal business' using errcode = 'TW010';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;
  acct := public._tw4c_lock(v_entity);
  -- a retry of the same source is a replay: never a second send, reservation or log
  select * into a from public.studio_sms_usage_attempts x where x.source_kind = p_source_kind and x.source_id = p_source_id;
  if a.id is not null then
    if a.studio_id <> p_studio_id then
      raise exception 'this source belongs to another studio' using errcode = '42501';
    end if;
    return jsonb_build_object('decision', 'replay', 'attempt_id', a.id, 'state', a.state, 'message_log_id', a.message_log_id, 'provider_sid', a.provider_sid,
                              'account_sid', a.account_sid, 'messaging_service_sid', a.messaging_service_sid, 'sender_e164', a.sender_e164,
                              'body', case when a.state = 'reserved' then (select l.body from public.sms_message_logs l where l.id = a.message_log_id) end,
                              'phone_e164', case when a.state = 'reserved' then (select l.phone_e164 from public.sms_message_logs l where l.id = a.message_log_id) end);
  end if;
  if not public._tw4us_switch_on() then
    raise exception 'billed texting is switched off' using errcode = 'TW018';
  end if;
  -- 20261218: nothing but the usage reconciler captures a reservation, so a new billed text needs a healthy reconciler (fail closed; a replay above still answers)
  v_ready := public._tw4usage_reconciler_ready();
  if not coalesce((v_ready ->> 'ok')::boolean, false) then
    raise exception 'billed texting is paused: the usage reconciler is not ready (%)', coalesce(v_ready ->> 'detail', 'unknown') using errcode = 'TW024';
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'billed texts go to US and Canadian numbers only' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 1600 then
    raise exception 'invalid message body' using errcode = '22023';
  end if;
  if p_client_id is not null and not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    raise exception 'the client does not belong to this studio' using errcode = '42501';
  end if;
  -- 20261204: only a VERIFIED, ready sender of the business's active subaccount (Messaging Service + approved campaign + this location's number)
  v_sender := public._tw4sr_ready(p_studio_id);
  v_account := v_sender.account_sid;
  if v_sender.id is null or v_sender.legal_entity_id <> v_entity then
    raise exception 'no verified, ready sender on the business''s active subaccount' using errcode = 'TW015';
  end if;
  if public._tw4rc_service_state(p_studio_id) = 'suspended' then
    raise exception 'texting is suspended for an uncovered monthly charge' using errcode = 'TW016';
  end if;
  select * into v_price from public.studio_sms_price_list p where p.kind = 'sms_usage' and p.active;
  if v_price.id is null then
    raise exception 'no published texting price' using errcode = 'TW008';
  end if;
  v_segments := public._tw4us_segments(p_body);
  if v_segments < 1 or v_segments > 10 then
    raise exception 'a billed text is 1 to 10 segments' using errcode = '22023';
  end if;
  -- 20261231130000: ONE rounding rule (public._tw4pm_cents): the exact amount is segments x unit micros; the reservation is that amount rounded UP to whole cents.
  -- A whole-cent price row (unit_price_micros null) is cents x 10000 micros, so v_amount is exactly segments x cents as before.
  v_exact := v_segments::bigint * coalesce(v_price.unit_price_micros, v_price.customer_price_cents::bigint * 10000);
  v_amount := public._tw4pm_cents(v_exact);
  perform public._tw4c_require_funds(acct, v_amount);
  perform public._tw4ml_ensure_tz(v_entity);
  perform public._tw4ml_require_room(v_entity, v_amount);   -- fail closed: the monthly limit (default $0) and the platform ceiling

  insert into public.sms_message_logs (studio_id, client_id, phone_e164, direction, message_type, body, segment_count, status, provider, related_table, related_id, sent_by, sent_at)
  values (p_studio_id, p_client_id, p_phone_e164, 'outbound', left(coalesce(p_message_type, 'manual'), 60), p_body, v_segments, 'queued', 'twilio', p_related_table, p_related_id, p_sent_by, now())
  returning id into v_log;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (v_entity, p_studio_id, 'sms_usage', v_amount, 'credit', 'sms:' || v_id) returning id into v_res;
  perform public._tw4c_post(v_entity, p_studio_id, 'reserve', 0, v_amount, 'reserve:sms:' || v_id, v_res, 'text=' || v_log, null, null);
  insert into public.studio_sms_usage_attempts (id, legal_entity_id, studio_id, source_kind, source_id, message_log_id, account_sid, messaging_service_sid, estimated_segments,
                                               unit_price_cents, unit_provider_cost_cents, price_list_id, reserved_cents, reservation_id, state, sender_e164,
                                               unit_price_micros, unit_cost_micros, exact_micros)
  values (v_id, v_entity, p_studio_id, p_source_kind, p_source_id, v_log, v_account, v_sender.messaging_service_sid, v_segments,
          v_price.customer_price_cents, v_price.provider_cost_cents, v_price.id, v_amount, v_res, 'reserved', v_sender.sender_e164,
          v_price.unit_price_micros, v_price.unit_cost_micros, case when v_price.unit_price_micros is null then null else v_exact end);
  return jsonb_build_object('decision', 'send', 'attempt_id', v_id, 'state', 'reserved', 'message_log_id', v_log, 'account_sid', v_account,
                            'messaging_service_sid', v_sender.messaging_service_sid, 'sender_e164', v_sender.sender_e164, 'segments', v_segments, 'amount_cents', v_amount);
end $$;

create or replace function public.tw4_inbound_record(
  p_studio_id uuid, p_signer_account text, p_provider_sid text, p_segments int, p_media int, p_classification text, p_reply_body text,
  p_received_at timestamptz, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
-- called on the webhook's response path: under contention it fails fast (the route logs it; the reconciler records the text later), never holding a reply
set lock_timeout = '2s'
set statement_timeout = '5s'
as $$
declare
  u public.studio_sms_inbound_usage;
  acct public.studio_sms_credit_accounts;
  v_entity uuid;
  v_account text;
  v_price public.studio_sms_price_list;
  v_out_price public.studio_sms_price_list;
  v_received timestamptz := coalesce(p_received_at, now());
  v_billable int := 0;
  v_exact bigint := 0;
  v_charged int := 0;
  v_ceiling int;
  v_protected bigint;
  v_upcoming bigint;
  v_cur text;
  v_reply int;
begin
  if p_studio_id is null or p_provider_sid is null or p_provider_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$'
     or p_classification not in ('ordinary', 'compliance') or p_source not in ('webhook', 'reconciler')
     or p_segments is null or p_segments not between 1 and 20 or coalesce(p_media, 0) not between 0 and 10
     or v_received > now() + interval '5 minutes' or v_received < now() - interval '400 days'
     or (p_source = 'webhook' and p_received_at is not null) then
    raise exception 'invalid inbound record' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('recorded', false, 'reason', 'legacy');
  end if;
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status in ('active', 'suspended');
  if v_account is null or p_signer_account is null or p_signer_account <> v_account then
    raise exception 'the text was not received by this business''s own subaccount' using errcode = '42501';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;
  acct := public._tw4c_lock(v_entity);
  select * into u from public.studio_sms_inbound_usage x where x.provider_sid = p_provider_sid;
  if u.id is not null then
    if u.legal_entity_id <> v_entity or u.studio_id <> p_studio_id then
      raise exception 'this message was recorded for another studio' using errcode = '42501';
    end if;
    return jsonb_build_object('recorded', true, 'replayed', true, 'classification', u.classification, 'charged_cents', u.charged_cents, 'uncollected_cents', u.uncollected_cents);
  end if;

  select * into v_price from public.studio_sms_price_list p where p.kind = 'sms_inbound' and p.active;
  select * into v_out_price from public.studio_sms_price_list p where p.kind = 'sms_usage' and p.active;
  -- only an ordinary SMS (not multimedia) with a published inbound price is billable
  if p_classification = 'ordinary' and p_provider_sid like 'SM%' and coalesce(p_media, 0) = 0 and v_price.id is not null then
    -- 20261231130000: exact = segments x unit micros (a whole-cent row is cents x 10000); billable cents = that rounded UP once per text (public._tw4pm_cents)
    v_exact := p_segments::bigint * coalesce(v_price.unit_price_micros, v_price.customer_price_cents::bigint * 10000);
    v_billable := public._tw4pm_cents(v_exact);
  end if;
  perform public._tw4ml_ensure_tz(v_entity);   -- the month this text counts in must not move later
  -- the pilot business carries NO inbound debt: its pilot-funded setup operations require a non-negative balance (and the pilot ceiling never funds texting)
  v_ceiling := case when exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity) then 0 else public._tw4in_ceiling(v_entity) end;
  -- D1: charge only down to the negative-balance ceiling, measured on AVAILABLE funds (reserved funds are already promised to an outgoing text or a set-aside
  -- month and will be spent); the rest is uncollected (absorbed); the text is never refused.
  -- Owner decision (PR 248): inbound never consumes funds reserved for authorized recurring fees (the first month set aside, a recurring charge in flight):
  -- the balance after the charge must still cover them. The pilot business additionally never goes below zero (its ceiling is 0).
  select coalesce(sum(r.amount_cents), 0) into v_protected from public.studio_sms_credit_reservations r
   where r.legal_entity_id = v_entity and r.status = 'reserved' and r.funding = 'credit' and (r.reservation_key like 'commit:%' or r.reservation_key like 'rec:%');
  -- Owner decision (PR 248, option B): one month of every ACTIVE recurring fee (not revoked, not expired) stays available, at its authorized price. A fee whose
  -- first month is still set aside is already covered by that reservation (counted in reserved_cents), so it is not counted twice. Nothing is reserved or
  -- charged by this: it only limits what an inbound text may charge.
  -- Only a fee that can still be charged is protected (the same refusals tw4_recurring_charge applies): within its total limit, at its published price, not a
  -- pilot business, and with a chargeable month left (this month not yet charged or refused, or a next month inside the term).
  v_cur := public._tw4ml_month_key(v_entity, now());
  select coalesce(sum(a.price_cents), 0) into v_upcoming from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = v_entity and a.status = 'active' and a.expires_at > now()
     and not exists (select 1 from public.studio_sms_credit_reservations r where r.id = a.commitment_reservation_id and r.status = 'reserved')
     and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id)
     and exists (select 1 from public.studio_sms_price_list p where p.kind = a.kind and p.active and p.customer_price_cents = a.price_cents)
     and coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0) + a.price_cents <= a.total_limit_cents
     and ((public._tw4ml_month_start(v_entity, v_cur) < a.expires_at
           and not exists (select 1 from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.period_key = v_cur and c.status in ('charged', 'refused')))
          or public._tw4ml_month_start(v_entity, public._tw4ml_key_add(v_cur, 1)) < a.expires_at);
  v_charged := least(v_billable,
                     greatest(0, acct.balance_cents - acct.reserved_cents + v_ceiling),
                     -- while any recurring fee is active or set aside there is NO inbound debt: only credit free of every reservation AND of one month of
                     -- each active fee may be used (other reservations - an outgoing text, a setup fee - settle without a funds check and would otherwise
                     -- be paid from the protected amount)
                     case when v_protected > 0 or v_upcoming > 0 then greatest(0, acct.balance_cents - acct.reserved_cents - v_upcoming) else v_billable end)::int;
  if v_charged > 0 then
    perform public._tw4c_post(v_entity, p_studio_id, 'usage_charge', -v_charged, 0, 'usage:in:' || p_provider_sid, null, 'inbound', null, null);
  end if;
  v_reply := case when p_reply_body is null or char_length(p_reply_body) = 0 then null else public._tw4us_segments(p_reply_body) end;
  insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, media, price_list_id,
                                               unit_price_cents, billable_cents, charged_cents, uncollected_cents, ceiling_cents, est_provider_cost_cents,
                                               reply_segments, est_reply_cost_cents, received_at, unit_price_micros, exact_micros)
  values (v_entity, p_studio_id, p_provider_sid, v_account, p_source, p_classification, p_segments, coalesce(p_media, 0), v_price.id,
          v_price.customer_price_cents, v_billable, v_charged, v_billable - v_charged, v_ceiling,
          case when v_price.id is null then null when v_price.unit_cost_micros is not null then public._tw4pm_cents(p_segments::bigint * v_price.unit_cost_micros) else p_segments * v_price.provider_cost_cents end,
          v_reply, case when v_reply is null or v_out_price.id is null then null when v_out_price.unit_cost_micros is not null then public._tw4pm_cents(v_reply::bigint * v_out_price.unit_cost_micros) else v_reply * v_out_price.provider_cost_cents end, v_received,
          v_price.unit_price_micros, case when v_price.unit_price_micros is null then null else v_exact end)
  returning * into u;
  return jsonb_build_object('recorded', true, 'replayed', false, 'classification', u.classification, 'charged_cents', u.charged_cents, 'uncollected_cents', u.uncollected_cents);
end $$;

create or replace function public.sms_price_list()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.user_studio_roles r where r.user_id = auth.uid() and r.active = true and r.role in ('studio_owner', 'studio_admin')) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'customer_price_cents', p.customer_price_cents, 'description', p.description, 'unit_price_micros', p.unit_price_micros) order by p.kind)
                     from public.studio_sms_price_list p where p.active), '[]'::jsonb);
end $$;

revoke all on function public._tw4pm_cents(bigint), public._tw4pm_attempt_guard() from public, anon, authenticated, service_role;
revoke all on function public.tw4_price_set_micros(text, int, int, text, uuid) from public, anon, authenticated, service_role;

do $$
begin
  if coalesce(current_setting('tw4pm.acl', true), '') <> (select coalesce(string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, 'default'), ';' order by p.oid::regprocedure::text), '') from pg_proc p where p.oid in ('public._tw4us_charge(public.studio_sms_usage_attempts,integer,text)'::regprocedure, 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure, 'public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text)'::regprocedure, 'public.sms_price_list()'::regprocedure)) then
    raise exception 'price-micros postcondition failed: function privileges changed';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4us_charge(public.studio_sms_usage_attempts,integer,text)'::regprocedure), chr(13), '')), 8) <> '78ec1e44' then
    raise exception 'price-micros postcondition failed: public._tw4us_charge(public.studio_sms_usage_attempts,integer,text) was not replaced as intended (line endings?)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '7d5b9675' then
    raise exception 'price-micros postcondition failed: public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid) was not replaced as intended (line endings?)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text)'::regprocedure), chr(13), '')), 8) <> '9b948318' then
    raise exception 'price-micros postcondition failed: public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text) was not replaced as intended (line endings?)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.sms_price_list()'::regprocedure), chr(13), '')), 8) <> '5f8ea9e8' then
    raise exception 'price-micros postcondition failed: public.sms_price_list() was not replaced as intended (line endings?)';
  end if;
  if has_function_privilege('service_role', 'public.tw4_price_set_micros(text,integer,integer,text,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.tw4_price_set_micros(text,integer,integer,text,uuid)', 'execute')
     or has_function_privilege('service_role', 'public._tw4pm_cents(bigint)', 'execute') then
    raise exception 'price-micros postcondition failed: unexpected function privileges';
  end if;
end $$;

commit;
