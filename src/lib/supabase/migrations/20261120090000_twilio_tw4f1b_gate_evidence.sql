-- 20261120090000_twilio_tw4f1b_gate_evidence.sql
-- TW-4F-1b ("gate evidence"): durable, database-enforced authorization for the two IRREVERSIBLE Twilio submissions (S11 = submit the business
-- profile for review, T6 = submit the A2P trust product), plus durable evidence of the evaluation verdicts they depend on.
-- NO Twilio call is made by anything in this file. Platform-admin / service-role only; nothing here is reachable by studios.
--
--   studio_sms_submission_confirmations   one row per confirmation (who, when, which lease, which generation); consumed exactly once
--   tw4_runner_confirm_submission         the runner records a platform admin's confirmation of S11 or T6 for THIS lease. Refused unless the
--                                         evaluation it relies on (S10 / T5) succeeded in this generation WITH a recorded compliant verdict
--                                         and was not followed by a needs_info / exception transition (TW002: stale, resubmit for a new generation)
--   tw4_runner_begin_step (replaced)      S11 / T6 can only begin (or be reconciled) with a fresh, unconsumed confirmation held by the same
--                                         lease (TW003). The confirmation is consumed in the same transaction. A succeeded step still skips.
--   tw4_runner_record_evaluation          records the verdict of an evaluation on the open S10 / T5 ledger row and in the audit trail
--                                         (also for the fresh re-check before a submission)
--   tw4_runner_status (replaced)          adds per-step evaluation verdicts, confirmations and recent evaluation events for the platform panel
-- Also: ledger column evaluation_verdict (reset when a step is begun again; S10 / T5 can only finish as succeeded with a compliant verdict; frozen
-- once the row has succeeded); audit actions runner_submission_confirmed / runner_evaluation; both confirm and begin require the onboarding to be in
-- the state the submission belongs to (S11: submitted_for_checks, T6: profile_review) and re-check that the evaluation is verified and not stale.
-- BEFORE APPLYING to a shared database: check for onboardings whose S10 / T5 succeeded before this migration and whose S11 / T6 has not run; they carry
-- no verdict, the runner sends them back to the owner (needs_info) to resubmit, which starts a fresh generation and evaluation.
-- Rollback order: application first; then this rollback BEFORE the R1.1 / R1 rollbacks (those refuse while this migration is applied).
-- Existing S10 / T5 rows from before this migration carry no verdict and therefore cannot authorize a submission (fail closed).
-- Rollback: rollback/20261120090000_twilio_tw4f1b_gate_evidence_rollback.sql (refuses once any confirmation or evaluation audit rows exist).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)') is null
     or to_regprocedure('public.tw4_runner_status(uuid,uuid)') is null
     or to_regclass('public.studio_sms_runner_windows') is null then
    raise exception 'TW-4F-1b precondition failed: R1 / R1.1 are not applied';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public._sms_onb_steps_guard()'::regprocedure and position('sid of a succeeded step' in prosrc) > 0) then
    raise exception 'TW-4F-1b precondition failed: R1.1 (20261119092100) is not applied';
  end if;
  if to_regclass('public.studio_sms_submission_confirmations') is not null then
    raise exception 'TW-4F-1b precondition failed: already applied';
  end if;
end $$;

-- audit vocabulary
alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation'));

-- the verdict an evaluation step established (S10 / T5 only)
alter table public.studio_sms_provisioning_steps add column evaluation_verdict text null
  check (evaluation_verdict is null or evaluation_verdict in ('compliant', 'noncompliant', 'unrecognized'));
alter table public.studio_sms_provisioning_steps add constraint studio_sms_provisioning_steps_verdict_steps
  check (evaluation_verdict is null or step_key in ('S10', 'T5'));

-- ---------------------------------------------------------------------------------------------------------------
-- the confirmations
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_submission_confirmations (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  studio_id uuid not null,
  step_key text not null check (step_key in ('S11', 'T6')),
  submission_seq int not null check (submission_seq >= 0),
  confirmed_by uuid not null,
  lease_owner text not null check (char_length(lease_owner) between 1 and 64),
  confirmed_at timestamptz not null default now(),
  consumed_at timestamptz null,
  constraint studio_sms_submission_confirmations_onboarding_fk foreign key (onboarding_id, studio_id)
    references public.studio_sms_onboarding (id, studio_id) on delete cascade
);
create index studio_sms_submission_confirmations_lookup on public.studio_sms_submission_confirmations (onboarding_id, step_key, submission_seq, confirmed_at);
revoke all on public.studio_sms_submission_confirmations from public, anon, authenticated, service_role;
alter table public.studio_sms_submission_confirmations enable row level security;

-- a confirmation is evidence: it can be consumed once and never edited or deleted (except by cascade from its onboarding / studio)
create or replace function public._tw4f1b_confirmations_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.studio_sms_onboarding o where o.id = old.onboarding_id) then
      return old;  -- cascade from a deleted onboarding / studio
    end if;
    raise exception 'studio_sms_submission_confirmations rows are not deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.onboarding_id is distinct from old.onboarding_id or new.studio_id is distinct from old.studio_id
     or new.step_key is distinct from old.step_key or new.submission_seq is distinct from old.submission_seq
     or new.confirmed_by is distinct from old.confirmed_by or new.lease_owner is distinct from old.lease_owner
     or new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'studio_sms_submission_confirmations: a confirmation cannot be edited' using errcode = '42501';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'studio_sms_submission_confirmations: a confirmation is consumed once' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger studio_sms_submission_confirmations_guard before update or delete on public.studio_sms_submission_confirmations
  for each row execute function public._tw4f1b_confirmations_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- may this submission be authorized RIGHT NOW? 'ok' | 'state' | 'missing' | 'unverified' | 'stale' (helper, callable by nobody)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4f1b_submission_check(p_o public.studio_sms_onboarding, p_step_key text)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  pre public.studio_sms_provisioning_steps;
  v_pre_key text;
begin
  -- a submission belongs to ONE onboarding state: S11 is made from submitted_for_checks, T6 from profile_review (after S11 moved it there)
  if p_o.state is distinct from (case when p_step_key = 'S11' then 'submitted_for_checks' else 'profile_review' end) then
    return 'state';
  end if;
  v_pre_key := case when p_step_key = 'S11' then 'S10' else 'T5' end;
  select * into pre from public.studio_sms_provisioning_steps s
  where s.onboarding_id = p_o.id and s.step_key = v_pre_key and s.submission_seq = p_o.submission_seq;
  if pre.id is null or pre.status <> 'succeeded' then return 'missing'; end if;
  -- a row written before verdicts were recorded, or one that did not establish compliance, can never authorize a submission
  if pre.evaluation_verdict is distinct from 'compliant' or pre.finished_at is null then return 'unverified'; end if;
  -- a later needs_info / exception means the evaluated object is no longer the one that was reviewed: a new generation is required
  if exists (select 1 from public.studio_sms_onboarding_audit a
             where a.onboarding_id = p_o.id and a.action = 'state_changed' and a.to_state in ('needs_info', 'exception') and a.created_at >= pre.finished_at) then
    return 'stale';
  end if;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- record a platform admin's confirmation of ONE submission for THIS lease
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_runner_confirm_submission(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_check text;
  v_id uuid;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_step_key is null or p_step_key not in ('S11', 'T6') then
    raise exception 'only S11 and T6 are submissions' using errcode = '22023';
  end if;
  if not exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = o.studio_id and w.expires_at > now()) then
    raise exception 'the runner window for this studio is closed' using errcode = 'TW001';
  end if;
  v_check := public._tw4f1b_submission_check(o, p_step_key);
  if v_check = 'missing' then
    raise exception 'the evaluation for % has not succeeded in this generation', p_step_key using errcode = '22023';
  elsif v_check <> 'ok' then
    raise exception 'the evaluation for % cannot authorize a submission (%): it is unverified or stale, or the onboarding is not in the submission state; resubmit for a new generation', p_step_key, v_check using errcode = 'TW002';
  end if;
  insert into public.studio_sms_submission_confirmations (onboarding_id, studio_id, step_key, submission_seq, confirmed_by, lease_owner)
  values (o.id, o.studio_id, p_step_key, o.submission_seq, p_actor, p_lease_owner) returning id into v_id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, from_state, to_state, step_key, note)
  values (o.studio_id, o.id, 'platform_admin', p_actor, 'runner_submission_confirmed', o.state, o.state, p_step_key,
          left('step=' || p_step_key || ';seq=' || o.submission_seq || ';evaluation=' || case when p_step_key = 'S11' then 'S10' else 'T5' end || ':compliant', 300));
  return jsonb_build_object('confirmation_id', v_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- begin_step: same as R1.1, plus S11 / T6 need a fresh confirmation held by this lease (consumed here, in the same transaction)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_runner_begin_step(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_friendly_name text,
  p_fee_bearing boolean, p_fee_confirmed_by uuid, p_mock boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_provisioning_steps;
  v_fee boolean;
  v_conf public.studio_sms_submission_confirmations;
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
  -- an irreversible submission (also its reconcile / retry) needs a platform admin's fresh confirmation held by THIS lease, used once
  if p_step_key in ('S11', 'T6') then
    select c.* into v_conf from public.studio_sms_submission_confirmations c
    where c.onboarding_id = o.id and c.step_key = p_step_key and c.submission_seq = o.submission_seq and c.lease_owner = p_lease_owner
      and c.consumed_at is null and c.confirmed_at > now() - interval '15 minutes'
    order by c.confirmed_at desc limit 1 for update;
    if v_conf.id is null then
      raise exception 'a submission needs a fresh platform-admin confirmation' using errcode = 'TW003';
    end if;
    -- the evaluation is checked again at the moment the step begins (state and staleness may have changed since the confirmation)
    if public._tw4f1b_submission_check(o, p_step_key) <> 'ok' then
      raise exception 'the evaluation can no longer authorize this submission' using errcode = 'TW002';
    end if;
    update public.studio_sms_submission_confirmations set consumed_at = now() where id = v_conf.id;
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
    update public.studio_sms_provisioning_steps set status = 'in_flight', started_at = now(), finished_at = null, error_code = null, evaluation_verdict = null,
      error_detail_sanitized = null, friendly_name = left(p_friendly_name, 128), fee_bearing = v_fee,
      fee_confirmed_by = case when v_fee then p_fee_confirmed_by end, fee_confirmed_at = case when v_fee then now() end, mock = coalesce(p_mock, false)
    where id = r.id;
  end if;
  return jsonb_build_object('action', 'execute');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- evaluation evidence
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_runner_record_evaluation(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_verdict text, p_context text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_provisioning_steps;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_step_key is null or p_step_key not in ('S10', 'T5')
     or p_verdict is null or p_verdict not in ('compliant', 'noncompliant', 'unrecognized')
     or p_context is null or p_context not in ('step', 'preverify') then
    raise exception 'invalid evaluation record' using errcode = '22023';
  end if;
  if p_context = 'step' then
    -- the verdict of the evaluation step itself is written onto its OPEN ledger row, before the step is finished
    select * into r from public.studio_sms_provisioning_steps s
    where s.onboarding_id = o.id and s.step_key = p_step_key and s.submission_seq = o.submission_seq for update;
    if r.id is null or r.status not in ('in_flight', 'unknown_outcome') then
      raise exception 'the evaluation step is not open' using errcode = '22023';
    end if;
    update public.studio_sms_provisioning_steps set evaluation_verdict = p_verdict where id = r.id;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, from_state, to_state, step_key, note)
  values (o.studio_id, o.id, 'system', null, 'runner_evaluation', o.state, o.state, p_step_key,
          left('step=' || p_step_key || ';verdict=' || p_verdict || ';context=' || p_context || ';seq=' || o.submission_seq, 300));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- finish_step (as R1, plus: S10 / T5 succeed only with a compliant verdict) and the ledger guard (as R1.1, plus: a succeeded verdict is frozen)
-- ---------------------------------------------------------------------------------------------------------------
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
  -- an evaluation step can only finish as succeeded with a recorded compliant verdict (written by tw4_runner_record_evaluation while the row is open)
  if p_status = 'succeeded' and p_step_key in ('S10', 'T5') and r.evaluation_verdict is distinct from 'compliant' then
    raise exception 'an evaluation step cannot succeed without a recorded compliant verdict' using errcode = '22023';
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
  -- the verdict an evaluation established is final once the step has succeeded
  if old.status = 'succeeded' and new.evaluation_verdict is distinct from old.evaluation_verdict then
    raise exception 'studio_sms_provisioning_steps: the verdict of a succeeded step cannot change' using errcode = '22023';
  end if;
  if old.status = 'succeeded' and new.status is distinct from 'succeeded' then
    raise exception 'studio_sms_provisioning_steps: a succeeded step cannot change status' using errcode = '22023';
  end if;
  return new;
end $$;

create or replace function public._tw4f1b_confirmations_truncate_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'studio_sms_submission_confirmations rows are not deleted' using errcode = '42501';
end $$;
create trigger studio_sms_submission_confirmations_truncate_guard before truncate on public.studio_sms_submission_confirmations
  for each statement execute function public._tw4f1b_confirmations_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- status for the platform panel (adds verdicts, confirmations and recent evaluation events)
-- ---------------------------------------------------------------------------------------------------------------
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
                         'fee_confirmed', s.fee_confirmed_at is not null, 'mock', s.mock, 'error_code', s.error_code,
                         'evaluation_verdict', s.evaluation_verdict, 'finished_at', s.finished_at) order by s.step_key)
                       from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.submission_seq = o.submission_seq), '[]'::jsonb),
    'confirmations', coalesce((select jsonb_agg(jsonb_build_object('step_key', c.step_key, 'confirmed_by', c.confirmed_by, 'confirmed_at', c.confirmed_at,
                         'consumed', c.consumed_at is not null) order by c.confirmed_at)
                       from public.studio_sms_submission_confirmations c where c.onboarding_id = o.id and c.submission_seq = o.submission_seq), '[]'::jsonb),
    'evaluations', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'note', e.note) order by e.created_at desc)
                       from (select a.created_at, a.note from public.studio_sms_onboarding_audit a
                             where a.onboarding_id = o.id and a.action = 'runner_evaluation' and a.note like '%;seq=' || o.submission_seq order by a.created_at desc limit 10) e), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges and self-check
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4f1b_confirmations_guard(), public._tw4f1b_confirmations_truncate_guard(), public._tw4f1b_submission_check(public.studio_sms_onboarding, text)
  from public, anon, authenticated, service_role;
revoke all on function public.tw4_runner_confirm_submission(uuid, text, text, uuid), public.tw4_runner_record_evaluation(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.tw4_runner_confirm_submission(uuid, text, text, uuid), public.tw4_runner_record_evaluation(uuid, text, text, text, text)
  to service_role;

do $$
declare
  v_bad text[] := '{}';
  r record;
  p text;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and (p.proname like 'tw4\_runner\_%' or p.proname like '\_tw4\_r1\_%' or p.proname in ('_tw4f1b_confirmations_guard', '_tw4f1b_confirmations_truncate_guard', '_tw4f1b_submission_check')) loop
    if r.proconfig is null or not ('search_path=pg_catalog, public, pg_temp' = any (r.proconfig)) then v_bad := v_bad || (r.proname || ' search_path'); end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then v_bad := v_bad || (r.proname || ' exposed'); end if;
    if r.proname like 'tw4\_runner\_%' and not has_function_privilege('service_role', r.oid, 'EXECUTE') then v_bad := v_bad || (r.proname || ' not service_role'); end if;
    if (r.proname like '\_tw4\_r1\_%' or r.proname in ('_tw4f1b_confirmations_guard', '_tw4f1b_confirmations_truncate_guard', '_tw4f1b_submission_check')) and has_function_privilege('service_role', r.oid, 'EXECUTE') then v_bad := v_bad || (r.proname || ' helper exposed'); end if;
    if r.proname like 'tw4\_runner\_%' and not r.prosecdef then v_bad := v_bad || (r.proname || ' not definer'); end if;
  end loop;
  foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('anon', 'public.studio_sms_submission_confirmations', p) or has_table_privilege('authenticated', 'public.studio_sms_submission_confirmations', p)
       or has_table_privilege('service_role', 'public.studio_sms_submission_confirmations', p) then
      v_bad := v_bad || ('confirmations grant ' || p);
    end if;
  end loop;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.studio_sms_submission_confirmations'::regclass) then v_bad := v_bad || 'confirmations RLS off'; end if;
  if cardinality(v_bad) > 0 then
    raise exception 'TW-4F-1b self-check failed: %', array_to_string(v_bad, '; ') using errcode = '42501';
  end if;
end $$;

commit;
