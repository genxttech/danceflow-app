-- 20261121090000_twilio_tw4f3a_subaccounts.sql
-- TW-4F-3a (D2 revised): one Twilio SUBACCOUNT per studio LEGAL BUSINESS. This file adds the database side only; NO Twilio call is made by anything in it.
--   studio_sms_legal_entities          the legal business (name, EIN last four only, spend cap). One subaccount per entity.
--   studio_sms_entity_studios          which studios (locations) belong to an entity, with the evidence of how the link was established
--   studio_sms_location_requests       an owner's ATTESTATION that another location belongs to the same legal business (pending until a platform admin decides)
--   studio_sms_twilio_accounts         the subaccount of an entity (SID and status only, NEVER a token)
--   studio_sms_subaccount_confirmations one-shot typed confirmation to CREATE a subaccount (its own run; never combined with registration or fees)
--   studio_sms_spend_events            owner-approved fee authorizations, bounded by the entity's spend cap; reserved once per fee step
-- Ledger rows of a studio that belongs to an entity record the subaccount they ran in and are refused when it is missing (fail closed).
-- BEFORE APPLYING to a shared database: nothing to migrate (new tables only); existing unlinked studios keep working until they are linked.
-- Rollback order: application first, then rollback/20261121090000_twilio_tw4f3a_subaccounts_rollback.sql (refuses once any entity, link, account,
-- confirmation, spend event or new audit row exists: that is evidence).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_submission_confirmations') is null
     or to_regprocedure('public.tw4_runner_begin_step(uuid,text,text,text,boolean,uuid,boolean)') is null then
    raise exception 'TW-4F-3a precondition failed: TW-4F-1b is not applied';
  end if;
  if to_regclass('public.studio_sms_legal_entities') is not null then
    raise exception 'TW-4F-3a precondition failed: already applied';
  end if;
end $$;

-- audit vocabulary
alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount'));

-- ---------------------------------------------------------------------------------------------------------------
-- legal entities and their locations
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4f3a_name_key(p_name text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select lower(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[^[:alnum:][:space:]]', '', 'g'), '\s+', ' ', 'g'))); $$;

create table public.studio_sms_legal_entities (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null check (char_length(legal_name) between 2 and 200),
  legal_name_key text generated always as (public._tw4f3a_name_key(legal_name)) stored,
  ein_last4 text not null check (ein_last4 ~ '^[0-9]{4}$'),
  spend_cap_cents int not null default 0 check (spend_cap_cents >= 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  -- a second entity with the same normalized name and EIN last four would be a duplicate registration: link the location instead
  constraint studio_sms_legal_entities_no_duplicate unique (legal_name_key, ein_last4)
);

create table public.studio_sms_location_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  claimed_legal_name text not null check (char_length(claimed_legal_name) between 2 and 200),
  claimed_ein_last4 text not null check (claimed_ein_last4 ~ '^[0-9]{4}$'),
  attested_by uuid not null,
  attestation_version text not null check (char_length(attestation_version) between 1 and 40),
  attested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid null,
  decided_at timestamptz null,
  decision_note text null check (decision_note is null or char_length(decision_note) <= 300),
  legal_entity_id uuid null references public.studio_sms_legal_entities(id),
  constraint studio_sms_location_requests_decided check ((status = 'pending') = (decided_by is null and decided_at is null))
);
create unique index studio_sms_location_requests_one_pending on public.studio_sms_location_requests (studio_id) where status = 'pending';

create table public.studio_sms_entity_studios (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  link_kind text not null check (link_kind in ('founding', 'additional')),
  linked_by uuid not null,
  linked_at timestamptz not null default now(),
  -- the verified association: what the platform admin checked (registry record, formation document, ...). Never an EIN.
  verification_note text not null check (char_length(btrim(verification_note)) between 10 and 300),
  supporting_checks jsonb not null default '{}'::jsonb,
  attested_by uuid null,
  request_id uuid null references public.studio_sms_location_requests(id),
  -- an additional location always rests on an owner attestation
  constraint studio_sms_entity_studios_additional_attested check (link_kind = 'founding' or (attested_by is not null and request_id is not null))
);
create index studio_sms_entity_studios_entity on public.studio_sms_entity_studios (legal_entity_id);

create table public.studio_sms_twilio_accounts (
  legal_entity_id uuid primary key references public.studio_sms_legal_entities(id),
  twilio_account_sid text null check (twilio_account_sid is null or twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  friendly_name text not null check (char_length(friendly_name) between 1 and 128),
  environment text not null check (char_length(environment) between 1 and 20),
  status text not null check (status in ('creating', 'unknown', 'failed', 'active', 'suspended', 'closed')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_sms_twilio_accounts_sid_known check (status not in ('active', 'suspended', 'closed') or twilio_account_sid is not null)
);
create unique index studio_sms_twilio_accounts_sid on public.studio_sms_twilio_accounts (twilio_account_sid) where twilio_account_sid is not null;

create table public.studio_sms_subaccount_confirmations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  confirmed_by uuid not null,
  confirmed_at timestamptz not null default now(),
  consumed_at timestamptz null
);
create index studio_sms_subaccount_confirmations_lookup on public.studio_sms_subaccount_confirmations (legal_entity_id, confirmed_at);

create table public.studio_sms_spend_events (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  kind text not null check (kind in ('brand', 'campaign_vetting', 'number', 'monthly')),
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'authorized' check (status in ('authorized', 'reserved', 'void')),
  approval_ref text not null check (char_length(btrim(approval_ref)) between 3 and 120),
  authorized_by uuid not null,
  authorized_at timestamptz not null default now(),
  reservation_key text null check (reservation_key is null or char_length(reservation_key) <= 120),
  reserved_at timestamptz null,
  constraint studio_sms_spend_events_reserved check ((status = 'reserved') = (reservation_key is not null and reserved_at is not null))
);
create unique index studio_sms_spend_events_reservation on public.studio_sms_spend_events (legal_entity_id, reservation_key) where reservation_key is not null;

revoke all on public.studio_sms_legal_entities, public.studio_sms_location_requests, public.studio_sms_entity_studios, public.studio_sms_twilio_accounts,
  public.studio_sms_subaccount_confirmations, public.studio_sms_spend_events from public, anon, authenticated, service_role;
alter table public.studio_sms_legal_entities enable row level security;
alter table public.studio_sms_location_requests enable row level security;
alter table public.studio_sms_entity_studios enable row level security;
alter table public.studio_sms_twilio_accounts enable row level security;
alter table public.studio_sms_subaccount_confirmations enable row level security;
alter table public.studio_sms_spend_events enable row level security;

-- the ledger remembers which subaccount each step ran in
alter table public.studio_sms_provisioning_steps add column twilio_account_sid text null
  check (twilio_account_sid is null or twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$');

create or replace function public._tw4f3a_steps_account_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_sid text;
begin
  if tg_op = 'UPDATE' then
    if new.twilio_account_sid is distinct from old.twilio_account_sid then
      raise exception 'studio_sms_provisioning_steps: the subaccount of a step is fixed' using errcode = '42501';
    end if;
    -- a row written BEFORE the studio was linked (parent-account era) is never continued inside a subaccount
    if old.twilio_account_sid is null and (new.status is distinct from old.status or new.provider_sid is distinct from old.provider_sid)
       and exists (select 1 from public.studio_sms_entity_studios es where es.studio_id = new.studio_id) then
      raise exception 'this step predates the studio''s Twilio subaccount and cannot be continued' using errcode = 'TW005';
    end if;
    return new;
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = new.studio_id;
  if v_entity is null then
    return new;  -- a studio that is not linked to a legal entity (legacy / local): the application refuses to run it
  end if;
  select a.twilio_account_sid into v_sid from public.studio_sms_twilio_accounts a where a.legal_entity_id = v_entity and a.status = 'active';
  if v_sid is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  if new.twilio_account_sid is not null and new.twilio_account_sid is distinct from v_sid then
    raise exception 'step account does not match the entity''s subaccount' using errcode = 'TW005';
  end if;
  new.twilio_account_sid := v_sid;
  return new;
end $$;
create trigger studio_sms_provisioning_steps_account_guard before insert or update on public.studio_sms_provisioning_steps
  for each row execute function public._tw4f3a_steps_account_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4f3a_audit(p_studio uuid, p_actor uuid, p_action text, p_note text)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio, null, case when p_actor is null then 'system' else 'platform_admin' end, p_actor, p_action, left(p_note, 300));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- the founding location: a platform admin creates the entity from the studio's own submitted onboarding
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_entity_create_for_studio(p_studio_id uuid, p_actor uuid, p_verification_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_id uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if exists (select 1 from public.studio_sms_entity_studios where studio_id = p_studio_id) then
    raise exception 'this studio already belongs to a legal entity' using errcode = '23505';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null or o.legal_name is null or o.ein_last4 is null or o.attested_at is null or o.state in ('draft', 'cancelled') then
    raise exception 'the studio has no submitted onboarding with a legal name and EIN' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps st where st.studio_id = p_studio_id) then
    raise exception 'the studio has registration steps from before subaccounts; start a fresh setup' using errcode = '22023';
  end if;
  begin
    insert into public.studio_sms_legal_entities (legal_name, ein_last4, created_by) values (o.legal_name, o.ein_last4, p_actor) returning id into v_id;
  exception when unique_violation then
    raise exception 'a legal entity with this name and EIN already exists: link this location to it instead of registering again' using errcode = '23505';
  end;
  insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, supporting_checks)
  values (p_studio_id, v_id, 'founding', p_actor, p_verification_note, jsonb_build_object('from_attested_onboarding', true));
  perform public._tw4f3a_audit(p_studio_id, p_actor, 'entity_created', 'entity=' || v_id);
  return jsonb_build_object('legal_entity_id', v_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- an additional location: the studio's OWNER attests that it belongs to the same legal business; a platform admin verifies and decides
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.sms_location_attest(p_studio_id uuid, p_claimed_legal_name text, p_claimed_ein_last4 text, p_attestation_version text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or public._sms_onb_studio_role(p_studio_id) is distinct from 'studio_owner' then
    raise exception 'only the studio owner can attest a location' using errcode = '42501';
  end if;
  if exists (select 1 from public.studio_sms_entity_studios where studio_id = p_studio_id) then
    raise exception 'this studio already belongs to a legal entity' using errcode = '23505';
  end if;
  insert into public.studio_sms_location_requests (studio_id, claimed_legal_name, claimed_ein_last4, attested_by, attestation_version)
  values (p_studio_id, btrim(p_claimed_legal_name), p_claimed_ein_last4, auth.uid(), p_attestation_version) returning id into v_id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'user', auth.uid(), 'location_attested', 'request=' || v_id);
  return jsonb_build_object('request_id', v_id);
end $$;

create or replace function public.tw4_entity_decide_link(p_request_id uuid, p_entity_id uuid, p_actor uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_location_requests;
  e public.studio_sms_legal_entities;
  o public.studio_sms_onboarding;
  v_name_ok boolean;
  v_ein_ok boolean;
  v_onb_ok boolean;
  v_owner_ok boolean;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into r from public.studio_sms_location_requests x where x.id = p_request_id for update;
  if r.id is null or r.status <> 'pending' then
    raise exception 'no pending request' using errcode = '22023';
  end if;
  if not p_approve then
    update public.studio_sms_location_requests set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = left(p_note, 300) where id = r.id;
    perform public._tw4f3a_audit(r.studio_id, p_actor, 'location_decided', 'request=' || r.id || ';decision=rejected');
    return jsonb_build_object('status', 'rejected');
  end if;
  if p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'record what was verified (at least 10 characters)' using errcode = '22023';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id;
  if e.id is null then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_entity_studios where studio_id = r.studio_id) then
    raise exception 'this studio already belongs to a legal entity' using errcode = '23505';
  end if;
  -- supporting checks (necessary, never sufficient): the owner's claim and the studio's own onboarding must agree with the entity
  -- the attester must STILL own the requesting studio AND already own a studio of this legal entity (an owner of an unrelated business cannot attach to it)
  v_owner_ok := exists (select 1 from public.user_studio_roles ur where ur.user_id = r.attested_by and ur.studio_id = r.studio_id and ur.role = 'studio_owner' and ur.active = true)
    and exists (select 1 from public.user_studio_roles ur join public.studio_sms_entity_studios es on es.studio_id = ur.studio_id
                where ur.user_id = r.attested_by and es.legal_entity_id = e.id and ur.role = 'studio_owner' and ur.active = true);
  if not v_owner_ok then
    raise exception 'the attesting owner does not own a studio of this legal entity' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps st where st.studio_id = r.studio_id) then
    raise exception 'the studio has registration steps from before subaccounts; start a fresh setup' using errcode = '22023';
  end if;
  v_name_ok := public._tw4f3a_name_key(r.claimed_legal_name) = e.legal_name_key;
  v_ein_ok := r.claimed_ein_last4 = e.ein_last4;
  select * into o from public.studio_sms_onboarding x where x.studio_id = r.studio_id and x.state <> 'cancelled' order by x.created_at desc limit 1;
  -- the studio's own onboarding must exist and agree (no onboarding is a failed check, not a pass)
  v_onb_ok := o.id is not null and o.legal_name is not null and o.ein_last4 is not null and public._tw4f3a_name_key(o.legal_name) = e.legal_name_key and o.ein_last4 = e.ein_last4;
  if not (v_name_ok and v_ein_ok and v_onb_ok) then
    raise exception 'the supporting checks do not agree with the entity (name %, EIN last four %, onboarding %)', v_name_ok, v_ein_ok, v_onb_ok using errcode = '22023';
  end if;
  insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, supporting_checks, attested_by, request_id)
  values (r.studio_id, e.id, 'additional', p_actor, btrim(p_note), jsonb_build_object('name_matches', v_name_ok, 'ein_last4_matches', v_ein_ok, 'onboarding_matches', v_onb_ok), r.attested_by, r.id);
  update public.studio_sms_location_requests set status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = left(p_note, 300), legal_entity_id = e.id where id = r.id;
  perform public._tw4f3a_audit(r.studio_id, p_actor, 'location_decided', 'request=' || r.id || ';decision=approved;entity=' || e.id);
  return jsonb_build_object('status', 'approved', 'legal_entity_id', e.id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- spend cap and authorizations
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4f3a_committed(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce(sum(amount_cents), 0) from public.studio_sms_spend_events where legal_entity_id = p_entity and status in ('authorized', 'reserved'); $$;

create or replace function public.tw4_entity_set_spend_cap(p_entity_id uuid, p_cents int, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  v_studio uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id for update;
  if e.id is null or p_cents is null or p_cents < 0 then
    raise exception 'invalid cap' using errcode = '22023';
  end if;
  if p_cents < public._tw4f3a_committed(e.id) then
    raise exception 'the cap cannot be below the amount already authorized or reserved' using errcode = '22023';
  end if;
  update public.studio_sms_legal_entities set spend_cap_cents = p_cents where id = e.id;
  select studio_id into v_studio from public.studio_sms_entity_studios where legal_entity_id = e.id order by linked_at limit 1;
  perform public._tw4f3a_audit(v_studio, p_actor, 'spend_cap_set', 'entity=' || e.id || ';cap_cents=' || p_cents);
  return jsonb_build_object('spend_cap_cents', p_cents);
end $$;

create or replace function public.tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  v_id uuid;
  v_studio uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id for update;
  if e.id is null or p_kind is null or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid authorization' using errcode = '22023';
  end if;
  if public._tw4f3a_committed(e.id) + p_amount_cents > e.spend_cap_cents then
    raise exception 'this authorization would exceed the spend cap' using errcode = 'TW004';
  end if;
  insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by)
  values (e.id, p_kind, p_amount_cents, p_approval_ref, p_actor) returning id into v_id;
  select studio_id into v_studio from public.studio_sms_entity_studios where legal_entity_id = e.id order by linked_at limit 1;
  perform public._tw4f3a_audit(v_studio, p_actor, 'spend_authorized', 'entity=' || e.id || ';kind=' || p_kind || ';cents=' || p_amount_cents);
  return jsonb_build_object('spend_event_id', v_id);
end $$;

-- the runner reserves the authorization for THIS fee step before it calls Twilio; the same step reserves the same event again (idempotent)
create or replace function public.tw4_spend_reserve(p_onboarding_id uuid, p_lease_owner text, p_kind text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_key text;
  s public.studio_sms_spend_events;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  if v_entity is null then
    raise exception 'the studio has no legal entity' using errcode = 'TW004';
  end if;
  perform 1 from public.studio_sms_legal_entities where id = v_entity for update;
  v_key := o.id || ':' || o.submission_seq || ':' || p_kind;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key = v_key;
  if s.id is null then
    select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.kind = p_kind and x.status = 'authorized' order by x.authorized_at limit 1 for update;
    if s.id is null then
      raise exception 'no authorized spend for % within the cap', p_kind using errcode = 'TW004';
    end if;
    update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_key, reserved_at = now() where id = s.id;
    perform public._tw4f3a_audit(o.studio_id, null, 'spend_reserved', 'entity=' || v_entity || ';kind=' || p_kind || ';cents=' || s.amount_cents);
  end if;
  return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- subaccount creation: its own run, own confirmation, ledgered like every irreversible-ish step
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_subaccount_confirm(p_entity_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  v_id uuid;
  v_studio uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id;
  if e.id is null then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  -- the budget decision comes first: no cap, no subaccount
  if e.spend_cap_cents <= 0 then
    raise exception 'set the spend cap for this legal entity before creating its Twilio subaccount' using errcode = 'TW004';
  end if;
  select studio_id into v_studio from public.studio_sms_entity_studios where legal_entity_id = e.id order by linked_at limit 1;
  if v_studio is null then
    raise exception 'the legal entity has no studio' using errcode = '22023';
  end if;
  insert into public.studio_sms_subaccount_confirmations (legal_entity_id, confirmed_by) values (e.id, p_actor) returning id into v_id;
  perform public._tw4f3a_audit(v_studio, p_actor, 'subaccount_confirmed', 'entity=' || e.id);
  return jsonb_build_object('confirmation_id', v_id);
end $$;

create or replace function public.tw4_subaccount_begin(p_entity_id uuid, p_actor uuid, p_friendly_name text, p_environment text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_twilio_accounts;
  c public.studio_sms_subaccount_confirmations;
  v_studio uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  perform 1 from public.studio_sms_legal_entities where id = p_entity_id for update;
  if not found then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_twilio_accounts x where x.legal_entity_id = p_entity_id;
  if a.legal_entity_id is not null and a.status in ('active', 'suspended', 'closed') then
    return jsonb_build_object('action', 'skip', 'account_sid', a.twilio_account_sid, 'status', a.status);
  end if;
  -- another creation is (probably) still running: do not start a second one, and do not burn a confirmation
  if a.legal_entity_id is not null and a.status = 'creating' and a.updated_at > now() - interval '10 minutes' then
    raise exception 'a subaccount creation for this legal entity is already in progress' using errcode = 'TW006';
  end if;
  -- creating (or reconciling an unknown attempt) needs a fresh, unconsumed confirmation; it is consumed here, in the same transaction
  select * into c from public.studio_sms_subaccount_confirmations x
    where x.legal_entity_id = p_entity_id and x.consumed_at is null and x.confirmed_at > now() - interval '15 minutes' and x.confirmed_by = p_actor
    order by x.confirmed_at desc limit 1 for update;
  if c.id is null then
    raise exception 'no fresh confirmation to create this subaccount' using errcode = 'TW003';
  end if;
  update public.studio_sms_subaccount_confirmations set consumed_at = now() where id = c.id;
  select studio_id into v_studio from public.studio_sms_entity_studios where legal_entity_id = p_entity_id order by linked_at limit 1;
  if a.legal_entity_id is null then
    insert into public.studio_sms_twilio_accounts (legal_entity_id, friendly_name, environment, status, created_by)
    values (p_entity_id, p_friendly_name, p_environment, 'creating', p_actor);
    perform public._tw4f3a_audit(v_studio, p_actor, 'runner_subaccount', 'entity=' || p_entity_id || ';status=creating');
    return jsonb_build_object('action', 'execute');
  end if;
  update public.studio_sms_twilio_accounts set status = 'creating', updated_at = now() where legal_entity_id = p_entity_id;
  perform public._tw4f3a_audit(v_studio, p_actor, 'runner_subaccount', 'entity=' || p_entity_id || ';status=creating;was=' || a.status);
  return jsonb_build_object('action', case when a.status in ('creating', 'unknown') then 'reconcile' else 'execute' end);
end $$;

create or replace function public.tw4_subaccount_finish(p_entity_id uuid, p_actor uuid, p_status text, p_account_sid text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_twilio_accounts;
  v_studio uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into a from public.studio_sms_twilio_accounts x where x.legal_entity_id = p_entity_id for update;
  if a.legal_entity_id is null or a.status <> 'creating' then
    raise exception 'no subaccount creation in progress' using errcode = '22023';
  end if;
  if p_status not in ('active', 'failed', 'unknown') or (p_status = 'active' and (p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$')) then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  update public.studio_sms_twilio_accounts
     set status = p_status, twilio_account_sid = case when p_status = 'active' then p_account_sid else twilio_account_sid end, updated_at = now()
   where legal_entity_id = p_entity_id;
  select studio_id into v_studio from public.studio_sms_entity_studios where legal_entity_id = p_entity_id order by linked_at limit 1;
  perform public._tw4f3a_audit(v_studio, p_actor, 'runner_subaccount', 'entity=' || p_entity_id || ';status=' || p_status);
  return jsonb_build_object('status', p_status);
end $$;

-- the account a run may use: the subaccount of the onboarding's legal entity (all nulls = not linked / no subaccount)
create or replace function public.tw4_runner_account(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  a public.studio_sms_twilio_accounts;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  if v_entity is not null then
    select * into a from public.studio_sms_twilio_accounts x where x.legal_entity_id = v_entity;
  end if;
  return jsonb_build_object('legal_entity_id', v_entity, 'account_sid', case when a.status = 'active' then a.twilio_account_sid end, 'status', a.status);
end $$;

-- the platform-side view for provisioning (no onboarding lease needed: the subaccount is created BEFORE any registration run)
create or replace function public.tw4_entity_for_studio(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  e public.studio_sms_legal_entities;
  a public.studio_sms_twilio_accounts;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('legal_entity_id', null);
  end if;
  select * into e from public.studio_sms_legal_entities where id = v_entity;
  select * into a from public.studio_sms_twilio_accounts where legal_entity_id = v_entity;
  return jsonb_build_object('legal_entity_id', v_entity, 'spend_cap_cents', e.spend_cap_cents, 'committed_cents', public._tw4f3a_committed(v_entity),
    'account_status', a.status, 'account_sid', a.twilio_account_sid);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- evidence is not edited or deleted
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4f3a_evidence_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- cascade from a deleted studio only
    if tg_table_name = 'studio_sms_entity_studios' or tg_table_name = 'studio_sms_location_requests' then
      if not exists (select 1 from public.studios s where s.id = old.studio_id) then return old; end if;
    end if;
    raise exception '% rows are not deleted', tg_table_name using errcode = '42501';
  end if;
  -- (nested on purpose: PL/pgSQL may resolve every field of a boolean expression, and NEW only has the fields of its own table)
  if tg_table_name = 'studio_sms_subaccount_confirmations' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.confirmed_by is distinct from old.confirmed_by
       or new.confirmed_at is distinct from old.confirmed_at or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at) then
      raise exception 'a subaccount confirmation can only be consumed, once' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_entity_studios' then
    raise exception 'a location link is not edited' using errcode = '42501';
  elsif tg_table_name = 'studio_sms_twilio_accounts' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.created_by is distinct from old.created_by
       or (old.twilio_account_sid is not null and new.twilio_account_sid is distinct from old.twilio_account_sid) then
      raise exception 'the subaccount sid is final' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_spend_events' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.kind is distinct from old.kind
       or new.amount_cents is distinct from old.amount_cents or new.approval_ref is distinct from old.approval_ref or new.authorized_by is distinct from old.authorized_by
       or (old.status = 'reserved' and (new.status is distinct from old.status or new.reservation_key is distinct from old.reservation_key or new.reserved_at is distinct from old.reserved_at)) then
      raise exception 'a spend authorization cannot be edited; a reserved one is final' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_subaccount_confirmations_guard before update or delete on public.studio_sms_subaccount_confirmations for each row execute function public._tw4f3a_evidence_guard();
create trigger studio_sms_entity_studios_guard before update or delete on public.studio_sms_entity_studios for each row execute function public._tw4f3a_evidence_guard();
create trigger studio_sms_twilio_accounts_guard before update or delete on public.studio_sms_twilio_accounts for each row execute function public._tw4f3a_evidence_guard();
create trigger studio_sms_spend_events_guard before update or delete on public.studio_sms_spend_events for each row execute function public._tw4f3a_evidence_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- grants: service role only (the owner attestation is the one authenticated entry point and checks the owner role itself)
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4f3a_name_key(text), public._tw4f3a_steps_account_guard(), public._tw4f3a_audit(uuid, uuid, text, text), public._tw4f3a_committed(uuid), public._tw4f3a_evidence_guard() from public, anon, authenticated;
revoke all on function public.tw4_entity_create_for_studio(uuid, uuid, text), public.tw4_entity_decide_link(uuid, uuid, uuid, boolean, text),
  public.tw4_entity_set_spend_cap(uuid, int, uuid), public.tw4_spend_authorize(uuid, text, int, text, uuid), public.tw4_spend_reserve(uuid, text, text),
  public.tw4_subaccount_confirm(uuid, uuid), public.tw4_subaccount_begin(uuid, uuid, text, text), public.tw4_subaccount_finish(uuid, uuid, text, text),
  public.tw4_runner_account(uuid, text), public.tw4_entity_for_studio(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tw4_entity_create_for_studio(uuid, uuid, text), public.tw4_entity_decide_link(uuid, uuid, uuid, boolean, text),
  public.tw4_entity_set_spend_cap(uuid, int, uuid), public.tw4_spend_authorize(uuid, text, int, text, uuid), public.tw4_spend_reserve(uuid, text, text),
  public.tw4_subaccount_confirm(uuid, uuid), public.tw4_subaccount_begin(uuid, uuid, text, text), public.tw4_subaccount_finish(uuid, uuid, text, text),
  public.tw4_runner_account(uuid, text), public.tw4_entity_for_studio(uuid, uuid) to service_role;
revoke all on function public.sms_location_attest(uuid, text, text, text) from public, anon;
grant execute on function public.sms_location_attest(uuid, text, text, text) to authenticated;

commit;
