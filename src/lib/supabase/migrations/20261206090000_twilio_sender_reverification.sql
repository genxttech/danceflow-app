-- 20261206090000_twilio_sender_reverification.sql
-- Automated sender re-verification (owner handoff "DanceFlow TW-4F - Automated Sender Re-Verification", 2026-10-20; design
-- docs/twilio/TW-4F_Sender_Reverification_Design.md). Extends the 20261204 sender-readiness model; no second registry, no new readiness rule.
--   * Trust is unchanged and expires on its own: _tw4sr_ready requires a decisive 'verified' verification no older than 24 hours (20261204). Nothing here
--     extends it: a failed, delayed or stopped scheduler only lets it expire, and sending is then refused until a re-verification succeeds.
--   * The work list (tw4_sender_due_reverify, replaced) is unchanged except for BACKOFF after transient (inconclusive) reads: 5 minutes doubling per
--     consecutive inconclusive read since the last decisive one, at most 30 minutes, so an outage is retried steadily but not hammered.
--   * The scheduled re-verify runs under the shared run lease (studio_sms_reconcile_runs, job 'sender_reverify', from 20261205): tw4_sender_reverify_run
--     is fenced by a live lease, calls the 20261204 tw4_sender_reverify (approved current senders only; a FAILED sender is never restored by the
--     scheduler; the Advanced Opt-Out attestation carries over from the last admin verification) and audits inconclusive outcomes too.
--   * Health for the platform panel: tw4_sender_health(actor) per linked studio (last success, deadline, state, blocked, reason, retries) and the
--     scheduler's own status (last completed run, stale alert, senders expiring / expired). Identifiers only.
-- Requires 20261205090000. Rollback: rollback/20261206090000_twilio_sender_reverification_rollback.sql (refuses once any re-verify run or inconclusive
-- audit row exists). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_reconcile_runs') is null or to_regprocedure('public.tw4_reconcile_run_begin(text,text,int)') is null
     or to_regprocedure('public.tw4_sender_reverify(uuid,uuid,jsonb,text)') is null then
    raise exception 'sender-reverification precondition failed: usage reconciliation (20261205090000) / sender readiness (20261204090000) is not applied';
  end if;
  if to_regprocedure('public.tw4_sender_reverify_run(uuid,uuid,uuid,jsonb,text)') is not null then
    raise exception 'sender-reverification precondition failed: already applied';
  end if;
  -- the run lease must offer the sender_reverify job (20261205 reserved it)
  if position('sender_reverify' in (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.studio_sms_reconcile_runs'::regclass and c.conname = 'studio_sms_reconcile_runs_job_check')) = 0 then
    raise exception 'sender-reverification precondition failed: the run lease has no sender_reverify job';
  end if;
  -- the functions replaced below must still be the 20261204 versions
  if position('v.created_at < now() - interval ''20 hours''' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_sender_due_reverify(int)'::regprocedure)) = 0
     or position('a read that failed transiently proves nothing either way' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4sr_judge(public.studio_sms_billed_senders,jsonb,boolean)'::regprocedure)) = 0
     or position('the attestation carries over from its last verification' in coalesce(obj_description('public.tw4_sender_reverify(uuid,uuid,jsonb,text)'::regprocedure, 'pg_proc'), 'the attestation carries over from its last verification')) = 0
     or position('a failed sender (re-read or 30034) is restored only by an admin' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_sender_reverify(uuid,uuid,jsonb,text)'::regprocedure)) = 0 then
    raise exception 'sender-reverification precondition failed: tw4_sender_due_reverify / _tw4sr_judge / tw4_sender_reverify differ from 20261204090000';
  end if;
end $$;

-- audit vocabulary: the live list plus the inconclusive re-verify (extended, not replaced)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text';
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['sender_reverify_inconclusive', 'sender_reverify_restored']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the work list (replaced: the 20261204 rule plus backoff after transient reads)
-- ---------------------------------------------------------------------------------------------------------------
-- approved current senders whose last decisive verification is a success older than 20 hours. A sender that FAILED (a re-read or a 30034 callback) is never
-- restored automatically: a platform admin verifies it again; nor is one whose last success is more than 72 hours old, i.e. trust lapsed
-- more than 48 hours ago (a person looks first).
-- ORDER: senders still trusted come first, nearest deadline first (so a few unreachable expired senders can never starve healthy ones into lapsing);
-- expired ones after them, fewest retries first.
-- BACKOFF after n consecutive inconclusive reads since that success: still trusted 5 min x 2^(n-1), at most 30 min; expired 30 min x 2^(n-1), at most
-- 6 hours. Backoff never extends trust: readiness still expires 24 h after the success.
create or replace function public.tw4_sender_due_reverify(p_limit int default 100)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('studio_id', q.studio_id, 'sender_id', q.id, 'account_sid', q.account_sid, 'messaging_service_sid', q.messaging_service_sid,
                                                       'campaign_sid', q.campaign_sid, 'phone_number_sid', q.phone_number_sid, 'sender_e164', q.sender_e164) order by q.ord)
    from (select l.*, row_number() over (order by (v.created_at < now() - interval '24 hours'), case when v.created_at >= now() - interval '24 hours' then v.created_at end, i.n, v.created_at) ord
            from public.studio_sms_entity_studios es
            cross join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l
            left join lateral (select * from public.studio_sms_sender_verifications x where x.studio_id = es.studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1) v on true
            left join lateral (select count(*) n, max(x.created_at) last_at from public.studio_sms_sender_verifications x
                                where x.studio_id = es.studio_id and x.outcome = 'inconclusive' and x.seq > coalesce(v.seq, 0)) i on true
           where l.status = 'approved' and v.outcome = 'verified' and v.created_at < now() - interval '20 hours' and v.created_at >= now() - interval '72 hours'
             and (i.n = 0 or i.last_at < now() - case when v.created_at >= now() - interval '24 hours'
                                                      then least(interval '30 minutes', interval '5 minutes' * power(2, least(i.n - 1, 6)))
                                                      else least(interval '6 hours', interval '30 minutes' * power(2, least(i.n - 1, 6))) end)
           order by (v.created_at < now() - interval '24 hours'), case when v.created_at >= now() - interval '24 hours' then v.created_at end, i.n, v.created_at
           limit least(greatest(coalesce(p_limit, 100), 1), 500)) q), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- judging (replaced): a definitive failure anywhere wins over a transient read error
-- ---------------------------------------------------------------------------------------------------------------
-- the outcome of a set of normalized provider reads for one sender row (computed here; the caller's opinion is never used). Replaced from 20261204090000:
-- a definitive failure anywhere wins over a transient read error elsewhere.
create or replace function public._tw4sr_judge(s public.studio_sms_billed_senders, p_evidence jsonb, p_attested boolean)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e jsonb := coalesce(p_evidence, '{}'::jsonb);
  acc jsonb := case when jsonb_typeof(e->'account') = 'object' then e->'account' else '{}'::jsonb end;   -- a resource not read (JSON null) counts as absent
  svc jsonb := case when jsonb_typeof(e->'service') = 'object' then e->'service' else '{}'::jsonb end;   -- a resource not read (JSON null) counts as absent
  cmp jsonb := case when jsonb_typeof(e->'campaign') = 'object' then e->'campaign' else '{}'::jsonb end;   -- a resource not read (JSON null) counts as absent
  brd jsonb := case when jsonb_typeof(e->'brand') = 'object' then e->'brand' else '{}'::jsonb end;   -- a resource not read (JSON null) counts as absent
  num jsonb := case when jsonb_typeof(e->'number') = 'object' then e->'number' else '{}'::jsonb end;   -- a resource not read (JSON null) counts as absent
  snm jsonb := case when jsonb_typeof(e->'service_number') = 'object' then e->'service_number' else '{}'::jsonb end;   -- a resource not read (JSON null) counts as absent
  v_path text := public._tw4fi_location_path_nolock(s.studio_id);
  v_usecase text := case v_path when 'standard' then 'MIXED' when 'low_volume_standard' then 'LOW_VOLUME' else null end;
  err jsonb;
  v_transient text;
  v_partial boolean;
begin
  -- 20261206: a DEFINITIVE answer anywhere wins over a transient one elsewhere (a 429 on the number must not hide a campaign that is no longer VERIFIED).
  -- First any definitive read error; then every check on the resources that WERE read; only then a transient read error makes it inconclusive.
  for err in select * from jsonb_array_elements(coalesce(e->'read_errors', '[]'::jsonb)) loop
    if coalesce(err->>'kind', '') in ('timeout', 'network', 'rate_limited', 'server', 'credentials_unavailable') then
      v_transient := coalesce(v_transient, 'read_' || (err->>'kind') || ':' || coalesce(err->>'resource', '?'));
    else
      return jsonb_build_object('outcome', 'failed', 'code', 'read_' || coalesce(err->>'kind', 'error') || ':' || coalesce(err->>'resource', '?'));
    end if;
  end loop;
  v_partial := v_transient is not null;
  if (not v_partial or acc <> '{}'::jsonb) and (acc->>'sid' is distinct from s.account_sid or acc->>'status' is distinct from 'active') then
    return jsonb_build_object('outcome', 'failed', 'code', 'account_not_active');
  end if;
  if (not v_partial or svc <> '{}'::jsonb) and (svc->>'sid' is distinct from s.messaging_service_sid or svc->>'account_sid' is distinct from s.account_sid) then
    return jsonb_build_object('outcome', 'failed', 'code', 'service_not_on_account');
  end if;
  if (not v_partial or svc <> '{}'::jsonb) and coalesce((svc->>'us_app_to_person_registered')::boolean, false) is not true then
    return jsonb_build_object('outcome', 'failed', 'code', 'service_not_a2p_registered');
  end if;
  if (not v_partial or svc <> '{}'::jsonb) and coalesce((svc->>'inbound_route_ok')::boolean, false) is not true then
    return jsonb_build_object('outcome', 'failed', 'code', 'inbound_not_routed_to_danceflow');
  end if;
  if (not v_partial or cmp <> '{}'::jsonb) and (cmp->>'sid' is distinct from s.campaign_sid or cmp->>'account_sid' is distinct from s.account_sid or cmp->>'messaging_service_sid' is distinct from s.messaging_service_sid) then
    return jsonb_build_object('outcome', 'failed', 'code', 'campaign_not_on_service');
  end if;
  if (not v_partial or cmp <> '{}'::jsonb) and cmp->>'campaign_status' is distinct from 'VERIFIED' then
    return jsonb_build_object('outcome', 'failed', 'code', 'campaign_not_verified');
  end if;
  if ((not v_partial or cmp <> '{}'::jsonb) and coalesce((cmp->>'mock')::boolean, true) is not false)
     or ((not v_partial or brd <> '{}'::jsonb) and coalesce((brd->>'mock')::boolean, true) is not false) then
    return jsonb_build_object('outcome', 'failed', 'code', 'mock_registration');
  end if;
  if v_usecase is null or ((not v_partial or cmp <> '{}'::jsonb) and cmp->>'us_app_to_person_usecase' is distinct from v_usecase) then
    return jsonb_build_object('outcome', 'failed', 'code', 'use_case_mismatch');
  end if;
  -- the campaign's brand must be the business's own, registered by the runner on THIS subaccount, and approved at Twilio
  if (not v_partial or (brd <> '{}'::jsonb and cmp <> '{}'::jsonb)) and (brd->>'sid' is distinct from cmp->>'brand_registration_sid' or brd->>'status' is distinct from 'APPROVED'
     or not exists (select 1 from public.studio_sms_provisioning_steps ps join public.studio_sms_entity_studios es on es.studio_id = ps.studio_id
                     where es.legal_entity_id = s.legal_entity_id and ps.step_key = 'B1' and ps.status = 'succeeded' and not ps.mock
                       and ps.twilio_account_sid = s.account_sid and ps.provider_sid = brd->>'sid')) then
    return jsonb_build_object('outcome', 'failed', 'code', 'brand_not_the_business');
  end if;
  if (not v_partial or num <> '{}'::jsonb) and (num->>'sid' is distinct from s.phone_number_sid or num->>'account_sid' is distinct from s.account_sid or num->>'phone_number' is distinct from s.sender_e164
     or coalesce((num->>'sms_capable')::boolean, false) is not true or num->>'status' is distinct from 'in-use') then
    return jsonb_build_object('outcome', 'failed', 'code', 'number_not_ready');
  end if;
  if (not v_partial or snm <> '{}'::jsonb) and (snm->>'sid' is distinct from s.phone_number_sid or snm->>'service_sid' is distinct from s.messaging_service_sid or snm->>'account_sid' is distinct from s.account_sid) then
    return jsonb_build_object('outcome', 'failed', 'code', 'number_not_in_service');
  end if;
  if coalesce(p_attested, false) is not true then
    return jsonb_build_object('outcome', 'failed', 'code', 'advanced_opt_out_not_attested');
  end if;
  -- nothing that WAS read failed, but something could not be read: proves nothing either way
  if v_transient is not null then
    return jsonb_build_object('outcome', 'inconclusive', 'code', v_transient);
  end if;
  return jsonb_build_object('outcome', 'verified', 'code', null);
end $$;


-- ---------------------------------------------------------------------------------------------------------------
-- the scheduled re-verify, fenced by the run lease
-- ---------------------------------------------------------------------------------------------------------------
-- the scheduled re-verify (no person): only an APPROVED current sender; the attestation carries over from its last verification.
-- Replaced from 20261204090000: callable only inside a scheduler run (tw4_sender_reverify_run).
create or replace function public.tw4_sender_reverify(p_studio_id uuid, p_sender_id uuid, p_evidence jsonb, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v_attested boolean;
  v_last text;
begin
  -- 20261206: only inside a live scheduler run (tw4_sender_reverify_run sets this for its own transaction); a direct call is refused
  if coalesce(current_setting('tw4.reverify_run', true), '') = '' then
    raise exception 'the scheduled re-verify runs only inside a scheduler run' using errcode = '42501';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  s := public._tw4sr_latest(p_studio_id);
  if s.id is null or s.id <> p_sender_id or s.status <> 'approved' then
    return jsonb_build_object('outcome', 'skipped');
  end if;
  -- a failed sender (re-read or 30034) is restored only by an admin's verification, never by the scheduler
  select x.outcome into v_last from public.studio_sms_sender_verifications x where x.studio_id = p_studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1;
  if v_last is distinct from 'verified' then
    return jsonb_build_object('outcome', 'skipped');
  end if;
  select x.attested_opt_out into v_attested from public.studio_sms_sender_verifications x where x.id = s.verification_id;
  return public._tw4sr_apply(p_studio_id, p_sender_id, null, p_evidence, coalesce(v_attested, false), p_source);
end $$;


-- one sender's scheduled re-verification inside a live 'sender_reverify' run (a run that lost its lease is refused, TW023). The decision is the 20261204
-- tw4_sender_reverify (the database judges the normalized provider evidence; skipped when the sender changed meanwhile or is not an approved, last-verified
-- sender). A transient (inconclusive) outcome is audited here as well; verified / failed are audited by 20261204.
create or replace function public.tw4_sender_reverify_run(p_run_id uuid, p_studio_id uuid, p_sender_id uuid, p_evidence jsonb, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r jsonb;
  v_last timestamptz;
begin
  perform public._tw4ur_fence(p_run_id, 'sender_reverify');
  if p_studio_id is null or p_sender_id is null or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'invalid re-verification' using errcode = '22023';
  end if;
  select x.created_at into v_last from public.studio_sms_sender_verifications x
   where x.studio_id = p_studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1;
  -- a last success more than 72 hours old (trust lapsed more than 48 hours ago) is restored only by a person (a dormant sender never comes back unattended)
  if v_last is not null and v_last < now() - interval '72 hours' then
    return jsonb_build_object('outcome', 'skipped', 'code', 'lapsed_needs_admin');
  end if;
  perform set_config('tw4.reverify_run', p_run_id::text, true);
  r := public.tw4_sender_reverify(p_studio_id, p_sender_id, p_evidence, p_source);
  perform set_config('tw4.reverify_run', '', true);
  -- a sender whose trust had LAPSED and is now restored by the scheduler is audited apart from routine renewals
  if r->>'outcome' = 'verified' and v_last < now() - interval '24 hours' then
    perform public._tw4sr_audit(p_studio_id, null, 'sender_reverify_restored', 'sender=' || coalesce(r->>'sender_id', '?') || ';lapsed_since=' || (v_last + interval '24 hours') || ';run=' || p_run_id);
  end if;
  if r->>'outcome' = 'inconclusive' then
    perform public._tw4sr_audit(p_studio_id, null, 'sender_reverify_inconclusive',
                                'sender=' || p_sender_id || ';verification=' || coalesce(r->>'verification_id', '?') || ';code=' || coalesce(r->>'code', '?') || ';run=' || p_run_id);
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- health (platform admin): per linked studio, and the scheduler
-- ---------------------------------------------------------------------------------------------------------------
-- state, derived from the same records readiness reads (never shown as approved without a fresh decisive success):
--   none / released / revoked     no usable sender row
--   pending                       recorded, never successfully verified (or a pending row after a re-record)
--   failed                        the latest decisive verification FAILED (a re-read, a 30034 callback or an admin verification): blocked until an admin verifies
--   expired                       approved, the last success is older than 24 hours: blocked until a re-verification succeeds (the scheduler retries)
--   expiring                      ready, less than 4 hours of trust left
--   ready                         _tw4sr_ready answers this sender
--   blocked                       approved and freshly verified but not ready for another reason (subaccount no longer active, location path changed)
create or replace function public.tw4_sender_health(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_rows jsonb;
  v_last_ok timestamptz;
begin
  perform public._tw4c_admin(p_actor);
  select coalesce(jsonb_agg(jsonb_build_object(
      'studio_id', q.studio_id, 'legal_entity_id', q.legal_entity_id, 'sender_id', q.sender_id, 'status', q.status,
      'state', q.state, 'blocked', q.state not in ('ready', 'expiring'),
      'last_success_at', q.last_success_at, 'expires_at', q.expires_at, 'next_check_at', q.next_check_at,
      'decisive_outcome', q.decisive_outcome, 'decisive_code', q.decisive_code, 'decisive_source', q.decisive_source, 'decisive_at', q.decisive_at,
      'last_attempt_outcome', q.last_attempt_outcome, 'last_attempt_code', q.last_attempt_code, 'last_attempt_at', q.last_attempt_at,
      'retries_since_success', q.retries) order by q.studio_id), '[]'::jsonb)
    into v_rows
    from (select es.studio_id, es.legal_entity_id, l.id sender_id, l.status,
                 case when l.id is null then 'none'
                      when l.status in ('released', 'revoked') then l.status
                      when l.status = 'pending' then 'pending'
                      when d.outcome = 'failed' then 'failed'
                      when d.id is null then 'pending'
                      when d.created_at < now() - interval '24 hours' then 'expired'
                      when (public._tw4sr_ready(es.studio_id)).id is null then 'blocked'
                      when d.created_at < now() - interval '20 hours' then 'expiring'
                      else 'ready' end state,
                 case when d.outcome = 'verified' then d.created_at end last_success_at,
                 case when d.outcome = 'verified' and l.status = 'approved' then d.created_at + interval '24 hours' end expires_at,
                 -- when the scheduler will try next (the same backoff as the work list); none once only a person can restore it (last success > 72 h)
                 case when d.outcome = 'verified' and l.status = 'approved' and d.created_at >= now() - interval '72 hours' then greatest(d.created_at + interval '20 hours',
                        coalesce(i.last_at + case when d.created_at >= now() - interval '24 hours'
                                                  then least(interval '30 minutes', interval '5 minutes' * power(2, least(i.n - 1, 6)))
                                                  else least(interval '6 hours', interval '30 minutes' * power(2, least(i.n - 1, 6))) end,
                                 d.created_at + interval '20 hours')) end next_check_at,
                 d.outcome decisive_outcome, d.failure_code decisive_code, d.source decisive_source, d.created_at decisive_at,
                 a.outcome last_attempt_outcome, a.failure_code last_attempt_code, a.created_at last_attempt_at,
                 coalesce(i.n, 0) retries
            from public.studio_sms_entity_studios es
            left join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l on true
            left join lateral (select * from public.studio_sms_sender_verifications x where x.studio_id = es.studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1) d on true
            left join lateral (select * from public.studio_sms_sender_verifications x where x.studio_id = es.studio_id order by x.seq desc limit 1) a on true
            left join lateral (select count(*) n, max(x.created_at) last_at from public.studio_sms_sender_verifications x
                                where x.studio_id = es.studio_id and x.outcome = 'inconclusive' and x.seq > coalesce(d.seq, 0)) i on true) q;
  select max(r.finished_at) into v_last_ok from public.studio_sms_reconcile_runs r where r.job = 'sender_reverify' and r.status = 'completed';
  return jsonb_build_object(
    'senders', v_rows,
    'scheduler', jsonb_build_object(
      'last_completed_at', v_last_ok,
      -- an approved sender exists and no run completed in 2 hours: trust will lapse without anyone re-checking it
      'stale', exists (select 1 from jsonb_array_elements(v_rows) x where x->>'status' = 'approved') and (v_last_ok is null or v_last_ok < now() - interval '2 hours'),
      'running', (select jsonb_build_object('run_id', r.id, 'started_at', r.started_at, 'lease_expires_at', r.lease_expires_at)
                    from public.studio_sms_reconcile_runs r where r.job = 'sender_reverify' and r.status = 'running' and r.lease_expires_at > now()),
      'runs', coalesce((select jsonb_agg(jsonb_build_object('run_id', r.id, 'status', r.status, 'started_at', r.started_at, 'finished_at', r.finished_at, 'summary', r.summary,
                                                           'error', r.error) order by r.started_at desc)
                          from (select * from public.studio_sms_reconcile_runs x where x.job = 'sender_reverify' order by x.started_at desc limit 5) r), '[]'::jsonb),
      'expiring', (select count(*) from jsonb_array_elements(v_rows) x where x->>'state' = 'expiring'),
      'expired', (select count(*) from jsonb_array_elements(v_rows) x where x->>'state' = 'expired'),
      'failed', (select count(*) from jsonb_array_elements(v_rows) x where x->>'state' = 'failed')));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: the service role only (the health read also checks the actor)
-- ---------------------------------------------------------------------------------------------------------------
-- the scheduler uses ONLY the fenced entry point. tw4_sender_reverify keeps its service-role grant but refuses outside a run (the run flag above); a REVOKE
-- was tried first and a PostgREST call of the revoked function crashed the local Postgres backend (signal 11), so privileges are left unchanged.
revoke all on function public.tw4_sender_due_reverify(int), public.tw4_sender_reverify_run(uuid, uuid, uuid, jsonb, text), public.tw4_sender_health(uuid)
  from public, anon, authenticated;
grant execute on function public.tw4_sender_due_reverify(int), public.tw4_sender_reverify_run(uuid, uuid, uuid, jsonb, text), public.tw4_sender_health(uuid)
  to service_role;

commit;
