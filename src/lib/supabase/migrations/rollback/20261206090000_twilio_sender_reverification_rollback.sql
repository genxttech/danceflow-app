-- Rollback of 20261206090000 (sender re-verification). Restores tw4_sender_due_reverify, _tw4sr_judge and tw4_sender_reverify as of 20261204090000 and the audit vocabulary without 'sender_reverify_inconclusive' / 'sender_reverify_restored', and drops the fenced entry point and the health read.
-- REFUSES once any sender re-verify run or re-verify audit row exists (forward-fix only from then on). Roll the app back first
-- (unset SMS_SENDER_REVERIFY). Readiness itself is untouched by either direction: it still expires 24 hours after the last success.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_sender_reverify_run(uuid,uuid,uuid,jsonb,text)') is null then
    raise exception 'sender-reverification rollback: not applied';
  end if;
  lock table public.studio_sms_reconcile_runs, public.studio_sms_onboarding_audit in share row exclusive mode;
  if exists (select 1 from public.studio_sms_reconcile_runs where job = 'sender_reverify')
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('sender_reverify_inconclusive', 'sender_reverify_restored')) then
    raise exception 'sender-reverification rollback refused: re-verification evidence exists' using errcode = '55000';
  end if;
end $$;

-- as of 20261204090000
-- the scheduled re-verify's work list: approved current senders whose last decisive verification is a success older than 20 hours. A sender that FAILED
-- (a re-read or a 30034 callback) is never restored automatically: a platform admin verifies it again.
create or replace function public.tw4_sender_due_reverify(p_limit int default 100)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('studio_id', q.studio_id, 'sender_id', q.id, 'account_sid', q.account_sid, 'messaging_service_sid', q.messaging_service_sid,
                                                       'campaign_sid', q.campaign_sid, 'phone_number_sid', q.phone_number_sid, 'sender_e164', q.sender_e164))
    from (select l.* from public.studio_sms_entity_studios es
            cross join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l
            left join lateral (select * from public.studio_sms_sender_verifications x where x.studio_id = es.studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1) v on true
           where l.status = 'approved' and v.outcome = 'verified' and v.created_at < now() - interval '20 hours'
           order by v.created_at nulls first limit least(greatest(coalesce(p_limit, 100), 1), 500)) q), '[]'::jsonb);
end $$;

-- the outcome of a set of normalized provider reads for one sender row (computed here; the caller's opinion is never used)
create or replace function public._tw4sr_judge(s public.studio_sms_billed_senders, p_evidence jsonb, p_attested boolean)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e jsonb := coalesce(p_evidence, '{}'::jsonb);
  acc jsonb := coalesce(e->'account', '{}'::jsonb);
  svc jsonb := coalesce(e->'service', '{}'::jsonb);
  cmp jsonb := coalesce(e->'campaign', '{}'::jsonb);
  brd jsonb := coalesce(e->'brand', '{}'::jsonb);
  num jsonb := coalesce(e->'number', '{}'::jsonb);
  snm jsonb := coalesce(e->'service_number', '{}'::jsonb);
  v_path text := public._tw4fi_location_path_nolock(s.studio_id);
  v_usecase text := case v_path when 'standard' then 'MIXED' when 'low_volume_standard' then 'LOW_VOLUME' else null end;
  err jsonb;
begin
  -- a read that failed transiently proves nothing either way
  for err in select * from jsonb_array_elements(coalesce(e->'read_errors', '[]'::jsonb)) loop
    if coalesce(err->>'kind', '') in ('timeout', 'network', 'rate_limited', 'server', 'credentials_unavailable') then
      return jsonb_build_object('outcome', 'inconclusive', 'code', 'read_' || (err->>'kind') || ':' || coalesce(err->>'resource', '?'));
    end if;
    return jsonb_build_object('outcome', 'failed', 'code', 'read_' || coalesce(err->>'kind', 'error') || ':' || coalesce(err->>'resource', '?'));
  end loop;
  if acc->>'sid' is distinct from s.account_sid or acc->>'status' is distinct from 'active' then
    return jsonb_build_object('outcome', 'failed', 'code', 'account_not_active');
  end if;
  if svc->>'sid' is distinct from s.messaging_service_sid or svc->>'account_sid' is distinct from s.account_sid then
    return jsonb_build_object('outcome', 'failed', 'code', 'service_not_on_account');
  end if;
  if coalesce((svc->>'us_app_to_person_registered')::boolean, false) is not true then
    return jsonb_build_object('outcome', 'failed', 'code', 'service_not_a2p_registered');
  end if;
  if coalesce((svc->>'inbound_route_ok')::boolean, false) is not true then
    return jsonb_build_object('outcome', 'failed', 'code', 'inbound_not_routed_to_danceflow');
  end if;
  if cmp->>'sid' is distinct from s.campaign_sid or cmp->>'account_sid' is distinct from s.account_sid or cmp->>'messaging_service_sid' is distinct from s.messaging_service_sid then
    return jsonb_build_object('outcome', 'failed', 'code', 'campaign_not_on_service');
  end if;
  if cmp->>'campaign_status' is distinct from 'VERIFIED' then
    return jsonb_build_object('outcome', 'failed', 'code', 'campaign_not_verified');
  end if;
  if coalesce((cmp->>'mock')::boolean, true) is not false or coalesce((brd->>'mock')::boolean, true) is not false then
    return jsonb_build_object('outcome', 'failed', 'code', 'mock_registration');
  end if;
  if v_usecase is null or cmp->>'us_app_to_person_usecase' is distinct from v_usecase then
    return jsonb_build_object('outcome', 'failed', 'code', 'use_case_mismatch');
  end if;
  -- the campaign's brand must be the business's own, registered by the runner on THIS subaccount, and approved at Twilio
  if brd->>'sid' is distinct from cmp->>'brand_registration_sid' or brd->>'status' is distinct from 'APPROVED'
     or not exists (select 1 from public.studio_sms_provisioning_steps ps join public.studio_sms_entity_studios es on es.studio_id = ps.studio_id
                     where es.legal_entity_id = s.legal_entity_id and ps.step_key = 'B1' and ps.status = 'succeeded' and not ps.mock
                       and ps.twilio_account_sid = s.account_sid and ps.provider_sid = brd->>'sid') then
    return jsonb_build_object('outcome', 'failed', 'code', 'brand_not_the_business');
  end if;
  if num->>'sid' is distinct from s.phone_number_sid or num->>'account_sid' is distinct from s.account_sid or num->>'phone_number' is distinct from s.sender_e164
     or coalesce((num->>'sms_capable')::boolean, false) is not true or num->>'status' is distinct from 'in-use' then
    return jsonb_build_object('outcome', 'failed', 'code', 'number_not_ready');
  end if;
  if snm->>'sid' is distinct from s.phone_number_sid or snm->>'service_sid' is distinct from s.messaging_service_sid or snm->>'account_sid' is distinct from s.account_sid then
    return jsonb_build_object('outcome', 'failed', 'code', 'number_not_in_service');
  end if;
  if coalesce(p_attested, false) is not true then
    return jsonb_build_object('outcome', 'failed', 'code', 'advanced_opt_out_not_attested');
  end if;
  return jsonb_build_object('outcome', 'verified', 'code', null);
end $$;

-- the scheduled re-verify (no person): only an APPROVED current sender; the attestation carries over from its last verification
create or replace function public.tw4_sender_reverify(p_studio_id uuid, p_sender_id uuid, p_evidence jsonb, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v_attested boolean;
  v_last text;
begin
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

drop function public.tw4_sender_health(uuid);
drop function public.tw4_sender_reverify_run(uuid, uuid, uuid, jsonb, text);

-- privileges as of 20261204090000
revoke all on function public.tw4_sender_due_reverify(int) from public, anon, authenticated;
grant execute on function public.tw4_sender_due_reverify(int) to service_role;

-- audit vocabulary without the inconclusive re-verify (no row uses it: checked above)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text' and m[1] not in ('sender_reverify_inconclusive', 'sender_reverify_restored');
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

commit;
