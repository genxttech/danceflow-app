-- Rollback for 20261119092100_twilio_tw4_r1_1_window_and_sid_guards.sql (TW-4 R1.1).
-- Restores tw4_runner_begin_step (as R1 defined it) and the 4A ledger guard (as 20261119090000 defined it), both lifted verbatim.
-- Order: application first, then this script.
begin;

set local lock_timeout = '5s';

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
  if old.status = 'succeeded' and new.status is distinct from 'succeeded' then
    raise exception 'studio_sms_provisioning_steps: a succeeded step cannot change status' using errcode = '22023';
  end if;
  return new;
end $$;

do $$
begin
  if position('TW001' in (select prosrc from pg_proc where oid = 'public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)'::regprocedure)) > 0
     or position('sid of a succeeded step' in (select prosrc from pg_proc where oid = 'public._sms_onb_steps_guard()'::regprocedure)) > 0 then
    raise exception 'R1.1 rollback self-check failed: new bodies remain';
  end if;
end $$;

commit;
