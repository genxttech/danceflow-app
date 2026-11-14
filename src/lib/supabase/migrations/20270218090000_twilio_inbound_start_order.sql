-- TW-4F compliance: a recovered STOP is ordered against a START by TWILIO'S message times, never by when DanceFlow processed the START. GIT-ONLY: not applied
-- anywhere. Apply this SQL before the app (an app without it keeps the old behaviour; see the rollback file for the reverse order).
--
-- Defects fixed (owner pre-activation items, 2026-10-21):
--   (2) tw4_inbound_recover treated DanceFlow's own START record (consent history changed_at, message log sent_at: both the webhook's processing time) more
--       than 2 minutes after the STOP's provider time as a NEWER START and did not apply the STOP. A START sent BEFORE the STOP but delivered or processed
--       late therefore suppressed the opt-out: a texter who opted out could keep receiving texts. Now such a record can only make the STOP
--       'applied_order_unverified' (applied, fail closed, listed for a person); only a START that the provider's own times place after the STOP
--       (later_keyword 'start') leaves it unapplied.
--   (1) a custom Advanced Opt-Out opt-in keyword (OptOutType START) from a texter with no client/contact row left no DanceFlow record, so the provider lookup
--       could not recognise it and an older recovered STOP was noted plain 'applied'. The webhook now records every START it handles, by MessageSid, in
--       studio_sms_inbound_start_signals; the reconciler asks tw4_inbound_start_sids which of the texter's later messages were such STARTs and orders them by
--       Twilio's own date_created. A signal that the provider lookup cannot place still lists the STOP (applied_order_unverified).
-- Residual (unchanged, documented): the live webhook applies STOP/START in the order it receives them, and a START supersedes a parked pending opt-out
-- (20270215100000) in that same order; Twilio Advanced Opt-Out keeps its own carrier-level order.
--
-- Service-role only. No client-visible grants. Nothing here sends a text or calls a provider. Idempotent.

begin;

do $$
begin
  if to_regprocedure('public.tw4_inbound_recover(uuid, text, jsonb)') is null or to_regclass('public.studio_sms_entity_studios') is null then
    raise exception '20270218090000 requires 20261205090000 (public.tw4_inbound_recover)';
  end if;
end $$;

-- one row per START the webhook handled: no body, no identity beyond studio + number (the same scope as a phone-level opt-out row)
create table if not exists public.studio_sms_inbound_start_signals (
  studio_id uuid not null references public.studios(id) on delete cascade,
  message_sid text not null check (message_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{9,14}$'),
  processed_at timestamptz not null default now(),
  primary key (studio_id, message_sid)
);
create index if not exists ix_studio_sms_inbound_start_signals_phone on public.studio_sms_inbound_start_signals (studio_id, phone_e164, processed_at);

alter table public.studio_sms_inbound_start_signals enable row level security;
revoke all on public.studio_sms_inbound_start_signals from public, anon, authenticated, service_role;

-- the webhook's write: true when recorded (or already recorded), false for an invalid input (validated here, so no error text echoes the number)
create or replace function public.sms_inbound_start_signal_record(p_studio_id uuid, p_phone_e164 text, p_message_sid text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_phone text := btrim(coalesce(p_phone_e164, ''));
  v_sid text := btrim(coalesce(p_message_sid, ''));
begin
  if p_studio_id is null or v_phone !~ '^\+[1-9][0-9]{9,14}$' or v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$'
     or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    return false;
  end if;
  insert into public.studio_sms_inbound_start_signals (studio_id, message_sid, phone_e164)
  values (p_studio_id, v_sid, v_phone)
  on conflict (studio_id, message_sid) do nothing;
  -- bounded retention: recovery never orders a STOP older than 400 days (tw4_inbound_recover treats it as having no usable time)
  delete from public.studio_sms_inbound_start_signals
   where (studio_id, message_sid) in (select g.studio_id, g.message_sid from public.studio_sms_inbound_start_signals g
                                       where g.processed_at < now() - interval '400 days' limit 100);
  return true;
end $$;

-- the reconciler's read: which of these listed message SIDs DanceFlow's webhook handled as a START from this texter, in a location of this subaccount's
-- legal business (a START signal, or an inbound 'start' message log, which predates the signals). Read-only; at most 1000 SIDs per call.
create or replace function public.tw4_inbound_start_sids(p_account_sid text, p_from text, p_sids text[])
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_from text := btrim(coalesce(p_from, ''));
begin
  if p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$' or v_from !~ '^\+[1-9][0-9]{9,14}$' or p_sids is null or cardinality(p_sids) > 1000 then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select t.legal_entity_id into v_entity from public.studio_sms_twilio_accounts t where t.twilio_account_sid = p_account_sid and t.status in ('active', 'suspended');
  if v_entity is null then
    raise exception 'not an active subaccount of a legal business' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x.sid order by x.sid)
      from (select distinct unnest(p_sids) sid) x
     where x.sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'
       and (exists (select 1 from public.studio_sms_inbound_start_signals g join public.studio_sms_entity_studios es on es.studio_id = g.studio_id
                     where g.message_sid = x.sid and g.phone_e164 = v_from and es.legal_entity_id = v_entity)
            or exists (select 1 from public.sms_message_logs l join public.studio_sms_entity_studios es on es.studio_id = l.studio_id
                        where l.provider_message_id = x.sid and l.phone_e164 = v_from and l.direction = 'inbound' and l.message_type = 'start'
                          and es.legal_entity_id = v_entity))), '[]'::jsonb);
end $$;

revoke all on function public.sms_inbound_start_signal_record(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.tw4_inbound_start_sids(text, text, text[]) from public, anon, authenticated, service_role;
grant execute on function public.sms_inbound_start_signal_record(uuid, text, text) to service_role;
grant execute on function public.tw4_inbound_start_sids(text, text, text[]) to service_role;

-- Recovery of a texted STOP: identical to 20261205090000 except the consent order (comments marked 20270218090000). create or replace keeps its privileges.
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
  --   a later START           -> not applied: the person's newer choice stands (listed). The app counts a later message as a START when its body is a START
  --                              keyword OR when DanceFlow's webhook handled that very message as a START (its SID is in studio_sms_inbound_start_signals or
  --                              an inbound 'start' message log), so a custom Advanced Opt-Out opt-in keyword is ordered by Twilio's time too (20270218090000)
  --   no later keyword / STOP -> applied (idempotent if the webhook already applied it; the webhook records usage only after a successful consent change,
  --                              so a STOP whose consent change failed is recovered here)
  --   anything unproven       -> applied (fail closed) and listed for a person (missing or implausible STOP time, failed lookup, tie)
  -- DanceFlow's own record of a CONTACT-originated opt-in (an inbound START in the consent history, an inbound 'start' message log, or a START signal, for
  -- this studio and number) carries the time the webhook PROCESSED it, never the time the texter sent it: a START sent before the STOP can be delivered
  -- after it. Such a record therefore never suppresses a STOP on its own (20270218090000); when one exists from 2 minutes before the STOP's time onward
  -- and the provider lookup did not prove a later START, the STOP is applied (fail closed) and listed for a person.
  -- Staff and public opt-ins never override a texted STOP (TW-2: only the contact can resubscribe; a web form never reverses an opt-out), so they are
  -- not consulted. A recovered START is never applied. Without a usable sender number nothing can be applied (listed).
  if v_kind = 'stop' then
    if v_from is not null and v_from ~ '^\+[1-9][0-9]{9,14}$' and v_received is not null then
      select max(t.at) into v_contact_start from (
        select h.changed_at at from public.sms_consent_history h where h.studio_id = v_studio and h.phone_e164 = v_from and h.event_type = 'inbound_start'
                                                                   and h.changed_at >= v_received - interval '2 minutes'
        union all
        select l.sent_at from public.sms_message_logs l where l.studio_id = v_studio and l.phone_e164 = v_from and l.direction = 'inbound' and l.message_type = 'start'
                                                        and l.sent_at >= v_received - interval '2 minutes'
        union all
        select g.processed_at from public.studio_sms_inbound_start_signals g where g.studio_id = v_studio and g.phone_e164 = v_from
                                                                         and g.processed_at >= v_received - interval '2 minutes') t;
    end if;
    if v_from is null or v_from !~ '^\+[1-9][0-9]{9,14}$' then
      v_note := 'not_applied_no_number';
    elsif v_received is null then
      v_note := 'applied_order_unverified';
    elsif v_later = 'start' then
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

-- PostgREST caches the schema: reload it so the new functions are callable at once (a stale cache answers PGRST202, which the app treats as "not installed").
notify pgrst, 'reload schema';

commit;
