-- Rollback of 20270218090000 (TW-4F inbound START order). Roll the APP back first: the webhook's START-signal write and the reconciler's START-SID read both
-- treat a missing function as "not installed" (no error to the texter, the old ordering rule), so the app may briefly run against either schema.
-- Restores tw4_inbound_recover exactly as 20261205090000 defined it (create or replace keeps its privileges), then drops the two functions and the table.
-- The START signals are dropped with the table: they hold no consent state (consent itself lives in sms_contact_permissions / sms_consent_history).

begin;

create or replace function public.tw4_inbound_recover(p_run_id uuid, p_account_sid text, p_evidence jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_sid text := p_evidence->>'sid';
  v_entity uuid;
  v_studio uuid;
  v_segments int;
  v_media int;
  v_received timestamptz := public._tw4ur_instant(p_evidence->>'date_created');
  v_class_in text := p_evidence->>'classification';
  v_keyword boolean := coalesce(p_evidence->>'keyword', '') = 'true';
  v_kind text := case when coalesce(p_evidence->>'keyword', '') = 'true' and p_evidence->>'keyword_kind' in ('stop', 'start', 'help') then p_evidence->>'keyword_kind' end;
  v_from text := nullif(btrim(coalesce(p_evidence->>'from', '')), '');
  v_applied boolean;
  v_note text;
  v_later text := p_evidence->>'later_keyword';
  v_contact_start timestamptz;
  v_possible boolean := coalesce(p_evidence->>'possible_opt_out', '') = 'true';
  v_basis text;
  v_class text;
  v_seen boolean;
  r jsonb;
begin
  perform public._tw4ur_fence(p_run_id, 'usage_reconcile');
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' or p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$'
     or v_sid is null or v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then
    raise exception 'invalid inbound evidence' using errcode = '22023';
  end if;
  if p_evidence->>'account_sid' is distinct from p_account_sid then
    raise exception 'the evidence is for another account' using errcode = '42501';
  end if;
  if lower(coalesce(p_evidence->>'direction', '')) <> 'inbound' then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'not_inbound');
  end if;
  select t.legal_entity_id into v_entity from public.studio_sms_twilio_accounts t where t.twilio_account_sid = p_account_sid and t.status in ('active', 'suspended');
  if v_entity is null then
    raise exception 'not an active subaccount of a legal business' using errcode = '42501';
  end if;
  -- already recorded (by the webhook or an earlier recovery): a replay, whatever the number routes to today (a number may have moved between locations)
  if exists (select 1 from public.studio_sms_inbound_usage u where u.provider_sid = v_sid) then
    if not exists (select 1 from public.studio_sms_inbound_usage u where u.provider_sid = v_sid and u.legal_entity_id = v_entity) then
      raise exception 'this message was recorded for another business' using errcode = '42501';
    end if;
    return jsonb_build_object('outcome', 'already_recorded');
  end if;
  -- the number decides (unique per account), exactly as the webhook routes it; an unroutable text is never recorded against a guess: its evidence is kept
  v_studio := public.tw4_inbound_studio_for(p_account_sid, nullif(p_evidence->>'messaging_service_sid', ''), nullif(p_evidence->>'to', ''));
  if v_studio is null then
    insert into public.studio_sms_inbound_unresolved (provider_sid, account_sid, legal_entity_id, run_id, reason, code)
    values (v_sid, p_account_sid, v_entity, p_run_id, 'unrouted', null) on conflict (provider_sid) do nothing;
    return jsonb_build_object('outcome', 'unrouted');
  end if;
  if not exists (select 1 from public.studio_sms_entity_studios es where es.studio_id = v_studio and es.legal_entity_id = v_entity) then
    raise exception 'the receiving location belongs to another business' using errcode = '42501';
  end if;
  if coalesce(p_evidence->>'num_segments', '') ~ '^[0-9]{1,2}$' and (p_evidence->>'num_segments')::int between 1 and 20 then v_segments := (p_evidence->>'num_segments')::int; end if;
  if coalesce(p_evidence->>'num_media', '') ~ '^[0-9]{1,2}$' and (p_evidence->>'num_media')::int between 0 and 10 then v_media := (p_evidence->>'num_media')::int; end if;
  if v_received is not null and (v_received > now() + interval '5 minutes' or v_received < now() - interval '400 days') then
    v_received := null;
  end if;
  v_basis := case when v_keyword then 'keyword'
                  when v_segments is null or v_media is null or v_received is null then 'incomplete'
                  when v_class_in = 'ordinary' then 'ordinary'
                  else 'uncertain' end;
  v_class := case when v_basis = 'ordinary' then 'ordinary' else 'compliance' end;
  v_seen := exists (select 1 from public.sms_webhook_receipts w where w.kind = 'inbound' and w.event_key = v_sid);
  r := public.tw4_inbound_record(v_studio, p_account_sid, v_sid, coalesce(v_segments, 1), coalesce(v_media, 0), v_class, null, coalesce(v_received, now()), 'reconciler');
  if coalesce((r->>'replayed')::boolean, false) then
    return jsonb_build_object('outcome', 'already_recorded');
  end if;
  if coalesce((r->>'recorded')::boolean, false) is not true then
    return jsonb_build_object('outcome', 'not_recorded', 'reason', coalesce(r->>'reason', 'unknown'));
  end if;
  -- Consent, ordered by TWILIO'S OWN message times, never by when recovery runs or by database clocks. For a recovered STOP the app reads (read-only, the
  -- subaccount's credentials) the same texter's later messages to that number and reports the latest later STOP/START keyword (later_keyword:
  -- 'start' | 'stop' | 'none', or 'unknown' when the lookup failed, was incomplete or tied in the same second):
  --   a later START           -> not applied: the person's newer choice stands (listed)
  --   no later keyword / STOP -> applied (idempotent if the webhook already applied it; the webhook records usage only after a successful consent change,
  --                              so a STOP whose consent change failed is recovered here)
  --   anything unproven       -> applied (fail closed) and listed for a person (missing or implausible STOP time, failed lookup, tie)
  -- DanceFlow's own record of a CONTACT-originated opt-in is a second, independent signal (it also catches custom Advanced Opt-Out opt-in keywords the
  -- provider lookup cannot recognise, and a START the provider list does not show yet): an inbound START in the consent history or an inbound 'start'
  -- message logged by the webhook, for this studio and number. Those times are the database's clock when the webhook ran, so more than 2 minutes after
  -- the STOP's own time is newer; within 2 minutes the order is not provable (applied, listed).
  -- Staff and public opt-ins never override a texted STOP (TW-2: only the contact can resubscribe; a web form never reverses an opt-out), so they are
  -- not consulted. A recovered START is never applied. Without a usable sender number nothing can be applied (listed).
  if v_kind = 'stop' then
    if v_from is not null and v_from ~ '^\+[1-9][0-9]{9,14}$' and v_received is not null then
      select max(t.at) into v_contact_start from (
        select h.changed_at at from public.sms_consent_history h where h.studio_id = v_studio and h.phone_e164 = v_from and h.event_type = 'inbound_start'
                                                                   and h.changed_at >= v_received - interval '2 minutes'
        union all
        select l.sent_at from public.sms_message_logs l where l.studio_id = v_studio and l.phone_e164 = v_from and l.direction = 'inbound' and l.message_type = 'start'
                                                        and l.sent_at >= v_received - interval '2 minutes') t;
    end if;
    if v_from is null or v_from !~ '^\+[1-9][0-9]{9,14}$' then
      v_note := 'not_applied_no_number';
    elsif v_received is null then
      v_note := 'applied_order_unverified';
    elsif v_later = 'start' or v_contact_start > v_received + interval '2 minutes' then
      v_note := 'not_applied_newer_start';
    elsif v_contact_start is not null then
      v_note := 'applied_order_unverified';
    elsif v_later in ('none', 'stop') then
      v_note := 'applied';
    else
      v_note := 'applied_order_unverified';
    end if;
    v_applied := v_note like 'applied%';
    if v_applied then
      perform public.record_sms_inbound_opt_event(v_studio, v_from, 'stop');
    end if;
  end if;
  insert into public.studio_sms_inbound_recoveries (provider_sid, account_sid, legal_entity_id, studio_id, run_id, classification, basis, webhook_seen, consent_applied,
                                                    consent_note, possible_opt_out, charged_cents)
  values (v_sid, p_account_sid, v_entity, v_studio, p_run_id, v_class, v_basis, v_seen, v_applied, v_note, v_possible and v_kind is null, coalesce((r->>'charged_cents')::int, 0));
  return jsonb_build_object('outcome', 'recovered', 'classification', v_class, 'basis', v_basis, 'webhook_seen', v_seen, 'keyword_kind', v_kind, 'consent_applied', v_applied, 'consent_note', v_note,
                            'charged_cents', coalesce((r->>'charged_cents')::int, 0), 'uncollected_cents', coalesce((r->>'uncollected_cents')::int, 0));
end $$;

drop function if exists public.tw4_inbound_start_sids(text, text, text[]);
drop function if exists public.sms_inbound_start_signal_record(uuid, text, text);
drop table if exists public.studio_sms_inbound_start_signals;

notify pgrst, 'reload schema';

commit;
