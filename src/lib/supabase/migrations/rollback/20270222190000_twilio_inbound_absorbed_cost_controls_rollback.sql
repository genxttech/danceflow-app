-- Rollback of 20270222190000_twilio_inbound_absorbed_cost_controls.sql. Roll the APP back first (or leave it: the app treats a missing function as "not installed":
-- the scan then counts no new alerts and the webhook sends every automatic reply exactly as before this migration).
-- REFUSES (55000) while ANY row this migration's tables hold exists (configuration, switch history, suppressions, audit events) or any alert row uses one of its
-- alert kinds: that history is never deleted or rewritten. Restores the alert-kind constraint WITHOUT the four kinds this migration added. Re-runnable.
begin;
set local lock_timeout = '5s';
do $$
declare
  v_new text[] := array['sms_in_volume_high', 'sms_in_absorbed_high', 'sms_in_anomaly', 'sms_in_daily_cap'];
  v_name text;
  v_def text;
  v_vals text[];
  v_rows boolean := false;
  t text;
begin
  -- dynamic so a second run (tables already gone) is not planned against missing tables
  foreach t in array array['studio_sms_inbound_cost_controls', 'studio_sms_inbound_reply_cap_switch_log', 'studio_sms_inbound_reply_suppressions', 'studio_sms_inbound_cost_control_events'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select exists (select 1 from public.%I)', t) into v_rows;
      if v_rows then
        raise exception 'inbound cost controls rollback refused: public.% holds rows (configuration, switch history, suppressions or audit events are never deleted)', t using errcode = '55000';
      end if;
    end if;
  end loop;
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  if exists (select 1 from public.studio_sms_provider_alerts a where a.kind = any (v_new)) then
    raise exception 'inbound cost controls rollback refused: alert rows use a kind that only 20270222190000 allows; they are never deleted or rewritten' using errcode = '55000';
  end if;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'inbound cost controls rollback refused: the alert-kind constraint is missing' using errcode = '55000';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is not null and v_vals && v_new then
    v_vals := (select array_agg(x order by x) from unnest(v_vals) x where x <> all (v_new));
    execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
    execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
  end if;
end $$;
drop function if exists public.tw4_inbound_cost_controls_status(uuid, uuid);
drop function if exists public.tw4_inbound_reply_suppression_clear(uuid, uuid, text);
drop function if exists public.tw4_inbound_reply_cap_switch_set(uuid, boolean, text);
drop function if exists public.tw4_inbound_cost_controls_set(uuid, uuid, jsonb, text);
drop function if exists public.tw4_inbound_auto_reply_allowed(text, text);
drop function if exists public._tw4ib_reply_allowed(text, text, timestamptz);
drop function if exists public.tw4_inbound_cost_controls_check();
drop function if exists public._tw4ib_check(timestamptz);
drop function if exists public._tw4ib_suppress(uuid, text, date, timestamptz, timestamptz, text, bigint, bigint, text);
drop function if exists public._tw4ib_cap_trigger(jsonb, bigint, bigint);
drop function if exists public._tw4ib_metrics(uuid, timestamptz);
drop function if exists public._tw4ib_window(uuid, timestamptz, timestamptz);
drop function if exists public._tw4ib_day(uuid, timestamptz);
drop function if exists public._tw4ib_switch_on();
drop function if exists public._tw4ib_config(uuid);
drop function if exists public._tw4ib_scope_settings(uuid);
drop function if exists public._tw4ib_valid_setting(text, jsonb);
drop function if exists public._tw4ib_defaults();
drop table if exists public.studio_sms_inbound_cost_control_events;
drop table if exists public.studio_sms_inbound_reply_suppressions;
drop table if exists public.studio_sms_inbound_reply_cap_switch_log;
drop table if exists public.studio_sms_inbound_cost_controls;
drop function if exists public._tw4ib_suppression_guard();
commit;
