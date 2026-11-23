-- 20270223090000_twilio_funding_exposure_alerts.sql
-- TW-4F audit F-11: proactive funding-exposure monitoring. Dark; Git-only.
--
-- PROBLEM. tw4_act_exposure (20261208090000) lists the locations and numbers DanceFlow may be paying Twilio for without a basis to collect, but nothing ever
-- called it outside the tests, and it requires a platform-administrator ACTOR (the scheduled scan has none). The recurring provider-fee lifecycle scan
-- (tw4_rfl_scan_entity) only sees resources registered in the fee inventory and alerts on an exposure ONCE, when it opens after the 7-day grace.
--
-- WHAT THIS ADDS (notification only: it inserts rows into the existing alert outbox through the existing _tw4rfl_alert, idempotent per kind + dedupe key):
--   _tw4fx_exposure_rows()            the body of tw4_act_exposure, verbatim, without the actor check (one definition; tw4_act_exposure now calls it after the
--                                     unchanged administrator check, so its answer is byte-for-byte what it was)
--   tw4_rfl_funding_exposure_check()  service role only; called from the EXISTING hourly provider-fee lifecycle scan (no new route, no new cron), so it runs only
--                                     when the scan's env flag (SMS_FEE_LIFECYCLE_SCAN=on) and its database `scan` switch both allow a pass. Returns counts only.
--   four alert kinds, all for the platform administrator only (never the owner: the owner already has next_period_uncovered / authorization_expiring):
--     funding_exposure_unfunded      a ready / active / suspended location whose funding continuity fails (tw4_act_exposure 'funding_continuity'), once per
--                                    location, failure detail and business month; a recurring charge recorded UNFUNDED for the current or previous business
--                                    month while a resource of that fee is live, once per charge row
--     funding_exposure_unauthorized  a live number with no active rent authorization, a number whose rent basis is indeterminate, the pilot's live number
--                                    (month two has no standing approval), an active rent authorization with no number to bill (the studio would be charged for
--                                    nothing), each once per location and business month; and a recorded OPEN exposure (past grace, uncovered: texting is
--                                    suspended but Twilio keeps billing until a dual-control cancellation is confirmed or the owner authorizes again), once
--                                    per resource and business month
--     funding_exposure_grace_ending  a live fee resource whose current or previous period is uncovered and whose 7-day grace ends within 72 hours (texting will
--                                    then be suspended while the provider keeps billing), once per resource and period
--     funding_exposure_threshold     the recorded open exposure of ONE business, or of the whole platform, reached its threshold (_tw4fx_entity_threshold_cents,
--                                    _tw4fx_platform_threshold_cents: single constants), once per business month (platform: once per UTC month, attached to the
--                                    business with the largest share so the existing recipient function can address it)
--   Summaries carry no amount, number, SID or name. A listed location that has no legal business cannot be attached to an alert: it is COUNTED (unattributed).
--
-- NOT TOUCHED: STOP/START/HELP handling, inbound recording, sending, any balance, reservation, ceiling, authorization, charge, resource or exposure row. No
-- Twilio call is possible from SQL. Requires 20261208090000, 20261209090000, 20261211090000 and 20261231140000 (the alert-kind constraint they extend).
-- ORDER: apply this SQL before the app that calls tw4_rfl_funding_exposure_check (until then the scan counts the missing function as an error, fail-loud).
-- Rollback: rollback/20270223090000_twilio_funding_exposure_alerts_rollback.sql (refuses while any alert row uses one of the four kinds).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_name text;
  v_def text;
  v_vals text[];
begin
  if to_regprocedure('public.tw4_act_exposure(uuid)') is null or to_regprocedure('public._tw4c_admin(uuid)') is null or to_regprocedure('public.tw4_num_rent_basis(uuid)') is null
     or to_regprocedure('public._tw4act_funding(uuid)') is null or to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is null
     or to_regprocedure('public._tw4rfl_cover(public.studio_sms_provider_resources,text)') is null or to_regprocedure('public._tw4rfl_due_from(public.studio_sms_provider_resources,text)') is null
     or to_regprocedure('public.tw4_rfl_inbound_allowance_check()') is null then
    raise exception 'funding exposure alert precondition failed: 20261208090000, 20261209090000, 20261211090000 and 20261231140000 are not all applied';
  end if;
  if to_regprocedure('public._tw4fx_exposure_rows()') is not null then
    raise exception 'funding exposure alert precondition failed: already applied';
  end if;
  -- the body this migration moves must be the 20261208 one (a later change would be silently replaced otherwise)
  if (select left(md5(replace(p.prosrc, chr(13), '')), 12) from pg_proc p where p.oid = 'public.tw4_act_exposure(uuid)'::regprocedure) is distinct from '86f81f72241d' then
    raise exception 'funding exposure alert precondition failed: tw4_act_exposure is not the 20261208090000 body';
  end if;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'funding exposure alert precondition failed: the alert-kind constraint is missing';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or cardinality(v_vals) < 18 or not ('inbound_absorbed_allowance' = any (v_vals)) then
    raise exception 'could not read the alert kinds from %', v_def;
  end if;
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  v_vals := (select array_agg(distinct x order by x) from unnest(v_vals || array['funding_exposure_unfunded', 'funding_exposure_unauthorized', 'funding_exposure_grace_ending', 'funding_exposure_threshold']) x);
  execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
  execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
end $$;

-- the single definitions of the thresholds (recorded open exposure, provider cents)
create function public._tw4fx_entity_threshold_cents()
returns int language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select 1000 $$;

create function public._tw4fx_platform_threshold_cents()
returns int language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select 5000 $$;

-- how close to the end of the 7-day grace the administrator is warned
create function public._tw4fx_grace_warning()
returns interval language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select interval '72 hours' $$;

-- the 20261208090000 body of tw4_act_exposure, verbatim, without the actor check
create function public._tw4fx_exposure_rows()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return coalesce((select jsonb_agg(x.j order by x.sid, x.j ->> 'reason') from (
      -- 1. ready / active / suspended locations whose funding continuity fails
      select o.studio_id sid, jsonb_build_object('studio_id', o.studio_id, 'state', o.state, 'reason', 'funding_continuity', 'funding', public._tw4act_funding(o.studio_id)) j
        from public.studio_sms_onboarding o
       where o.state in ('ready_for_activation', 'active', 'suspended') and (public._tw4act_funding(o.studio_id) ->> 'ok')::boolean is not true
      union all
      -- 2. a number that MAY be paid for with no confirmed basis (unknown purchase outcome, ownership not confirmed or lost, attachment lost, subaccount not active, released but not retired)
      select s.sid, jsonb_build_object('studio_id', s.sid, 'reason', 'rent_basis_indeterminate', 'detail', s.b ->> 'reason', 'number', s.b ->> 'e164')
        from (select d.studio_id sid, public.tw4_num_rent_basis(d.studio_id) b from (select distinct studio_id from public.studio_sms_num_operations) d) s
       where s.b ->> 'state' = 'indeterminate'
      union all
      -- 3. a live number of the pilot business: its month two has no approval operation and DanceFlow pays Twilio meanwhile
      select s.sid, jsonb_build_object('studio_id', s.sid, 'reason', 'pilot_number_live', 'number', s.b ->> 'e164')
        from (select d.studio_id sid, public.tw4_num_rent_basis(d.studio_id) b from (select distinct studio_id from public.studio_sms_num_operations) d) s
       where s.b ->> 'state' = 'billable' and (s.b ->> 'pilot')::boolean
      union all
      -- 4. a live number with no active rent authorization (credit businesses): DanceFlow pays Twilio and nothing is collected
      select p.studio_id, jsonb_build_object('studio_id', p.studio_id, 'reason', 'number_without_authorization', 'number', p.e164)
        from public.studio_sms_num_operations p
       where p.op_kind = 'number_purchase' and p.status = 'succeeded' and p.superseded_at is null
         and not exists (select 1 from public.studio_sms_pilot_exceptions y where y.legal_entity_id = p.legal_entity_id)
         and not exists (select 1 from public.studio_sms_recurring_authorizations a where a.studio_id = p.studio_id and a.kind = 'number' and a.status = 'active' and a.expires_at > now())
      union all
      -- 5. an active rent authorization on an R2b-managed location that has no number to bill (rent would be charged for nothing)
      select a.studio_id, jsonb_build_object('studio_id', a.studio_id, 'reason', 'authorization_without_number', 'authorization', a.id)
        from public.studio_sms_recurring_authorizations a
       where a.kind = 'number' and a.status = 'active' and a.expires_at > now()
         and (public.tw4_num_rent_basis(a.studio_id) ->> 'managed')::boolean and public.tw4_num_rent_basis(a.studio_id) ->> 'state' = 'not_billable'
    ) x), '[]'::jsonb);
end $$;

-- unchanged contract: the administrator check, then the same rows
create or replace function public.tw4_act_exposure(p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return public._tw4fx_exposure_rows();
end $$;

-- raises the alerts (idempotent per kind + dedupe key); returns counts only
create function public.tw4_rfl_funding_exposure_check()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  z record;
  v_entity uuid;
  v_month text;
  v_kind text;
  v_sev text;
  v_key text;
  v_sum text;
  v_unf int := 0;
  v_una int := 0;
  v_gr int := 0;
  v_thr int := 0;
  v_unattributed int := 0;
  v_total bigint;
  v_top uuid;
  v_due timestamptz;
  v_cov text;
  k text;
begin
  -- 1. what tw4_act_exposure lists
  for z in select e.value j from jsonb_array_elements(public._tw4fx_exposure_rows()) e loop
    select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = (z.j ->> 'studio_id')::uuid;
    if v_entity is null then
      v_unattributed := v_unattributed + 1;   -- cannot be addressed (the outbox needs a business); counted so it is never silent
      continue;
    end if;
    v_month := public._tw4ml_month_key(v_entity, now());
    v_kind := 'funding_exposure_unauthorized';
    v_sev := 'warning';
    case z.j ->> 'reason'
      when 'funding_continuity' then
        v_kind := 'funding_exposure_unfunded';
        v_sev := case when z.j ->> 'state' = 'active' then 'critical' else 'warning' end;
        v_key := 'fx-fund:' || (z.j ->> 'studio_id') || ':' || coalesce(z.j -> 'funding' ->> 'detail', 'unknown') || ':' || v_month;
        v_sum := 'A texting location (' || replace(z.j ->> 'state', '_', ' ') || ') no longer has continuous funding for its recurring provider fees ('
                 || replace(coalesce(z.j -> 'funding' ->> 'detail', 'unknown'), '_', ' ') || '). DanceFlow keeps paying the provider until it is funded or cancelled.';
      when 'number_without_authorization' then
        v_sev := 'critical';
        v_key := 'fx-noauth:' || (z.j ->> 'studio_id') || ':' || v_month;
        v_sum := 'A live phone number has no active rent authorization: DanceFlow pays the provider every month and nothing is collected.';
      when 'rent_basis_indeterminate' then
        v_key := 'fx-basis:' || (z.j ->> 'studio_id') || ':' || v_month;
        v_sum := 'A phone number may be billed by the provider with no confirmed basis (' || replace(coalesce(z.j ->> 'detail', 'unknown'), '_', ' ') || '). Reconcile it with the provider console.';
      when 'pilot_number_live' then
        v_key := 'fx-pilot:' || (z.j ->> 'studio_id') || ':' || v_month;
        v_sum := 'The pilot business has a live phone number: each month needs its own written approval, and DanceFlow pays the provider meanwhile.';
      when 'authorization_without_number' then
        v_key := 'fx-nonum:' || (z.j ->> 'studio_id') || ':' || v_month;
        v_sum := 'An active rent authorization has no phone number to bill: the owner could be charged for nothing. Review it before the next charge.';
      else
        v_key := 'fx-other:' || (z.j ->> 'studio_id') || ':' || left(coalesce(z.j ->> 'reason', 'unknown'), 40) || ':' || v_month;
        v_sum := 'A texting location is listed as a funding exposure. Review it in the administrator overview.';
    end case;
    if public._tw4rfl_alert(v_entity, (z.j ->> 'studio_id')::uuid, null, v_kind, v_key, 'admin', v_sev, v_sum) then
      if v_kind = 'funding_exposure_unfunded' then v_unf := v_unf + 1; else v_una := v_una + 1; end if;
    end if;
  end loop;

  -- 2. a recurring charge recorded UNFUNDED for the current or previous business month while a resource of that fee is live (once per charge row)
  for z in select c.id, c.legal_entity_id, c.studio_id from public.studio_sms_recurring_charges c
            where c.status = 'unfunded'
              and c.period_key in (public._tw4ml_month_key(c.legal_entity_id, now()), public._tw4ml_key_add(public._tw4ml_month_key(c.legal_entity_id, now()), -1))
              and exists (select 1 from public.studio_sms_provider_resources rr where rr.legal_entity_id = c.legal_entity_id and rr.studio_id = c.studio_id
                           and rr.provider_state = 'active' and c.kind = any (public._tw4rfl_charge_kinds(rr.fee_kind)))
            order by c.id loop
    if public._tw4rfl_alert(z.legal_entity_id, z.studio_id, null, 'funding_exposure_unfunded', 'fx-unf:' || z.id, 'admin', 'critical',
         'A recurring provider fee could not be charged: prepaid credit is insufficient. DanceFlow pays the provider for this period unless credit is added in time.') then v_unf := v_unf + 1; end if;
  end loop;

  -- 3. recorded OPEN exposures: texting is suspended, the provider keeps billing until a dual-control cancellation is confirmed or the owner authorizes again
  for z in select distinct on (e.resource_id) e.resource_id, e.legal_entity_id, e.studio_id from public.studio_sms_provider_exposure e
             join public.studio_sms_provider_resources r on r.id = e.resource_id and r.provider_state = 'active'
            where e.state = 'open' order by e.resource_id loop
    if public._tw4rfl_alert(z.legal_entity_id, z.studio_id, z.resource_id, 'funding_exposure_unauthorized', 'fx-open:' || z.resource_id || ':' || public._tw4ml_month_key(z.legal_entity_id, now()), 'admin', 'critical',
         'A live provider resource has an open fee exposure: texting is suspended, but DanceFlow keeps paying the provider until the owner authorizes again or a dual-control cancellation is confirmed.') then v_una := v_una + 1; end if;
  end loop;

  -- 4. the 7-day grace ends within the warning window for an uncovered current or previous period
  for z in select r.* from public.studio_sms_provider_resources r where r.provider_state = 'active' and r.fee_kind is not null order by r.id loop
    foreach k in array array[public._tw4ml_key_add(public._tw4ml_month_key(z.legal_entity_id, now()), -1), public._tw4ml_month_key(z.legal_entity_id, now())] loop
      continue when k < public._tw4ml_month_key(z.legal_entity_id, z.registered_at);
      v_due := public._tw4rfl_due_from(z, k);
      continue when v_due < now() or v_due > now() + public._tw4fx_grace_warning();
      v_cov := public._tw4rfl_cover(z, k);
      continue when v_cov like 'covered:%';
      if public._tw4rfl_alert(z.legal_entity_id, z.studio_id, z.id, 'funding_exposure_grace_ending', 'fx-grace:' || z.id || ':' || k, 'admin', 'warning',
           'A recurring provider fee for ' || k || ' is still uncovered (' || replace(substr(v_cov, 11), '_', ' ') || '). Its grace ends '
           || to_char(v_due at time zone public._tw4ml_tz_for(z.legal_entity_id, k), 'YYYY-MM-DD HH24:MI') || ' business time; then the period is recorded as exposure and texting can be suspended, while the provider keeps billing.') then v_gr := v_gr + 1; end if;
    end loop;
  end loop;

  -- 5. thresholds on RECORDED open exposure (provider cents: the larger of the expected cost and any recorded provider bill)
  for z in select e.legal_entity_id, sum(greatest(coalesce(e.expected_provider_cents, 0), coalesce(e.provider_billed_cents, 0)))::bigint total
             from public.studio_sms_provider_exposure e where e.state = 'open' group by e.legal_entity_id
           having sum(greatest(coalesce(e.expected_provider_cents, 0), coalesce(e.provider_billed_cents, 0))) >= public._tw4fx_entity_threshold_cents() order by e.legal_entity_id loop
    if public._tw4rfl_alert(z.legal_entity_id, null, null, 'funding_exposure_threshold', 'fx-thr:' || z.legal_entity_id || ':' || public._tw4ml_month_key(z.legal_entity_id, now()), 'admin', 'critical',
         'The recorded open fee exposure of one business reached the platform threshold. Review its exposures and decide on authorization or cancellation.') then v_thr := v_thr + 1; end if;
  end loop;
  select coalesce(sum(greatest(coalesce(e.expected_provider_cents, 0), coalesce(e.provider_billed_cents, 0))), 0)::bigint into v_total from public.studio_sms_provider_exposure e where e.state = 'open';
  if v_total >= public._tw4fx_platform_threshold_cents() then
    select e.legal_entity_id into v_top from public.studio_sms_provider_exposure e where e.state = 'open' group by e.legal_entity_id
     order by sum(greatest(coalesce(e.expected_provider_cents, 0), coalesce(e.provider_billed_cents, 0))) desc, e.legal_entity_id limit 1;
    if public._tw4rfl_alert(v_top, null, null, 'funding_exposure_threshold', 'fx-thr-all:' || to_char(now() at time zone 'UTC', 'YYYY-MM'), 'admin', 'critical',
         'The recorded open fee exposure across ALL businesses reached the platform threshold. Review the exposure overview.') then v_thr := v_thr + 1; end if;
  end if;

  return jsonb_build_object('unfunded', v_unf, 'unauthorized', v_una, 'grace_ending', v_gr, 'threshold', v_thr, 'unattributed', v_unattributed);
end $$;

revoke all on function public._tw4fx_entity_threshold_cents(), public._tw4fx_platform_threshold_cents(), public._tw4fx_grace_warning(), public._tw4fx_exposure_rows()
  from public, anon, authenticated, service_role;
revoke all on function public.tw4_act_exposure(uuid) from public, anon, authenticated;
grant execute on function public.tw4_act_exposure(uuid) to service_role;
revoke all on function public.tw4_rfl_funding_exposure_check() from public, anon, authenticated;
grant execute on function public.tw4_rfl_funding_exposure_check() to service_role;

commit;
