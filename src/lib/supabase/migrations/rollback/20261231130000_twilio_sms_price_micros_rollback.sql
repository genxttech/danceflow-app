-- Rollback of 20261231130000_twilio_sms_price_micros.sql: restores _tw4us_charge, tw4_usage_begin, tw4_inbound_record and sms_price_list byte-exactly (verified by
-- fingerprint) and drops the micro-dollar columns, constraints, trigger and functions.
-- REFUSES if any micro-priced row exists in studio_sms_price_list, studio_sms_usage_attempts or studio_sms_inbound_usage (dropping the columns would destroy the
-- exact amounts, and a whole-cent reading of those rows is not equivalent), and if a replaced function was changed after the migration.
-- Locks the billed-texting switch and the three tables for the duration so no micro-priced row can appear between the check and the drop.
begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtext('tw4_usage_switch'));
lock table public.studio_sms_price_list, public.studio_sms_usage_attempts, public.studio_sms_inbound_usage in share row exclusive mode;
do $$
begin
  if to_regprocedure('public._tw4pm_cents(bigint)') is null then
    raise exception 'price-micros rollback precondition failed: the migration is not applied';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4us_charge(public.studio_sms_usage_attempts,integer,text)'::regprocedure), chr(13), '')), 8) <> '69170960' then
    raise exception 'price-micros rollback precondition failed: public._tw4us_charge(public.studio_sms_usage_attempts,integer,text) was changed after this migration (roll back the later migration first)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '7d5b9675' then
    raise exception 'price-micros rollback precondition failed: public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid) was changed after this migration (roll back the later migration first)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text)'::regprocedure), chr(13), '')), 8) <> '46d448c4' then
    raise exception 'price-micros rollback precondition failed: public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text) was changed after this migration (roll back the later migration first)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.sms_price_list()'::regprocedure), chr(13), '')), 8) <> '5f8ea9e8' then
    raise exception 'price-micros rollback precondition failed: public.sms_price_list() was changed after this migration (roll back the later migration first)';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_credit_verify(uuid)'::regprocedure), chr(13), '')), 8) <> '740206bf' then
    raise exception 'price-micros rollback precondition failed: public.tw4_credit_verify(uuid) was changed after this migration (roll back the later migration first)';
  end if;
  if exists (select 1 from public.studio_sms_credit_accounts where usage_carry_micros <> 0) then
    raise exception 'price-micros rollback refused: a business carries a non-zero sub-cent remainder (usage_carry_micros); micro-priced history exists';
  end if;
  if exists (select 1 from public.studio_sms_price_list where unit_price_micros is not null or unit_cost_micros is not null)
     or exists (select 1 from public.studio_sms_usage_attempts where unit_price_micros is not null or unit_cost_micros is not null or exact_micros is not null or charged_micros is not null)
     or exists (select 1 from public.studio_sms_inbound_usage where unit_price_micros is not null or exact_micros is not null) then
    raise exception 'price-micros rollback refused: micro-priced rows exist (price rows, attempts or inbound records); no automatic rollback loses sub-cent amounts';
  end if;
  if exists (select 1 from pg_proc p where p.prosrc like '%\_tw4pm\_cents%'
               and p.oid not in ('public._tw4pm_cents(bigint)'::regprocedure, 'public._tw4pm_carry(uuid,bigint)'::regprocedure, 'public._tw4pm_attempt_guard()'::regprocedure, 'public.tw4_price_set_micros(text,integer,integer,text,uuid)'::regprocedure,
                                 'public._tw4us_charge(public.studio_sms_usage_attempts,integer,text)'::regprocedure, 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure,
                                 'public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text)'::regprocedure)) then
    raise exception 'price-micros rollback refused: another function calls public._tw4pm_cents (roll that migration back first)';
  end if;
end $$;

drop trigger studio_sms_usage_attempts_micros on public.studio_sms_usage_attempts;

create or replace function public._tw4us_charge(a public.studio_sms_usage_attempts, p_segments int, p_ref text)
returns int language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_cents int := p_segments * a.unit_price_cents;
begin
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
  v_amount := v_segments * v_price.customer_price_cents;
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
                                               unit_price_cents, unit_provider_cost_cents, price_list_id, reserved_cents, reservation_id, state, sender_e164)
  values (v_id, v_entity, p_studio_id, p_source_kind, p_source_id, v_log, v_account, v_sender.messaging_service_sid, v_segments,
          v_price.customer_price_cents, v_price.provider_cost_cents, v_price.id, v_amount, v_res, 'reserved', v_sender.sender_e164);
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
    v_billable := p_segments * v_price.customer_price_cents;
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
                                               reply_segments, est_reply_cost_cents, received_at)
  values (v_entity, p_studio_id, p_provider_sid, v_account, p_source, p_classification, p_segments, coalesce(p_media, 0), v_price.id,
          v_price.customer_price_cents, v_billable, v_charged, v_billable - v_charged, v_ceiling,
          case when v_price.id is null then null else p_segments * v_price.provider_cost_cents end,
          v_reply, case when v_reply is null or v_out_price.id is null then null else v_reply * v_out_price.provider_cost_cents end, v_received)
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
  return coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'customer_price_cents', p.customer_price_cents, 'description', p.description) order by p.kind)
                     from public.studio_sms_price_list p where p.active), '[]'::jsonb);
end $$;

create or replace function public.tw4_credit_verify(p_entity_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_b bigint;
  v_r bigint;
  v_open bigint;
begin
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = p_entity_id;
  select coalesce(sum(balance_delta_cents), 0), coalesce(sum(reserved_delta_cents), 0) into v_b, v_r from public.studio_sms_credit_ledger where legal_entity_id = p_entity_id;
  select coalesce(sum(amount_cents), 0) into v_open from public.studio_sms_credit_reservations where legal_entity_id = p_entity_id and status = 'reserved' and funding = 'credit';
  return jsonb_build_object('pilot_used_cents', (select coalesce(sum(r.amount_cents), 0) from public.studio_sms_credit_reservations r where r.legal_entity_id = p_entity_id and r.funding = 'pilot' and r.status in ('reserved', 'captured')),'balance_cents', coalesce(a.balance_cents, 0), 'reserved_cents', coalesce(a.reserved_cents, 0), 'ledger_balance_cents', v_b, 'ledger_reserved_cents', v_r,
    'open_reservations_cents', v_open, 'ok', coalesce(a.balance_cents, 0) = v_b and coalesce(a.reserved_cents, 0) = v_r and v_r = v_open);
end $$;

drop function public.tw4_price_set_micros(text, int, int, text, uuid);
drop function public._tw4pm_attempt_guard();
drop function public._tw4pm_carry(uuid, bigint);
drop function public._tw4pm_cents(bigint);

alter table public.studio_sms_usage_attempts drop constraint studio_sms_usage_attempts_micros_charged, drop constraint studio_sms_usage_attempts_micros_shape;
alter table public.studio_sms_inbound_usage drop constraint studio_sms_inbound_usage_micros;
alter table public.studio_sms_price_list drop constraint studio_sms_price_list_micros;
alter table public.studio_sms_usage_attempts drop column unit_price_micros, drop column unit_cost_micros, drop column exact_micros, drop column charged_micros, drop column carry_before_micros, drop column carry_after_micros;
alter table public.studio_sms_inbound_usage drop column unit_price_micros, drop column exact_micros, drop column carry_before_micros, drop column carry_after_micros;
alter table public.studio_sms_credit_accounts drop column usage_carry_micros;
alter table public.studio_sms_price_list drop column unit_price_micros, drop column unit_cost_micros;

do $$
begin
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_credit_verify(uuid)'::regprocedure), chr(13), '')), 8) <> '61da0813' then
    raise exception 'price-micros rollback failed: public.tw4_credit_verify(uuid) was not restored byte-exactly';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4us_charge(public.studio_sms_usage_attempts,integer,text)'::regprocedure), chr(13), '')), 8) <> 'fec36e86' then
    raise exception 'price-micros rollback failed: public._tw4us_charge(public.studio_sms_usage_attempts,integer,text) was not restored byte-exactly';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '7e85d636' then
    raise exception 'price-micros rollback failed: public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid) was not restored byte-exactly';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text)'::regprocedure), chr(13), '')), 8) <> '8d24953b' then
    raise exception 'price-micros rollback failed: public.tw4_inbound_record(uuid,text,text,integer,integer,text,text,timestamp with time zone,text) was not restored byte-exactly';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.sms_price_list()'::regprocedure), chr(13), '')), 8) <> 'ed9f57d9' then
    raise exception 'price-micros rollback failed: public.sms_price_list() was not restored byte-exactly';
  end if;
end $$;

commit;
