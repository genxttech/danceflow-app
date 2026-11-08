-- 20261201090000_twilio_sms_usage_financials.sql
-- SMS usage financial integration (owner direction 2026-10-20; design docs/twilio/TW-4F_Usage_Financials_Design.md v2).
--   * A text for a studio of a verified legal business is BILLED: it is sent only from the business's own Twilio subaccount and approved sender, after an atomic
--     reservation of its estimated cost (segments computed here from the stored body x the published per-segment price) under the credit account lock, with funds,
--     hold, monthly limit, platform ceiling, sender approval, recurring suspension and a database kill switch all checked in the same transaction.
--   * One attempt per SOURCE (outbound delivery or manual-send idempotency key); begin creates the message log row and the attempt together, so a retry is a replay.
--   * Money moves only on provider EVIDENCE (the Message resource read by the reconciler) or a platform admin's written resolution; callbacks bind the SID and record
--     status only. Definite provider refusals release; uncertain outcomes keep the reservation and are never refunded automatically.
--   * Settlement releases the reservation and posts one usage_charge linked to it; the month's spending attributes that charge to the reservation's month.
--   * Ledger history is untouched. Requires 20261128090000 (monthly limits). Rollback: rollback/20261201090000_twilio_sms_usage_financials_rollback.sql
--     (refuses once any attempt, billed sender or switch row exists). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_monthly_limits') is null or to_regprocedure('public._tw4ml_require_room(uuid,bigint,bigint)') is null then
    raise exception 'usage-financials precondition failed: monthly limits (20261128090000) is not applied';
  end if;
  if to_regclass('public.studio_sms_usage_attempts') is not null then
    raise exception 'usage-financials precondition failed: already applied';
  end if;
end $$;

-- audit vocabulary (the 20261128090000 list plus three actions)
alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount',
  'credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set', 'credit_pilot_exception', 'spend_withdrawn',
  'recurring_authorized', 'recurring_revoked', 'recurring_charged', 'recurring_unfunded', 'recurring_held', 'recurring_refused',
  'monthly_limit_set', 'monthly_limit_ceiling', 'entity_timezone_set',
  'usage_switch', 'usage_sender_set', 'usage_resolved'));

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges)
-- ---------------------------------------------------------------------------------------------------------------
-- database kill switch for billed sending: append-only, the latest row wins, no row = OFF
create table public.studio_sms_usage_switch_log (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null,
  changed_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  changed_at timestamptz not null default now()
);

-- the subaccount's own approved Messaging Service per studio (platform admin; the registration runner's campaign step will feed it later). Append-only, latest wins.
create table public.studio_sms_billed_senders (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  studio_id uuid not null,
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  messaging_service_sid text not null check (messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  sender_e164 text null check (sender_e164 is null or sender_e164 ~ '^\+1[2-9][0-9]{9}$'),
  status text not null check (status in ('approved', 'revoked')),
  set_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  created_at timestamptz not null default now(),
  constraint studio_sms_billed_senders_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_billed_senders_lookup on public.studio_sms_billed_senders (studio_id, created_at desc);

create table public.studio_sms_usage_attempts (
  id uuid primary key,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  studio_id uuid not null,
  source_kind text not null check (source_kind in ('delivery', 'manual')),
  source_id uuid not null,
  message_log_id uuid not null unique references public.sms_message_logs(id),
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  messaging_service_sid text not null check (messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  estimated_segments int not null check (estimated_segments between 1 and 10),
  unit_price_cents int not null check (unit_price_cents > 0),
  unit_provider_cost_cents int not null check (unit_provider_cost_cents >= 0),
  price_list_id uuid not null references public.studio_sms_price_list(id),
  reserved_cents int not null check (reserved_cents > 0),
  reservation_id uuid not null unique references public.studio_sms_credit_reservations(id),
  state text not null check (state in ('reserved', 'submitting', 'submitted', 'unknown', 'review', 'released', 'settled')),
  provider_sid text null unique check (provider_sid is null or provider_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  submit_error_code text null check (submit_error_code is null or char_length(submit_error_code) <= 40),
  callback_status text null check (callback_status is null or char_length(callback_status) <= 40),
  callback_rank int not null default 0,
  callback_at timestamptz null,
  evidence_status text null check (evidence_status is null or char_length(evidence_status) <= 40),
  evidence_segments int null,
  evidence_media int null,
  evidence_price_micros numeric null check (evidence_price_micros is null or evidence_price_micros >= 0),
  evidence_price_unit text null check (evidence_price_unit is null or char_length(evidence_price_unit) <= 10),
  evidence_at timestamptz null,
  review_reason text null check (review_reason is null or char_length(review_reason) <= 200),
  charged_cents int null check (charged_cents is null or charged_cents >= 0),
  resolved_by uuid null,
  resolved_outcome text null check (resolved_outcome is null or resolved_outcome in ('released', 'charged')),
  resolve_note text null check (resolve_note is null or char_length(resolve_note) <= 300),
  created_at timestamptz not null default now(),
  submitting_at timestamptz null,
  submitted_at timestamptz null,
  last_reconciled_at timestamptz null,
  closed_at timestamptz null,
  constraint studio_sms_usage_attempts_source unique (source_kind, source_id),
  constraint studio_sms_usage_attempts_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id),
  constraint studio_sms_usage_attempts_settled check ((state = 'settled') = (charged_cents is not null)),
  constraint studio_sms_usage_attempts_closed check ((state in ('released', 'settled')) = (closed_at is not null) or (state = 'submitted' and resolved_outcome = 'released'))
);
create index studio_sms_usage_attempts_open on public.studio_sms_usage_attempts (state, created_at) where state in ('reserved', 'submitting', 'submitted', 'unknown', 'review');
create index studio_sms_usage_attempts_entity on public.studio_sms_usage_attempts (legal_entity_id, created_at);

revoke all on public.studio_sms_usage_switch_log, public.studio_sms_billed_senders, public.studio_sms_usage_attempts from public, anon, authenticated, service_role;
alter table public.studio_sms_usage_switch_log enable row level security;
alter table public.studio_sms_billed_senders enable row level security;
alter table public.studio_sms_usage_attempts enable row level security;

create or replace function public._tw4us_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
-- attempts change only inside the functions below (they set tw4.usage_write for their own transaction); never deleted
create or replace function public._tw4us_attempt_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'usage attempts are never deleted' using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.usage_write', true), '') <> 'on' then
    raise exception 'usage attempts change only through the usage functions' using errcode = '42501';
  end if;
  if new.id <> old.id or new.legal_entity_id <> old.legal_entity_id or new.studio_id <> old.studio_id or new.source_kind <> old.source_kind or new.source_id <> old.source_id
     or new.message_log_id <> old.message_log_id or new.account_sid <> old.account_sid or new.reservation_id <> old.reservation_id or new.reserved_cents <> old.reserved_cents
     or new.unit_price_cents <> old.unit_price_cents or new.estimated_segments <> old.estimated_segments or new.messaging_service_sid <> old.messaging_service_sid
     or new.price_list_id <> old.price_list_id or new.unit_provider_cost_cents <> old.unit_provider_cost_cents or new.created_at <> old.created_at
     or (old.provider_sid is not null and new.provider_sid is distinct from old.provider_sid)
     or (old.state = 'settled') then
    raise exception 'a usage attempt''s identity, money and settled outcome are final' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger studio_sms_usage_switch_log_guard before update or delete on public.studio_sms_usage_switch_log for each row execute function public._tw4us_append_only();
create trigger studio_sms_billed_senders_guard before update or delete on public.studio_sms_billed_senders for each row execute function public._tw4us_append_only();
create trigger studio_sms_usage_attempts_guard before update or delete on public.studio_sms_usage_attempts for each row execute function public._tw4us_attempt_guard();
create trigger studio_sms_usage_switch_log_truncate before truncate on public.studio_sms_usage_switch_log for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_billed_senders_truncate before truncate on public.studio_sms_billed_senders for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_usage_attempts_truncate before truncate on public.studio_sms_usage_attempts for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------
-- segments of a body (same rule as src/lib/sms/segments.ts): GSM-7 when every character is in the basic set or the extension table (2 septets each,
-- 152 per part when any is present), otherwise UCS-2 in UTF-16 code units; 160/153 and 70/67 per part.
create or replace function public._tw4us_segments(p_body text)
returns int language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_basic text := '@£$¥èéùìòÇ' || chr(10) || 'Øø' || chr(13) || 'ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_ext text := '^{}\[~]|€' || chr(12);
  v_len int := char_length(coalesce(p_body, ''));
  v_ext_count int;
  v_units int;
begin
  if v_len = 0 then
    return 0;
  end if;
  if translate(p_body, v_basic || v_ext, '') = '' then
    v_ext_count := v_len - char_length(translate(p_body, v_ext, ''));
    v_units := v_len + v_ext_count;
    if v_units <= 160 then return 1; end if;
    return ceil(v_units::numeric / (case when v_ext_count > 0 then 152 else 153 end))::int;
  end if;
  select v_len + count(*) into v_units from regexp_split_to_table(p_body, '') c where ascii(c) > 65535;   -- astral characters are two UTF-16 units
  if v_units <= 70 then return 1; end if;
  return ceil(v_units::numeric / 67)::int;
end $$;

create or replace function public._tw4us_switch_on()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce((select l.enabled from public.studio_sms_usage_switch_log l order by l.changed_at desc, l.id desc limit 1), false); $$;

create or replace function public._tw4us_write()
returns void language sql
set search_path = pg_catalog, public, pg_temp
as $$ select set_config('tw4.usage_write', 'on', true); $$;

-- delivery-status ranking: a status is recorded only when it ranks above the one already seen (a late 'sent' never overwrites 'delivered')
create or replace function public._tw4us_rank(p_status text)
returns int language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case lower(coalesce(p_status, ''))
    when 'accepted' then 1 when 'scheduled' then 1 when 'queued' then 1
    when 'sending' then 2 when 'sent' then 3
    when 'delivered' then 4 when 'undelivered' then 4 when 'failed' then 4 when 'canceled' then 4
    when 'read' then 5
    else 0 end;
$$;

-- releases the open reservation of an attempt (caller holds the account lock and the attempt row)
create or replace function public._tw4us_release_reservation(a public.studio_sms_usage_attempts, p_ref text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare r public.studio_sms_credit_reservations;
begin
  select * into r from public.studio_sms_credit_reservations x where x.id = a.reservation_id for update;
  if r.status = 'reserved' then
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, p_ref, null, null);
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
  end if;
end $$;

-- charges an attempt at N segments: the reservation (if still open) is released and ONE usage_charge linked to it is posted. The charge may exceed the reservation
-- and may take the balance below zero: the message went out and its cost was incurred.
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

-- the attempt with its business locked (entity row, then the account, then the attempt), or raises
create or replace function public._tw4us_lock_attempt(p_attempt uuid)
returns public.studio_sms_usage_attempts language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_usage_attempts;
begin
  select * into a from public.studio_sms_usage_attempts x where x.id = p_attempt;
  if a.id is null then
    raise exception 'unknown usage attempt' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = a.legal_entity_id for share;
  perform public._tw4c_lock(a.legal_entity_id);
  select * into a from public.studio_sms_usage_attempts x where x.id = p_attempt for update;
  perform public._tw4us_write();
  return a;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- month spending: open sms reservations count in the month they were made; a usage charge linked to a reservation belongs to the reservation's month
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4ml_month_parts(p_entity uuid, p_key text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s timestamptz := public._tw4ml_month_start(p_entity, p_key);
  e timestamptz := public._tw4ml_month_start(p_entity, public._tw4ml_key_add(p_key, 1));
  v_usage bigint;
  v_recurring bigint;
  v_reserved bigint;
begin
  select coalesce(sum(-l.balance_delta_cents), 0) into v_usage from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind in ('usage_charge', 'usage_refund')
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  -- a captured recurring fee belongs to the month its funds were reserved in (a set-aside captured by a later month's charge is NOT counted a second time there)
  select coalesce(sum(-l.balance_delta_cents), 0) into v_recurring from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind = 'capture' and (l.idempotency_key like 'capture:rec:%' or l.idempotency_key like 'capture:commit:%')
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  select coalesce(sum(r.amount_cents), 0) into v_reserved from public.studio_sms_credit_reservations r
   where r.legal_entity_id = p_entity and r.status = 'reserved' and (r.reservation_key like 'rec:%' or r.reservation_key like 'commit:%' or r.reservation_key like 'sms:%')
     and r.created_at >= s and r.created_at < e;
  return jsonb_build_object('usage_cents', v_usage, 'recurring_cents', v_recurring, 'reserved_cents', v_reserved, 'total_cents', v_usage + v_recurring + v_reserved,
                            'starts_at', s, 'ends_at', e);
end $$;

-- the generic admin resolution never touches a recurring set-aside or a text's reservation (those have their own resolution paths)
create or replace function public.tw4_credit_resolve_reservation(p_reservation_id uuid, p_outcome text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_credit_reservations;
  s public.studio_sms_spend_events;
begin
  perform public._tw4c_admin(p_actor);
  if p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'an outcome and a written reason (10+ characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id;
  if r.id is null then
    raise exception 'unknown reservation' using errcode = '22023';
  end if;
  perform public._tw4c_lock(r.legal_entity_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id for update;
  if r.reservation_key like 'commit:%' then
    raise exception 'a recurring set-aside is captured only by its charge and released by revoking the authorization' using errcode = '22023';
  end if;
  if r.reservation_key like 'sms:%' then
    raise exception 'a text''s reservation is resolved only through tw4_usage_resolve' using errcode = '22023';
  end if;
  if (r.status = 'captured' and p_outcome = 'captured') or (r.status = 'released' and p_outcome = 'released') then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
  else
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    select * into s from public.studio_sms_spend_events x where x.credit_reservation_id = r.id;
    if s.id is not null then
      perform set_config('tw4.credit_settle', 'on', true);
      update public.studio_sms_spend_events set status = 'void' where id = s.id;
      perform set_config('tw4.credit_settle', 'off', true);
    end if;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (r.studio_id, null, 'platform_admin', p_actor, case when p_outcome = 'captured' then 'credit_captured' else 'credit_released' end, left('reservation=' || r.id || ';admin', 300));
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

-- the direct usage debit (no reservation) can never write into the billed-text key namespace
create or replace function public.tw4_credit_debit_usage(p_entity_id uuid, p_studio_id uuid, p_cents int, p_key text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
begin
  if p_cents is null or p_cents <= 0 or p_studio_id is null then
    raise exception 'invalid usage amount or location' using errcode = '22023';
  end if;
  if p_key is null or p_key like 'sms:%' then
    raise exception 'this key namespace belongs to billed texts' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  -- a replay of a debit that already happened must succeed even if the account has since run low or the month's limit is used up
  if exists (select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id and l.idempotency_key = 'usage:' || p_key) then
    return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  end if;
  perform public._tw4ml_ensure_tz(p_entity_id);
  perform public._tw4c_require_funds(a, p_cents);
  perform public._tw4ml_require_room(p_entity_id, p_cents);   -- fail closed: funds AND the month's limit
  return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- platform controls
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_usage_set_switch(p_enabled boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a switch change needs a written reason (10+ characters)' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_usage_switch'));
  insert into public.studio_sms_usage_switch_log (enabled, changed_by, reason, changed_at) values (p_enabled, p_actor, btrim(p_reason), clock_timestamp());
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  select es.studio_id, null, 'platform_admin', p_actor, 'usage_switch', left('enabled=' || p_enabled || ';' || btrim(p_reason), 300)
    from public.studio_sms_entity_studios es order by es.linked_at limit 1;
  return jsonb_build_object('enabled', p_enabled);
end $$;

-- records the subaccount's approved Messaging Service for a studio (or revokes it). It must belong to the business's ACTIVE subaccount.
create or replace function public.tw4_usage_billed_sender_set(p_studio_id uuid, p_actor uuid, p_messaging_service_sid text, p_sender_e164 text, p_status text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_account text;
  v_id uuid;
begin
  perform public._tw4c_admin(p_actor);
  if p_status not in ('approved', 'revoked') or p_reason is null or char_length(btrim(p_reason)) < 10
     or p_messaging_service_sid is null or p_messaging_service_sid !~ '^MG[0-9a-fA-F]{32}$'
     or (p_sender_e164 is not null and p_sender_e164 !~ '^\+1[2-9][0-9]{9}$') then
    raise exception 'a valid Messaging Service, status and written reason are required' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'the studio is not linked to a verified legal business' using errcode = 'TW010';
  end if;
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status = 'active';
  if v_account is null then
    raise exception 'the legal business has no active subaccount' using errcode = 'TW015';
  end if;
  insert into public.studio_sms_billed_senders (legal_entity_id, studio_id, account_sid, messaging_service_sid, sender_e164, status, set_by, reason)
  values (v_entity, p_studio_id, v_account, p_messaging_service_sid, p_sender_e164, p_status, p_actor, btrim(p_reason)) returning id into v_id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'platform_admin', p_actor, 'usage_sender_set', left('status=' || p_status || ';account=' || v_account || ';' || btrim(p_reason), 300));
  return jsonb_build_object('billed_sender_id', v_id, 'account_sid', v_account, 'status', p_status);
end $$;

-- 'billed' for a studio of a verified legal business, else 'legacy'
create or replace function public.tw4_usage_studio_mode(p_studio_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select case when exists (select 1 from public.studio_sms_entity_studios es where es.studio_id = p_studio_id) then 'billed' else 'legacy' end; $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the send lifecycle
-- ---------------------------------------------------------------------------------------------------------------
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

-- written BEFORE the provider call: reserved -> submitting. If this fails the app must not send. Only from 'reserved'.
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

-- the provider accepted the message (SID). Also writes the log's provider id in the same transaction.
create or replace function public.tw4_usage_submitted(p_attempt_id uuid, p_provider_sid text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_usage_attempts;
begin
  if p_provider_sid is null or p_provider_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then
    raise exception 'invalid provider message id' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_usage_attempts x where x.id = p_attempt_id for update;
  if a.id is null then
    raise exception 'unknown usage attempt' using errcode = '22023';
  end if;
  if a.provider_sid is not null then
    if a.provider_sid = p_provider_sid then
      return jsonb_build_object('state', a.state, 'replayed', true);
    end if;
    raise exception 'the attempt is bound to another provider message' using errcode = '23505';
  end if;
  if not (a.state in ('submitting', 'unknown') or (a.state = 'released' and a.resolved_outcome = 'released')) then
    raise exception 'the attempt cannot take a provider message in state %', a.state using errcode = '22023';
  end if;
  perform public._tw4us_write();
  -- a SID after an admin released the attempt: the message really went out; it is settled from evidence without a reservation
  update public.studio_sms_usage_attempts
     set provider_sid = p_provider_sid, state = 'submitted', submitted_at = coalesce(submitted_at, clock_timestamp()),
         closed_at = case when state = 'released' then closed_at else null end
   where id = a.id;
  update public.sms_message_logs set provider_message_id = p_provider_sid, updated_at = now() where id = a.message_log_id;
  return jsonb_build_object('state', 'submitted', 'replayed', false);
end $$;

-- a DEFINITE provider refusal (no message was created): the reservation is released. Only while no SID is bound.
create or replace function public.tw4_usage_rejected(p_attempt_id uuid, p_error_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_usage_attempts;
begin
  a := public._tw4us_lock_attempt(p_attempt_id);
  if a.state = 'released' and a.provider_sid is null and a.resolved_outcome is null then
    return jsonb_build_object('state', 'released', 'replayed', true);
  end if;
  if a.provider_sid is not null or a.state not in ('submitting', 'unknown') then
    raise exception 'only an unsent attempt can be released as refused (state %)', a.state using errcode = '22023';
  end if;
  perform public._tw4us_release_reservation(a, 'refused:' || left(coalesce(p_error_code, 'unknown'), 40));
  update public.studio_sms_usage_attempts set state = 'released', submit_error_code = left(p_error_code, 40), closed_at = clock_timestamp() where id = a.id;
  update public.sms_message_logs set status = 'failed', provider_error_code = left(p_error_code, 40), failed_at = now(), updated_at = now() where id = a.message_log_id;
  return jsonb_build_object('state', 'released', 'replayed', false);
end $$;

-- the outcome of the provider call is not known (timeout, 5xx, network, unreadable reply): the reservation stays
create or replace function public.tw4_usage_uncertain(p_attempt_id uuid, p_error_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_usage_attempts;
begin
  select * into a from public.studio_sms_usage_attempts x where x.id = p_attempt_id for update;
  if a.id is null then
    raise exception 'unknown usage attempt' using errcode = '22023';
  end if;
  if a.state <> 'submitting' then
    return jsonb_build_object('state', a.state, 'replayed', true);
  end if;
  perform public._tw4us_write();
  update public.studio_sms_usage_attempts set state = 'unknown', submit_error_code = left(p_error_code, 40) where id = a.id;
  return jsonb_build_object('state', 'unknown', 'replayed', false);
end $$;

-- a verified delivery callback. The signer must be the attempt's own subaccount (a parent-signed callback for a billed text is refused). It may bind the SID of an
-- attempt that has none (the StatusCallback carries the attempt id), records the status monotonically, and never moves money.
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

-- evidence from the provider's Message resource. Charge table on STATUS; the provider price is cost evidence only.
create or replace function public.tw4_usage_settle(p_attempt_id uuid, p_evidence jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  v_status text := lower(coalesce(p_evidence->>'status', ''));
  v_sid text := p_evidence->>'sid';
  v_account text := p_evidence->>'account_sid';
  v_segments int;
  v_media int;
  v_price numeric;
  v_unit text := upper(nullif(btrim(coalesce(p_evidence->>'price_unit', '')), ''));
  v_review text;
  v_cents int;
begin
  a := public._tw4us_lock_attempt(p_attempt_id);
  if a.state = 'settled' then
    return jsonb_build_object('outcome', 'settled', 'charged_cents', a.charged_cents, 'replayed', true);
  end if;
  if a.state <> 'submitted' or a.provider_sid is null then
    raise exception 'only a submitted text is settled from evidence (state %)', a.state using errcode = '22023';
  end if;
  if v_sid is distinct from a.provider_sid or v_account is distinct from a.account_sid then
    raise exception 'the evidence is for another message or account' using errcode = '42501';
  end if;
  if coalesce(p_evidence->>'num_segments', '') ~ '^[0-9]{1,3}$' then v_segments := (p_evidence->>'num_segments')::int; end if;
  if coalesce(p_evidence->>'num_media', '') ~ '^[0-9]{1,3}$' then v_media := (p_evidence->>'num_media')::int; end if;
  if coalesce(p_evidence->>'price', '') ~ '^-?[0-9]{1,6}(\.[0-9]{1,10})?$' then v_price := abs((p_evidence->>'price')::numeric) * 1000000; end if;
  update public.studio_sms_usage_attempts
     set evidence_status = left(v_status, 40), evidence_segments = v_segments, evidence_media = v_media, evidence_price_micros = v_price,
         evidence_price_unit = left(v_unit, 10), evidence_at = clock_timestamp(), last_reconciled_at = clock_timestamp()
   where id = a.id;

  if v_status in ('failed', 'canceled') then
    perform public._tw4us_release_reservation(a, 'not_charged:' || v_status);
    update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 0, closed_at = clock_timestamp() where id = a.id;
    update public.sms_message_logs set status = 'failed', failed_at = now(), updated_at = now() where id = a.message_log_id;
    return jsonb_build_object('outcome', 'settled', 'charged_cents', 0, 'replayed', false);
  elsif a.provider_sid like 'MM%' or coalesce(v_media, 0) > 0 then
    v_review := 'multimedia message';
  elsif v_price is not null and v_unit is distinct from 'USD' then
    v_review := 'price not in USD';
  elsif v_status in ('delivered', 'undelivered', 'read') or (v_status = 'sent' and a.submitted_at < now() - interval '72 hours') then
    if v_segments is null or v_segments < 1 or v_segments > 10 or v_segments > a.estimated_segments + 2 then
      v_review := 'segment count outside the expected range';
    else
      v_cents := public._tw4us_charge(a, v_segments, 'evidence:' || v_status);
      update public.studio_sms_usage_attempts set state = 'settled', charged_cents = v_cents, closed_at = clock_timestamp() where id = a.id;
      update public.sms_message_logs set status = case when v_status = 'undelivered' then 'failed' when v_status = 'sent' then 'sent' else 'delivered' end,
             segment_count = v_segments, delivered_at = case when v_status in ('delivered', 'read') then coalesce(delivered_at, now()) else delivered_at end, updated_at = now()
       where id = a.message_log_id;
      return jsonb_build_object('outcome', 'settled', 'charged_cents', v_cents, 'replayed', false);
    end if;
  elsif v_status in ('accepted', 'scheduled', 'queued', 'sending', 'sent') then
    return jsonb_build_object('outcome', 'pending', 'replayed', false);
  else
    v_review := 'unrecognized provider status';
  end if;
  update public.studio_sms_usage_attempts set state = 'review', review_reason = v_review, closed_at = null where id = a.id;
  return jsonb_build_object('outcome', 'review', 'reason', v_review, 'replayed', false);
end $$;

-- an attempt still 'reserved' 10 minutes after begin never reached the provider (the dispatch marker comes first): released. Returns how many.
create or replace function public.tw4_usage_release_unsent()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r record;
  a public.studio_sms_usage_attempts;
  n int := 0;
begin
  for r in select x.id from public.studio_sms_usage_attempts x where x.state = 'reserved' and x.created_at < now() - interval '10 minutes' order by x.legal_entity_id, x.created_at loop
    a := public._tw4us_lock_attempt(r.id);
    if a.state = 'reserved' then
      perform public._tw4us_release_reservation(a, 'never_sent');
      update public.studio_sms_usage_attempts set state = 'released', closed_at = clock_timestamp() where id = a.id;
      update public.sms_message_logs set status = 'failed', provider_error_code = 'not_sent', failed_at = now(), updated_at = now() where id = a.message_log_id;
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('released', n);
end $$;

-- a platform admin's written resolution of an attempt whose outcome cannot be established from evidence. Never within 15 minutes of begin (a request may still be in flight).
create or replace function public.tw4_usage_resolve(p_attempt_id uuid, p_actor uuid, p_outcome text, p_segments int, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  v_cents int;
begin
  perform public._tw4c_admin(p_actor);
  if p_outcome not in ('released', 'charged', 'not_charged') or p_reason is null or char_length(btrim(p_reason)) < 10
     or (p_outcome = 'charged' and (p_segments is null or p_segments not between 1 and 10)) then
    raise exception 'an outcome, a written reason (10+ characters) and, for a charge, 1 to 10 segments are required' using errcode = '22023';
  end if;
  a := public._tw4us_lock_attempt(p_attempt_id);
  if a.state not in ('submitting', 'unknown', 'review', 'submitted') then
    raise exception 'the attempt is not awaiting resolution (state %)', a.state using errcode = '22023';
  end if;
  if coalesce(a.submitting_at, a.created_at) > now() - interval '15 minutes' then
    raise exception 'too early: the provider request may still be in flight' using errcode = '22023';
  end if;
  if p_outcome = 'not_charged' then
    -- a text that reached the provider but is not billable (for example a failed multimedia message): closed with no charge, the reservation released
    if a.provider_sid is null then
      raise exception 'a text without a provider message is released, not closed as not charged' using errcode = '22023';
    end if;
    perform public._tw4us_release_reservation(a, 'admin_not_charged');
    update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 0, resolved_by = p_actor, resolved_outcome = 'charged',
           resolve_note = left(btrim(p_reason), 300), closed_at = clock_timestamp() where id = a.id;
  elsif p_outcome = 'released' then
    if a.provider_sid is not null then
      raise exception 'a text with a provider message is settled from evidence, charged or closed as not charged, not released' using errcode = '22023';
    end if;
    perform public._tw4us_release_reservation(a, 'admin');
    update public.studio_sms_usage_attempts set state = 'released', resolved_by = p_actor, resolved_outcome = 'released', resolve_note = left(btrim(p_reason), 300),
           closed_at = clock_timestamp() where id = a.id;
  else
    v_cents := public._tw4us_charge(a, p_segments, 'admin');
    update public.studio_sms_usage_attempts set state = 'settled', charged_cents = v_cents, resolved_by = p_actor, resolved_outcome = 'charged',
           resolve_note = left(btrim(p_reason), 300), closed_at = clock_timestamp() where id = a.id;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'platform_admin', p_actor, 'usage_resolved', left('attempt=' || a.id || ';outcome=' || p_outcome || coalesce(';segments=' || p_segments, '') || ';' || btrim(p_reason), 300));
  return jsonb_build_object('state', case when p_outcome = 'released' then 'released' else 'settled' end, 'charged_cents', coalesce(v_cents, 0));
end $$;

-- the reconciler's work list: submitted texts not read in the last 10 minutes (oldest first), with what is needed to read the evidence
create or replace function public.tw4_usage_due(p_limit int default 100)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('attempt_id', x.id, 'account_sid', x.account_sid, 'provider_sid', x.provider_sid) order by x.last_reconciled_at nulls first, x.submitted_at)
    from (select * from public.studio_sms_usage_attempts y
           where y.state = 'submitted' and y.provider_sid is not null and (y.last_reconciled_at is null or y.last_reconciled_at < now() - interval '10 minutes')
           order by y.last_reconciled_at nulls first, y.submitted_at limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;

-- the reconciler could not read or settle this text: stamp it so it goes to the back of the queue (no other change)
create or replace function public.tw4_usage_touch(p_attempt_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4us_write();
  update public.studio_sms_usage_attempts set last_reconciled_at = clock_timestamp() where id = p_attempt_id and state = 'submitted';
end $$;

-- every text's money must agree with its attempt: counts the exceptions (0 = reconciled)
create or replace function public._tw4us_reconciliation_gaps()
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    -- an open attempt whose reservation is not open (except a text that went out after an admin released it)
    (select count(*) from public.studio_sms_usage_attempts a join public.studio_sms_credit_reservations r on r.id = a.reservation_id
      where a.state in ('reserved', 'submitting', 'submitted', 'unknown', 'review') and r.status <> 'reserved' and a.resolved_outcome is distinct from 'released')
    -- a closed attempt whose reservation is still open
    + (select count(*) from public.studio_sms_usage_attempts a join public.studio_sms_credit_reservations r on r.id = a.reservation_id
        where a.state in ('released', 'settled') and r.status = 'reserved')
    -- a settled charge without exactly its usage entry
    + (select count(*) from public.studio_sms_usage_attempts a
        where a.state = 'settled' and a.charged_cents > 0 and not exists (
          select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = a.legal_entity_id and l.idempotency_key = 'usage:sms:' || a.id and l.balance_delta_cents = -a.charged_cents))
    -- a usage entry for a text that is not settled with that amount
    + (select count(*) from public.studio_sms_credit_ledger l
        where l.kind = 'usage_charge' and l.idempotency_key like 'usage:sms:%' and not exists (
          select 1 from public.studio_sms_usage_attempts a where 'usage:sms:' || a.id = l.idempotency_key and a.state = 'settled' and a.charged_cents = -l.balance_delta_cents))
    -- a text reservation without an attempt
    + (select count(*) from public.studio_sms_credit_reservations r
        where r.reservation_key like 'sms:%' and not exists (select 1 from public.studio_sms_usage_attempts a where a.reservation_id = r.id));
$$;

-- platform view: counts only (no bodies, no numbers, no SIDs)
create or replace function public.sms_usage_admin_overview(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return jsonb_build_object(
    'switch_on', public._tw4us_switch_on(),
    'by_state', coalesce((select jsonb_object_agg(s.state, s.n) from (select state, count(*) n from public.studio_sms_usage_attempts group by state) s), '{}'::jsonb),
    'overdue', (select count(*) from public.studio_sms_usage_attempts x where x.state in ('reserved', 'submitting', 'submitted', 'unknown', 'review') and x.created_at < now() - interval '7 days'),
    'needs_admin', (select count(*) from public.studio_sms_usage_attempts x where x.state = 'review' or (x.state in ('unknown', 'submitting') and x.created_at < now() - interval '15 minutes')),
    'reconciliation_gaps', public._tw4us_reconciliation_gaps());
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: internal helpers for nobody; every action for the service role only (admin actions also check the actor)
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4us_append_only(), public._tw4us_attempt_guard(), public._tw4us_segments(text), public._tw4us_switch_on(), public._tw4us_write(),
  public._tw4us_rank(text), public._tw4us_release_reservation(public.studio_sms_usage_attempts, text), public._tw4us_charge(public.studio_sms_usage_attempts, int, text),
  public._tw4us_lock_attempt(uuid), public._tw4us_reconciliation_gaps() from public, anon, authenticated, service_role;
revoke all on function public.tw4_usage_set_switch(boolean, uuid, text), public.tw4_usage_billed_sender_set(uuid, uuid, text, text, text, text), public.tw4_usage_studio_mode(uuid),
  public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid), public.tw4_usage_dispatching(uuid), public.tw4_usage_submitted(uuid, text),
  public.tw4_usage_rejected(uuid, text), public.tw4_usage_uncertain(uuid, text), public.tw4_usage_record_callback(uuid, text, text, text, text), public.tw4_usage_settle(uuid, jsonb),
  public.tw4_usage_release_unsent(), public.tw4_usage_resolve(uuid, uuid, text, int, text), public.tw4_usage_due(int), public.sms_usage_admin_overview(uuid),
  public.tw4_usage_touch(uuid)
  from public, anon, authenticated;
grant execute on function public.tw4_usage_set_switch(boolean, uuid, text), public.tw4_usage_billed_sender_set(uuid, uuid, text, text, text, text), public.tw4_usage_studio_mode(uuid),
  public.tw4_usage_begin(text, uuid, uuid, uuid, text, text, text, text, uuid, uuid), public.tw4_usage_dispatching(uuid), public.tw4_usage_submitted(uuid, text),
  public.tw4_usage_rejected(uuid, text), public.tw4_usage_uncertain(uuid, text), public.tw4_usage_record_callback(uuid, text, text, text, text), public.tw4_usage_settle(uuid, jsonb),
  public.tw4_usage_release_unsent(), public.tw4_usage_resolve(uuid, uuid, text, int, text), public.tw4_usage_due(int), public.sms_usage_admin_overview(uuid),
  public.tw4_usage_touch(uuid)
  to service_role;

commit;
