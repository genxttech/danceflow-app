-- 20261119090000_twilio_tw4a_sms_onboarding.sql
-- TW-4 slice 4A: studio SMS onboarding foundation (database only; NO Twilio calls anywhere).
--
-- Creates
--   public.studio_sms_onboarding_access   per-studio pilot switch (default absent = OFF), platform-admin RPC only
--   public.studio_sms_onboarding          one active onboarding per studio: owner draft, attestation, state machine,
--                                         EIN ciphertext (AES-GCM done in the application; the key never touches the DB)
--   public.studio_sms_provisioning_steps  orchestrator ledger (schema only; unused until 4C)
--   public.studio_sms_onboarding_audit    append-only audit (ids, states, actions; never EIN, phone, email or message text)
--   RPCs  set_sms_onboarding_access, get_studio_sms_status, get_sms_onboarding_draft, save_sms_onboarding_draft,
--         submit_sms_onboarding, cancel_sms_onboarding, list_sms_onboardings            (authenticated; role checked inside)
--         store_sms_onboarding_ein, purge_sms_onboarding_ein, purge_due_sms_onboarding_eins, get_sms_legal_context
--                                                                                       (service_role only)
-- Privileges: no API role holds ANY privilege on the four tables (RLS on, no policies); every read and write is a
--   SECURITY DEFINER RPC with a pinned search_path that derives the studio role from auth.uid(). The EIN ciphertext is
--   returned by no function. Nothing here touches studio_sms_registrations, sending, consent, inbound or status routes.
-- Not in this slice: orchestrator, Twilio adapter, Event Streams, registration-column extensions (TW-3 table unchanged),
--   billing/entitlement, emails.
-- Rollback: rollback/20261119090000_twilio_tw4a_sms_onboarding_rollback.sql (refuses once any onboarding data exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_registrations') is null then
    raise exception 'TW-4A precondition failed: studio_sms_registrations is missing (TW-3 not applied)';
  end if;
  if to_regclass('public.studio_sms_onboarding') is not null
     or to_regclass('public.studio_sms_onboarding_access') is not null
     or to_regclass('public.studio_sms_provisioning_steps') is not null
     or to_regclass('public.studio_sms_onboarding_audit') is not null then
    raise exception 'TW-4A precondition failed: a TW-4A table already exists';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Helpers (callable only from inside the definer functions below)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._sms_onb_is_platform_admin()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin');
$$;

create or replace function public._sms_onb_studio_role(p_studio_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select r.role::text from public.user_studio_roles r
  where r.user_id = auth.uid() and r.studio_id = p_studio_id and r.active = true
  limit 1;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Pilot access (feature flag sms_isv_onboarding): absent row = OFF. Only a platform admin can change it.
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_onboarding_access (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  enabled boolean not null default false,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  updated_by uuid null,
  updated_at timestamptz not null default now()
);

-- (defined after its table: SQL-language function bodies are validated at creation)
create or replace function public._sms_onb_access_enabled(p_studio_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select a.enabled from public.studio_sms_onboarding_access a where a.studio_id = p_studio_id), false);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Onboarding record
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_onboarding (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  state text not null default 'draft' check (state in (
    'draft', 'submitted_for_checks', 'needs_info', 'profile_review', 'brand_pending', 'service_setup',
    'campaign_pending', 'ready_for_activation', 'active', 'suspended', 'blocked', 'exception', 'cancelled')),
  step text null check (step is null or char_length(step) <= 64),
  tier text null check (tier is null or tier in ('low_volume_standard', 'standard')),
  opt_out_mode text not null default 'twilio_default' check (opt_out_mode in ('twilio_default', 'twilio_advanced')),

  -- owner-entered draft (non-secret)
  legal_name text null check (legal_name is null or char_length(legal_name) between 2 and 200),
  entity_type text null check (entity_type is null or entity_type in ('llc', 'corporation', 'partnership', 'non_profit', 'cooperative')),
  industry text null check (industry is null or industry in ('EDUCATION', 'CONSUMER')),
  website_choice text null check (website_choice is null or website_choice in ('own', 'danceflow')),
  website_url text null check (website_url is null or (char_length(website_url) <= 300 and website_url ~ '^https://[^\s/]+\.[^\s/]+(/[^\s]*)?$')),
  address_line1 text null check (address_line1 is null or char_length(address_line1) between 3 and 200),
  address_line2 text null check (address_line2 is null or char_length(address_line2) <= 200),
  city text null check (city is null or char_length(city) between 2 and 100),
  region text null check (region is null or region ~ '^[A-Z]{2}$'),
  postal_code text null check (postal_code is null or postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  country text not null default 'US' check (country = 'US'),
  rep_first_name text null check (rep_first_name is null or char_length(rep_first_name) between 1 and 100),
  rep_last_name text null check (rep_last_name is null or char_length(rep_last_name) between 1 and 100),
  rep_title text null check (rep_title is null or char_length(rep_title) between 2 and 100),
  rep_position text null check (rep_position is null or rep_position in ('director', 'gm', 'vp', 'ceo', 'cfo', 'general_counsel', 'other')),
  rep_email text null check (rep_email is null or (char_length(rep_email) <= 254 and rep_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  rep_phone text null check (rep_phone is null or rep_phone ~ '^\+[1-9][0-9]{9,14}$'),
  preferred_area_code text null check (preferred_area_code is null or preferred_area_code ~ '^[2-9][0-9]{2}$'),

  -- EIN: ciphertext written only by the service-role RPC; last4 is the only value ever shown
  ein_last4 text null check (ein_last4 is null or ein_last4 ~ '^[0-9]{4}$'),
  ein_ciphertext text null check (ein_ciphertext is null or char_length(ein_ciphertext) between 20 and 400),
  ein_key_id text null check (ein_key_id is null or ein_key_id ~ '^[a-z0-9_-]{1,32}$'),
  ein_stored_at timestamptz null,
  ein_purged_at timestamptz null,

  -- attestation (each box is part of the record; version-pinned)
  attestation_version text null check (attestation_version is null or char_length(attestation_version) <= 32),
  attested_by uuid null,
  attested_at timestamptz null,
  attestation jsonb null check (attestation is null or jsonb_typeof(attestation) = 'object'),

  submission_seq int not null default 0 check (submission_seq >= 0),
  lease_owner text null,
  lease_expires_at timestamptz null,
  next_attempt_at timestamptz null,
  attempt_count int not null default 0 check (attempt_count >= 0),
  last_error_code text null check (last_error_code is null or char_length(last_error_code) <= 64),
  last_error_field text null check (last_error_field is null or char_length(last_error_field) <= 64),
  submitted_at timestamptz null,
  cancelled_at timestamptz null,
  terminal_at timestamptz null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint studio_sms_onboarding_id_studio_key unique (id, studio_id),
  constraint studio_sms_onboarding_ein_pair check (
    (ein_ciphertext is null) = (ein_key_id is null) and (ein_ciphertext is null or (ein_last4 is not null and ein_stored_at is not null))),
  constraint studio_sms_onboarding_website_pair check (website_choice is distinct from 'own' or website_url is not null or state = 'draft')
);
create unique index studio_sms_onboarding_one_active on public.studio_sms_onboarding (studio_id) where state <> 'cancelled';
create index studio_sms_onboarding_state on public.studio_sms_onboarding (state);

create table public.studio_sms_provisioning_steps (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  studio_id uuid not null,
  step_key text not null check (step_key ~ '^[A-Z][0-9]{1,2}$'),
  submission_seq int not null check (submission_seq >= 0),
  status text not null default 'pending' check (status in ('pending', 'in_flight', 'succeeded', 'failed', 'unknown_outcome', 'skipped')),
  provider_sid text null check (provider_sid is null or provider_sid ~ '^[A-Za-z]{2}[0-9a-fA-F]{32}$'),
  friendly_name text null check (friendly_name is null or char_length(friendly_name) <= 128),
  request_fingerprint text null check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'),
  fee_bearing boolean not null default false,
  fee_confirmed_by uuid null,
  fee_confirmed_at timestamptz null,
  started_at timestamptz null,
  finished_at timestamptz null,
  error_code text null check (error_code is null or char_length(error_code) <= 64),
  error_detail_sanitized text null check (error_detail_sanitized is null or char_length(error_detail_sanitized) <= 500),
  created_at timestamptz not null default now(),
  constraint studio_sms_provisioning_steps_unique unique (onboarding_id, step_key, submission_seq),
  constraint studio_sms_provisioning_steps_onboarding_fk foreign key (onboarding_id, studio_id)
    references public.studio_sms_onboarding (id, studio_id) on delete cascade,
  constraint studio_sms_provisioning_steps_fee_pair check ((fee_confirmed_by is null) = (fee_confirmed_at is null))
);

create table public.studio_sms_onboarding_audit (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  onboarding_id uuid null,
  actor_type text not null check (actor_type in ('user', 'system', 'platform_admin')),
  actor_user_id uuid null,
  action text not null check (action in (
    'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed')),
  from_state text null,
  to_state text null,
  step_key text null,
  provider_sid text null,
  note text null check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index studio_sms_onboarding_audit_studio on public.studio_sms_onboarding_audit (studio_id, created_at);

-- R25: nothing is reachable through the API roles directly.
revoke all on public.studio_sms_onboarding_access, public.studio_sms_onboarding, public.studio_sms_provisioning_steps,
  public.studio_sms_onboarding_audit from public, anon, authenticated, service_role;
alter table public.studio_sms_onboarding_access enable row level security;
alter table public.studio_sms_onboarding enable row level security;
alter table public.studio_sms_provisioning_steps enable row level security;
alter table public.studio_sms_onboarding_audit enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- Integrity: immutable ownership, server-derived timestamps, the state graph, and draft locking.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._sms_onb_transition_allowed(p_from text, p_to text)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select p_from <> p_to and (p_from, p_to) in (
    ('draft', 'submitted_for_checks'), ('draft', 'cancelled'),
    ('submitted_for_checks', 'needs_info'), ('submitted_for_checks', 'profile_review'),
    ('submitted_for_checks', 'exception'), ('submitted_for_checks', 'cancelled'),
    ('needs_info', 'submitted_for_checks'), ('needs_info', 'cancelled'),
    ('profile_review', 'brand_pending'), ('profile_review', 'needs_info'), ('profile_review', 'blocked'),
    ('profile_review', 'exception'), ('profile_review', 'cancelled'),
    ('brand_pending', 'service_setup'), ('brand_pending', 'needs_info'), ('brand_pending', 'blocked'), ('brand_pending', 'exception'),
    ('service_setup', 'campaign_pending'), ('service_setup', 'exception'),
    ('campaign_pending', 'ready_for_activation'), ('campaign_pending', 'needs_info'), ('campaign_pending', 'blocked'),
    ('campaign_pending', 'exception'),
    ('ready_for_activation', 'active'), ('ready_for_activation', 'exception'),
    ('active', 'suspended'), ('active', 'exception'),
    ('suspended', 'active'), ('suspended', 'exception'),
    ('exception', 'needs_info'), ('exception', 'submitted_for_checks'), ('exception', 'profile_review'),
    ('exception', 'brand_pending'), ('exception', 'service_setup'), ('exception', 'campaign_pending'),
    ('exception', 'ready_for_activation'), ('exception', 'blocked'), ('exception', 'cancelled'),
    ('blocked', 'exception'), ('blocked', 'cancelled'));
$$;

create or replace function public._sms_onb_integrity()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.studio_id is distinct from old.studio_id or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception 'studio_sms_onboarding: ownership and creation fields are immutable' using errcode = '42501';
    end if;
    if new.state is distinct from old.state and not public._sms_onb_transition_allowed(old.state, new.state) then
      raise exception 'studio_sms_onboarding: transition % -> % is not allowed', old.state, new.state using errcode = '22023';
    end if;
    -- the owner-entered draft can only change while the owner may edit
    if old.state not in ('draft', 'needs_info') and (
         new.legal_name is distinct from old.legal_name or new.entity_type is distinct from old.entity_type
         or new.industry is distinct from old.industry or new.website_choice is distinct from old.website_choice
         or new.website_url is distinct from old.website_url or new.address_line1 is distinct from old.address_line1
         or new.address_line2 is distinct from old.address_line2 or new.city is distinct from old.city
         or new.region is distinct from old.region or new.postal_code is distinct from old.postal_code
         or new.country is distinct from old.country or new.rep_first_name is distinct from old.rep_first_name
         or new.rep_last_name is distinct from old.rep_last_name or new.rep_title is distinct from old.rep_title
         or new.rep_position is distinct from old.rep_position or new.rep_email is distinct from old.rep_email
         or new.rep_phone is distinct from old.rep_phone or new.preferred_area_code is distinct from old.preferred_area_code) then
      raise exception 'studio_sms_onboarding: the draft is locked in state %', old.state using errcode = '22023';
    end if;
    -- submission data is frozen once the owner can no longer edit: attestation, submission clock/count, EIN columns
    -- (the only EIN change allowed then is the purge: ciphertext and key id cleared, last4/stored_at untouched)
    if new.submission_seq < old.submission_seq or new.submission_seq > old.submission_seq + 1 then
      raise exception 'studio_sms_onboarding: submission_seq may only stay or increase by one' using errcode = '22023';
    end if;
    if old.state not in ('draft', 'needs_info') then
      if new.attestation_version is distinct from old.attestation_version or new.attested_by is distinct from old.attested_by
         or new.attested_at is distinct from old.attested_at or new.attestation is distinct from old.attestation
         or new.submitted_at is distinct from old.submitted_at then
        raise exception 'studio_sms_onboarding: the attestation and submission time are frozen in state %', old.state using errcode = '22023';
      end if;
      if (new.ein_ciphertext is distinct from old.ein_ciphertext or new.ein_key_id is distinct from old.ein_key_id
          or new.ein_last4 is distinct from old.ein_last4 or new.ein_stored_at is distinct from old.ein_stored_at)
         and not (new.ein_ciphertext is null and new.ein_key_id is null
                  and new.ein_last4 is not distinct from old.ein_last4 and new.ein_stored_at is not distinct from old.ein_stored_at) then
        raise exception 'studio_sms_onboarding: the EIN is frozen in state % (it can only be purged)', old.state using errcode = '22023';
      end if;
    end if;
    -- the 30-day terminal clock restarts on every entry into cancelled/blocked and is cleared when a blocked record is reopened
    if new.state in ('cancelled', 'blocked') and old.state not in ('cancelled', 'blocked') then
      new.terminal_at := now();
    elsif old.state = 'blocked' and new.state not in ('cancelled', 'blocked') then
      new.terminal_at := null;
    end if;
    if new.state = 'cancelled' and old.state <> 'cancelled' then
      new.cancelled_at := coalesce(new.cancelled_at, now());
    end if;
  else
    if new.state <> 'draft' then
      raise exception 'studio_sms_onboarding: a new onboarding starts as draft' using errcode = '22023';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger studio_sms_onboarding_10_integrity before insert or update on public.studio_sms_onboarding
  for each row execute function public._sms_onb_integrity();

create or replace function public._sms_onb_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.studios s where s.id = old.studio_id) then
    return old;  -- only together with a deleted studio
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;

create or replace function public._sms_onb_refuse_truncate()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'TRUNCATE of % is refused', tg_table_name using errcode = '42501';
end $$;

-- provisioning ledger: rows are updated by the orchestrator (4C) but their identity never changes, a succeeded step never
-- regresses, and a row is deleted only together with its onboarding
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

create trigger studio_sms_provisioning_steps_10_guard before update or delete on public.studio_sms_provisioning_steps
  for each row execute function public._sms_onb_steps_guard();
create trigger studio_sms_provisioning_steps_20_no_truncate before truncate on public.studio_sms_provisioning_steps
  for each statement execute function public._sms_onb_refuse_truncate();

create trigger studio_sms_onboarding_audit_10_append_only before update or delete on public.studio_sms_onboarding_audit
  for each row execute function public._sms_onb_append_only();
create trigger studio_sms_onboarding_audit_20_no_truncate before truncate on public.studio_sms_onboarding_audit
  for each statement execute function public._sms_onb_refuse_truncate();
create trigger studio_sms_onboarding_20_no_truncate before truncate on public.studio_sms_onboarding
  for each statement execute function public._sms_onb_refuse_truncate();
create trigger studio_sms_onboarding_access_20_no_truncate before truncate on public.studio_sms_onboarding_access
  for each statement execute function public._sms_onb_refuse_truncate();

create or replace function public._sms_onb_audit(p_studio_id uuid, p_onboarding_id uuid, p_actor_type text, p_action text,
  p_from text default null, p_to text default null, p_note text default null)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, from_state, to_state, note)
  values (p_studio_id, p_onboarding_id, p_actor_type, auth.uid(), p_action, p_from, p_to, p_note);
$$;

-- required fields in setup order (names are the wizard's field keys)
create or replace function public._sms_onb_missing(o public.studio_sms_onboarding)
returns text[] language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select array_remove(array[
    case when o.legal_name is null then 'legal_name' end,
    case when o.entity_type is null then 'entity_type' end,
    case when o.industry is null then 'industry' end,
    case when o.ein_ciphertext is null or o.ein_last4 is null then 'ein' end,
    case when o.address_line1 is null then 'address_line1' end,
    case when o.city is null then 'city' end,
    case when o.region is null then 'region' end,
    case when o.postal_code is null then 'postal_code' end,
    case when o.website_choice is null then 'website_choice' end,
    case when o.website_choice = 'own' and o.website_url is null then 'website_url' end,
    case when o.rep_first_name is null then 'rep_first_name' end,
    case when o.rep_last_name is null then 'rep_last_name' end,
    case when o.rep_title is null then 'rep_title' end,
    case when o.rep_position is null then 'rep_position' end,
    case when o.rep_email is null then 'rep_email' end,
    case when o.rep_phone is null then 'rep_phone' end
  ], null);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Platform admin: pilot access and read-only list
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.set_sms_onboarding_access(p_studio_id uuid, p_enabled boolean, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public._sms_onb_is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'an explicit flag and a reason of 3-500 characters are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'unknown studio' using errcode = '22023';
  end if;
  insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by, updated_at)
  values (p_studio_id, p_enabled, btrim(p_reason), auth.uid(), now())
  on conflict (studio_id) do update set enabled = excluded.enabled, reason = excluded.reason,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform public._sms_onb_audit(p_studio_id, null, 'platform_admin', case when p_enabled then 'access_enabled' else 'access_disabled' end,
    null, null, left(btrim(p_reason), 300));
end $$;

create or replace function public.list_sms_onboardings()
returns table (studio_id uuid, studio_name text, access_enabled boolean, state text, submission_seq int,
               submitted_at timestamptz, updated_at timestamptz, ein_stored boolean)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public._sms_onb_is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  select s.id, s.name::text, coalesce(a.enabled, false), o.state, o.submission_seq, o.submitted_at,
         coalesce(o.updated_at, a.updated_at), (o.ein_ciphertext is not null)
  from public.studios s
  left join public.studio_sms_onboarding_access a on a.studio_id = s.id
  left join public.studio_sms_onboarding o on o.studio_id = s.id and o.state <> 'cancelled'
  where a.studio_id is not null or o.id is not null
  order by s.name, s.id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Studio-facing reads. Owner/admin see the tracker; front desk sees only whether texting is on. No SIDs, no EIN.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.get_studio_sms_status(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_role text := public._sms_onb_studio_role(p_studio_id);
  v_admin boolean := public._sms_onb_is_platform_admin();
  v_on boolean;
  o public.studio_sms_onboarding;
begin
  if auth.uid() is null or (v_role is null and not v_admin) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_role is not null and v_role not in ('studio_owner', 'studio_admin', 'front_desk') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_on := exists (select 1 from public.studio_sms_registrations r
                  where r.studio_id = p_studio_id and r.registration_status = 'approved');
  if v_role = 'front_desk' then
    return jsonb_build_object('texting_on', v_on);
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    return jsonb_build_object('available', false, 'texting_on', v_on);
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  return jsonb_build_object(
    'available', true,
    'texting_on', v_on,
    'role', coalesce(v_role, 'platform_admin'),
    'can_edit', v_role = 'studio_owner' and (o.id is null or o.state in ('draft', 'needs_info')),
    'state', coalesce(o.state, 'not_started'),
    'needs_info_fields', case when o.state = 'needs_info' and o.last_error_field is not null then jsonb_build_array(o.last_error_field) else '[]'::jsonb end,
    'submitted_at', o.submitted_at,
    'submission_seq', coalesce(o.submission_seq, 0));
end $$;

create or replace function public.get_sms_onboarding_draft(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_role text := public._sms_onb_studio_role(p_studio_id);
  o public.studio_sms_onboarding;
begin
  if auth.uid() is null or v_role is null or v_role not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  if o.id is null then return null; end if;
  return jsonb_build_object(
    'state', o.state, 'legal_name', o.legal_name, 'entity_type', o.entity_type, 'industry', o.industry,
    'website_choice', o.website_choice, 'website_url', o.website_url, 'address_line1', o.address_line1,
    'address_line2', o.address_line2, 'city', o.city, 'region', o.region, 'postal_code', o.postal_code,
    'country', o.country, 'rep_first_name', o.rep_first_name, 'rep_last_name', o.rep_last_name,
    'rep_title', o.rep_title, 'rep_position', o.rep_position, 'rep_email', o.rep_email, 'rep_phone', o.rep_phone,
    'preferred_area_code', o.preferred_area_code, 'ein_last4', o.ein_last4,
    'ein_on_file', o.ein_ciphertext is not null, 'missing', to_jsonb(public._sms_onb_missing(o)),
    'attested_at', o.attested_at, 'updated_at', o.updated_at);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Owner writes
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.save_sms_onboarding_draft(p_studio_id uuid, p_fields jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c_keys constant text[] := array['legal_name', 'entity_type', 'industry', 'website_choice', 'website_url', 'address_line1',
    'address_line2', 'city', 'region', 'postal_code', 'country', 'rep_first_name', 'rep_last_name', 'rep_title',
    'rep_position', 'rep_email', 'rep_phone', 'preferred_area_code'];
  o public.studio_sms_onboarding;
  k text;
  v jsonb;
  v_con text;
begin
  if auth.uid() is null or public._sms_onb_studio_role(p_studio_id) is distinct from 'studio_owner' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'fields must be an object' using errcode = '22023';
  end if;
  for k, v in select key, value from jsonb_each(p_fields) loop
    if not (k = any (c_keys)) then
      raise exception 'unsupported field %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) not in ('string', 'null') then
      raise exception 'field % must be text', k using errcode = '22023';
    end if;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    insert into public.studio_sms_onboarding (studio_id, created_by) values (p_studio_id, auth.uid()) returning * into o;
    perform public._sms_onb_audit(p_studio_id, o.id, 'user', 'draft_created', null, 'draft');
  elsif o.state not in ('draft', 'needs_info') then
    raise exception 'the setup is already submitted and cannot be edited' using errcode = '22023';
  end if;
  -- A check violation is re-raised without Postgres' DETAIL ("Failing row contains ..."), which would echo other columns
  -- of the row (including the start of the EIN ciphertext) to the caller and into the server log.
  begin
  update public.studio_sms_onboarding t set
    legal_name = case when p_fields ? 'legal_name' then nullif(btrim(p_fields ->> 'legal_name'), '') else t.legal_name end,
    entity_type = case when p_fields ? 'entity_type' then nullif(btrim(p_fields ->> 'entity_type'), '') else t.entity_type end,
    industry = case when p_fields ? 'industry' then nullif(btrim(p_fields ->> 'industry'), '') else t.industry end,
    website_choice = case when p_fields ? 'website_choice' then nullif(btrim(p_fields ->> 'website_choice'), '') else t.website_choice end,
    website_url = case when p_fields ? 'website_url' then nullif(btrim(p_fields ->> 'website_url'), '') else t.website_url end,
    address_line1 = case when p_fields ? 'address_line1' then nullif(btrim(p_fields ->> 'address_line1'), '') else t.address_line1 end,
    address_line2 = case when p_fields ? 'address_line2' then nullif(btrim(p_fields ->> 'address_line2'), '') else t.address_line2 end,
    city = case when p_fields ? 'city' then nullif(btrim(p_fields ->> 'city'), '') else t.city end,
    region = case when p_fields ? 'region' then nullif(upper(btrim(p_fields ->> 'region')), '') else t.region end,
    postal_code = case when p_fields ? 'postal_code' then nullif(btrim(p_fields ->> 'postal_code'), '') else t.postal_code end,
    country = case when p_fields ? 'country' then coalesce(nullif(upper(btrim(p_fields ->> 'country')), ''), t.country) else t.country end,
    rep_first_name = case when p_fields ? 'rep_first_name' then nullif(btrim(p_fields ->> 'rep_first_name'), '') else t.rep_first_name end,
    rep_last_name = case when p_fields ? 'rep_last_name' then nullif(btrim(p_fields ->> 'rep_last_name'), '') else t.rep_last_name end,
    rep_title = case when p_fields ? 'rep_title' then nullif(btrim(p_fields ->> 'rep_title'), '') else t.rep_title end,
    rep_position = case when p_fields ? 'rep_position' then nullif(btrim(p_fields ->> 'rep_position'), '') else t.rep_position end,
    rep_email = case when p_fields ? 'rep_email' then nullif(lower(btrim(p_fields ->> 'rep_email')), '') else t.rep_email end,
    rep_phone = case when p_fields ? 'rep_phone' then nullif(btrim(p_fields ->> 'rep_phone'), '') else t.rep_phone end,
    preferred_area_code = case when p_fields ? 'preferred_area_code' then nullif(btrim(p_fields ->> 'preferred_area_code'), '') else t.preferred_area_code end
  where t.id = o.id
  returning * into o;
  exception when check_violation then
    get stacked diagnostics v_con = constraint_name;
    raise exception 'invalid value (%)', coalesce(v_con, 'check') using errcode = '23514';
  end;
  return jsonb_build_object('state', o.state, 'updated_at', o.updated_at, 'missing', to_jsonb(public._sms_onb_missing(o)));
end $$;

create or replace function public.submit_sms_onboarding(p_studio_id uuid, p_attestation jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_missing text[];
  v_from text;
begin
  if auth.uid() is null or public._sms_onb_studio_role(p_studio_id) is distinct from 'studio_owner' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  if p_attestation is null or jsonb_typeof(p_attestation) <> 'object'
     or p_attestation ->> 'version' is distinct from 'tw4a-v1'
     or p_attestation -> 'authorized' is distinct from 'true'::jsonb
     or p_attestation -> 'accurate' is distinct from 'true'::jsonb
     or p_attestation -> 'opt_in_only' is distinct from 'true'::jsonb
     or p_attestation -> 'fees_terms' is distinct from 'true'::jsonb then
    raise exception 'every attestation must be accepted' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'there is no setup to submit' using errcode = '22023';
  end if;
  if o.state not in ('draft', 'needs_info') then
    raise exception 'the setup is already submitted' using errcode = '22023';
  end if;
  v_missing := public._sms_onb_missing(o);
  if cardinality(v_missing) > 0 then
    return jsonb_build_object('submitted', false, 'missing', to_jsonb(v_missing), 'state', o.state);
  end if;
  v_from := o.state;
  update public.studio_sms_onboarding set
    state = 'submitted_for_checks', submission_seq = o.submission_seq + 1, submitted_at = now(),
    attestation_version = 'tw4a-v1', attested_by = auth.uid(), attested_at = now(),
    attestation = jsonb_build_object('authorized', true, 'accurate', true, 'opt_in_only', true, 'fees_terms', true),
    last_error_code = null, last_error_field = null
  where id = o.id returning * into o;
  perform public._sms_onb_audit(p_studio_id, o.id, 'user', 'submitted', v_from, o.state, 'seq=' || o.submission_seq);
  return jsonb_build_object('submitted', true, 'missing', '[]'::jsonb, 'state', o.state, 'submission_seq', o.submission_seq);
end $$;

create or replace function public.cancel_sms_onboarding(p_studio_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_from text;
begin
  if auth.uid() is null or public._sms_onb_studio_role(p_studio_id) is distinct from 'studio_owner' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- no pilot-flag check: an owner can always cancel a setup that exists, even after the switch was turned off
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'there is no setup to cancel' using errcode = '22023';
  end if;
  if o.state not in ('draft', 'submitted_for_checks', 'needs_info', 'profile_review') then
    raise exception 'this setup can no longer be cancelled here; contact DanceFlow' using errcode = '22023';
  end if;
  v_from := o.state;
  update public.studio_sms_onboarding set state = 'cancelled' where id = o.id returning * into o;
  perform public._sms_onb_audit(p_studio_id, o.id, 'user', 'cancelled', v_from, 'cancelled');
  -- the wizard promises "Your saved EIN will be removed": do it now rather than waiting for the 30-day sweep
  perform public.purge_sms_onboarding_ein(o.id, 'owner_cancel');
  return jsonb_build_object('state', o.state);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Service-role only: EIN storage / purge and the public legal-page context
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.store_sms_onboarding_ein(p_studio_id uuid, p_actor uuid, p_ciphertext text, p_key_id text, p_last4 text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_con text;
begin
  if p_actor is null or not exists (
       select 1 from public.user_studio_roles r
       where r.user_id = p_actor and r.studio_id = p_studio_id and r.role = 'studio_owner' and r.active = true) then
    raise exception 'the actor must be an active owner of this studio' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  if p_ciphertext is null or p_key_id is null or p_last4 is null then
    raise exception 'ciphertext, key id and last4 are all required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    insert into public.studio_sms_onboarding (studio_id, created_by) values (p_studio_id, p_actor) returning * into o;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, from_state, to_state)
    values (p_studio_id, o.id, 'user', p_actor, 'draft_created', null, 'draft');
  elsif o.state not in ('draft', 'needs_info') then
    raise exception 'the setup is already submitted and cannot be edited' using errcode = '22023';
  end if;
  begin
    update public.studio_sms_onboarding set ein_ciphertext = p_ciphertext, ein_key_id = p_key_id, ein_last4 = p_last4,
      ein_stored_at = now(), ein_purged_at = null where id = o.id;
  exception when check_violation then
    -- no DETAIL: the failing-row text would carry the ciphertext being stored
    get stacked diagnostics v_con = constraint_name;
    raise exception 'invalid value (%)', coalesce(v_con, 'check') using errcode = '23514';
  end;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action)
  values (p_studio_id, o.id, 'user', p_actor, 'ein_stored');
end $$;

create or replace function public.purge_sms_onboarding_ein(p_onboarding_id uuid, p_reason text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if p_reason is null or p_reason not in ('brand_approved', 'terminal_30d', 'manual', 'owner_cancel') then
    raise exception 'unsupported purge reason' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = p_onboarding_id for update;
  if o.id is null or o.ein_ciphertext is null then return false; end if;
  -- re-checked under the row lock, so a stale candidate list (or a reopened record) is never purged early
  if p_reason = 'terminal_30d' and not (o.state in ('cancelled', 'blocked') and o.terminal_at is not null
                                        and o.terminal_at < now() - interval '30 days') then
    return false;
  end if;
  if p_reason = 'owner_cancel' and o.state <> 'cancelled' then return false; end if;
  update public.studio_sms_onboarding set ein_ciphertext = null, ein_key_id = null, ein_purged_at = now() where id = o.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, action, note)
  values (o.studio_id, o.id, 'system', 'ein_purged', 'reason=' || p_reason);
  return true;
end $$;

-- terminal onboardings keep the ciphertext at most 30 days (design 18.6 step 4). The "brand approved" purge is added when
-- the orchestrator (4C) can observe brand approval.
create or replace function public.purge_due_sms_onboarding_eins()
returns integer language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select id from public.studio_sms_onboarding
           where ein_ciphertext is not null and state in ('cancelled', 'blocked') and terminal_at < now() - interval '30 days' loop
    if public.purge_sms_onboarding_ein(r.id, 'terminal_30d') then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Public legal pages: only for studios with the pilot switch ON. The legal name appears only after the owner attested.
create or replace function public.get_sms_legal_context(p_studio_slug text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s record;
  o public.studio_sms_onboarding;
begin
  select st.id, st.name, st.slug, st.public_name into s from public.studios st where st.slug = p_studio_slug;
  if s.id is null then return null; end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = s.id and x.state <> 'cancelled';
  -- available while the pilot switch is on, and for as long as a submitted setup exists (the pages are linked from a
  -- campaign once it is registered, so turning the switch off must not 404 them)
  if not public._sms_onb_access_enabled(s.id) and not (o.id is not null and o.state <> 'draft') then
    return null;
  end if;
  return jsonb_build_object(
    'display_name', coalesce(nullif(btrim(s.public_name), ''), s.name),
    'legal_name', case when o.id is not null and o.state <> 'draft' then o.legal_name else null end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- R25 privileges: helpers for nobody; RPCs by class.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._sms_onb_is_platform_admin(), public._sms_onb_studio_role(uuid), public._sms_onb_access_enabled(uuid),
  public._sms_onb_transition_allowed(text, text), public._sms_onb_integrity(), public._sms_onb_append_only(),
  public._sms_onb_refuse_truncate(), public._sms_onb_audit(uuid, uuid, text, text, text, text, text),
  public._sms_onb_missing(public.studio_sms_onboarding), public._sms_onb_steps_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.set_sms_onboarding_access(uuid, boolean, text), public.list_sms_onboardings(),
  public.get_studio_sms_status(uuid), public.get_sms_onboarding_draft(uuid), public.save_sms_onboarding_draft(uuid, jsonb),
  public.submit_sms_onboarding(uuid, jsonb), public.cancel_sms_onboarding(uuid),
  public.store_sms_onboarding_ein(uuid, uuid, text, text, text), public.purge_sms_onboarding_ein(uuid, text),
  public.purge_due_sms_onboarding_eins(), public.get_sms_legal_context(text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_sms_onboarding_access(uuid, boolean, text), public.list_sms_onboardings(),
  public.get_studio_sms_status(uuid), public.get_sms_onboarding_draft(uuid), public.save_sms_onboarding_draft(uuid, jsonb),
  public.submit_sms_onboarding(uuid, jsonb), public.cancel_sms_onboarding(uuid) to authenticated;
grant execute on function public.store_sms_onboarding_ein(uuid, uuid, text, text, text), public.purge_sms_onboarding_ein(uuid, text),
  public.purge_due_sms_onboarding_eins(), public.get_sms_legal_context(text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Self-check: abort the migration if any object deviates from the privilege design.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare
  v_bad text[] := '{}';
  r record;
  t text;
  p text;
begin
  foreach t in array array['studio_sms_onboarding_access', 'studio_sms_onboarding', 'studio_sms_provisioning_steps', 'studio_sms_onboarding_audit'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      v_bad := v_bad || (t || ' has RLS disabled');
    end if;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', ('public.' || t)::regclass, p) or has_table_privilege('authenticated', ('public.' || t)::regclass, p)
         or has_table_privilege('service_role', ('public.' || t)::regclass, p) then
        v_bad := v_bad || (t || ' grants ' || p || ' to an API role');
      end if;
    end loop;
  end loop;
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and (p.proname like '\_sms\_onb\_%' or p.proname in ('set_sms_onboarding_access', 'list_sms_onboardings', 'get_studio_sms_status',
                  'get_sms_onboarding_draft', 'save_sms_onboarding_draft', 'submit_sms_onboarding', 'cancel_sms_onboarding',
                  'store_sms_onboarding_ein', 'purge_sms_onboarding_ein', 'purge_due_sms_onboarding_eins', 'get_sms_legal_context')) loop
    if r.proconfig is null or not ('search_path=pg_catalog, public, pg_temp' = any (r.proconfig)) then
      v_bad := v_bad || (r.proname || ' has no pinned search_path');
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') then v_bad := v_bad || (r.proname || ' executable by anon'); end if;
    if r.proname like '\_sms\_onb\_%' and (has_function_privilege('authenticated', r.oid, 'EXECUTE') or has_function_privilege('service_role', r.oid, 'EXECUTE')) then
      v_bad := v_bad || (r.proname || ' helper executable by an API role');
    end if;
    if r.proname in ('store_sms_onboarding_ein', 'purge_sms_onboarding_ein', 'purge_due_sms_onboarding_eins', 'get_sms_legal_context')
       and (has_function_privilege('authenticated', r.oid, 'EXECUTE') or not has_function_privilege('service_role', r.oid, 'EXECUTE')) then
      v_bad := v_bad || (r.proname || ' must be service_role only');
    end if;
    if r.proname in ('set_sms_onboarding_access', 'list_sms_onboardings', 'get_studio_sms_status', 'get_sms_onboarding_draft',
                     'save_sms_onboarding_draft', 'submit_sms_onboarding', 'cancel_sms_onboarding')
       and (not has_function_privilege('authenticated', r.oid, 'EXECUTE') or has_function_privilege('service_role', r.oid, 'EXECUTE')) then
      v_bad := v_bad || (r.proname || ' must be authenticated only');
    end if;
    if r.proname not like '\_sms\_onb\_%' and not r.prosecdef then v_bad := v_bad || (r.proname || ' must be SECURITY DEFINER'); end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'TW-4A self-check failed: %', array_to_string(v_bad, '; ') using errcode = '42501';
  end if;
end $$;

commit;
