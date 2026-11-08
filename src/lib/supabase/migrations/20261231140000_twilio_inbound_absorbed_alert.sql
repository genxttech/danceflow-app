-- 20261231140000_twilio_inbound_absorbed_alert.sql
-- TW-4F pilot: automatic notification when DanceFlow-ABSORBED inbound text cost approaches or reaches the pilot business's $20 allowance (carved out of the $150
-- cumulative pilot ceiling; owner decision 2026-10-30, docs/twilio/TW-4F_Pilot_Readiness_Checklist.md section 6), plus a daily inbound-volume exception. Dark; Git-only.
--
-- NOTIFICATION ONLY. Nothing here blocks, holds, releases or limits anything: it does not touch STOP/START/HELP handling, inbound recording, number ownership, outbound
-- sending, any balance, any ceiling or any reservation. It only inserts rows into the existing alert outbox (studio_sms_provider_alerts) through the existing
-- _tw4rfl_alert (idempotent per kind + dedupe key); delivery, escalation (alert_delivery_exhausted) and the kill switches are the existing ones, and it is called from
-- the existing scheduled provider-fee lifecycle scan (no new route, no new cron).
--
-- DEFINITION (one place: _tw4ia_absorbed_cents). The cost DanceFlow absorbs for ONE inbound record is its estimated provider cost that the studio was not charged for,
-- plus the estimated cost of the reply sent for it:
--     est_reply_cost_cents                                                            (always DanceFlow's: compliance confirmations and error replies)
--   + est_provider_cost_cents                                                          when billable_cents = 0 (compliance STOP/START/HELP, MMS, no inbound price)
--   + ceil(est_provider_cost_cents * uncollected_cents / billable_cents)               when billable_cents > 0 (the part of an ordinary text beyond the ceiling/credit)
-- A text charged in full contributes only its reply cost. Rows without a cost estimate (no inbound price was published when recorded) contribute 0: publishing an
-- inbound price is a pilot precondition (checklist section 6 item 3). MMS is estimated at the SMS rate (the recorded estimate), so it can be slightly understated.
-- PERIOD: cumulative from the pilot exception's created_at (the allowance is part of a cumulative ceiling, not a monthly figure). The alert is raised ONCE per threshold
-- per period; a new pilot exception (a new period) re-arms it. Only a business with a pilot exception is checked for the allowance.
-- THRESHOLDS: warning at 80% (1600 of 2000), critical at 100%. Only the highest newly crossed threshold is raised in a pass. The allowance is ONE constant:
-- _tw4ia_allowance_cents(). VOLUME: any business whose inbound segments in the last 24 hours exceed 200 (the same condition as sms_inbound_admin_overview.alert_volume),
-- once per business per UTC day.
-- Audience is the verified platform administrator only (never the studio owner); the alert has no location (entity level): tw4_rfl_alert_recipients already supplies
-- the business's earliest-linked location for administrator rows so the existing delivery sink can queue the mail (unchanged).
-- Summaries carry no amounts. Requires 20261211090000 (alert outbox, kind constraint) and 20261203090000 (inbound usage). Rollback: rollback/20261231140000_twilio_inbound_absorbed_alert_rollback.sql
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_name text;
  v_def text;
  v_vals text[];
begin
  if to_regclass('public.studio_sms_inbound_usage') is null or to_regclass('public.studio_sms_pilot_exceptions') is null
     or to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is null or to_regprocedure('public.tw4_rfl_escalate_delivery()') is null then
    raise exception 'inbound absorbed alert precondition failed: 20261203090000 and 20261211090000 are not both applied';
  end if;
  if to_regprocedure('public._tw4ia_allowance_cents()') is not null then
    raise exception 'inbound absorbed alert precondition failed: already applied';
  end if;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'inbound absorbed alert precondition failed: the alert-kind constraint is missing';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or cardinality(v_vals) < 16 or not ('alert_delivery_exhausted' = any (v_vals)) then
    raise exception 'could not read the alert kinds from %', v_def;
  end if;
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  v_vals := (select array_agg(distinct x order by x) from unnest(v_vals || array['inbound_absorbed_allowance', 'inbound_volume_high']) x);
  execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
  execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
end $$;

-- the single definition of the allowance and the volume threshold
create function public._tw4ia_allowance_cents()
returns int language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select 2000 $$;

create function public._tw4ia_daily_segment_limit()
returns int language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select 200 $$;

-- DanceFlow-absorbed inbound cost of a business since a time (see the definition in the header)
create function public._tw4ia_absorbed_cents(p_entity uuid, p_since timestamptz)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(sum(coalesce(u.est_reply_cost_cents, 0)
    + case when u.est_provider_cost_cents is null then 0
           when u.billable_cents = 0 then u.est_provider_cost_cents
           else ceil(u.est_provider_cost_cents::numeric * u.uncollected_cents / u.billable_cents)::int end), 0)::bigint
    from public.studio_sms_inbound_usage u where u.legal_entity_id = p_entity and u.received_at >= p_since;
$$;

-- raises the alerts (idempotent per kind + dedupe key); returns counts only
create function public.tw4_rfl_inbound_allowance_check()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  z record;
  v_abs bigint;
  v_allow int := public._tw4ia_allowance_cents();
  v_warn int := (public._tw4ia_allowance_cents() * 80 + 99) / 100;
  v_period text;
  v_w int := 0;
  v_c int := 0;
  v_v int := 0;
begin
  for z in select pe.legal_entity_id, pe.created_at from public.studio_sms_pilot_exceptions pe order by pe.legal_entity_id loop
    v_abs := public._tw4ia_absorbed_cents(z.legal_entity_id, z.created_at);
    v_period := to_char(z.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
    if v_abs >= v_allow then
      if public._tw4rfl_alert(z.legal_entity_id, null, null, 'inbound_absorbed_allowance', 'inb-allow:' || z.legal_entity_id || ':' || v_period || ':100', 'admin', 'critical',
           'Absorbed inbound text cost for the pilot business has reached its full allowance. Nothing has been blocked or released; review inbound traffic and decide on any action.') then v_c := v_c + 1; end if;
    elsif v_abs >= v_warn then
      if public._tw4rfl_alert(z.legal_entity_id, null, null, 'inbound_absorbed_allowance', 'inb-allow:' || z.legal_entity_id || ':' || v_period || ':80', 'admin', 'warning',
           'Absorbed inbound text cost for the pilot business has reached 80 percent of its allowance. Nothing has been blocked or released.') then v_w := v_w + 1; end if;
    end if;
  end loop;
  for z in select u.legal_entity_id from public.studio_sms_inbound_usage u where u.received_at >= now() - interval '1 day'
            group by u.legal_entity_id having sum(u.segments) > public._tw4ia_daily_segment_limit() order by u.legal_entity_id loop
    if public._tw4rfl_alert(z.legal_entity_id, null, null, 'inbound_volume_high', 'inb-vol:' || z.legal_entity_id || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDD'), 'admin', 'warning',
         'Inbound text volume for a business passed the daily threshold. Nothing has been blocked; review inbound traffic.') then v_v := v_v + 1; end if;
  end loop;
  return jsonb_build_object('allowance_warnings', v_w, 'allowance_critical', v_c, 'volume', v_v);
end $$;

revoke all on function public._tw4ia_allowance_cents(), public._tw4ia_daily_segment_limit(), public._tw4ia_absorbed_cents(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.tw4_rfl_inbound_allowance_check() from public, anon, authenticated;
grant execute on function public.tw4_rfl_inbound_allowance_check() to service_role;

commit;
