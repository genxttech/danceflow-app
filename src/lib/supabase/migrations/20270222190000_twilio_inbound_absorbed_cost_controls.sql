-- 20270222190000_twilio_inbound_absorbed_cost_controls.sql
-- TW-4F financial safety slice C: absorbed inbound cost controls for EVERY legal business (docs/twilio/TW-4F_Inbound_Absorbed_Cost_Runbook.md). Dark; Git-only.
--
-- PROBLEM. tw4_inbound_record (20261203090000, as replaced by 20261231130000) charges an ordinary inbound text down to the business's negative-balance ceiling and
-- records the rest as uncollected: a received text is never refused (owner decision D1). The absorbed-cost and daily-volume alerts of 20261231140000 cover only the
-- pilot business and are notifications only. A flood on any other business is absorbed by DanceFlow with no alert and no response.
--
-- WHAT THIS ADDS (nothing here refuses, delays or charges an inbound text, and nothing touches STOP / START / HELP handling, consent, the ledger, balances,
-- ceilings, reservations, senders or numbers):
--   1. ALERTS for every business, administrator audience, deduped per business per LOCAL day (or local month), through the existing outbox (_tw4rfl_alert):
--        sms_in_volume_high    inbound segments in the business's local day above daily_segment_alert (default 200). NOT raised for the pilot business,
--                              which keeps its own unchanged 20261231140000 volume alert (no duplicate notice).
--        sms_in_absorbed_high  DanceFlow-absorbed inbound cost (the ONE definition, _tw4ia_absorbed_cents) in the local day at/above daily_absorbed_alert_cents
--                              (default 500), and in the local month at/above monthly_absorbed_alert_cents (default 2000).
--        sms_in_anomaly        today's segments (or absorbed cost) above anomaly_multiple (default 5) times the business's trailing daily average over
--                              anomaly_trailing_days (default 7) full local days, AND at/above an absolute floor (anomaly_min_segments 100 /
--                              anomaly_min_absorbed_cents 200). Days without traffic count as zero, so a first-day flood is an anomaly once over the floor.
--        sms_in_daily_cap      today's absorbed cost at/above cap_daily_absorbed_cents (default 1000) or today's segments at/above cap_daily_segments
--                              (default 2000). Critical. Raised whether or not the automatic response below is switched on (the summary says which).
--      alerts_enabled (default true) turns these four off per business or platform-wide. The pilot allowance / volume alerts of 20261231140000 are NOT changed.
--   2. AUTOMATIC RESPONSE (database switch studio_sms_inbound_reply_cap_switch_log, default OFF): once a business reaches its daily cap, DanceFlow's
--      NON-COMPLIANCE automatic replies to texts received by that business's subaccount (today: the error replies 'temporarily unavailable', 'could not process',
--      'could not recognize your number', 'not routed') are suppressed until the business's next local day or until a platform administrator clears it
--      (tw4_inbound_reply_suppression_clear, written note, audited). Ordinary texts already get no automatic reply (D3). STOP / START / HELP confirmations and
--      every carrier-required reply are NEVER suppressed: tw4_inbound_auto_reply_allowed answers true for those kinds before reading anything, and the route
--      never asks it for them. A cleared day is not suppressed again that day.
--   3. CONFIGURATION in studio_sms_inbound_cost_controls (append-only; platform row, per-business override, built-in defaults in _tw4ib_defaults), set only by a
--      platform administrator with a written reason (tw4_inbound_cost_controls_set). The switch is set by tw4_inbound_reply_cap_switch_set (platform administrator,
--      written reason). Every set, switch change, suppression and clearance is appended to studio_sms_inbound_cost_control_events.
--
-- DAYS AND MONTHS are the business's own: the timezone that governs the month (_tw4ml_tz_for / _tw4ml_month_key of 20261128090000, the founding location's zone
-- until one is recorded). A local day is [local midnight, next local midnight). The month is _tw4ml_month_start .. the next month's start.
-- COUNTING: per stored inbound record (one row per provider message SID, so a replayed or duplicate delivery is never counted twice). Segments count every text
-- (compliance included, like the existing volume alert). Absorbed cost is _tw4ia_absorbed_cents (estimated provider cost DanceFlow bears + reply cost); rows
-- without a cost estimate (no inbound price published when recorded) contribute 0 to cost, which is why the cap also has a segment limit.
-- The scan entry point tw4_inbound_cost_controls_check() is called by the existing provider-fee lifecycle scan (no new route, no new cron).
--
-- Requires 20261231140000 (absorbed alert, kinds), 20261211090000 (alert outbox), 20261203090000 (inbound usage), 20261128090000 (business months).
-- Rollback: rollback/20270222190000_twilio_inbound_absorbed_cost_controls_rollback.sql (refuses while any configuration, switch, suppression, event or alert row
-- of this migration exists). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_name text;
  v_def text;
  v_vals text[];
begin
  if to_regprocedure('public._tw4ia_absorbed_cents(uuid,timestamp with time zone)') is null or to_regclass('public.studio_sms_inbound_usage') is null
     or to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is null or to_regprocedure('public._tw4ml_tz_for(uuid,text)') is null
     or to_regprocedure('public._tw4c_admin(uuid)') is null or to_regclass('public.studio_sms_pilot_exceptions') is null then
    raise exception 'inbound cost controls precondition failed: 20261231140000 and its predecessors are not applied';
  end if;
  if to_regclass('public.studio_sms_inbound_cost_controls') is not null or to_regprocedure('public._tw4ib_defaults()') is not null then
    raise exception 'inbound cost controls precondition failed: already applied';
  end if;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'inbound cost controls precondition failed: the alert-kind constraint is missing';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or not (array['inbound_absorbed_allowance', 'inbound_volume_high', 'alert_delivery_exhausted'] <@ v_vals) then
    raise exception 'could not read the alert kinds from %', v_def;
  end if;
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  v_vals := (select array_agg(distinct x order by x) from unnest(v_vals || array['sms_in_volume_high', 'sms_in_absorbed_high', 'sms_in_anomaly', 'sms_in_daily_cap']) x);
  execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
  execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges, RLS on, no policies)
-- ---------------------------------------------------------------------------------------------------------------
-- configuration: each row is the COMPLETE override set of its scope at that time (latest row wins); a key absent from it inherits (entity -> platform -> default)
create table public.studio_sms_inbound_cost_controls (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('platform', 'entity')),
  legal_entity_id uuid null references public.studio_sms_legal_entities(id),
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  set_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_inbound_cost_controls_scope check ((scope = 'platform') = (legal_entity_id is null))
);
create index studio_sms_inbound_cost_controls_lookup on public.studio_sms_inbound_cost_controls (scope, legal_entity_id, created_at desc);

-- the automatic-response switch: latest row wins; no row = OFF
create table public.studio_sms_inbound_reply_cap_switch_log (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null,
  changed_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  changed_at timestamptz not null default clock_timestamp()
);

-- one row per business per local day on which its automatic non-compliance replies were suppressed; only the clearance columns ever change, once
create table public.studio_sms_inbound_reply_suppressions (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  local_day date not null,
  timezone text not null,
  day_starts_at timestamptz not null,
  day_ends_at timestamptz not null,
  trigger text not null check (trigger in ('absorbed', 'segments')),
  absorbed_cents bigint not null check (absorbed_cents >= 0),
  segments bigint not null check (segments >= 0),
  source text not null check (source in ('scan', 'reply_check')),
  created_at timestamptz not null default clock_timestamp(),
  cleared_at timestamptz null,
  cleared_by uuid null,
  clear_note text null check (clear_note is null or char_length(btrim(clear_note)) between 10 and 300),
  constraint studio_sms_inbound_reply_suppressions_day unique (legal_entity_id, local_day),
  constraint studio_sms_inbound_reply_suppressions_window check (day_ends_at > day_starts_at),
  constraint studio_sms_inbound_reply_suppressions_clear check ((cleared_at is null) = (cleared_by is null) and (cleared_at is null) = (clear_note is null))
);

-- audit timeline of every change this migration makes possible
create table public.studio_sms_inbound_cost_control_events (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid null references public.studio_sms_legal_entities(id),
  event text not null check (event in ('config_set', 'switch_set', 'suppressed', 'cleared')),
  actor uuid null,
  note text null check (note is null or char_length(note) <= 600),
  created_at timestamptz not null default clock_timestamp()
);
create index studio_sms_inbound_cost_control_events_entity on public.studio_sms_inbound_cost_control_events (legal_entity_id, created_at);

revoke all on public.studio_sms_inbound_cost_controls, public.studio_sms_inbound_reply_cap_switch_log, public.studio_sms_inbound_reply_suppressions,
  public.studio_sms_inbound_cost_control_events from public, anon, authenticated, service_role;
alter table public.studio_sms_inbound_cost_controls enable row level security;
alter table public.studio_sms_inbound_reply_cap_switch_log enable row level security;
alter table public.studio_sms_inbound_reply_suppressions enable row level security;
alter table public.studio_sms_inbound_cost_control_events enable row level security;

create trigger studio_sms_inbound_cost_controls_guard before update or delete on public.studio_sms_inbound_cost_controls for each row execute function public._tw4us_append_only();
create trigger studio_sms_inbound_reply_cap_switch_log_guard before update or delete on public.studio_sms_inbound_reply_cap_switch_log for each row execute function public._tw4us_append_only();
create trigger studio_sms_inbound_cost_control_events_guard before update or delete on public.studio_sms_inbound_cost_control_events for each row execute function public._tw4us_append_only();
create trigger studio_sms_inbound_cost_controls_truncate before truncate on public.studio_sms_inbound_cost_controls for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_inbound_reply_cap_switch_log_truncate before truncate on public.studio_sms_inbound_reply_cap_switch_log for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_inbound_reply_suppressions_truncate before truncate on public.studio_sms_inbound_reply_suppressions for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_inbound_cost_control_events_truncate before truncate on public.studio_sms_inbound_cost_control_events for each statement execute function public._tw4c_truncate_guard();

-- a suppression is never deleted and never rewritten: the only change is ONE clearance (cleared_at / cleared_by / clear_note from null)
create function public._tw4ib_suppression_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inbound reply suppressions are never deleted' using errcode = '42501';
  end if;
  if old.cleared_at is not null or new.cleared_at is null
     or (to_jsonb(new) - array['cleared_at', 'cleared_by', 'clear_note']) <> (to_jsonb(old) - array['cleared_at', 'cleared_by', 'clear_note']) then
    raise exception 'an inbound reply suppression can only be cleared, once' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger studio_sms_inbound_reply_suppressions_guard before update or delete on public.studio_sms_inbound_reply_suppressions for each row execute function public._tw4ib_suppression_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- configuration
-- ---------------------------------------------------------------------------------------------------------------
-- the built-in defaults: the ONE place they are written
create function public._tw4ib_defaults()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'alerts_enabled', true,
    'daily_segment_alert', 200,
    'daily_absorbed_alert_cents', 500,
    'monthly_absorbed_alert_cents', 2000,
    'anomaly_multiple', 5,
    'anomaly_trailing_days', 7,
    'anomaly_min_segments', 100,
    'anomaly_min_absorbed_cents', 200,
    'cap_daily_absorbed_cents', 1000,
    'cap_daily_segments', 2000);
$$;

-- one validated value: the key must exist in the defaults and the value must be in range (raises 22023 otherwise)
create function public._tw4ib_valid_setting(p_key text, p_value jsonb)
returns boolean language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v numeric;
begin
  if p_key = 'alerts_enabled' then
    return jsonb_typeof(p_value) = 'boolean';
  end if;
  if jsonb_typeof(p_value) <> 'number' then
    return false;
  end if;
  v := (p_value #>> '{}')::numeric;
  return case p_key
    when 'anomaly_multiple' then v between 1.5 and 100
    when 'anomaly_trailing_days' then v = trunc(v) and v between 1 and 31
    when 'daily_segment_alert' then v = trunc(v) and v between 1 and 1000000
    when 'anomaly_min_segments' then v = trunc(v) and v between 1 and 1000000
    when 'cap_daily_segments' then v = trunc(v) and v between 1 and 1000000
    when 'daily_absorbed_alert_cents' then v = trunc(v) and v between 1 and 1000000
    when 'monthly_absorbed_alert_cents' then v = trunc(v) and v between 1 and 1000000
    when 'anomaly_min_absorbed_cents' then v = trunc(v) and v between 1 and 1000000
    when 'cap_daily_absorbed_cents' then v = trunc(v) and v between 1 and 1000000
    else false end;
end $$;

create function public._tw4ib_scope_settings(p_entity uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select c.settings from public.studio_sms_inbound_cost_controls c
                    where (p_entity is null and c.scope = 'platform') or (p_entity is not null and c.scope = 'entity' and c.legal_entity_id = p_entity)
                    order by c.created_at desc, c.id desc limit 1), '{}'::jsonb);
$$;

-- the effective configuration of a business: defaults, then the platform overrides, then the business's own
create function public._tw4ib_config(p_entity uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public._tw4ib_defaults() || public._tw4ib_scope_settings(null) || case when p_entity is null then '{}'::jsonb else public._tw4ib_scope_settings(p_entity) end;
$$;

create function public._tw4ib_switch_on()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select l.enabled from public.studio_sms_inbound_reply_cap_switch_log l order by l.changed_at desc, l.id desc limit 1), false);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- measurement (business-local days and months)
-- ---------------------------------------------------------------------------------------------------------------
create function public._tw4ib_day(p_entity uuid, p_at timestamptz, out tz text, out local_day date, out starts_at timestamptz, out ends_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  tz := public._tw4ml_tz_for(p_entity, public._tw4ml_month_key(p_entity, p_at));
  local_day := (p_at at time zone tz)::date;
  starts_at := (local_day::timestamp) at time zone tz;
  ends_at := ((local_day + 1)::timestamp) at time zone tz;
end $$;

-- inbound segments and absorbed cost received in [p_from, p_to)
create function public._tw4ib_window(p_entity uuid, p_from timestamptz, p_to timestamptz, out segments bigint, out absorbed_cents bigint)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select (select coalesce(sum(u.segments), 0)::bigint from public.studio_sms_inbound_usage u where u.legal_entity_id = p_entity and u.received_at >= p_from and u.received_at < p_to),
         public._tw4ia_absorbed_cents(p_entity, p_from) - public._tw4ia_absorbed_cents(p_entity, p_to);
$$;

-- everything the checks compare, for the local day (and month) that contains p_at
create function public._tw4ib_metrics(p_entity uuid, p_at timestamptz)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  d record;
  t record;
  m record;
  h record;
  cfg jsonb := public._tw4ib_config(p_entity);
  n int := (cfg->>'anomaly_trailing_days')::int;
  v_key text := public._tw4ml_month_key(p_entity, p_at);
  v_hist_from timestamptz;
begin
  select * into d from public._tw4ib_day(p_entity, p_at);
  select * into t from public._tw4ib_window(p_entity, d.starts_at, d.ends_at);
  select * into m from public._tw4ib_window(p_entity, public._tw4ml_month_start(p_entity, v_key), public._tw4ml_month_start(p_entity, public._tw4ml_key_add(v_key, 1)));
  v_hist_from := ((d.local_day - n)::timestamp) at time zone d.tz;
  select * into h from public._tw4ib_window(p_entity, v_hist_from, d.starts_at);
  return jsonb_build_object('timezone', d.tz, 'local_day', d.local_day, 'day_starts_at', d.starts_at, 'day_ends_at', d.ends_at,
                            'segments_today', t.segments, 'absorbed_today_cents', t.absorbed_cents,
                            'month_key', v_key, 'absorbed_month_cents', m.absorbed_cents,
                            'trailing_days', n, 'avg_segments', round(h.segments::numeric / n, 2), 'avg_absorbed_cents', round(h.absorbed_cents::numeric / n, 2));
end $$;

-- which daily cap (if any) today's numbers reach: 'absorbed', 'segments' or null
create function public._tw4ib_cap_trigger(p_cfg jsonb, p_segments bigint, p_absorbed bigint)
returns text language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select case when p_absorbed >= (p_cfg->>'cap_daily_absorbed_cents')::bigint then 'absorbed'
              when p_segments >= (p_cfg->>'cap_daily_segments')::bigint then 'segments' end;
$$;

-- records today's suppression for a business (once per local day); true when this call created it
create function public._tw4ib_suppress(p_entity uuid, p_tz text, p_day date, p_starts timestamptz, p_ends timestamptz, p_trigger text, p_segments bigint, p_absorbed bigint, p_source text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  insert into public.studio_sms_inbound_reply_suppressions (legal_entity_id, local_day, timezone, day_starts_at, day_ends_at, trigger, absorbed_cents, segments, source)
  values (p_entity, p_day, p_tz, p_starts, p_ends, p_trigger, greatest(p_absorbed, 0), greatest(p_segments, 0), p_source)
  on conflict (legal_entity_id, local_day) do nothing returning id into v_id;
  if v_id is not null then
    insert into public.studio_sms_inbound_cost_control_events (legal_entity_id, event, actor, note)
    values (p_entity, 'suppressed', null, 'local_day=' || p_day || ';trigger=' || p_trigger || ';source=' || p_source);
  end if;
  return v_id is not null;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the scheduled check (alerts + the automatic response); p_at only so tests can pin the day
-- ---------------------------------------------------------------------------------------------------------------
create function public._tw4ib_check(p_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  z record;
  cfg jsonb;
  mt jsonb;
  v_on boolean := public._tw4ib_switch_on();
  v_pilot boolean;
  v_day text;
  v_seg bigint;
  v_abs bigint;
  v_trig text;
  v_vol int := 0;
  v_absn int := 0;
  v_anom int := 0;
  v_cap int := 0;
  v_sup int := 0;
begin
  for z in select distinct u.legal_entity_id from public.studio_sms_inbound_usage u where u.received_at >= p_at - interval '32 days' order by u.legal_entity_id loop
    cfg := public._tw4ib_config(z.legal_entity_id);
    mt := public._tw4ib_metrics(z.legal_entity_id, p_at);
    v_pilot := exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = z.legal_entity_id);
    v_day := to_char((mt->>'local_day')::date, 'YYYYMMDD');
    v_seg := (mt->>'segments_today')::bigint;
    v_abs := (mt->>'absorbed_today_cents')::bigint;
    if (cfg->>'alerts_enabled')::boolean then
      if not v_pilot and v_seg > (cfg->>'daily_segment_alert')::bigint then
        if public._tw4rfl_alert(z.legal_entity_id, null, null, 'sms_in_volume_high', 'inbv:' || z.legal_entity_id || ':' || v_day, 'admin', 'warning',
             'Inbound text volume for a business passed its daily threshold. Nothing has been blocked; review inbound traffic.') then v_vol := v_vol + 1; end if;
      end if;
      if v_abs >= (cfg->>'daily_absorbed_alert_cents')::bigint then
        if public._tw4rfl_alert(z.legal_entity_id, null, null, 'sms_in_absorbed_high', 'inba:' || z.legal_entity_id || ':day:' || v_day, 'admin', 'warning',
             'Inbound text cost absorbed by DanceFlow for a business passed its daily threshold. Nothing has been blocked; review inbound traffic.') then v_absn := v_absn + 1; end if;
      end if;
      if (mt->>'absorbed_month_cents')::bigint >= (cfg->>'monthly_absorbed_alert_cents')::bigint then
        if public._tw4rfl_alert(z.legal_entity_id, null, null, 'sms_in_absorbed_high', 'inba:' || z.legal_entity_id || ':month:' || (mt->>'month_key'), 'admin', 'warning',
             'Inbound text cost absorbed by DanceFlow for a business passed its monthly threshold. Nothing has been blocked; review inbound traffic.') then v_absn := v_absn + 1; end if;
      end if;
      if v_seg >= (cfg->>'anomaly_min_segments')::bigint and v_seg > (cfg->>'anomaly_multiple')::numeric * (mt->>'avg_segments')::numeric then
        if public._tw4rfl_alert(z.legal_entity_id, null, null, 'sms_in_anomaly', 'inbx:' || z.legal_entity_id || ':' || v_day || ':segments', 'admin', 'warning',
             'Inbound text volume for a business is far above its recent daily average. Nothing has been blocked; review inbound traffic.') then v_anom := v_anom + 1; end if;
      end if;
      if v_abs >= (cfg->>'anomaly_min_absorbed_cents')::bigint and v_abs > (cfg->>'anomaly_multiple')::numeric * (mt->>'avg_absorbed_cents')::numeric then
        if public._tw4rfl_alert(z.legal_entity_id, null, null, 'sms_in_anomaly', 'inbx:' || z.legal_entity_id || ':' || v_day || ':absorbed', 'admin', 'warning',
             'Absorbed inbound text cost for a business is far above its recent daily average. Nothing has been blocked; review inbound traffic.') then v_anom := v_anom + 1; end if;
      end if;
    end if;
    v_trig := public._tw4ib_cap_trigger(cfg, v_seg, v_abs);
    if v_trig is not null then
      if v_on and public._tw4ib_suppress(z.legal_entity_id, mt->>'timezone', (mt->>'local_day')::date, (mt->>'day_starts_at')::timestamptz, (mt->>'day_ends_at')::timestamptz,
                                         v_trig, v_seg, v_abs, 'scan') then
        v_sup := v_sup + 1;
      end if;
      if (cfg->>'alerts_enabled')::boolean and public._tw4rfl_alert(z.legal_entity_id, null, null, 'sms_in_daily_cap', 'inbc:' || z.legal_entity_id || ':' || v_day, 'admin', 'critical',
           case when v_on then 'Inbound texts for a business reached the daily cap. Its automatic non-compliance replies are suppressed until its next local day or until cleared; STOP, START and HELP are unaffected and no text is refused.'
                else 'Inbound texts for a business reached the daily cap. Automatic reply suppression is switched off, so nothing was suppressed and no text is refused; review inbound traffic.' end) then
        v_cap := v_cap + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('volume_alerts', v_vol, 'absorbed_alerts', v_absn, 'anomaly_alerts', v_anom, 'cap_alerts', v_cap, 'suppressed', v_sup);
end $$;

create function public.tw4_inbound_cost_controls_check()
returns jsonb language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$ select public._tw4ib_check(now()); $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the reply-path question: may DanceFlow send THIS automatic reply for a text received by this subaccount?
-- ---------------------------------------------------------------------------------------------------------------
create function public._tw4ib_reply_allowed(p_account_sid text, p_kind text, p_at timestamptz)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  d record;
  s public.studio_sms_inbound_reply_suppressions;
  t record;
  v_trig text;
begin
  -- compliance and carrier-required replies are never suppressed: answered before anything is read, whatever the switch, cap or account
  if p_kind in ('stop', 'start', 'help') then
    return true;
  end if;
  if p_kind is null or p_kind not in ('error_unavailable', 'error_invalid', 'error_unrecognized', 'error_unrouted')
     or (p_account_sid is not null and p_account_sid !~ '^AC[0-9a-fA-F]{32}$') then
    raise exception 'invalid reply check' using errcode = '22023';
  end if;
  if p_account_sid is null or not public._tw4ib_switch_on() then
    return true;   -- the parent account (legacy studios) is never suppressed; nothing is suppressed while the switch is off
  end if;
  select t2.legal_entity_id into v_entity from public.studio_sms_twilio_accounts t2 where t2.twilio_account_sid = p_account_sid and t2.status in ('active', 'suspended');
  if v_entity is null then
    return true;
  end if;
  select * into d from public._tw4ib_day(v_entity, p_at);
  select * into s from public.studio_sms_inbound_reply_suppressions x where x.legal_entity_id = v_entity and x.local_day = d.local_day;
  if s.id is not null then
    return s.cleared_at is not null;   -- suppressed until the next local day, unless an administrator cleared it (then not again that day)
  end if;
  select * into t from public._tw4ib_window(v_entity, d.starts_at, d.ends_at);
  v_trig := public._tw4ib_cap_trigger(public._tw4ib_config(v_entity), t.segments, t.absorbed_cents);
  if v_trig is null then
    return true;
  end if;
  perform public._tw4ib_suppress(v_entity, d.tz, d.local_day, d.starts_at, d.ends_at, v_trig, t.segments, t.absorbed_cents, 'reply_check');
  select * into s from public.studio_sms_inbound_reply_suppressions x where x.legal_entity_id = v_entity and x.local_day = d.local_day;
  return s.cleared_at is not null;
end $$;

create function public.tw4_inbound_auto_reply_allowed(p_account_sid text, p_kind text)
returns boolean language sql security definer
set search_path = pg_catalog, public, pg_temp
-- on the webhook's response path: fail fast (the route then sends the reply exactly as before this migration)
set lock_timeout = '2s'
set statement_timeout = '5s'
as $$ select public._tw4ib_reply_allowed(p_account_sid, p_kind, now()); $$;

-- ---------------------------------------------------------------------------------------------------------------
-- platform administrator functions (written reason / note; audited)
-- ---------------------------------------------------------------------------------------------------------------
-- p_settings: keys of _tw4ib_defaults(); a JSON null removes that override (the scope then inherits). p_entity null = platform-wide.
create function public.tw4_inbound_cost_controls_set(p_entity uuid, p_actor uuid, p_settings jsonb, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k text;
  v jsonb;
  v_new jsonb;
begin
  perform public._tw4c_admin(p_actor);
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 or p_settings is null or jsonb_typeof(p_settings) <> 'object' or p_settings = '{}'::jsonb then
    raise exception 'settings (a JSON object) and a written reason (10 to 300 characters) are required' using errcode = '22023';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_settings) e loop
    if not (public._tw4ib_defaults() ? k) then
      raise exception 'unknown inbound cost control setting %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) <> 'null' and not public._tw4ib_valid_setting(k, v) then
      raise exception 'inbound cost control setting % is out of range', k using errcode = '22023';
    end if;
  end loop;
  if p_entity is not null and not exists (select 1 from public.studio_sms_legal_entities le where le.id = p_entity) then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  v_new := jsonb_strip_nulls(public._tw4ib_scope_settings(p_entity) || p_settings);
  insert into public.studio_sms_inbound_cost_controls (scope, legal_entity_id, settings, set_by, reason)
  values (case when p_entity is null then 'platform' else 'entity' end, p_entity, v_new, p_actor, btrim(p_reason));
  insert into public.studio_sms_inbound_cost_control_events (legal_entity_id, event, actor, note) values (p_entity, 'config_set', p_actor, left(v_new::text || ';' || btrim(p_reason), 600));
  return jsonb_build_object('scope', case when p_entity is null then 'platform' else 'entity' end, 'overrides', v_new, 'effective', public._tw4ib_config(p_entity));
end $$;

create function public.tw4_inbound_reply_cap_switch_set(p_actor uuid, p_enabled boolean, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a switch state and a written reason (10 to 300 characters) are required' using errcode = '22023';
  end if;
  insert into public.studio_sms_inbound_reply_cap_switch_log (enabled, changed_by, reason) values (p_enabled, p_actor, btrim(p_reason));
  insert into public.studio_sms_inbound_cost_control_events (legal_entity_id, event, actor, note) values (null, 'switch_set', p_actor, left('enabled=' || p_enabled || ';' || btrim(p_reason), 600));
  return jsonb_build_object('enabled', p_enabled);
end $$;

-- clears TODAY's (business-local) suppression of one business; the cap does not suppress it again that day
create function public.tw4_inbound_reply_suppression_clear(p_entity uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  d record;
  v_id uuid;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a written note (10 to 300 characters) is required' using errcode = '22023';
  end if;
  if p_entity is null or not exists (select 1 from public.studio_sms_legal_entities le where le.id = p_entity) then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  select * into d from public._tw4ib_day(p_entity, now());
  update public.studio_sms_inbound_reply_suppressions set cleared_at = clock_timestamp(), cleared_by = p_actor, clear_note = btrim(p_note)
   where legal_entity_id = p_entity and local_day = d.local_day and cleared_at is null returning id into v_id;
  if v_id is null then
    return jsonb_build_object('cleared', false, 'reason', 'no active suppression today', 'local_day', d.local_day);
  end if;
  insert into public.studio_sms_inbound_cost_control_events (legal_entity_id, event, actor, note) values (p_entity, 'cleared', p_actor, left('local_day=' || d.local_day || ';' || btrim(p_note), 600));
  return jsonb_build_object('cleared', true, 'local_day', d.local_day);
end $$;

-- administrator read: the switch, the effective configuration, today's numbers and today's suppression state of one business
create function public.tw4_inbound_cost_controls_status(p_actor uuid, p_entity uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  mt jsonb;
  s public.studio_sms_inbound_reply_suppressions;
begin
  perform public._tw4c_admin(p_actor);
  if p_entity is null or not exists (select 1 from public.studio_sms_legal_entities le where le.id = p_entity) then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  mt := public._tw4ib_metrics(p_entity, now());
  select * into s from public.studio_sms_inbound_reply_suppressions x where x.legal_entity_id = p_entity and x.local_day = (mt->>'local_day')::date;
  return jsonb_build_object('switch_on', public._tw4ib_switch_on(), 'config', public._tw4ib_config(p_entity), 'metrics', mt,
                            'suppression', case when s.id is null then 'none' when s.cleared_at is null then 'active' else 'cleared' end,
                            'suppression_trigger', s.trigger);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4ib_suppression_guard(), public._tw4ib_defaults(), public._tw4ib_valid_setting(text, jsonb), public._tw4ib_scope_settings(uuid),
  public._tw4ib_config(uuid), public._tw4ib_switch_on(), public._tw4ib_day(uuid, timestamptz), public._tw4ib_window(uuid, timestamptz, timestamptz),
  public._tw4ib_metrics(uuid, timestamptz), public._tw4ib_cap_trigger(jsonb, bigint, bigint),
  public._tw4ib_suppress(uuid, text, date, timestamptz, timestamptz, text, bigint, bigint, text), public._tw4ib_check(timestamptz),
  public._tw4ib_reply_allowed(text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.tw4_inbound_cost_controls_check(), public.tw4_inbound_auto_reply_allowed(text, text), public.tw4_inbound_cost_controls_set(uuid, uuid, jsonb, text),
  public.tw4_inbound_reply_cap_switch_set(uuid, boolean, text), public.tw4_inbound_reply_suppression_clear(uuid, uuid, text), public.tw4_inbound_cost_controls_status(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.tw4_inbound_cost_controls_check(), public.tw4_inbound_auto_reply_allowed(text, text), public.tw4_inbound_cost_controls_set(uuid, uuid, jsonb, text),
  public.tw4_inbound_reply_cap_switch_set(uuid, boolean, text), public.tw4_inbound_reply_suppression_clear(uuid, uuid, text), public.tw4_inbound_cost_controls_status(uuid, uuid)
  to service_role;

commit;
