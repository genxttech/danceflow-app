-- Rollback of 20261204090000 (sender readiness). Restores tw4_usage_begin, tw4_usage_dispatching and tw4_usage_record_callback as of 20261201090000, the
-- old status list, the old setter's privileges and the audit vocabulary without the sender actions, and drops the sender objects.
-- REFUSES once any verification, sender row with the new identifiers/statuses, sender audit row, or attempt with a sender number exists. Roll the app back first.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_sender_verifications') is null then
    raise exception 'sender-readiness rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_sender_verifications)
     or exists (select 1 from public.studio_sms_billed_senders where status in ('pending', 'released') or campaign_sid is not null or phone_number_sid is not null or verification_id is not null)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('sender_recorded', 'sender_verified', 'sender_verify_failed', 'sender_revoked', 'sender_released', 'sender_flagged'))
     or exists (select 1 from public.studio_sms_usage_attempts where sender_e164 is not null) then
    raise exception 'sender-readiness rollback refused: sender records or verifications exist' using errcode = '55000';
  end if;
end $$;

-- as of 20261201090000
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
                              'account_sid', a.account_sid, 'messaging_service_sid', a.messaging_service_sid,
                              'body', case when a.state = 'reserved' then (select l.body from public.sms_message_logs l where l.id = a.message_log_id) end,
                              'phone_e164', case when a.state = 'reserved' then (select l.phone_e164 from public.sms_message_logs l where l.id = a.message_log_id) end);
  end if;
  if not public._tw4us_switch_on() then
    raise exception 'billed texting is switched off' using errcode = 'TW018';
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
  select * into v_sender from public.studio_sms_billed_senders s where s.studio_id = p_studio_id order by s.created_at desc, s.id desc limit 1;
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status = 'active';
  if v_sender.id is null or v_sender.status <> 'approved' or v_account is null or v_sender.account_sid <> v_account or v_sender.legal_entity_id <> v_entity then
    raise exception 'no approved sender on the business''s active subaccount' using errcode = 'TW015';
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
                                               unit_price_cents, unit_provider_cost_cents, price_list_id, reserved_cents, reservation_id, state)
  values (v_id, v_entity, p_studio_id, p_source_kind, p_source_id, v_log, v_account, v_sender.messaging_service_sid, v_segments,
          v_price.customer_price_cents, v_price.provider_cost_cents, v_price.id, v_amount, v_res, 'reserved');
  return jsonb_build_object('decision', 'send', 'attempt_id', v_id, 'state', 'reserved', 'message_log_id', v_log, 'account_sid', v_account,
                            'messaging_service_sid', v_sender.messaging_service_sid, 'segments', v_segments, 'amount_cents', v_amount);
end $$;

-- as of 20261201090000
create or replace function public.tw4_usage_dispatching(p_attempt_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_usage_attempts;
begin
  select * into a from public.studio_sms_usage_attempts x where x.id = p_attempt_id for update;
  if a.id is null then
    raise exception 'unknown usage attempt' using errcode = '22023';
  end if;
  if a.state <> 'reserved' then
    return jsonb_build_object('dispatch', false, 'state', a.state);   -- already dispatched, or released as never sent: do not send
  end if;
  perform public._tw4us_write();
  update public.studio_sms_usage_attempts set state = 'submitting', submitting_at = clock_timestamp() where id = a.id;
  return jsonb_build_object('dispatch', true, 'state', 'submitting');
end $$;

-- as of 20261201090000
create or replace function public.tw4_usage_record_callback(p_attempt_id uuid, p_provider_sid text, p_signer_account text, p_status text, p_error_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  v_rank int := public._tw4us_rank(p_status);
begin
  if p_provider_sid is null or p_provider_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then
    raise exception 'invalid provider message id' using errcode = '22023';
  end if;
  if p_attempt_id is not null then
    select * into a from public.studio_sms_usage_attempts x where x.id = p_attempt_id for update;
  else
    select * into a from public.studio_sms_usage_attempts x where x.provider_sid = p_provider_sid for update;
  end if;
  if a.id is null then
    if p_attempt_id is not null then
      raise exception 'unknown usage attempt' using errcode = '42501';
    end if;
    return jsonb_build_object('billed', false);
  end if;
  if p_signer_account is null or p_signer_account <> a.account_sid then
    raise exception 'the callback is not signed by the attempt''s subaccount' using errcode = '42501';
  end if;
  if a.provider_sid is not null and a.provider_sid <> p_provider_sid then
    raise exception 'the callback names another provider message' using errcode = '42501';
  end if;
  if exists (select 1 from public.studio_sms_usage_attempts x where x.provider_sid = p_provider_sid and x.id <> a.id) then
    raise exception 'the provider message belongs to another attempt' using errcode = '42501';
  end if;
  perform public._tw4us_write();
  if a.provider_sid is null then
    if not (a.state in ('submitting', 'unknown') or (a.state = 'released' and a.resolved_outcome = 'released')) then
      raise exception 'the attempt cannot take a provider message in state %', a.state using errcode = '22023';
    end if;
    update public.studio_sms_usage_attempts set provider_sid = p_provider_sid, state = 'submitted', submitted_at = coalesce(submitted_at, clock_timestamp()) where id = a.id;
    update public.sms_message_logs set provider_message_id = p_provider_sid, updated_at = now() where id = a.message_log_id;
  end if;
  if a.state = 'settled' then
    return jsonb_build_object('billed', true, 'needs_reconcile', false);   -- final: a late callback is acknowledged and changes nothing
  end if;
  if v_rank > a.callback_rank then
    update public.studio_sms_usage_attempts set callback_status = lower(p_status), callback_rank = v_rank, callback_at = clock_timestamp() where id = a.id;
  end if;
  return jsonb_build_object('billed', true, 'needs_reconcile', v_rank >= 4 or greatest(v_rank, a.callback_rank) >= 4);
end $$;

drop function public.tw4_sender_due_reverify(int), public.tw4_sender_overview(uuid), public.tw4_inbound_studio_for(text, text, text),
  public.tw4_sender_revoke(uuid, uuid, text, boolean), public.tw4_sender_reverify(uuid, uuid, jsonb, text), public.tw4_sender_verify(uuid, uuid, uuid, jsonb, boolean, text),
  public.tw4_sender_record(uuid, uuid, text, text, text, text, text), public._tw4sr_flag(uuid, text, text, text, text), public.tw4_usage_release_unprepared(uuid, text),public._tw4sr_apply(uuid, uuid, uuid, jsonb, boolean, text),
  public._tw4sr_judge(public.studio_sms_billed_senders, jsonb, boolean), public._tw4sr_audit(uuid, uuid, text, text),
  public._tw4sr_append(public.studio_sms_billed_senders, text, uuid, text, uuid), public._tw4sr_ready(uuid), public._tw4sr_fake_allowed(), public._tw4sr_latest(uuid),
  public._tw4sr_lock(uuid);
drop table public.studio_sms_sender_verifications;
alter table public.studio_sms_usage_attempts drop column sender_e164;
drop index public.studio_sms_billed_senders_latest;
drop index public.studio_sms_billed_senders_seq;
alter table public.studio_sms_billed_senders drop constraint studio_sms_billed_senders_status_check;
alter table public.studio_sms_billed_senders add constraint studio_sms_billed_senders_status_check check (status in ('approved', 'revoked'));
alter table public.studio_sms_billed_senders drop column verification_id, drop column phone_number_sid, drop column campaign_sid, drop column seq;
grant execute on function public.tw4_usage_billed_sender_set(uuid, uuid, text, text, text, text) to service_role;

do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m
   where m[1] <> 'text' and m[1] not in ('sender_recorded', 'sender_verified', 'sender_verify_failed', 'sender_revoked', 'sender_released', 'sender_flagged');
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

commit;
