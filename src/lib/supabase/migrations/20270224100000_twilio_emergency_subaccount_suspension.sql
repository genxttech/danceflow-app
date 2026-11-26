-- TW-4F slice E: DanceFlow traffic hold and EMERGENCY Twilio subaccount suspension / reactivation (design: docs/twilio/TW-4F_Emergency_Subaccount_Suspension.md).
-- NOT APPLIED anywhere; Git only. DARK: the suspension switch is created OFF and only an owner-level statement can change it; the application also needs
-- TW4_SUBACCOUNT_SUSPENSION_CALLS=on (unset everywhere). Nothing here calls Twilio: the provider calls are made by the guarded server action, and only the
-- outcome it observed is recorded here (service role). Suspension is NOT a spending ceiling and NOT a response to low credit; no automated path calls it.
--
--   studio_sms_traffic_hold_events     append-only DanceFlow-level hold per location (hold / release). While held: no new billed text and no dispatch of a
--                                      reserved one (trigger on studio_sms_usage_attempts, TW080); optional error replies are suppressed by the webhook. Inbound
--                                      recording and STOP / START / HELP (and their confirmations) are never affected.
--   studio_sms_suspension_switch       singleton database gate, default OFF (owner-level setter, audited)
--   studio_sms_suspension_attempts     one row per suspend / reactivate request; unique idempotency key; at most one OPEN attempt per legal business
--   studio_sms_suspension_audit        append-only evidence: no UPDATE / DELETE / TRUNCATE for any role (trigger, enabled ALWAYS)
--
-- No existing function is replaced (so no md5 body guard is needed); the one existing object touched is a NEW trigger on studio_sms_usage_attempts.
-- Rollback: rollback/20270224100000_twilio_emergency_subaccount_suspension_rollback.sql (refuses once any evidence row exists: forward-fix only).
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regprocedure('public._tw4price_session_actor(text)') is null or to_regprocedure('public._tw4price_admin_active(uuid)') is null
     or to_regprocedure('public._tw4c_admin(uuid)') is null or to_regclass('public.studio_sms_twilio_accounts') is null
     or to_regclass('public.studio_sms_usage_attempts') is null or to_regclass('public.studio_sms_entity_studios') is null then
    raise exception 'TW4SUSP_PRECONDITION: the TW-4F subaccount (20261121), usage (20261201) and price dual-control (20270210090000) migrations must be applied first';
  end if;
  if to_regclass('public.studio_sms_suspension_attempts') is not null or to_regclass('public.studio_sms_traffic_hold_events') is not null then
    raise exception 'TW4SUSP_PRECONDITION: already applied';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------------
-- (no foreign key to studios: an append-only row must never block or be cascaded by a studio deletion)
create table public.studio_sms_traffic_hold_events (
  seq bigint generated always as identity primary key,
  studio_id uuid not null,
  legal_entity_id uuid null,
  hold boolean not null,
  actor uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  attempt_id uuid null,
  created_at timestamptz not null default clock_timestamp()
);
create index studio_sms_traffic_hold_events_studio on public.studio_sms_traffic_hold_events (studio_id, seq desc);

create table public.studio_sms_suspension_switch (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamptz null,
  updated_by uuid null
);
insert into public.studio_sms_suspension_switch (singleton, enabled) values (true, false);

create table public.studio_sms_suspension_attempts (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (idempotency_key ~ '^[A-Za-z0-9_-]{16,80}$'),
  action text not null check (action in ('suspend', 'reactivate')),
  studio_id uuid not null,
  legal_entity_id uuid not null,
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  actor uuid not null,
  authorization_ref text not null check (char_length(btrim(authorization_ref)) between 6 and 120),
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  state text not null default 'in_flight' check (state in ('in_flight', 'unknown', 'closed')),
  outcome text null check (outcome is null or outcome in ('succeeded', 'already_in_state', 'failed', 'refused', 'unknown', 'reconciled')),
  provider_state_before text null,
  provider_state_after text null,
  created_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz null,
  constraint studio_sms_suspension_attempts_closed check ((state = 'closed') = (closed_at is not null)),
  constraint studio_sms_suspension_attempts_outcome check (state = 'in_flight' or outcome is not null)
);
-- ONE open attempt per legal business (its subaccount): a second concurrent request can never reach the provider
create unique index studio_sms_suspension_attempts_one_open on public.studio_sms_suspension_attempts (legal_entity_id) where state in ('in_flight', 'unknown');

create table public.studio_sms_suspension_audit (
  seq bigint generated always as identity primary key,
  attempt_id uuid null,
  event text not null check (event in ('requested', 'refused', 'precheck', 'outcome', 'reconciled', 'switch')),
  action text null check (action is null or action in ('suspend', 'reactivate', 'verify')),
  actor uuid null,
  studio_id uuid null,
  legal_entity_id uuid null,
  sid_tail text null check (sid_tail is null or sid_tail ~ '^[0-9a-f]{6}$'),
  authorization_ref text null check (authorization_ref is null or char_length(authorization_ref) <= 120),
  reason text null check (reason is null or char_length(reason) <= 300),
  idempotency_key text null check (idempotency_key is null or char_length(idempotency_key) <= 80),
  provider_state_before text null check (provider_state_before is null or char_length(provider_state_before) <= 20),
  provider_state_after text null check (provider_state_after is null or char_length(provider_state_after) <= 20),
  outcome text null check (outcome is null or char_length(outcome) <= 40),
  code text null check (code is null or code ~ '^[a-z0-9_:.-]{1,60}$'),
  detail text null check (detail is null or char_length(detail) <= 300),
  created_at timestamptz not null default clock_timestamp()
);
create index studio_sms_suspension_audit_attempt on public.studio_sms_suspension_audit (attempt_id, seq);
create index studio_sms_suspension_audit_studio on public.studio_sms_suspension_audit (studio_id, seq desc);

revoke all on public.studio_sms_traffic_hold_events, public.studio_sms_suspension_switch, public.studio_sms_suspension_attempts, public.studio_sms_suspension_audit
  from public, anon, authenticated, service_role;
alter table public.studio_sms_traffic_hold_events enable row level security;
alter table public.studio_sms_suspension_switch enable row level security;
alter table public.studio_sms_suspension_attempts enable row level security;
alter table public.studio_sms_suspension_audit enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- guards
-- ---------------------------------------------------------------------------------------------------------------
-- evidence (audit, hold events): never updated, deleted or truncated, by ANY role (the triggers are enabled ALWAYS, so replication-role tricks do not skip them)
create or replace function public._tw4susp_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception '% is append-only evidence: rows are never changed or removed', tg_table_name using errcode = '42501';
end $$;
create trigger studio_sms_suspension_audit_append_only before update or delete on public.studio_sms_suspension_audit for each row execute function public._tw4susp_append_only();
create trigger studio_sms_suspension_audit_no_truncate before truncate on public.studio_sms_suspension_audit for each statement execute function public._tw4susp_append_only();
create trigger studio_sms_traffic_hold_events_append_only before update or delete on public.studio_sms_traffic_hold_events for each row execute function public._tw4susp_append_only();
create trigger studio_sms_traffic_hold_events_no_truncate before truncate on public.studio_sms_traffic_hold_events for each statement execute function public._tw4susp_append_only();
alter table public.studio_sms_suspension_audit enable always trigger studio_sms_suspension_audit_append_only;
alter table public.studio_sms_suspension_audit enable always trigger studio_sms_suspension_audit_no_truncate;
alter table public.studio_sms_traffic_hold_events enable always trigger studio_sms_traffic_hold_events_append_only;
alter table public.studio_sms_traffic_hold_events enable always trigger studio_sms_traffic_hold_events_no_truncate;

-- attempts and the switch change only inside this migration's functions (transaction-local flag), and an attempt only moves forward
create or replace function public._tw4susp_state_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception '% rows are never removed', tg_table_name using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.susp_write', true), '') <> 'on' then
    raise exception '% changes only through the tw4susp functions', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_suspension_attempts' and tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.idempotency_key is distinct from old.idempotency_key or new.action is distinct from old.action
       or new.studio_id is distinct from old.studio_id or new.legal_entity_id is distinct from old.legal_entity_id or new.account_sid is distinct from old.account_sid
       or new.actor is distinct from old.actor or new.authorization_ref is distinct from old.authorization_ref or new.reason is distinct from old.reason
       or new.created_at is distinct from old.created_at or old.state = 'closed' or (old.state = 'unknown' and new.state = 'in_flight') then
      raise exception 'a suspension attempt only moves forward, and a closed one is final' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_suspension_attempts_guard before insert or update or delete on public.studio_sms_suspension_attempts for each row execute function public._tw4susp_state_guard();
create trigger studio_sms_suspension_attempts_no_truncate before truncate on public.studio_sms_suspension_attempts for each statement execute function public._tw4susp_state_guard();
create trigger studio_sms_suspension_switch_guard before insert or update or delete on public.studio_sms_suspension_switch for each row execute function public._tw4susp_state_guard();
create trigger studio_sms_suspension_switch_no_truncate before truncate on public.studio_sms_suspension_switch for each statement execute function public._tw4susp_state_guard();
alter table public.studio_sms_suspension_attempts enable always trigger studio_sms_suspension_attempts_guard;
alter table public.studio_sms_suspension_attempts enable always trigger studio_sms_suspension_attempts_no_truncate;
alter table public.studio_sms_suspension_switch enable always trigger studio_sms_suspension_switch_guard;
alter table public.studio_sms_suspension_switch enable always trigger studio_sms_suspension_switch_no_truncate;

-- ---------------------------------------------------------------------------------------------------------------
-- helpers (callable by nobody)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4susp_held(p_studio uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select h.hold from public.studio_sms_traffic_hold_events h where h.studio_id = p_studio order by h.seq desc limit 1), false);
$$;

create or replace function public._tw4susp_tail(p_sid text)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select case when p_sid ~ '^AC[0-9a-fA-F]{32}$' then lower(right(p_sid, 6)) end; $$;

-- printable, trimmed, bounded text (no control characters, no Unicode format characters)
create or replace function public._tw4susp_text_ok(p_text text, p_min int, p_max int)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select p_text is not null and char_length(btrim(p_text)) between p_min and p_max and p_text !~ '[[:cntrl:]]' and p_text !~ '[​-‏‪-‮⁠-⁤﻿]'; $$;

create or replace function public._tw4susp_audit(p_attempt uuid, p_event text, p_action text, p_actor uuid, p_studio uuid, p_entity uuid, p_sid text,
  p_auth_ref text, p_reason text, p_key text, p_before text, p_after text, p_outcome text, p_code text, p_detail text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into public.studio_sms_suspension_audit (attempt_id, event, action, actor, studio_id, legal_entity_id, sid_tail, authorization_ref, reason, idempotency_key,
                                                  provider_state_before, provider_state_after, outcome, code, detail)
  values (p_attempt, p_event, p_action, p_actor, p_studio, p_entity, public._tw4susp_tail(p_sid), left(btrim(p_auth_ref), 120), left(btrim(p_reason), 300),
          case when p_key ~ '^[A-Za-z0-9_-]{1,80}$' then p_key end, left(p_before, 20), left(p_after, 20), p_outcome, p_code, left(p_detail, 300));
end $$;

-- a provider state as recorded: Twilio's three documented values, or what DanceFlow could (not) read
create or replace function public._tw4susp_state_ok(p_state text)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select p_state is null or p_state in ('active', 'suspended', 'closed', 'unreadable', 'other', 'not_called'); $$;

create or replace function public._tw4susp_switch_on()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce((select s.enabled from public.studio_sms_suspension_switch s where s.singleton), false); $$;

-- ---------------------------------------------------------------------------------------------------------------
-- (a) DanceFlow traffic hold
-- ---------------------------------------------------------------------------------------------------------------
-- the billed send path: a new attempt, or the reserved -> submitting dispatch marker, is refused while the location is held. Nothing else is touched:
-- inbound recording, consent changes and the TwiML compliance replies never create a usage attempt.
create or replace function public._tw4susp_usage_hold_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if (tg_op = 'INSERT' or (old.state = 'reserved' and new.state = 'submitting')) and public._tw4susp_held(new.studio_id) then
    raise exception 'texting is on a DanceFlow administrator hold for this location' using errcode = 'TW080';
  end if;
  return new;
end $$;
create trigger studio_sms_usage_attempts_traffic_hold before insert or update of state on public.studio_sms_usage_attempts for each row execute function public._tw4susp_usage_hold_guard();

create or replace function public.tw4_traffic_hold_set(p_studio_id uuid, p_hold boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
begin
  perform public._tw4c_admin(p_actor);
  if p_studio_id is null or p_hold is null or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'a known location and a hold decision are required' using errcode = '22023';
  end if;
  if not public._tw4susp_text_ok(p_reason, 10, 300) then
    raise exception 'a written reason (10 to 300 characters) is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tw4susp:hold:' || p_studio_id::text, 0));
  if public._tw4susp_held(p_studio_id) = p_hold then
    return jsonb_build_object('held', p_hold, 'replayed', true);
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  insert into public.studio_sms_traffic_hold_events (studio_id, legal_entity_id, hold, actor, reason) values (p_studio_id, v_entity, p_hold, p_actor, btrim(p_reason));
  return jsonb_build_object('held', p_hold, 'replayed', false);
end $$;

create or replace function public.tw4_traffic_hold_state(p_studio_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select jsonb_build_object('held', h.hold, 'since', h.created_at, 'reason', h.reason, 'attempt_id', h.attempt_id)
                     from public.studio_sms_traffic_hold_events h where h.studio_id = p_studio_id order by h.seq desc limit 1),
                  jsonb_build_object('held', false));
$$;

-- for the webhook's optional error replies: is ANY location of the business that owns this subaccount held? (conservative; compliance replies never ask)
create or replace function public.tw4_traffic_hold_for_account(p_account_sid text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_twilio_accounts t join public.studio_sms_entity_studios es on es.legal_entity_id = t.legal_entity_id
                  where t.twilio_account_sid = p_account_sid and public._tw4susp_held(es.studio_id));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- (b) emergency suspension: gate
-- ---------------------------------------------------------------------------------------------------------------
-- OWNER-LEVEL ONLY (no API role can execute it). Turning it on is never part of a release by itself: it needs a separate owner authorization.
create or replace function public.tw4susp_switch_set(p_on boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_on is null or not public._tw4susp_text_ok(p_reason, 10, 300) then
    raise exception 'a decision and a written reason (10 to 300 characters) are required' using errcode = '22023';
  end if;
  perform set_config('tw4.susp_write', 'on', true);
  update public.studio_sms_suspension_switch set enabled = p_on, updated_at = clock_timestamp(), updated_by = p_actor where singleton;
  perform set_config('tw4.susp_write', 'off', true);
  perform public._tw4susp_audit(null, 'switch', null, p_actor, null, null, null, null, p_reason, null, null, null, case when p_on then 'enabled' else 'disabled' end, null, null);
  return jsonb_build_object('enabled', p_on);
end $$;

create or replace function public.tw4susp_switch_state()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select public._tw4susp_switch_on(); $$;

-- ---------------------------------------------------------------------------------------------------------------
-- (b) begin: the ADMINISTRATOR'S OWN TOKEN (granted to authenticated). Identity and freshness come from the verified JWT and auth.sessions
-- (_tw4price_session_actor 'recent'); authority from the registered-administrator registry (_tw4price_admin_active). No actor can be named.
-- A refusal of a request that got past authentication is recorded (and committed: the function returns normally).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4susp_begin(p_studio_id uuid, p_action text, p_studio_name text, p_sid_tail text, p_authorization_ref text, p_reason text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid;
  a public.studio_sms_suspension_attempts;
  acc public.studio_sms_twilio_accounts;
  v_entity uuid;
  v_name text;
  v_code text := null;
  v_id uuid := gen_random_uuid();
  v_held int := 0;
  s record;
begin
  v_actor := public._tw4price_session_actor('recent');
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'a registered, active platform administrator is required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('suspend', 'reactivate') then
    raise exception 'the action is suspend or reactivate (closing a subaccount is never offered)' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,80}$' then
    raise exception 'an idempotency key (16 to 80 letters, digits, - or _) is required' using errcode = '22023';
  end if;
  if p_studio_id is null then
    raise exception 'a location is required' using errcode = '22023';
  end if;
  -- the same key is serialised, then replayed: never a second provider call
  perform pg_advisory_xact_lock(hashtextextended('tw4susp:key:' || p_idempotency_key, 0));
  select * into a from public.studio_sms_suspension_attempts x where x.idempotency_key = p_idempotency_key;
  if a.id is not null then
    if a.actor <> v_actor or a.studio_id <> p_studio_id or a.action <> p_action then
      -- never a replay of someone else's result, and never a new attempt under a used key
      perform public._tw4susp_audit(null, 'refused', p_action, v_actor, p_studio_id, null, null, p_authorization_ref, p_reason, p_idempotency_key, null, null, 'refused', 'key_conflict', null);
      return jsonb_build_object('decision', 'refused', 'code', 'key_conflict');
    end if;
    return jsonb_build_object('decision', 'replay', 'attempt_id', a.id, 'state', a.state, 'outcome', a.outcome, 'provider_state_after', a.provider_state_after);
  end if;

  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is not null then
    perform pg_advisory_xact_lock(hashtextextended('tw4susp:entity:' || v_entity::text, 0));
    select * into acc from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity for update;
  end if;
  select s2.name into v_name from public.studios s2 where s2.id = p_studio_id;

  if not public._tw4susp_text_ok(p_reason, 10, 300) or not public._tw4susp_text_ok(p_authorization_ref, 6, 120) then
    v_code := 'missing_reason_or_authorization';
  elsif not public._tw4susp_switch_on() then
    v_code := 'switched_off';
  elsif v_name is null then
    v_code := 'unknown_location';
  elsif v_entity is null then
    v_code := 'no_legal_business';
  elsif acc.legal_entity_id is null or acc.twilio_account_sid is null then
    v_code := 'no_subaccount';
  elsif acc.status = 'closed' then
    v_code := 'closed';
  elsif acc.status not in ('active', 'suspended') then
    v_code := 'subaccount_not_ready';
  elsif p_studio_name is null or btrim(p_studio_name) <> btrim(v_name) then
    v_code := 'wrong_studio_name';
  elsif p_sid_tail is null or lower(btrim(p_sid_tail)) <> public._tw4susp_tail(acc.twilio_account_sid) then
    v_code := 'wrong_sid_tail';
  elsif exists (select 1 from public.studio_sms_suspension_attempts x where x.legal_entity_id = v_entity and x.state in ('in_flight', 'unknown')) then
    v_code := 'attempt_open';
  elsif p_action = 'reactivate' and (acc.status <> 'suspended' or not exists (
          select 1 from public.studio_sms_suspension_attempts x where x.legal_entity_id = v_entity and x.account_sid = acc.twilio_account_sid
             and x.action = 'suspend' and (x.outcome in ('succeeded', 'already_in_state') or (x.outcome = 'reconciled' and x.provider_state_after = 'suspended')))) then
    v_code := 'not_suspended';
  end if;

  if v_code is not null then
    perform public._tw4susp_audit(null, 'refused', p_action, v_actor, p_studio_id, v_entity, acc.twilio_account_sid, p_authorization_ref, p_reason, p_idempotency_key,
                                  null, null, 'refused', v_code, null);
    return jsonb_build_object('decision', 'refused', 'code', v_code);
  end if;

  perform set_config('tw4.susp_write', 'on', true);
  insert into public.studio_sms_suspension_attempts (id, idempotency_key, action, studio_id, legal_entity_id, account_sid, actor, authorization_ref, reason)
  values (v_id, p_idempotency_key, p_action, p_studio_id, v_entity, acc.twilio_account_sid, v_actor, btrim(p_authorization_ref), btrim(p_reason));
  perform set_config('tw4.susp_write', 'off', true);
  -- failure-safe: BEFORE the provider is called, every location of the business is put on the DanceFlow traffic hold (never lifted automatically)
  if p_action = 'suspend' then
    for s in select es.studio_id from public.studio_sms_entity_studios es where es.legal_entity_id = v_entity order by es.studio_id loop
      -- the same per-location lock tw4_traffic_hold_set takes: a concurrent release cannot slip between the check and the hold (studio_id order: no cycle)
      perform pg_advisory_xact_lock(hashtextextended('tw4susp:hold:' || s.studio_id::text, 0));
      if not public._tw4susp_held(s.studio_id) then
        insert into public.studio_sms_traffic_hold_events (studio_id, legal_entity_id, hold, actor, reason, attempt_id)
        values (s.studio_id, v_entity, true, v_actor, left('emergency subaccount suspension requested: ' || btrim(p_reason), 300), v_id);
        v_held := v_held + 1;
      end if;
    end loop;
  end if;
  perform public._tw4susp_audit(v_id, 'requested', p_action, v_actor, p_studio_id, v_entity, acc.twilio_account_sid, p_authorization_ref, p_reason, p_idempotency_key,
                                acc.status, null, 'pending', null,
                                'locations=' || (select count(*) from public.studio_sms_entity_studios es where es.legal_entity_id = v_entity) || ';holds_placed=' || v_held);
  return jsonb_build_object('decision', 'proceed', 'attempt_id', v_id, 'action', p_action, 'account_sid', acc.twilio_account_sid,
                            'locations', (select count(*) from public.studio_sms_entity_studios es where es.legal_entity_id = v_entity), 'holds_placed', v_held);
end $$;

-- read-only verification of an OPEN attempt (unknown, or in_flight older than 10 minutes): the server reads the provider (GET only) and records the
-- observed state with tw4susp_record('reconciled'). It never changes the provider state.
create or replace function public.tw4susp_verify_begin(p_studio_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid;
  v_entity uuid;
  a public.studio_sms_suspension_attempts;
begin
  v_actor := public._tw4price_session_actor('recent');
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'a registered, active platform administrator is required' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is not null then
    perform pg_advisory_xact_lock(hashtextextended('tw4susp:entity:' || v_entity::text, 0));
  end if;
  select * into a from public.studio_sms_suspension_attempts x where x.legal_entity_id = v_entity and x.state in ('in_flight', 'unknown');
  if not public._tw4susp_text_ok(p_reason, 10, 300) or not public._tw4susp_switch_on() or a.id is null
     or (a.state = 'in_flight' and a.created_at > clock_timestamp() - interval '10 minutes') then
    perform public._tw4susp_audit(a.id, 'refused', 'verify', v_actor, p_studio_id, v_entity, a.account_sid, null, p_reason, null, null, null, 'refused',
      case when not public._tw4susp_text_ok(p_reason, 10, 300) then 'missing_reason_or_authorization' when not public._tw4susp_switch_on() then 'switched_off'
           when a.id is null then 'nothing_to_verify' else 'attempt_in_progress' end, null);
    return jsonb_build_object('decision', 'refused', 'code',
      case when not public._tw4susp_text_ok(p_reason, 10, 300) then 'missing_reason_or_authorization' when not public._tw4susp_switch_on() then 'switched_off'
           when a.id is null then 'nothing_to_verify' else 'attempt_in_progress' end);
  end if;
  perform public._tw4susp_audit(a.id, 'requested', 'verify', v_actor, p_studio_id, v_entity, a.account_sid, null, p_reason, null, a.provider_state_before, null, 'pending', null, null);
  return jsonb_build_object('decision', 'proceed', 'attempt_id', a.id, 'action', a.action, 'account_sid', a.account_sid);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- (b) record: SERVICE ROLE only (the server, after it talked to the provider). An administrator's token can never write a provider outcome.
--   step 'precheck'   provider state before the change (attempt stays in_flight)
--   step 'outcome'    succeeded | already_in_state (state_after must be the target) | failed | refused (attempt closed) | unknown (attempt stays OPEN)
--   step 'reconciled' the observed state of an open attempt after a read-only verification (closes it)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4susp_record(p_attempt_id uuid, p_account_sid text, p_step text, p_state_before text, p_state_after text, p_outcome text,
  p_code text, p_detail text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_suspension_attempts;
  v_target text;
  v_status text := null;
begin
  select * into a from public.studio_sms_suspension_attempts x where x.id = p_attempt_id for update;
  if a.id is null then
    raise exception 'unknown suspension attempt' using errcode = '22023';
  end if;
  if p_account_sid is distinct from a.account_sid then
    raise exception 'the account does not match this attempt' using errcode = '42501';
  end if;
  if not public._tw4susp_state_ok(p_state_before) or not public._tw4susp_state_ok(p_state_after) or (p_code is not null and p_code !~ '^[a-z0-9_:.-]{1,60}$') then
    raise exception 'invalid provider state or code' using errcode = '22023';
  end if;
  v_target := case a.action when 'suspend' then 'suspended' else 'active' end;

  if p_step = 'precheck' then
    if a.state <> 'in_flight' then
      raise exception 'the attempt is not in progress' using errcode = '22023';
    end if;
    perform set_config('tw4.susp_write', 'on', true);
    update public.studio_sms_suspension_attempts set provider_state_before = p_state_before where id = a.id;
    perform set_config('tw4.susp_write', 'off', true);
    perform public._tw4susp_audit(a.id, 'precheck', a.action, a.actor, a.studio_id, a.legal_entity_id, a.account_sid, null, null, null, p_state_before, null, null, p_code, p_detail);
    return jsonb_build_object('recorded', 'precheck');
  end if;

  perform set_config('tw4.susp_write', 'on', true);
  if p_step = 'outcome' then
    if a.state <> 'in_flight' then
      raise exception 'the attempt already has an outcome' using errcode = '22023';
    end if;
    if p_outcome is null or p_outcome not in ('succeeded', 'already_in_state', 'failed', 'refused', 'unknown') then
      raise exception 'invalid outcome' using errcode = '22023';
    end if;
    if p_outcome in ('succeeded', 'already_in_state') and p_state_after is distinct from v_target then
      raise exception 'a success needs the provider read-back to show %', v_target using errcode = '22023';
    end if;
    update public.studio_sms_suspension_attempts
       set state = case when p_outcome = 'unknown' then 'unknown' else 'closed' end, outcome = p_outcome,
           provider_state_before = p_state_before, provider_state_after = p_state_after,
           closed_at = case when p_outcome = 'unknown' then null else clock_timestamp() end
     where id = a.id;
    if p_outcome in ('succeeded', 'already_in_state') then
      v_status := v_target;
    end if;
    perform public._tw4susp_audit(a.id, 'outcome', a.action, a.actor, a.studio_id, a.legal_entity_id, a.account_sid, a.authorization_ref, null, a.idempotency_key,
                                  p_state_before, p_state_after, p_outcome, p_code, p_detail);
  elsif p_step = 'reconciled' then
    if a.state = 'closed' then
      raise exception 'the attempt is already closed' using errcode = '22023';
    end if;
    if p_state_after is null or p_state_after not in ('active', 'suspended', 'closed') then
      raise exception 'a verification records the observed provider state (active, suspended or closed)' using errcode = '22023';
    end if;
    update public.studio_sms_suspension_attempts set state = 'closed', outcome = 'reconciled', provider_state_after = p_state_after, closed_at = clock_timestamp() where id = a.id;
    -- the observed fact is recorded; a closed account is reported, never changed here (escalate: its numbers are gone)
    if p_state_after in ('active', 'suspended') then
      v_status := p_state_after;
    end if;
    perform public._tw4susp_audit(a.id, 'reconciled', 'verify', a.actor, a.studio_id, a.legal_entity_id, a.account_sid, null, null, null, a.provider_state_before, p_state_after,
                                  'reconciled', p_code, p_detail);
  else
    raise exception 'invalid step' using errcode = '22023';
  end if;
  perform set_config('tw4.susp_write', 'off', true);
  if v_status is not null then
    update public.studio_sms_twilio_accounts set status = v_status, updated_at = now()
     where legal_entity_id = a.legal_entity_id and twilio_account_sid = a.account_sid and status in ('active', 'suspended');
  end if;
  return jsonb_build_object('recorded', p_step, 'account_status', v_status);
end $$;

-- read-back for the console and the runbook: the location's hold, its business's subaccount status and the last attempts (SID tail only)
create or replace function public.tw4susp_overview(p_studio_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'switch_on', public._tw4susp_switch_on(),
    'hold', public.tw4_traffic_hold_state(p_studio_id),
    'account', (select jsonb_build_object('status', t.status, 'sid_tail', public._tw4susp_tail(t.twilio_account_sid))
                  from public.studio_sms_entity_studios es join public.studio_sms_twilio_accounts t on t.legal_entity_id = es.legal_entity_id where es.studio_id = p_studio_id),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'action', x.action, 'state', x.state, 'outcome', x.outcome, 'before', x.provider_state_before,
                                                             'after', x.provider_state_after, 'created_at', x.created_at, 'sid_tail', public._tw4susp_tail(x.account_sid)) order by x.created_at desc)
                            from (select * from public.studio_sms_suspension_attempts y
                                   where y.legal_entity_id = (select es.legal_entity_id from public.studio_sms_entity_studios es where es.studio_id = p_studio_id)
                                   order by y.created_at desc limit 20) x), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4susp_append_only(), public._tw4susp_state_guard(), public._tw4susp_held(uuid), public._tw4susp_tail(text),
  public._tw4susp_text_ok(text, int, int), public._tw4susp_audit(uuid, text, text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text),
  public._tw4susp_state_ok(text), public._tw4susp_switch_on(), public._tw4susp_usage_hold_guard(),
  public.tw4_traffic_hold_set(uuid, boolean, uuid, text), public.tw4_traffic_hold_state(uuid), public.tw4_traffic_hold_for_account(text),
  public.tw4susp_switch_set(boolean, uuid, text), public.tw4susp_switch_state(), public.tw4susp_begin(uuid, text, text, text, text, text, text),
  public.tw4susp_verify_begin(uuid, text), public.tw4susp_record(uuid, text, text, text, text, text, text, text), public.tw4susp_overview(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.tw4susp_begin(uuid, text, text, text, text, text, text), public.tw4susp_verify_begin(uuid, text) to authenticated;
grant execute on function public.tw4_traffic_hold_set(uuid, boolean, uuid, text), public.tw4_traffic_hold_state(uuid), public.tw4_traffic_hold_for_account(text),
  public.tw4susp_switch_state(), public.tw4susp_record(uuid, text, text, text, text, text, text, text), public.tw4susp_overview(uuid) to service_role;

-- postconditions: dark, and the setter reachable by no API role
do $$ begin
  if (select enabled from public.studio_sms_suspension_switch where singleton) is distinct from false then
    raise exception 'TW4SUSP_POSTCONDITION: the suspension switch must be off';
  end if;
  if has_function_privilege('service_role', 'public.tw4susp_switch_set(boolean, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.tw4susp_switch_set(boolean, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.tw4susp_switch_set(boolean, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.tw4susp_record(uuid, text, text, text, text, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.tw4susp_begin(uuid, text, text, text, text, text, text)', 'execute') then
    raise exception 'TW4SUSP_POSTCONDITION: unexpected execute privilege';
  end if;
end $$;

commit;
