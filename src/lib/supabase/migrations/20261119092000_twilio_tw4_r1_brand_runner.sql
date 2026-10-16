-- 20261119092000_twilio_tw4_r1_brand_runner.sql
-- TW-4 slice R1 ("brand submission runner"): the service-role database functions the runner needs. The 4A tables have no API
-- privileges, so every runner read/write goes through these SECURITY DEFINER functions (service_role only, pinned search_path).
-- NO Twilio call is made by anything in this file.
--
--   tw4_runner_set_window       a platform admin opens (or closes) a time-limited "runner window" for ONE studio (database kill switch)
--   tw4_runner_claim            lease one studio's onboarding: platform-admin actor, pilot switch ON, state runnable, and (mode 'run') an OPEN window
--   tw4_runner_get_inputs       the draft fields the Twilio steps need (server-only; holds PII, never an EIN)
--   tw4_runner_get_ein          the EIN ciphertext + key id, only to the lease holder; the read is audited with the admin's identity
--   tw4_runner_begin_step       ledger protocol: skip a succeeded step / reconcile an ambiguous one / mark in_flight. The fee flag is DERIVED
--                               here (only B1 is paid); B1 needs a platform-admin confirmation, is refused if the studio already has a brand
--                               or any earlier brand attempt that is not a definite failure; the lease is renewed on every step
--   tw4_runner_finish_step      persist the outcome of an OPEN step (a succeeded step can never be rewritten)
--   tw4_runner_transition       move the onboarding along the 4A state graph (the table trigger still enforces it)
--   tw4_runner_record_brand     mirror the brand into the TW-3 registration row; refused for mock brands
--   tw4_runner_brand_approved   brand approved -> service_setup and PURGE the EIN (design D6); refused for mock brands
--   tw4_runner_release / tw4_runner_status
-- Also: audit actions runner_step / runner_ein_read / runner_lease / runner_window; ledger column `mock`; a stale `exception` EIN is purged
-- after 30 days (forward fix of the 4A purge functions).
-- Rollback: rollback/20261119092000_twilio_tw4_r1_brand_runner_rollback.sql (refuses once any runner ledger, window or audit rows exist).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_onboarding') is null or to_regclass('public.studio_sms_provisioning_steps') is null
     or to_regprocedure('public.get_studio_sms_status(uuid)') is null
     or not exists (select 1 from pg_proc where oid = 'public.get_studio_sms_status(uuid)'::regprocedure and position('can_cancel' in prosrc) > 0) then
    raise exception 'R1 precondition failed: TW-4A and TW-4A.1 are not applied';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like 'tw4\_runner\_%') then
    raise exception 'R1 precondition failed: already applied';
  end if;
end $$;

-- audit vocabulary
alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window'));

-- a mock brand (Twilio test brand) is recorded on the ledger so it can never be mistaken for the real thing
alter table public.studio_sms_provisioning_steps add column mock boolean not null default false;

-- the database kill switch: a studio can be run only inside an open, expiring window opened by a platform admin
create table public.studio_sms_runner_windows (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  expires_at timestamptz not null,
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  opened_by uuid null,
  opened_at timestamptz not null default now()
);
revoke all on public.studio_sms_runner_windows from public, anon, authenticated, service_role;
alter table public.studio_sms_runner_windows enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- helpers (callable by nobody; used inside the definer functions)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4_r1_is_platform_admin(p_user uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p_user is not null and exists (select 1 from public.profiles p where p.id = p_user and p.platform_role = 'platform_admin');
$$;

create or replace function public._tw4_r1_lease(p_onboarding_id uuid, p_lease_owner text)
returns public.studio_sms_onboarding language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if p_lease_owner is null or char_length(p_lease_owner) not between 1 and 64 then
    raise exception 'invalid lease owner' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = p_onboarding_id for update;
  if o.id is null or o.state = 'cancelled' then
    raise exception 'no active onboarding' using errcode = '22023';
  end if;
  if o.lease_owner is distinct from p_lease_owner or o.lease_expires_at is null or o.lease_expires_at <= now() then
    raise exception 'lease not held' using errcode = '55P03';
  end if;
  return o;
end $$;

create or replace function public._tw4_r1_step_ok(p_key text)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select p_key = any (array['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10','S11','T1','T2','T3','T4','T5','T6','B1']);
$$;

create or replace function public._tw4_r1_audit(p_o public.studio_sms_onboarding, p_actor uuid, p_action text, p_from text, p_to text, p_note text)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, from_state, to_state, note)
  values (p_o.studio_id, p_o.id, case when p_actor is null then 'system' else 'platform_admin' end, p_actor, p_action, p_from, p_to, left(p_note, 300));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- the runner window (kill switch)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_runner_set_window(p_studio_id uuid, p_actor uuid, p_hours integer, p_reason text)
returns timestamptz language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_expires timestamptz;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 0 and 72 or p_reason is null or char_length(btrim(p_reason)) not between 3 and 300 then
    raise exception 'hours (0-72, 0 closes) and a reason of 3-300 characters are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'unknown studio' using errcode = '22023';
  end if;
  v_expires := case when p_hours = 0 then now() else now() + make_interval(hours => p_hours) end;
  insert into public.studio_sms_runner_windows (studio_id, expires_at, reason, opened_by, opened_at)
  values (p_studio_id, v_expires, btrim(p_reason), p_actor, now())
  on conflict (studio_id) do update set expires_at = excluded.expires_at, reason = excluded.reason, opened_by = excluded.opened_by, opened_at = excluded.opened_at;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'platform_admin', p_actor, 'runner_window', left('hours=' || p_hours || ';' || btrim(p_reason), 300));
  return v_expires;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- claim
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_runner_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer default 300,
  p_mode text default 'run')
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_lease_owner is null or char_length(p_lease_owner) not between 1 and 64 or p_lease_seconds is null or p_lease_seconds not between 30 and 900
     or p_mode is null or p_mode not in ('run', 'refresh') then
    raise exception 'invalid lease' using errcode = '22023';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  -- 'run' may create resources and spend money: it needs an open window. 'refresh' only reads Twilio and needs none.
  if p_mode = 'run' and not exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = p_studio_id and w.expires_at > now()) then
    raise exception 'the runner window for this studio is closed' using errcode = 'TW001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'there is no onboarding to run' using errcode = '22023';
  end if;
  if o.state not in ('submitted_for_checks', 'profile_review', 'brand_pending') then
    raise exception 'onboarding state % is not runnable', o.state using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() and o.lease_owner <> p_lease_owner then
    raise exception 'another run holds the lease' using errcode = '55P03';
  end if;
  update public.studio_sms_onboarding set lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'runner_lease', o.state, o.state, 'claimed ' || p_mode);
  return jsonb_build_object(
    'onboarding_id', o.id, 'studio_id', o.studio_id, 'state', o.state, 'submission_seq', o.submission_seq,
    'steps', coalesce((select jsonb_agg(jsonb_build_object('step_key', s.step_key, 'status', s.status, 'provider_sid', s.provider_sid,
                         'fee_bearing', s.fee_bearing, 'mock', s.mock) order by s.step_key)
                       from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.submission_seq = o.submission_seq), '[]'::jsonb));
end $$;

create or replace function public.tw4_runner_release(p_onboarding_id uuid, p_lease_owner text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  select * into o from public.studio_sms_onboarding x where x.id = p_onboarding_id for update;
  if o.id is null or o.lease_owner is distinct from p_lease_owner then return; end if;
  update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = o.id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- inputs (PII, server-only) and the EIN (ciphertext only; decrypted by the application inside one step)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_runner_get_inputs(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  s record;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  select st.name, st.slug, st.public_name into s from public.studios st where st.id = o.studio_id;
  return jsonb_build_object(
    'studio_id', o.studio_id, 'submission_seq', o.submission_seq, 'state', o.state,
    'studio_name', s.name, 'studio_slug', s.slug, 'studio_public_name', s.public_name,
    'legal_name', o.legal_name, 'entity_type', o.entity_type, 'industry', o.industry, 'website_choice', o.website_choice,
    'website_url', o.website_url, 'address_line1', o.address_line1, 'address_line2', o.address_line2, 'city', o.city,
    'region', o.region, 'postal_code', o.postal_code, 'country', o.country, 'rep_first_name', o.rep_first_name,
    'rep_last_name', o.rep_last_name, 'rep_title', o.rep_title, 'rep_position', o.rep_position, 'rep_email', o.rep_email,
    'rep_phone', o.rep_phone, 'preferred_area_code', o.preferred_area_code, 'ein_last4', o.ein_last4,
    'missing', to_jsonb(public._sms_onb_missing(o)));
end $$;

create or replace function public.tw4_runner_get_ein(p_onboarding_id uuid, p_lease_owner text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if o.ein_ciphertext is null or o.ein_key_id is null then
    raise exception 'no EIN on file' using errcode = '22023';
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'runner_ein_read', o.state, o.state, 'for step S2');
  return jsonb_build_object('studio_id', o.studio_id, 'ciphertext', o.ein_ciphertext, 'key_id', o.ein_key_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- ledger protocol
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

-- ---------------------------------------------------------------------------------------------------------------
-- state and the TW-3 registration mirror
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_runner_transition(p_onboarding_id uuid, p_lease_owner text, p_to_state text, p_step text,
  p_error_code text, p_error_field text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_from text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_to_state not in ('profile_review', 'brand_pending', 'needs_info', 'exception') then
    raise exception 'target state not allowed for the runner' using errcode = '22023';
  end if;
  if p_error_field is not null and p_error_field not in ('legal_name', 'entity_type', 'industry', 'ein', 'address_line1', 'city', 'region',
       'postal_code', 'website_choice', 'website_url', 'rep_first_name', 'rep_last_name', 'rep_title', 'rep_position', 'rep_email', 'rep_phone') then
    raise exception 'unknown field' using errcode = '22023';
  end if;
  v_from := o.state;
  if v_from = p_to_state then
    return jsonb_build_object('state', o.state);
  end if;
  update public.studio_sms_onboarding set state = p_to_state, step = left(p_step, 64), last_error_code = left(p_error_code, 64),
    last_error_field = p_error_field where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, null, 'state_changed', v_from, p_to_state, 'runner step=' || coalesce(p_step, '-'));
  return jsonb_build_object('state', o.state);
end $$;

create or replace function public.tw4_runner_record_brand(p_onboarding_id uuid, p_lease_owner text, p_brand_sid text, p_brand_status text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_profile text;
  v_mock boolean;
  r public.studio_sms_registrations;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_brand_sid is null or p_brand_sid !~ '^BN[0-9a-fA-F]{32}$' or p_brand_status not in ('in_review', 'approved', 'rejected', 'suspended') then
    raise exception 'invalid brand' using errcode = '22023';
  end if;
  select s.mock into v_mock from public.studio_sms_provisioning_steps s
  where s.onboarding_id = o.id and s.step_key = 'B1' and s.submission_seq = o.submission_seq and s.status = 'succeeded' and s.provider_sid = p_brand_sid;
  if v_mock is null then
    raise exception 'that brand is not this onboarding''s recorded brand step' using errcode = '22023';
  end if;
  if v_mock then
    raise exception 'a mock brand is never mirrored into the registration' using errcode = '22023';
  end if;
  select s.provider_sid into v_profile from public.studio_sms_provisioning_steps s
  where s.onboarding_id = o.id and s.step_key = 'S1' and s.submission_seq = o.submission_seq and s.status = 'succeeded';
  if v_profile is null or v_profile !~ '^BU[0-9a-fA-F]{32}$' then
    raise exception 'the customer profile step has not succeeded' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_registrations x where x.studio_id = o.studio_id for update;
  if r.id is null then
    insert into public.studio_sms_registrations (studio_id, registration_status, customer_profile_sid, brand_sid, brand_status)
    values (o.studio_id, 'in_review', v_profile, p_brand_sid, p_brand_status);
  else
    if r.brand_sid is not null and r.brand_sid <> p_brand_sid then
      raise exception 'this studio already has a different brand recorded' using errcode = '22023';
    end if;
    update public.studio_sms_registrations set customer_profile_sid = coalesce(customer_profile_sid, v_profile), brand_sid = p_brand_sid,
      brand_status = p_brand_status,
      registration_status = case when registration_status = 'not_registered' then 'in_review' else registration_status end
    where id = r.id;
  end if;
end $$;

create or replace function public.tw4_runner_brand_approved(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_from text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if o.state <> 'brand_pending' then
    raise exception 'onboarding is not waiting for the brand' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.step_key = 'B1' and s.submission_seq = o.submission_seq and s.mock) then
    raise exception 'a mock brand cannot approve an onboarding' using errcode = '22023';
  end if;
  if not exists (select 1 from public.studio_sms_registrations r where r.studio_id = o.studio_id and r.brand_status = 'approved' and r.brand_sid is not null) then
    raise exception 'the brand is not recorded as approved' using errcode = '22023';
  end if;
  v_from := o.state;
  update public.studio_sms_onboarding set state = 'service_setup', step = 'M1', last_error_code = null, last_error_field = null
  where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, null, 'state_changed', v_from, o.state, 'brand approved');
  perform public.purge_sms_onboarding_ein(o.id, 'brand_approved');
  return jsonb_build_object('state', o.state);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- platform-admin summary (no SIDs, no PII)
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
                         'fee_confirmed', s.fee_confirmed_at is not null, 'mock', s.mock, 'error_code', s.error_code) order by s.step_key)
                       from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.submission_seq = o.submission_seq), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- forward fix of the 4A purge functions: an onboarding left in `exception` keeps its EIN ciphertext for at most 30 days
-- (the owner re-enters it if the setup resumes, design D6 step 5)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.purge_sms_onboarding_ein(p_onboarding_id uuid, p_reason text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if p_reason is null or p_reason not in ('brand_approved', 'terminal_30d', 'manual', 'owner_cancel', 'stale_exception') then
    raise exception 'unsupported purge reason' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = p_onboarding_id for update;
  if o.id is null or o.ein_ciphertext is null then return false; end if;
  -- re-checked under the row lock, so a stale candidate list (or a reopened record) is never purged early
  if p_reason = 'terminal_30d' and not (o.state in ('cancelled', 'blocked') and o.terminal_at is not null
                                        and o.terminal_at < now() - interval '30 days') then
    return false;
  end if;
  if p_reason = 'stale_exception' and not (o.state = 'exception' and o.updated_at < now() - interval '30 days') then
    return false;
  end if;
  if p_reason = 'owner_cancel' and o.state <> 'cancelled' then return false; end if;
  update public.studio_sms_onboarding set ein_ciphertext = null, ein_key_id = null, ein_purged_at = now() where id = o.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, action, note)
  values (o.studio_id, o.id, 'system', 'ein_purged', 'reason=' || p_reason);
  return true;
end $$;

create or replace function public.purge_due_sms_onboarding_eins()
returns integer language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select id, state from public.studio_sms_onboarding
           where ein_ciphertext is not null
             and ((state in ('cancelled', 'blocked') and terminal_at < now() - interval '30 days')
                  or (state = 'exception' and updated_at < now() - interval '30 days')) loop
    if public.purge_sms_onboarding_ein(r.id, case when r.state = 'exception' then 'stale_exception' else 'terminal_30d' end) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: helpers for nobody, runner functions for service_role only
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4_r1_is_platform_admin(uuid), public._tw4_r1_lease(uuid, text), public._tw4_r1_step_ok(text),
  public._tw4_r1_audit(public.studio_sms_onboarding, uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.tw4_runner_set_window(uuid, uuid, integer, text), public.tw4_runner_claim(uuid, uuid, text, integer, text),
  public.tw4_runner_release(uuid, text), public.tw4_runner_get_inputs(uuid, text), public.tw4_runner_get_ein(uuid, text, uuid),
  public.tw4_runner_begin_step(uuid, text, text, text, boolean, uuid, boolean), public.tw4_runner_finish_step(uuid, text, text, text, text, text, text),
  public.tw4_runner_transition(uuid, text, text, text, text, text), public.tw4_runner_record_brand(uuid, text, text, text),
  public.tw4_runner_brand_approved(uuid, text), public.tw4_runner_status(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.tw4_runner_set_window(uuid, uuid, integer, text), public.tw4_runner_claim(uuid, uuid, text, integer, text),
  public.tw4_runner_release(uuid, text), public.tw4_runner_get_inputs(uuid, text), public.tw4_runner_get_ein(uuid, text, uuid),
  public.tw4_runner_begin_step(uuid, text, text, text, boolean, uuid, boolean), public.tw4_runner_finish_step(uuid, text, text, text, text, text, text),
  public.tw4_runner_transition(uuid, text, text, text, text, text), public.tw4_runner_record_brand(uuid, text, text, text),
  public.tw4_runner_brand_approved(uuid, text), public.tw4_runner_status(uuid, uuid) to service_role;

do $$
declare
  v_bad text[] := '{}';
  r record;
  p text;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and (p.proname like 'tw4\_runner\_%' or p.proname like '\_tw4\_r1\_%') loop
    if r.proconfig is null or not ('search_path=pg_catalog, public, pg_temp' = any (r.proconfig)) then v_bad := v_bad || (r.proname || ' search_path'); end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then v_bad := v_bad || (r.proname || ' exposed'); end if;
    if r.proname like 'tw4\_runner\_%' and not has_function_privilege('service_role', r.oid, 'EXECUTE') then v_bad := v_bad || (r.proname || ' not service_role'); end if;
    if r.proname like '\_tw4\_r1\_%' and has_function_privilege('service_role', r.oid, 'EXECUTE') then v_bad := v_bad || (r.proname || ' helper exposed'); end if;
    if r.proname like 'tw4\_runner\_%' and not r.prosecdef then v_bad := v_bad || (r.proname || ' not definer'); end if;
  end loop;
  foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('anon', 'public.studio_sms_runner_windows', p) or has_table_privilege('authenticated', 'public.studio_sms_runner_windows', p)
       or has_table_privilege('service_role', 'public.studio_sms_runner_windows', p) then
      v_bad := v_bad || ('runner windows grant ' || p);
    end if;
  end loop;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.studio_sms_runner_windows'::regclass) then v_bad := v_bad || 'runner windows RLS off'; end if;
  if cardinality(v_bad) > 0 then
    raise exception 'R1 self-check failed: %', array_to_string(v_bad, '; ') using errcode = '42501';
  end if;
end $$;

commit;
