-- 20261218090000_twilio_usage_reconciler_readiness.sql
-- TW-4F F3 (completion tracker F-5, P1): billed texting needs a healthy usage reconciler (dark; Git-only until separately authorized).
--   Only the scheduled usage reconciler (src/lib/sms/usageReconciler.ts via /api/cron/sms-usage-reconcile) settles a billed text from provider evidence
--   (tw4_usage_settle). Without it every reservation would stay held and DanceFlow would pay Twilio for texts it never collects.
--   * public._tw4usage_reconciler_ready() -> jsonb {ok boolean, detail text, last_success_at timestamptz}: READY when a completed usage_reconcile run that PROVED
--     IT CAN SETTLE finished within the last 30 minutes (the panel's "Reconciliation is not running" alert, design section 5) and no expired run lease has been
--     left unclosed for 10 minutes (two 5-minute ticks: the schedule has stopped). Proved = it read provider evidence (evidence_read) and either had nothing due
--     or settled / read a pending status for at least one text: a run without evidence reads, or whose every read failed, settles nothing and never counts.
--     The NEWEST run in the window that had texts due must have proved it too (a failed read backs its text off, so a later idle run proves nothing).
--     Escalated attempts do not block: they keep their reservation until a platform admin resolves them in writing (design section 1).
--     detail is one of: ready, no_completed_run, no_evidence_reads, evidence_failing, stale, stuck_lease. This signature and shape are a contract (slice F1's
--     activation checklist); last_success_at is the newest proved run in the last 7 days (null if none); the not-ready details look back 7 days.
--   * tw4_usage_set_switch refuses to switch billed texting ON unless the reconciler is ready and the usage ledger reconciles (gaps = 0). OFF is always allowed.
--   * tw4_usage_begin refuses a NEW billed text unless the reconciler is ready (TW024, after the switch check; a replay of an existing source still answers).
--     Nothing is reserved or logged on that refusal, so the app retries an automated text later (it is never skipped) and asks staff to try a manual one again.
-- Settlement, reservations, monthly limits, the pilot ceiling and sender readiness (_tw4sr_*) are unchanged. Requires 20261205090000 (and 20261204090000).
-- Rollback: rollback/20261218090000_twilio_usage_reconciler_readiness_rollback.sql (restores both bodies byte-exactly; refuses while billed texting is switched
-- on or another function calls the helper). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_reconcile_runs') is null or to_regprocedure('public.tw4_reconcile_run_begin(text,text,integer)') is null then
    raise exception 'reconciler-readiness precondition failed: usage reconciliation (20261205090000) is not applied';
  end if;
  if to_regprocedure('public._tw4usage_reconciler_ready()') is not null then
    raise exception 'reconciler-readiness precondition failed: already applied';
  end if;
  -- the functions replaced below must still be their main versions (20261204 / 20261201): another slice must not be clobbered silently
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '3013c006' then
    raise exception 'reconciler-readiness precondition failed: public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_set_switch(boolean,uuid,text)'::regprocedure), chr(13), '')), 8) <> '90813ea0' then
    raise exception 'reconciler-readiness precondition failed: public.tw4_usage_set_switch(boolean,uuid,text) differs from its main definition';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- readiness (read-only; identifiers and times only)
-- ---------------------------------------------------------------------------------------------------------------
-- the readiness reads walk completed runs newest first (a run is completed once, so the index never changes under a running job)
create index studio_sms_reconcile_runs_completed on public.studio_sms_reconcile_runs (job, finished_at desc) where status = 'completed';

-- did this completed run PROVE it can settle? It read provider evidence (evidence_read) and either had nothing due or settled / read a pending status for at least
-- one text. A run whose every read failed (revoked token, provider outage, settle timing out) still finishes 'completed' with errors and proves nothing.
create or replace function public._tw4usage_run_proved(p_summary jsonb)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(p_summary @> '{"evidence_read": true}'::jsonb
    and (p_summary -> 'due' = '0'::jsonb
         or (case when jsonb_typeof(p_summary -> 'settled') = 'number' then (p_summary -> 'settled')::numeric else 0 end
             + case when jsonb_typeof(p_summary -> 'pending') = 'number' then (p_summary -> 'pending')::numeric else 0 end) > 0), false);
$$;

create or replace function public._tw4usage_reconciler_ready()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_last timestamptz;
  v_busy_proved boolean;
begin
  -- the newest completed run inside the window that proved it can settle (index range on job, finished_at: a handful of rows)
  select r.finished_at into v_last from public.studio_sms_reconcile_runs r
   where r.job = 'usage_reconcile' and r.status = 'completed' and r.finished_at > v_now - interval '30 minutes' and r.finished_at <= v_now
     and public._tw4usage_run_proved(r.summary)
   order by r.finished_at desc limit 1;
  -- ...and the newest run in the window that HAD texts due must have proved it too: a failed read backs its text off (tw4_usage_due hides it), so an idle run
  -- after a failing one says nothing about whether reads work (null = no run in the window had anything due)
  select public._tw4usage_run_proved(r.summary) into v_busy_proved from public.studio_sms_reconcile_runs r
   where r.job = 'usage_reconcile' and r.status = 'completed' and r.finished_at > v_now - interval '30 minutes' and r.finished_at <= v_now
     and jsonb_typeof(r.summary -> 'due') = 'number' and (r.summary -> 'due')::numeric > 0
   order by r.finished_at desc limit 1;
  if v_last is null or v_busy_proved is false then
    -- not ready: report the last success (looked for over 7 days, so a refused begin stays cheap) and why
    if v_last is null then
      select r.finished_at into v_last from public.studio_sms_reconcile_runs r
       where r.job = 'usage_reconcile' and r.status = 'completed' and r.finished_at > v_now - interval '7 days' and r.finished_at <= v_now
         and public._tw4usage_run_proved(r.summary)
       order by r.finished_at desc limit 1;
    end if;
    return jsonb_build_object('ok', false, 'last_success_at', v_last, 'detail', case
      when v_busy_proved is false then 'evidence_failing'
      when exists (select 1 from public.studio_sms_reconcile_runs r where r.job = 'usage_reconcile' and r.status = 'completed' and r.finished_at > v_now - interval '30 minutes'
                     and r.summary @> '{"evidence_read": true}'::jsonb) then 'evidence_failing'
      when v_last is not null then 'stale'
      when exists (select 1 from public.studio_sms_reconcile_runs r where r.job = 'usage_reconcile' and r.status = 'completed' and r.finished_at > v_now - interval '7 days'
                     and r.summary @> '{"evidence_read": true}'::jsonb) then 'evidence_failing'
      when exists (select 1 from public.studio_sms_reconcile_runs r where r.job = 'usage_reconcile' and r.status = 'completed' and r.finished_at > v_now - interval '7 days') then 'no_evidence_reads'
      else 'no_completed_run' end);
  end if;
  -- a lease that expired and was not taken over for 10 minutes: the schedule has stopped (each begin closes an expired lease as failed)
  if exists (select 1 from public.studio_sms_reconcile_runs r where r.job = 'usage_reconcile' and r.status = 'running' and r.lease_expires_at < v_now - interval '10 minutes') then
    return jsonb_build_object('ok', false, 'detail', 'stuck_lease', 'last_success_at', v_last);
  end if;
  return jsonb_build_object('ok', true, 'detail', 'ready', 'last_success_at', v_last);
end $$;

comment on function public._tw4usage_reconciler_ready() is
  'TW-4F F3 (20261218090000) contract: {ok, detail in (ready, no_completed_run, no_evidence_reads, evidence_failing, stale, stuck_lease), last_success_at}. Ready = within 30 min a completed usage_reconcile run proved it can settle (read evidence; nothing due, or something settled / pending), the newest run in that window with texts due proved it too, and no expired lease is left for 10 min. Not-ready details look back 7 days.';

-- ---------------------------------------------------------------------------------------------------------------
-- replaced from 20261201090000 / 20261204090000 (only the 20261218 lines change)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_usage_set_switch(p_enabled boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ready jsonb;
begin
  perform public._tw4c_admin(p_actor);
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a switch change needs a written reason (10+ characters)' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_usage_switch'));
  -- 20261218: billed texting is switched ON only while the usage reconciler is healthy and the usage ledger reconciles (switching OFF is always allowed)
  if p_enabled then
    v_ready := public._tw4usage_reconciler_ready();
    if not coalesce((v_ready ->> 'ok')::boolean, false) then
      raise exception 'billed texting cannot be switched on: the usage reconciler is not ready (%)', coalesce(v_ready ->> 'detail', 'unknown') using errcode = 'TW024';
    end if;
    if public._tw4us_reconciliation_gaps() + public._tw4in_reconciliation_gaps() <> 0 then
      raise exception 'billed texting cannot be switched on: the usage ledger has reconciliation gaps' using errcode = 'TW024';
    end if;
  end if;
  insert into public.studio_sms_usage_switch_log (enabled, changed_by, reason, changed_at) values (p_enabled, p_actor, btrim(p_reason), clock_timestamp());
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  select es.studio_id, null, 'platform_admin', p_actor, 'usage_switch', left('enabled=' || p_enabled || ';' || btrim(p_reason), 300)
    from public.studio_sms_entity_studios es order by es.linked_at limit 1;
  return jsonb_build_object('enabled', p_enabled);
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

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: the replaced actions keep theirs (create or replace); the helper is read by the service role (platform panel) and by SQL, never by API users
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4usage_run_proved(jsonb) from public, anon, authenticated, service_role;
revoke all on function public._tw4usage_reconciler_ready() from public, anon, authenticated;
grant execute on function public._tw4usage_reconciler_ready() to service_role;
revoke all on function public.tw4_usage_set_switch(boolean, uuid, text), public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.tw4_usage_set_switch(boolean, uuid, text), public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid) to service_role;

do $$
begin
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure), chr(13), '')), 8) <> '7e85d636'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_set_switch(boolean,uuid,text)'::regprocedure), chr(13), '')), 8) <> '8adf296c'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4usage_reconciler_ready()'::regprocedure), chr(13), '')), 8) <> '39b0ad11'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4usage_run_proved(jsonb)'::regprocedure), chr(13), '')), 8) <> '98db0ae5' then
    raise exception 'reconciler-readiness postcondition failed: a function body differs from this file (line endings?)';
  end if;
end $$;

commit;
