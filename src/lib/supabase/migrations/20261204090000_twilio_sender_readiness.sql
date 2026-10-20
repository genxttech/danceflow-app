-- 20261204090000_twilio_sender_readiness.sql
-- Sender readiness and dispatch integrity (owner direction 2026-10-20, option 1; design docs/twilio/TW-4F_Sender_Readiness_Design.md incl. section 9).
--   * A studio of a verified legal business sends only through a VERIFIED sender of its business's ACTIVE subaccount: the subaccount's Messaging Service,
--     its approved A2P campaign and the location's own number. A platform admin records the identifiers; read-only provider reads made by the server with
--     the subaccount's own credentials are checked HERE (the outcome is computed by the database, never trusted from the caller).
--   * Readiness = latest sender row approved + latest decisive verification 'verified' for exactly its identifiers, no older than 24 hours, on the
--     business's current active subaccount. tw4_usage_begin requires it before any reservation; tw4_usage_dispatching re-checks it (and that it is the
--     sender the attempt was reserved for) right before the provider call; a registration-failure callback (30034) fails readiness at once.
--   * Every sender write takes one per-studio row lock; history is ordered by seq. A number belongs to one studio; a Messaging Service / campaign is never
--     shared across businesses (locations of one business may share them). Inbound texts to a billed sender map back to exactly one studio.
--   * No Twilio resource is created by anything here. Requires 20261203090000. Rollback: rollback/20261204090000_twilio_sender_readiness_rollback.sql
--     (refuses once any verification or new-style sender row exists). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_inbound_usage') is null or to_regprocedure('public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)') is null then
    raise exception 'sender-readiness precondition failed: 20261203090000 (and 20261201090000) are not applied';
  end if;
  if to_regclass('public.studio_sms_sender_verifications') is not null then
    raise exception 'sender-readiness precondition failed: already applied';
  end if;
  -- the functions replaced below must still be the 20261201 versions (another slice must not be clobbered silently)
  if position('no approved sender on the business' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid)'::regprocedure)) = 0
     or position('already dispatched, or released as never sent' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_dispatching(uuid)'::regprocedure)) = 0
     or position('the callback is not signed by the attempt' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_record_callback(uuid,text,text,text,text)'::regprocedure)) = 0 then
    raise exception 'sender-readiness precondition failed: tw4_usage_begin / dispatching / record_callback differ from 20261201090000';
  end if;
end $$;

-- audit vocabulary: the live list plus the sender actions (extended, not replaced)
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
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['sender_recorded', 'sender_verified', 'sender_verify_failed', 'sender_revoked', 'sender_released', 'sender_flagged']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- sender history (additive) and verifications
-- ---------------------------------------------------------------------------------------------------------------
alter table public.studio_sms_billed_senders add column seq bigserial;
alter table public.studio_sms_billed_senders add column campaign_sid text null check (campaign_sid is null or campaign_sid ~ '^QE[0-9a-fA-F]{32}$');
alter table public.studio_sms_billed_senders add column phone_number_sid text null check (phone_number_sid is null or phone_number_sid ~ '^PN[0-9a-fA-F]{32}$');
alter table public.studio_sms_billed_senders add column verification_id uuid null;
alter table public.studio_sms_billed_senders drop constraint studio_sms_billed_senders_status_check;
alter table public.studio_sms_billed_senders add constraint studio_sms_billed_senders_status_check check (status in ('pending', 'approved', 'revoked', 'released'));
create unique index studio_sms_billed_senders_seq on public.studio_sms_billed_senders (seq);
create index studio_sms_billed_senders_latest on public.studio_sms_billed_senders (studio_id, seq desc);

create table public.studio_sms_sender_verifications (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null unique,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  studio_id uuid not null,
  sender_id uuid null references public.studio_sms_billed_senders(id),
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  messaging_service_sid text not null,
  campaign_sid text null,
  phone_number_sid text null,
  sender_e164 text null,
  source text not null check (source in ('provider_read', 'fake', 'callback')),
  outcome text not null check (outcome in ('verified', 'failed', 'inconclusive')),
  failure_code text null check (failure_code is null or char_length(failure_code) <= 60),
  evidence jsonb not null default '{}'::jsonb check (pg_column_size(evidence) <= 16384),
  attested_opt_out boolean not null default false,
  actor uuid null,
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_sender_verifications_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_sender_verifications_latest on public.studio_sms_sender_verifications (studio_id, seq desc);

revoke all on public.studio_sms_sender_verifications from public, anon, authenticated, service_role;
alter table public.studio_sms_sender_verifications enable row level security;
create trigger studio_sms_sender_verifications_guard before update or delete on public.studio_sms_sender_verifications for each row execute function public._tw4us_append_only();
create trigger studio_sms_sender_verifications_truncate before truncate on public.studio_sms_sender_verifications for each statement execute function public._tw4c_truncate_guard();

-- readiness depends on seq order: no API role may touch these sequences (Supabase default privileges would otherwise grant them)
revoke all on sequence public.studio_sms_billed_senders_seq_seq, public.studio_sms_sender_verifications_seq_seq from public, anon, authenticated, service_role;

-- the attempt remembers the sending number it was reserved for (dispatch re-checks it)
alter table public.studio_sms_usage_attempts add column sender_e164 text null check (sender_e164 is null or sender_e164 ~ '^\+1[2-9][0-9]{9}$');

-- the old setter wrote unverified rows; it is no longer callable (kept for the 20261201 rollback)
revoke all on function public.tw4_usage_billed_sender_set(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------
-- the one lock every sender write takes (NO KEY UPDATE: does not block the foreign-key checks of sends)
create or replace function public._tw4sr_lock(p_studio_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_entity uuid;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id for no key update;
  if v_entity is null then
    raise exception 'the studio is not linked to a verified legal business' using errcode = 'TW010';
  end if;
  return v_entity;
end $$;

create or replace function public._tw4sr_latest(p_studio_id uuid)
returns public.studio_sms_billed_senders language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select s.* from public.studio_sms_billed_senders s where s.studio_id = p_studio_id order by s.seq desc limit 1; $$;

create or replace function public._tw4sr_fake_allowed()
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp
as $$ select to_regclass('public.tw4_local_qa_only') is not null; $$;   -- a marker table created by LOCAL QA fixtures only; no migration creates it

-- the verified, ready sender of a studio, or an all-null row
create or replace function public._tw4sr_ready(p_studio_id uuid)
returns public.studio_sms_billed_senders language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v public.studio_sms_sender_verifications;
  v_entity uuid;
  v_account text;
  none public.studio_sms_billed_senders;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  s := public._tw4sr_latest(p_studio_id);
  if v_entity is null or s.id is null or s.status <> 'approved' or s.legal_entity_id <> v_entity
     or s.campaign_sid is null or s.phone_number_sid is null or s.sender_e164 is null or s.verification_id is null then
    return none;
  end if;
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status = 'active';
  if v_account is null or v_account <> s.account_sid then
    return none;
  end if;
  -- the latest DECISIVE verification of this studio (an inconclusive re-read changes nothing)
  select * into v from public.studio_sms_sender_verifications x where x.studio_id = p_studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1;
  if v.id is null or v.outcome <> 'verified' or v.created_at < now() - interval '24 hours'
     or (v.source = 'fake' and not public._tw4sr_fake_allowed()) or v.source = 'callback'
     or v.account_sid <> s.account_sid or v.messaging_service_sid <> s.messaging_service_sid or v.campaign_sid is distinct from s.campaign_sid
     or v.phone_number_sid is distinct from s.phone_number_sid or v.sender_e164 is distinct from s.sender_e164 then
    return none;
  end if;
  -- the location's path may have changed since: the verified campaign's use case must still be the one its CURRENT path requires
  if v.evidence->'campaign'->>'us_app_to_person_usecase' is distinct from
     (case public._tw4fi_location_path_nolock(p_studio_id) when 'standard' then 'MIXED' when 'low_volume_standard' then 'LOW_VOLUME' end) then
    return none;
  end if;
  return s;
end $$;

-- appends a sender row (caller holds the studio lock); copies the identifiers of p_from when given
create or replace function public._tw4sr_append(p_from public.studio_sms_billed_senders, p_status text, p_actor uuid, p_reason text, p_verification uuid)
returns public.studio_sms_billed_senders language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare r public.studio_sms_billed_senders;
begin
  insert into public.studio_sms_billed_senders (legal_entity_id, studio_id, account_sid, messaging_service_sid, sender_e164, status, set_by, reason, campaign_sid, phone_number_sid, verification_id)
  values (p_from.legal_entity_id, p_from.studio_id, p_from.account_sid, p_from.messaging_service_sid, p_from.sender_e164, p_status,
          coalesce(p_actor, p_from.set_by), left(btrim(p_reason), 300), p_from.campaign_sid, p_from.phone_number_sid, p_verification)
  returning * into r;
  return r;
end $$;

create or replace function public._tw4sr_audit(p_studio uuid, p_actor uuid, p_action text, p_note text)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio, null, case when p_actor is null then 'system' else 'platform_admin' end, p_actor, p_action, left(p_note, 300));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- record, verify, re-verify, revoke / release, flag
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_sender_record(p_studio_id uuid, p_actor uuid, p_messaging_service_sid text, p_campaign_sid text, p_phone_number_sid text,
                                                    p_sender_e164 text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_account text;
  r public.studio_sms_billed_senders;
begin
  perform public._tw4c_admin(p_actor);
  if p_messaging_service_sid is null or p_messaging_service_sid !~ '^MG[0-9a-fA-F]{32}$' or p_campaign_sid is null or p_campaign_sid !~ '^QE[0-9a-fA-F]{32}$'
     or p_phone_number_sid is null or p_phone_number_sid !~ '^PN[0-9a-fA-F]{32}$' or p_sender_e164 is null or p_sender_e164 !~ '^\+1[2-9][0-9]{9}$'
     or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a Messaging Service, campaign, phone number, US/Canada E.164 and a written reason are required' using errcode = '22023';
  end if;
  -- identifiers are serialized globally (two studios can never both pass the uniqueness check), then the studio
  perform pg_advisory_xact_lock(hashtext('tw4sr:pn:' || upper(p_phone_number_sid)));
  perform pg_advisory_xact_lock(hashtext('tw4sr:e164:' || p_sender_e164));
  perform pg_advisory_xact_lock(hashtext('tw4sr:mg:' || upper(p_messaging_service_sid)));
  perform pg_advisory_xact_lock(hashtext('tw4sr:qe:' || upper(p_campaign_sid)));
  v_entity := public._tw4sr_lock(p_studio_id);
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status = 'active';
  if v_account is null then
    raise exception 'the legal business has no active subaccount' using errcode = 'TW015';
  end if;
  -- a location changes its NUMBER only after releasing the current one: inbound (STOP/START) maps by the latest row, so a number is never silently superseded
  -- while still unreleased (a legacy row without a phone number SID was never ready and is replaced freely)
  r := public._tw4sr_latest(p_studio_id);
  if r.id is not null and r.status <> 'released' and r.phone_number_sid is not null
     and (upper(r.phone_number_sid) <> upper(p_phone_number_sid) or r.sender_e164 is distinct from p_sender_e164) then
    raise exception 'release the current number of this location before recording another' using errcode = 'TW022';
  end if;
  -- a number belongs to ONE studio (a revoked row keeps it until released); a Messaging Service / campaign never crosses businesses
  if exists (select 1 from public.studio_sms_entity_studios es cross join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l
              where es.studio_id <> p_studio_id and l.status <> 'released'
                and (upper(l.phone_number_sid) = upper(p_phone_number_sid) or l.sender_e164 = p_sender_e164)) then
    raise exception 'this phone number is already the sender of another location' using errcode = '23505';
  end if;
  if exists (select 1 from public.studio_sms_entity_studios es cross join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l
              where es.legal_entity_id <> v_entity and l.status <> 'released'
                and (upper(l.messaging_service_sid) = upper(p_messaging_service_sid) or upper(l.campaign_sid) = upper(p_campaign_sid))) then
    raise exception 'this Messaging Service or campaign belongs to another business' using errcode = '23505';
  end if;
  insert into public.studio_sms_billed_senders (legal_entity_id, studio_id, account_sid, messaging_service_sid, sender_e164, status, set_by, reason, campaign_sid, phone_number_sid)
  values (v_entity, p_studio_id, v_account, p_messaging_service_sid, p_sender_e164, 'pending', p_actor, left(btrim(p_reason), 300), p_campaign_sid, p_phone_number_sid)
  returning * into r;
  perform public._tw4sr_audit(p_studio_id, p_actor, 'sender_recorded', 'sender=' || r.id || ';account=' || v_account || ';mg=' || p_messaging_service_sid || ';qe=' || p_campaign_sid || ';pn=' || p_phone_number_sid);
  return jsonb_build_object('sender_id', r.id, 'status', 'pending', 'account_sid', v_account);
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

-- applies a verification to the CURRENT latest sender row (caller holds the studio lock)
create or replace function public._tw4sr_apply(p_studio_id uuid, p_sender_id uuid, p_actor uuid, p_evidence jsonb, p_attested boolean, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  j jsonb;
  v_id uuid;
  v_account text;
  r public.studio_sms_billed_senders;
begin
  if p_source not in ('provider_read', 'fake') then
    raise exception 'invalid evidence source' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is accepted only on a local QA database' using errcode = '42501';
  end if;
  s := public._tw4sr_latest(p_studio_id);
  if s.id is null or s.id <> p_sender_id then
    raise exception 'this sender row is no longer the current one' using errcode = 'TW021';   -- not 40001: PostgREST retries serialization failures
  end if;
  if s.status not in ('pending', 'approved') then
    raise exception 'only a pending or approved sender is verified (status %)', s.status using errcode = '22023';
  end if;
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = s.legal_entity_id and t.status = 'active';
  if v_account is null or v_account <> s.account_sid then
    j := jsonb_build_object('outcome', 'failed', 'code', 'subaccount_not_active');
  else
    j := public._tw4sr_judge(s, p_evidence, p_attested);
  end if;
  insert into public.studio_sms_sender_verifications (legal_entity_id, studio_id, sender_id, account_sid, messaging_service_sid, campaign_sid, phone_number_sid, sender_e164,
                                                      source, outcome, failure_code, evidence, attested_opt_out, actor)
  values (s.legal_entity_id, s.studio_id, s.id, s.account_sid, s.messaging_service_sid, s.campaign_sid, s.phone_number_sid, s.sender_e164,
          p_source, j->>'outcome', j->>'code', coalesce(p_evidence, '{}'::jsonb) - 'raw', coalesce(p_attested, false), p_actor)
  returning id into v_id;
  if j->>'outcome' = 'verified' then
    r := public._tw4sr_append(s, 'approved', p_actor, 'verified: ' || v_id, v_id);
    perform public._tw4sr_audit(p_studio_id, p_actor, 'sender_verified', 'sender=' || r.id || ';verification=' || v_id);
  elsif j->>'outcome' = 'failed' then
    perform public._tw4sr_audit(p_studio_id, p_actor, 'sender_verify_failed', 'sender=' || s.id || ';verification=' || v_id || ';code=' || coalesce(j->>'code', '?'));
  end if;
  return jsonb_build_object('verification_id', v_id, 'outcome', j->>'outcome', 'code', j->>'code', 'sender_id', coalesce(r.id, s.id));
end $$;

-- a platform admin verifies the current sender (pending or approved) with reads the server made through the subaccount's credentials
create or replace function public.tw4_sender_verify(p_studio_id uuid, p_sender_id uuid, p_actor uuid, p_evidence jsonb, p_attested_opt_out boolean, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4sr_lock(p_studio_id);
  return public._tw4sr_apply(p_studio_id, p_sender_id, p_actor, p_evidence, p_attested_opt_out, p_source);
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

-- immediate stop (revoked keeps its identifiers reserved and inbound-mapped; released frees them)
create or replace function public.tw4_sender_revoke(p_studio_id uuid, p_actor uuid, p_reason text, p_release boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  r public.studio_sms_billed_senders;
  v_status text := case when coalesce(p_release, false) then 'released' else 'revoked' end;
begin
  perform public._tw4c_admin(p_actor);
  if p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a written reason (10+ characters) is required' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  s := public._tw4sr_latest(p_studio_id);
  if s.id is null then
    raise exception 'the studio has no sender' using errcode = '22023';
  end if;
  if s.status = v_status then
    return jsonb_build_object('sender_id', s.id, 'status', s.status, 'replayed', true);
  end if;
  if s.status = 'released' then
    raise exception 'a released sender is recorded again, not revoked' using errcode = '22023';
  end if;
  r := public._tw4sr_append(s, v_status, p_actor, p_reason, null);
  perform public._tw4sr_audit(p_studio_id, p_actor, 'sender_' || v_status, 'sender=' || r.id || ';' || btrim(p_reason));
  return jsonb_build_object('sender_id', r.id, 'status', v_status, 'replayed', false);
end $$;

-- a registration-failure signal from Twilio (a delivery callback's error 30034): readiness fails at once until a new verification succeeds
-- Only the identity the attempt was SENT from is flagged (a late callback of an older number / service changes nothing), and only once.
create or replace function public._tw4sr_flag(p_studio_id uuid, p_code text, p_account_sid text, p_messaging_service_sid text, p_sender_e164 text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v_last text;
begin
  perform public._tw4sr_lock(p_studio_id);
  s := public._tw4sr_latest(p_studio_id);
  if s.id is null or s.status <> 'approved' or s.account_sid is distinct from p_account_sid
     or s.messaging_service_sid is distinct from p_messaging_service_sid or s.sender_e164 is distinct from p_sender_e164 then
    return;
  end if;
  select x.outcome into v_last from public.studio_sms_sender_verifications x where x.studio_id = p_studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1;
  if v_last is distinct from 'verified' then
    return;   -- already not ready: no repeated rows
  end if;
  insert into public.studio_sms_sender_verifications (legal_entity_id, studio_id, sender_id, account_sid, messaging_service_sid, campaign_sid, phone_number_sid, sender_e164,
                                                      source, outcome, failure_code, actor)
  values (s.legal_entity_id, s.studio_id, s.id, s.account_sid, s.messaging_service_sid, s.campaign_sid, s.phone_number_sid, s.sender_e164, 'callback', 'failed', left(p_code, 60), null);
  perform public._tw4sr_audit(p_studio_id, null, 'sender_flagged', 'sender=' || s.id || ';code=' || left(p_code, 60));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- inbound mapping, readiness reads, re-verify work list
-- ---------------------------------------------------------------------------------------------------------------
-- the one studio whose current sender (any status but released: STOP must reach a revoked sender) is this subaccount's number To (or, without a To, its
-- Messaging Service); null when none or ambiguous. A location's number is never superseded unreleased (tw4_sender_record), so the latest row suffices. Only for SUBACCOUNT-signed webhooks.
create or replace function public.tw4_inbound_studio_for(p_account_sid text, p_messaging_service_sid text, p_to_e164 text)
returns uuid language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$' or ((p_to_e164 is null or p_to_e164 = '') and (p_messaging_service_sid is null or p_messaging_service_sid = '')) then
    return null;
  end if;
  select array_agg(l.studio_id) into v_ids
    from public.studio_sms_entity_studios es
    cross join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l
   where l.status <> 'released' and l.account_sid = p_account_sid
     -- the number decides (unique per account); the Messaging Service is used only when no To is given (shared by locations: then usually ambiguous)
     and case when coalesce(p_to_e164, '') <> '' then l.sender_e164 = p_to_e164 else l.messaging_service_sid = p_messaging_service_sid end;
  if v_ids is null or cardinality(v_ids) <> 1 then
    return null;
  end if;
  return v_ids[1];
end $$;

-- platform view: per linked studio, the current sender, its latest verification and readiness (identifiers only)
create or replace function public.tw4_sender_overview(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'studio_id', es.studio_id, 'legal_entity_id', es.legal_entity_id,
      'sender_id', l.id, 'status', l.status, 'account_sid', l.account_sid, 'messaging_service_sid', l.messaging_service_sid, 'campaign_sid', l.campaign_sid,
      'phone_number_sid', l.phone_number_sid, 'sender_e164', l.sender_e164, 'recorded_at', l.created_at,
      'verification_outcome', v.outcome, 'verification_code', v.failure_code, 'verified_at', v.created_at, 'verification_source', v.source,
      'ready', (public._tw4sr_ready(es.studio_id)).id is not null) order by es.studio_id)
    from public.studio_sms_entity_studios es
    left join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l on true
    left join lateral (select * from public.studio_sms_sender_verifications x where x.studio_id = es.studio_id order by x.seq desc limit 1) v on true), '[]'::jsonb);
end $$;

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

-- the sender cannot get ready BEFORE the dispatch marker for a permanent reason (real sends off, no sender number): nothing reached the provider,
-- so the reservation is released at once rather than waiting for the reconciler. Only a still-'reserved' attempt (no marker) changes; a later replay of
-- the same source reads 'released' (not sent), exactly like a provider refusal after the marker.
create or replace function public.tw4_usage_release_unprepared(p_attempt_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_usage_attempts;
begin
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{2,39}$' then   -- submit_error_code holds at most 40 characters
    raise exception 'a short error code is required' using errcode = '22023';
  end if;
  a := public._tw4us_lock_attempt(p_attempt_id);   -- raises for an unknown attempt
  if a.state <> 'reserved' then
    return jsonb_build_object('released', false, 'state', a.state);   -- marked (or already closed) by another caller: never touched here
  end if;
  perform public._tw4us_release_reservation(a, 'not_prepared');
  update public.studio_sms_usage_attempts set state = 'released', closed_at = clock_timestamp(), submit_error_code = p_code where id = a.id;
  update public.sms_message_logs set status = 'failed', provider_error_code = 'not_sent', failed_at = now(), updated_at = now() where id = a.message_log_id;
  return jsonb_build_object('released', true, 'state', 'released');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- replaced from 20261201090000 (only the marked parts change)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_usage_begin(
  p_source_kind text, p_source_id uuid, p_studio_id uuid, p_client_id uuid, p_phone_e164 text, p_body text,
  p_message_type text, p_related_table text, p_related_id uuid, p_sent_by uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  acct public.studio_sms_credit_accounts;
  v_entity uuid;
  v_sender public.studio_sms_billed_senders;
  v_account text;
  v_price public.studio_sms_price_list;
  v_segments int;
  v_amount int;
  v_id uuid := gen_random_uuid();
  v_log uuid;
  v_res uuid;
begin
  if p_source_kind not in ('delivery', 'manual') or p_source_id is null or p_studio_id is null then
    raise exception 'a source and a studio are required' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'the studio is not linked to a verified legal business' using errcode = 'TW010';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;
  acct := public._tw4c_lock(v_entity);
  -- a retry of the same source is a replay: never a second send, reservation or log
  select * into a from public.studio_sms_usage_attempts x where x.source_kind = p_source_kind and x.source_id = p_source_id;
  if a.id is not null then
    if a.studio_id <> p_studio_id then
      raise exception 'this source belongs to another studio' using errcode = '42501';
    end if;
    return jsonb_build_object('decision', 'replay', 'attempt_id', a.id, 'state', a.state, 'message_log_id', a.message_log_id, 'provider_sid', a.provider_sid,
                              'account_sid', a.account_sid, 'messaging_service_sid', a.messaging_service_sid, 'sender_e164', a.sender_e164,
                              'body', case when a.state = 'reserved' then (select l.body from public.sms_message_logs l where l.id = a.message_log_id) end,
                              'phone_e164', case when a.state = 'reserved' then (select l.phone_e164 from public.sms_message_logs l where l.id = a.message_log_id) end);
  end if;
  if not public._tw4us_switch_on() then
    raise exception 'billed texting is switched off' using errcode = 'TW018';
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'billed texts go to US and Canadian numbers only' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 1600 then
    raise exception 'invalid message body' using errcode = '22023';
  end if;
  if p_client_id is not null and not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    raise exception 'the client does not belong to this studio' using errcode = '42501';
  end if;
  -- 20261204: only a VERIFIED, ready sender of the business's active subaccount (Messaging Service + approved campaign + this location's number)
  v_sender := public._tw4sr_ready(p_studio_id);
  v_account := v_sender.account_sid;
  if v_sender.id is null or v_sender.legal_entity_id <> v_entity then
    raise exception 'no verified, ready sender on the business''s active subaccount' using errcode = 'TW015';
  end if;
  if public._tw4rc_service_state(p_studio_id) = 'suspended' then
    raise exception 'texting is suspended for an uncovered monthly charge' using errcode = 'TW016';
  end if;
  select * into v_price from public.studio_sms_price_list p where p.kind = 'sms_usage' and p.active;
  if v_price.id is null then
    raise exception 'no published texting price' using errcode = 'TW008';
  end if;
  v_segments := public._tw4us_segments(p_body);
  if v_segments < 1 or v_segments > 10 then
    raise exception 'a billed text is 1 to 10 segments' using errcode = '22023';
  end if;
  v_amount := v_segments * v_price.customer_price_cents;
  perform public._tw4c_require_funds(acct, v_amount);
  perform public._tw4ml_ensure_tz(v_entity);
  perform public._tw4ml_require_room(v_entity, v_amount);   -- fail closed: the monthly limit (default $0) and the platform ceiling

  insert into public.sms_message_logs (studio_id, client_id, phone_e164, direction, message_type, body, segment_count, status, provider, related_table, related_id, sent_by, sent_at)
  values (p_studio_id, p_client_id, p_phone_e164, 'outbound', left(coalesce(p_message_type, 'manual'), 60), p_body, v_segments, 'queued', 'twilio', p_related_table, p_related_id, p_sent_by, now())
  returning id into v_log;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (v_entity, p_studio_id, 'sms_usage', v_amount, 'credit', 'sms:' || v_id) returning id into v_res;
  perform public._tw4c_post(v_entity, p_studio_id, 'reserve', 0, v_amount, 'reserve:sms:' || v_id, v_res, 'text=' || v_log, null, null);
  insert into public.studio_sms_usage_attempts (id, legal_entity_id, studio_id, source_kind, source_id, message_log_id, account_sid, messaging_service_sid, estimated_segments,
                                               unit_price_cents, unit_provider_cost_cents, price_list_id, reserved_cents, reservation_id, state, sender_e164)
  values (v_id, v_entity, p_studio_id, p_source_kind, p_source_id, v_log, v_account, v_sender.messaging_service_sid, v_segments,
          v_price.customer_price_cents, v_price.provider_cost_cents, v_price.id, v_amount, v_res, 'reserved', v_sender.sender_e164);
  return jsonb_build_object('decision', 'send', 'attempt_id', v_id, 'state', 'reserved', 'message_log_id', v_log, 'account_sid', v_account,
                            'messaging_service_sid', v_sender.messaging_service_sid, 'sender_e164', v_sender.sender_e164, 'segments', v_segments, 'amount_cents', v_amount);
end $$;

create or replace function public.tw4_usage_dispatching(p_attempt_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  s public.studio_sms_billed_senders;
begin
  -- 20261204: the business's locks first (entity, account, attempt), then readiness is re-checked right before the provider call
  a := public._tw4us_lock_attempt(p_attempt_id);
  if a.state <> 'reserved' then
    return jsonb_build_object('dispatch', false, 'state', a.state);   -- already dispatched, or released as never sent: do not send
  end if;
  s := public._tw4sr_ready(a.studio_id);
  if s.id is null or s.account_sid <> a.account_sid or s.messaging_service_sid <> a.messaging_service_sid or s.sender_e164 is distinct from a.sender_e164 then
    -- the sender was revoked, failed re-verification or was replaced since the reservation: nothing is sent, the reservation is released
    perform public._tw4us_release_reservation(a, 'sender_not_ready');
    update public.studio_sms_usage_attempts set state = 'released', submit_error_code = 'sender_not_ready', closed_at = clock_timestamp() where id = a.id;
    update public.sms_message_logs set status = 'failed', provider_error_code = 'sender_not_ready', failed_at = now(), updated_at = now() where id = a.message_log_id;
    return jsonb_build_object('dispatch', false, 'state', 'released', 'reason', 'sender_not_ready');
  end if;
  update public.studio_sms_usage_attempts set state = 'submitting', submitting_at = clock_timestamp() where id = a.id;
  return jsonb_build_object('dispatch', true, 'state', 'submitting', 'sender_e164', a.sender_e164);
end $$;

create or replace function public.tw4_usage_record_callback(p_attempt_id uuid, p_provider_sid text, p_signer_account text, p_status text, p_error_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  v_rank int := public._tw4us_rank(p_status);
begin
  if p_provider_sid is null or p_provider_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then
    raise exception 'invalid provider message id' using errcode = '22023';
  end if;
  if p_attempt_id is not null then
    select * into a from public.studio_sms_usage_attempts x where x.id = p_attempt_id for update;
  else
    select * into a from public.studio_sms_usage_attempts x where x.provider_sid = p_provider_sid for update;
  end if;
  if a.id is null then
    if p_attempt_id is not null then
      raise exception 'unknown usage attempt' using errcode = '42501';
    end if;
    return jsonb_build_object('billed', false);
  end if;
  if p_signer_account is null or p_signer_account <> a.account_sid then
    raise exception 'the callback is not signed by the attempt''s subaccount' using errcode = '42501';
  end if;
  if a.provider_sid is not null and a.provider_sid <> p_provider_sid then
    raise exception 'the callback names another provider message' using errcode = '42501';
  end if;
  if exists (select 1 from public.studio_sms_usage_attempts x where x.provider_sid = p_provider_sid and x.id <> a.id) then
    raise exception 'the provider message belongs to another attempt' using errcode = '42501';
  end if;
  perform public._tw4us_write();
  if a.provider_sid is null then
    if not (a.state in ('submitting', 'unknown') or (a.state = 'released' and a.resolved_outcome = 'released')) then
      raise exception 'the attempt cannot take a provider message in state %', a.state using errcode = '22023';
    end if;
    update public.studio_sms_usage_attempts set provider_sid = p_provider_sid, state = 'submitted', submitted_at = coalesce(submitted_at, clock_timestamp()) where id = a.id;
    update public.sms_message_logs set provider_message_id = p_provider_sid, updated_at = now() where id = a.message_log_id;
  end if;
  -- 20261204: Twilio reports the sender is not (or no longer) registered: readiness fails at once until a new verification succeeds
  if coalesce(p_error_code, '') = '30034' then
    perform public._tw4sr_flag(a.studio_id, 'callback:30034', a.account_sid, a.messaging_service_sid, a.sender_e164);
  end if;
  if a.state = 'settled' then
    return jsonb_build_object('billed', true, 'needs_reconcile', false);   -- final: a late callback is acknowledged and changes nothing
  end if;
  if v_rank > a.callback_rank then
    update public.studio_sms_usage_attempts set callback_status = lower(p_status), callback_rank = v_rank, callback_at = clock_timestamp() where id = a.id;
  end if;
  return jsonb_build_object('billed', true, 'needs_reconcile', v_rank >= 4 or greatest(v_rank, a.callback_rank) >= 4);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4sr_lock(uuid), public._tw4sr_latest(uuid), public._tw4sr_fake_allowed(), public._tw4sr_ready(uuid),
  public._tw4sr_append(public.studio_sms_billed_senders, text, uuid, text, uuid), public._tw4sr_audit(uuid, uuid, text, text),
  public._tw4sr_judge(public.studio_sms_billed_senders, jsonb, boolean), public._tw4sr_apply(uuid, uuid, uuid, jsonb, boolean, text), public._tw4sr_flag(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.tw4_usage_release_unprepared(uuid, text) from public, anon, authenticated;
grant execute on function public.tw4_usage_release_unprepared(uuid, text) to service_role;
revoke all on function public.tw4_sender_record(uuid, uuid, text, text, text, text, text), public.tw4_sender_verify(uuid, uuid, uuid, jsonb, boolean, text),
  public.tw4_sender_reverify(uuid, uuid, jsonb, text), public.tw4_sender_revoke(uuid, uuid, text, boolean), public.tw4_inbound_studio_for(text, text, text),
  public.tw4_sender_overview(uuid), public.tw4_sender_due_reverify(int) from public, anon, authenticated;
grant execute on function public.tw4_sender_record(uuid, uuid, text, text, text, text, text), public.tw4_sender_verify(uuid, uuid, uuid, jsonb, boolean, text),
  public.tw4_sender_reverify(uuid, uuid, jsonb, text), public.tw4_sender_revoke(uuid, uuid, text, boolean), public.tw4_inbound_studio_for(text, text, text),
  public.tw4_sender_overview(uuid), public.tw4_sender_due_reverify(int) to service_role;

commit;
