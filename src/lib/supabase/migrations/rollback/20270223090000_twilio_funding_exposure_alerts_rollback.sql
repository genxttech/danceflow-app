-- Rollback of 20270223090000_twilio_funding_exposure_alerts.sql: restores the 20261208090000 body of tw4_act_exposure and the 20261211090000 body of tw4_rfl_health, drops the check and its helpers, and
-- restores the alert-kind constraint WITHOUT the four kinds this migration added.
-- REFUSES (55000) while any alert row uses one of those kinds (history is never deleted or rewritten), when the live constraint does not carry exactly them,
-- or when tw4_act_exposure is no longer the body this migration installed (a later change would be lost).
begin;
set local lock_timeout = '5s';
do $$
declare
  v_new text[] := array['funding_exposure_unfunded', 'funding_exposure_unauthorized', 'funding_exposure_grace_ending', 'funding_exposure_threshold'];
  v_name text;
  v_def text;
  v_vals text[];
begin
  if to_regprocedure('public._tw4fx_exposure_rows()') is null then
    raise exception 'funding exposure alert rollback refused: 20270223090000 is not applied' using errcode = '55000';
  end if;
  if (select replace(p.prosrc, chr(13), '') from pg_proc p where p.oid = 'public.tw4_act_exposure(uuid)'::regprocedure) not like '%public._tw4fx_exposure_rows()%' then
    raise exception 'funding exposure alert rollback refused: tw4_act_exposure was changed after 20270223090000' using errcode = '55000';
  end if;
  if (select replace(p.prosrc, chr(13), '') from pg_proc p where p.oid = 'public.tw4_rfl_health(uuid)'::regprocedure) not like '%public._tw4fx_unattributed_locations()%' then
    raise exception 'funding exposure alert rollback refused: tw4_rfl_health was changed after 20270223090000' using errcode = '55000';
  end if;
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'funding exposure alert rollback refused: the alert-kind constraint is missing' using errcode = '55000';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or not (v_new <@ v_vals) then
    raise exception 'funding exposure alert rollback refused: the alert-kind constraint does not carry this migration''s kinds (a later change, or already rolled back)' using errcode = '55000';
  end if;
  if exists (select 1 from public.studio_sms_provider_alerts a where a.kind = any (v_new)) then
    raise exception 'funding exposure alert rollback refused: alert rows use a kind that only 20270223090000 allows; they are never deleted or rewritten' using errcode = '55000';
  end if;
  v_vals := (select array_agg(x order by x) from unnest(v_vals) x where x <> all (v_new));
  execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
  execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
end $$;

-- the 20261208090000 body, verbatim
create or replace function public.tw4_act_exposure(p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
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
revoke all on function public.tw4_act_exposure(uuid) from public, anon, authenticated;
grant execute on function public.tw4_act_exposure(uuid) to service_role;

-- the 20261211090000 body of tw4_rfl_health, verbatim
create or replace function public.tw4_rfl_health(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $
declare
  v_last timestamptz;
  v_ok timestamptz;
  v_status text;
begin
  perform public._tw4c_admin(p_actor);
  select r.started_at, r.status into v_last, v_status from public.studio_sms_rfl_runs r order by r.started_at desc, r.id desc limit 1;
  select max(r.finished_at) into v_ok from public.studio_sms_rfl_runs r where r.status = 'completed';
  return jsonb_build_object(
    'scan_switch', public.tw4_rfl_switch_enabled('scan'),
    'delivery_switch', public.tw4_rfl_switch_enabled('delivery'),
    'last_run_at', v_last,
    'last_success_at', v_ok,
    'last_status', v_status,
    'stale', v_ok is null or v_ok < now() - interval '26 hours',
    'runs_failed_24h', (select count(*) from public.studio_sms_rfl_runs r where r.status = 'failed' and coalesce(r.finished_at, r.started_at) > now() - interval '24 hours'),
    'alerts_pending', (select count(*) from public.studio_sms_provider_alerts a where a.status = 'pending'),
    'alerts_failed', (select count(*) from public.studio_sms_provider_alerts a where a.status = 'failed'),
    'alerts_exhausted', (select count(*) from public.studio_sms_provider_alerts a where a.attempts >= 5 and (a.status = 'failed' or (a.status = 'sending' and a.claimed_at < now() - interval '15 minutes'))),
    'oldest_pending_alert_age_seconds', (select floor(extract(epoch from now() - min(a.created_at)))::bigint from public.studio_sms_provider_alerts a where a.status = 'pending'),
    'open_exposure_count', (select count(*) from public.studio_sms_provider_exposure e where e.state = 'open'),
    'open_cancel_operations', (select count(*) from public.studio_sms_provider_cancel_ops o where o.status in ('authorized', 'in_flight', 'unknown_outcome')));
end $;

drop function if exists public.tw4_rfl_funding_exposure_check();
drop function if exists public._tw4fx_unattributed_locations();
drop function if exists public._tw4fx_exposure_rows();
drop function if exists public._tw4fx_grace_warning();
drop function if exists public._tw4fx_platform_threshold_cents();
drop function if exists public._tw4fx_entity_threshold_cents();
commit;
