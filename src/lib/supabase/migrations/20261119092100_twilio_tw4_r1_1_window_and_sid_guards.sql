-- 20261119092100_twilio_tw4_r1_1_window_and_sid_guards.sql
-- TW-4 R1.1 (forward fix on top of 20261119092000; function bodies only, no table, column or privilege change). Found by the R1 dry run
-- (docs/twilio/TW-4_R1_DryRun_Report.md):
--   1. The runner window (database kill switch) was checked only when a run CLAIMED a studio. A run already in progress kept going,
--      including into the paid brand step, after an admin had closed the window. tw4_runner_begin_step now requires an open window
--      for EVERY step at the moment it begins (SQLSTATE TW001), so closing the window stops a run before its next step and before the
--      paid step. (A step that already began finishes and is recorded; the paid call itself follows its begin within milliseconds.)
--   2. The ledger guard froze a succeeded step's status but not its provider sid: the table owner (no API role) could rewrite it. The
--      guard now freezes the sid of a succeeded step as well.
-- Privileges are unchanged (CREATE OR REPLACE keeps the grants; the self-check proves it).
-- Rollback: rollback/20261119092100_twilio_tw4_r1_1_window_and_sid_guards_rollback.sql
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)') is null
     or to_regclass('public.studio_sms_runner_windows') is null then
    raise exception 'R1.1 precondition failed: R1 (20261119092000) is not applied';
  end if;
end $$;

create or replace function public.tw4_runner_begin_step(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_friendly_name text,
  p_fee_bearing boolean, p_fee_confirmed_by uuid, p_mock boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_provisioning_steps;
  v_fee boolean;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if not public._tw4_r1_step_ok(p_step_key) then
    raise exception 'unknown step' using errcode = '22023';
  end if;
  -- the fee flag is a property of the STEP, never of the caller: only the brand is paid
  v_fee := (p_step_key = 'B1');
  if p_fee_bearing is distinct from v_fee or coalesce(p_mock, false) and not v_fee then
    raise exception 'fee flag does not match the step' using errcode = '22023';
  end if;
  -- the database kill switch also stops a run that is ALREADY in progress: every step needs an open window at the moment it begins
  if not exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = o.studio_id and w.expires_at > now()) then
    raise exception 'the runner window for this studio is closed' using errcode = 'TW001';
  end if;
  -- keep the lease alive while a long run progresses
  update public.studio_sms_onboarding set lease_expires_at = greatest(lease_expires_at, now() + interval '5 minutes') where id = o.id;
  select * into r from public.studio_sms_provisioning_steps s
  where s.onboarding_id = o.id and s.step_key = p_step_key and s.submission_seq = o.submission_seq for update;
  if r.id is not null and r.status = 'succeeded' then
    return jsonb_build_object('action', 'skip', 'provider_sid', r.provider_sid);
  end if;
  if r.id is not null and r.status in ('in_flight', 'unknown_outcome') then
    return jsonb_build_object('action', 'reconcile', 'provider_sid', r.provider_sid, 'status', r.status);
  end if;
  if v_fee then
    if not public._tw4_r1_is_platform_admin(p_fee_confirmed_by) then
      raise exception 'a platform admin must confirm a fee-bearing step' using errcode = '42501';
    end if;
    -- one paid brand per studio: refuse when the registration row already holds a brand, or when ANY earlier brand attempt for this studio
    -- (another generation or onboarding) is not a definite failure. Resubmission never buys a second brand silently.
    if exists (select 1 from public.studio_sms_registrations g where g.studio_id = o.studio_id and g.brand_sid is not null)
       or exists (select 1 from public.studio_sms_provisioning_steps b
                  where b.studio_id = o.studio_id and b.step_key = 'B1' and b.status <> 'failed' and b.id is distinct from r.id) then
      raise exception 'this studio already has a brand registration or an unresolved brand attempt' using errcode = '55000';
    end if;
  end if;
  if r.id is null then
    insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, friendly_name, fee_bearing,
      fee_confirmed_by, fee_confirmed_at, started_at, mock)
    values (o.id, o.studio_id, p_step_key, o.submission_seq, 'in_flight', left(p_friendly_name, 128), v_fee,
      case when v_fee then p_fee_confirmed_by end, case when v_fee then now() end, now(), coalesce(p_mock, false));
  else
    update public.studio_sms_provisioning_steps set status = 'in_flight', started_at = now(), finished_at = null, error_code = null,
      error_detail_sanitized = null, friendly_name = left(p_friendly_name, 128), fee_bearing = v_fee,
      fee_confirmed_by = case when v_fee then p_fee_confirmed_by end, fee_confirmed_at = case when v_fee then now() end, mock = coalesce(p_mock, false)
    where id = r.id;
  end if;
  return jsonb_build_object('action', 'execute');
end $$;

create or replace function public._sms_onb_steps_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.studio_sms_onboarding o where o.id = old.onboarding_id) then
      return old;  -- cascade from a deleted onboarding / studio
    end if;
    raise exception 'studio_sms_provisioning_steps rows are not deleted' using errcode = '42501';
  end if;
  if new.onboarding_id is distinct from old.onboarding_id or new.studio_id is distinct from old.studio_id
     or new.step_key is distinct from old.step_key or new.submission_seq is distinct from old.submission_seq
     or new.created_at is distinct from old.created_at then
    raise exception 'studio_sms_provisioning_steps: identity fields are immutable' using errcode = '42501';
  end if;
  -- a succeeded step's provider sid is final, even for the table owner
  if old.status = 'succeeded' and new.provider_sid is distinct from old.provider_sid then
    raise exception 'studio_sms_provisioning_steps: the sid of a succeeded step cannot change' using errcode = '22023';
  end if;
  if old.status = 'succeeded' and new.status is distinct from 'succeeded' then
    raise exception 'studio_sms_provisioning_steps: a succeeded step cannot change status' using errcode = '22023';
  end if;
  return new;
end $$;

do $$
declare
  v_bad text[] := '{}';
begin
  if not has_function_privilege('service_role', 'public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)', 'EXECUTE') then
    v_bad := v_bad || 'begin_step privileges changed';
  end if;
  if has_function_privilege('anon', 'public._sms_onb_steps_guard()', 'EXECUTE') or has_function_privilege('authenticated', 'public._sms_onb_steps_guard()', 'EXECUTE')
     or has_function_privilege('service_role', 'public._sms_onb_steps_guard()', 'EXECUTE') then
    v_bad := v_bad || 'guard exposed';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)'::regprocedure and p.prosecdef
                 and 'search_path=pg_catalog, public, pg_temp' = any (p.proconfig)) then
    v_bad := v_bad || 'definer or search_path pin lost';
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'R1.1 self-check failed: %', array_to_string(v_bad, '; ') using errcode = '42501';
  end if;
end $$;

commit;
