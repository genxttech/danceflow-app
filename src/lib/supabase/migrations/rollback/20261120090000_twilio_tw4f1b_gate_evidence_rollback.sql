-- Rollback for 20261120090000_twilio_tw4f1b_gate_evidence.sql (TW-4F-1b).
-- Restores tw4_runner_begin_step and the ledger guard (as R1.1 defined them), tw4_runner_finish_step and tw4_runner_status (as R1 defined them) and the
-- audit vocabulary (as R1 defined it), lifted verbatim. Refuses once any submission confirmation, evaluation audit row or recorded verdict exists: that
-- is evidence and must not be dropped silently.
-- Order: application first (it calls the new functions), then this script, and only then (if ever) the R1.1 / R1 rollbacks, which refuse while this
-- migration is applied.
begin;

set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.studio_sms_submission_confirmations)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('runner_submission_confirmed', 'runner_evaluation'))
     or exists (select 1 from public.studio_sms_provisioning_steps where evaluation_verdict is not null) then
    raise exception 'TW-4F-1b rollback refused: submission confirmations or evaluation evidence exist' using errcode = '55000';
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

create or replace function public.tw4_runner_finish_step(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_status text,
  p_provider_sid text, p_error_code text, p_error_detail text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_provisioning_steps;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if not public._tw4_r1_step_ok(p_step_key) or p_status not in ('succeeded', 'failed', 'unknown_outcome') then
    raise exception 'invalid step outcome' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_provisioning_steps s
  where s.onboarding_id = o.id and s.step_key = p_step_key and s.submission_seq = o.submission_seq for update;
  if r.id is null then
    raise exception 'step was not started' using errcode = '22023';
  end if;
  -- only an OPEN step can be finished: a succeeded step (and its sid) is final, a failed one must be begun again first
  if r.status not in ('in_flight', 'unknown_outcome') then
    raise exception 'step is not open' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (p_provider_sid is null or p_provider_sid !~ '^[A-Za-z]{2}[0-9a-fA-F]{32}$') then
    raise exception 'a succeeded step needs a valid provider sid' using errcode = '22023';
  end if;
  update public.studio_sms_provisioning_steps set status = p_status, provider_sid = coalesce(p_provider_sid, provider_sid),
    error_code = left(p_error_code, 64), error_detail_sanitized = left(p_error_detail, 500), finished_at = now()
  where id = r.id;
  perform public._tw4_r1_audit(o, null, 'runner_step', o.state, o.state, 'step=' || p_step_key || ';status=' || p_status || coalesce(';code=' || left(p_error_code, 64), ''));
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

create or replace function public.tw4_runner_status(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  if o.id is null then return null; end if;
  return jsonb_build_object(
    'onboarding_id', o.id, 'state', o.state, 'step', o.step, 'submission_seq', o.submission_seq,
    'ein_on_file', o.ein_ciphertext is not null,
    'leased', o.lease_owner is not null and o.lease_expires_at > now(),
    'window_open', exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = o.studio_id and w.expires_at > now()),
    'brand_status', (select r.brand_status from public.studio_sms_registrations r where r.studio_id = o.studio_id),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('step_key', s.step_key, 'status', s.status, 'fee_bearing', s.fee_bearing,
                         'fee_confirmed', s.fee_confirmed_at is not null, 'mock', s.mock, 'error_code', s.error_code) order by s.step_key)
                       from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.submission_seq = o.submission_seq), '[]'::jsonb));
end $$;

drop function public.tw4_runner_confirm_submission(uuid, text, text, uuid);
drop function public.tw4_runner_record_evaluation(uuid, text, text, text, text);
drop table public.studio_sms_submission_confirmations;
drop function public._tw4f1b_confirmations_guard();
drop function public._tw4f1b_confirmations_truncate_guard();
drop function public._tw4f1b_submission_check(public.studio_sms_onboarding, text);
alter table public.studio_sms_provisioning_steps drop constraint studio_sms_provisioning_steps_verdict_steps;
alter table public.studio_sms_provisioning_steps drop column evaluation_verdict;

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window'));

commit;
