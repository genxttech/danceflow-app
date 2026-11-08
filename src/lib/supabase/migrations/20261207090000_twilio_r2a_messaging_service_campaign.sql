-- 20261207090000_twilio_r2a_messaging_service_campaign.sql
-- TW-4F R2a: provisioning ledger for the studio's Twilio Messaging Service and A2P campaign (design docs/twilio/TW-4F_R2_Provisioning_Design.md).
--   * studio_sms_prov_operations: one row per provider operation ATTEMPT, stamped with the legal business's ACTIVE subaccount. Unknown outcomes are
--     recorded as such and reconciled against the provider before anything is repeated; a fee operation is never repeated without a human.
--   * studio_sms_prov_resources: what the PROVIDER reports about the resource (read back, judged here). Approval exists only as a provider-evidence verdict.
--   * Fee gate (campaign): a written owner approval of campaign_vetting (permanent reference, location-attributed), reserved atomically with the first
--     month's fee: the pilot business needs a SECOND explicit approval of the path's monthly kind inside the same cumulative ceiling; every other business
--     needs an ACTIVE recurring authorization (its first month is already set aside). No authorization, no price, no funds, an unverified path: nothing is reserved
--     and nothing is begun.
--   * Nothing here calls Twilio, sends SMS, buys a number or publishes a price. Number purchase and the sender registry hand-off are R2b.
-- Requires 20261204090000 (sender readiness). Independent of 20261205 / 20261206 (only new objects; the audit vocabulary is extended from the live list).
-- Rollback: rollback/20261207090000_twilio_r2a_messaging_service_campaign_rollback.sql (refuses once any operation, resource or provisioning audit row exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_sender_verifications') is null or to_regprocedure('public._tw4sr_fake_allowed()') is null
     or to_regprocedure('public.tw4_runner_fee_kinds(uuid,text)') is null or to_regprocedure('public._tw4c_post(uuid,uuid,text,bigint,bigint,text,uuid,text,uuid,text)') is null then
    raise exception 'R2a precondition failed: 20261204090000 (sender readiness) and its predecessors are not applied';
  end if;
  if to_regclass('public.studio_sms_prov_operations') is not null then
    raise exception 'R2a precondition failed: already applied';
  end if;
  -- the resolver replaced below must still be the 20261201 version (another slice must not be clobbered silently)
  if position('resolved only through tw4_usage_resolve' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_credit_resolve_reservation(uuid,text,uuid,text)'::regprocedure)) = 0 then
    raise exception 'R2a precondition failed: tw4_credit_resolve_reservation differs from 20261201090000';
  end if;
end $$;

-- audit vocabulary: the live list plus the provisioning actions (extended, not replaced)
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
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['prov_started', 'prov_finished', 'prov_observed', 'prov_resolved']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges; everything goes through the functions below)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_prov_operations (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  studio_id uuid not null,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  op_kind text not null check (op_kind in ('messaging_service', 'campaign')),
  attempt int not null check (attempt >= 1),
  submission_seq int not null check (submission_seq >= 0),
  status text not null default 'in_flight' check (status in ('in_flight', 'succeeded', 'failed', 'unknown_outcome', 'abandoned')),
  friendly_name text not null check (char_length(friendly_name) between 3 and 128),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 4096),
  provider_sid text null,
  fee_bearing boolean not null default false,
  fee_kinds text[] not null default '{}',
  started_by uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz null,
  superseded_at timestamptz null,
  error_code text null check (error_code is null or char_length(error_code) <= 64),
  error_detail_sanitized text null check (error_detail_sanitized is null or char_length(error_detail_sanitized) <= 500),
  resolved_by uuid null,
  resolved_at timestamptz null,
  resolution_note text null check (resolution_note is null or char_length(resolution_note) between 10 and 500),
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_prov_operations_onboarding_fk foreign key (onboarding_id, studio_id) references public.studio_sms_onboarding (id, studio_id) on delete restrict,
  constraint studio_sms_prov_operations_attempt unique (onboarding_id, op_kind, attempt),
  constraint studio_sms_prov_operations_sid_shape check (provider_sid is null
    or (op_kind = 'messaging_service' and provider_sid ~ '^MG[0-9a-fA-F]{32}$') or (op_kind = 'campaign' and provider_sid ~ '^QE[0-9a-fA-F]{32}$')),
  constraint studio_sms_prov_operations_succeeded_sid check (status <> 'succeeded' or provider_sid is not null),
  constraint studio_sms_prov_operations_fee_shape check ((fee_bearing and cardinality(fee_kinds) > 0) or (not fee_bearing and cardinality(fee_kinds) = 0)),
  constraint studio_sms_prov_operations_resolution check ((resolved_by is null) = (resolved_at is null) and (resolved_by is null or resolution_note is not null))
);
-- one LIVE operation per studio and kind (open or succeeded, not superseded): a duplicate create can never be recorded
create unique index studio_sms_prov_operations_one_live on public.studio_sms_prov_operations (studio_id, op_kind)
  where status in ('in_flight', 'unknown_outcome', 'succeeded') and superseded_at is null;
-- a provider resource is adopted by one operation only
create unique index studio_sms_prov_operations_sid_once on public.studio_sms_prov_operations (provider_sid) where provider_sid is not null and status = 'succeeded';
create index studio_sms_prov_operations_entity on public.studio_sms_prov_operations (legal_entity_id, op_kind);

create table public.studio_sms_prov_resources (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references public.studio_sms_prov_operations(id) on delete restrict,
  legal_entity_id uuid not null,
  studio_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  resource_kind text not null check (resource_kind in ('messaging_service', 'campaign')),
  provider_sid text not null,
  parent_sid text null,
  brand_sid text null,
  use_case text null check (use_case is null or use_case in ('MIXED', 'LOW_VOLUME')),
  status text not null check (status in ('pending', 'ready', 'verified', 'failed', 'mismatch')),
  mismatch_code text null check (mismatch_code is null or char_length(mismatch_code) <= 60),
  provider_status text null check (provider_status is null or char_length(provider_status) <= 40),
  failure_reasons text null check (failure_reasons is null or char_length(failure_reasons) <= 500),
  source text not null check (source in ('provider_read', 'fake')),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default clock_timestamp(),
  verified_at timestamptz null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index studio_sms_prov_resources_sid on public.studio_sms_prov_resources (provider_sid);

revoke all on public.studio_sms_prov_operations, public.studio_sms_prov_resources from public, anon, authenticated, service_role;
alter table public.studio_sms_prov_operations enable row level security;
alter table public.studio_sms_prov_resources enable row level security;

-- history is never deleted; identity never changes
create or replace function public._tw4prov_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%: provisioning evidence is never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_prov_operations' then
    if new.id is distinct from old.id or new.onboarding_id is distinct from old.onboarding_id or new.studio_id is distinct from old.studio_id
       or new.legal_entity_id is distinct from old.legal_entity_id or new.twilio_account_sid is distinct from old.twilio_account_sid
       or new.op_kind is distinct from old.op_kind or new.attempt is distinct from old.attempt or new.submission_seq is distinct from old.submission_seq
       or new.friendly_name is distinct from old.friendly_name or new.request_digest is distinct from old.request_digest or new.params is distinct from old.params
       or new.fee_bearing is distinct from old.fee_bearing or new.fee_kinds is distinct from old.fee_kinds or new.started_by is distinct from old.started_by
       or new.started_at is distinct from old.started_at or new.created_at is distinct from old.created_at then
      raise exception 'studio_sms_prov_operations: the identity of an operation is fixed' using errcode = '42501';
    end if;
    if old.provider_sid is not null and new.provider_sid is distinct from old.provider_sid then
      raise exception 'studio_sms_prov_operations: a provider sid never changes' using errcode = '42501';
    end if;
    if old.status in ('succeeded', 'failed', 'abandoned') and new.status is distinct from old.status
       and not (old.status = 'succeeded' and new.status = 'succeeded') then
      raise exception 'studio_sms_prov_operations: a closed operation is final' using errcode = '42501';
    end if;
  else
    if new.id is distinct from old.id or new.operation_id is distinct from old.operation_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.twilio_account_sid is distinct from old.twilio_account_sid
       or new.resource_kind is distinct from old.resource_kind or new.provider_sid is distinct from old.provider_sid or new.created_at is distinct from old.created_at then
      raise exception 'studio_sms_prov_resources: the identity of a resource is fixed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_prov_operations_guard before update or delete on public.studio_sms_prov_operations for each row execute function public._tw4prov_guard();
create trigger studio_sms_prov_resources_guard before update or delete on public.studio_sms_prov_resources for each row execute function public._tw4prov_guard();
create trigger studio_sms_prov_operations_truncate before truncate on public.studio_sms_prov_operations for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_prov_resources_truncate before truncate on public.studio_sms_prov_resources for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------
-- the campaign use case a registration path takes (the application derives the same mapping; the database is the authority)
create or replace function public._tw4prov_use_case(p_path text)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select case p_path when 'standard' then 'MIXED' when 'low_volume_standard' then 'LOW_VOLUME' end; $$;

-- the brand this studio registered, only when Twilio approved it and it is not a mock (a mock brand never approves anything)
create or replace function public._tw4prov_brand(p_studio_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select r.brand_sid from public.studio_sms_registrations r
   where r.studio_id = p_studio_id and r.brand_status = 'approved' and r.brand_sid is not null
     and exists (select 1 from public.studio_sms_provisioning_steps s where s.studio_id = p_studio_id and s.step_key = 'B1' and s.status = 'succeeded' and s.provider_sid = r.brand_sid and not s.mock
                     and s.twilio_account_sid = (select a.twilio_account_sid from public.studio_sms_entity_studios es join public.studio_sms_twilio_accounts a on a.legal_entity_id = es.legal_entity_id and a.status = 'active' where es.studio_id = p_studio_id));
$$;


-- ---------------------------------------------------------------------------------------------------------------
-- fee reservation PER OPERATION. tw4_spend_reserve / tw4_spend_settle key a reservation by (onboarding, generation, kind): right for the single paid brand,
-- but a second campaign attempt would silently REPLAY the first (captured) reservation and spend nothing from a new approval. These copies of the same
-- logic (20261202090000 bodies) key a reservation by the OPERATION, so every attempt consumes its own explicit, never-reused approval. Callers hold the
-- onboarding lease and the legal business row.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4prov_reserve(p_o public.studio_sms_onboarding, p_kind text, p_op uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  s public.studio_sms_spend_events;
  pe public.studio_sms_pilot_exceptions;
  v_entity uuid;
  v_key text := 'prov:' || p_op::text || ':' || p_kind;
  v_res uuid;
  v_pilot_used bigint;
begin
  if p_kind not in ('campaign_vetting', 'monthly', 'monthly_low_volume') then
    raise exception 'unknown fee kind' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_o.studio_id;
  if v_entity is null then
    raise exception 'the studio has no legal entity' using errcode = 'TW004';
  end if;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.kind = p_kind and x.status = 'authorized' and (x.studio_id is null or x.studio_id = p_o.studio_id)
   order by (x.studio_id is null), x.authorized_at limit 1 for update;
  if s.id is null then
    raise exception 'no authorized spend for % within the cap', p_kind using errcode = 'TW004';
  end if;
  a := public._tw4c_lock(v_entity);
  if s.funding = 'credit' then
    perform public._tw4c_require_funds(a, s.amount_cents);
  else
    select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity;
    if pe.legal_entity_id is null or a.hold or a.balance_cents < 0 then
      raise exception 'the pilot exception cannot fund this operation' using errcode = 'TW007';
    end if;
    select coalesce(sum(r.amount_cents), 0) into v_pilot_used from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured');
    if v_pilot_used + s.amount_cents > pe.ceiling_cents then
      raise exception 'the pilot ceiling would be exceeded' using errcode = 'TW007';
    end if;
  end if;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key) values (v_entity, p_o.studio_id, p_kind, s.amount_cents, s.funding, v_key) returning id into v_res;
  if s.funding = 'credit' then
    perform public._tw4c_post(v_entity, p_o.studio_id, 'reserve', 0, s.amount_cents, 'reserve:' || v_key, v_res, 'spend_event=' || s.id, null, null);
  end if;
  update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_key, reserved_at = now(), credit_reservation_id = v_res where id = s.id;
  perform public._tw4f3a_audit(p_o.studio_id, null, 'spend_reserved', 'entity=' || v_entity || ';kind=' || p_kind || ';cents=' || s.amount_cents || ';funding=' || s.funding || ';op=' || p_op);
  return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', v_res, 'funding', s.funding);
end $$;

create or replace function public._tw4prov_settle(p_op uuid, p_kind text, p_outcome text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_spend_events;
  r public.studio_sms_credit_reservations;
  v_key text := 'prov:' || p_op::text || ':' || p_kind;
begin
  if p_outcome not in ('captured', 'released') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  select * into s from public.studio_sms_spend_events x where x.reservation_key = v_key;
  if s.id is null or s.credit_reservation_id is null then
    raise exception 'no reservation for this operation' using errcode = 'TW004';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id;
  perform public._tw4c_lock(r.legal_entity_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id for update;
  if r.status = 'captured' and p_outcome = 'captured' then
    return jsonb_build_object('status', 'captured', 'replayed', true);
  end if;
  if r.status = 'released' and p_outcome = 'released' then
    return jsonb_build_object('status', 'released', 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, p_ref, null, null);
    end if;
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
    perform public._tw4f3a_audit(r.studio_id, null, 'credit_captured', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  else
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, p_ref, null, null);
    end if;
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    perform set_config('tw4.credit_settle', 'on', true);
    update public.studio_sms_spend_events set status = 'void' where id = s.id;
    perform set_config('tw4.credit_settle', 'off', true);
    perform public._tw4f3a_audit(r.studio_id, null, 'credit_released', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  end if;
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

-- what the campaign needs before it may start, read-only (the reservation in tw4_prov_begin is the authority and re-checks everything under its locks)
-- blocker: null | tier_ineligible | unpriced | awaiting_authorization | awaiting_recurring | awaiting_funding | on_hold | pilot_ceiling | pilot_recurring
create or replace function public._tw4prov_campaign_requirements(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_fees jsonb := public.tw4_location_fee_kinds(p_studio_id);
  v_path text := v_fees ->> 'path';
  v_entity uuid;
  v_pilot public.studio_sms_pilot_exceptions;
  a public.studio_sms_credit_accounts;
  v_monthly text := v_fees ->> 'campaign_monthly_kind';
  v_vet_price int := (select p.customer_price_cents from public.studio_sms_price_list p where p.active and p.kind = 'campaign_vetting');
  v_monthly_price int := nullif(v_fees ->> 'campaign_monthly_price_cents', '')::int;
  v_components jsonb := '[]'::jsonb;
  v_blocker text := null;
  v_pilot_used bigint;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_path not in ('standard', 'low_volume_standard') or v_monthly is null then
    return jsonb_build_object('path', v_path, 'use_case', null, 'pilot', false, 'blocker', 'tier_ineligible', 'components', v_components);
  end if;
  select * into v_pilot from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity;
  if v_vet_price is null or v_monthly_price is null then
    v_blocker := 'unpriced';
  end if;
  v_components := jsonb_build_array(
    jsonb_build_object('kind', 'campaign_vetting', 'price_cents', v_vet_price, 'source', 'spend',
      'authorized', exists (select 1 from public.studio_sms_spend_events s where s.legal_entity_id = v_entity and s.kind = 'campaign_vetting'
                             and s.status = 'authorized' and (s.studio_id is null or s.studio_id = p_studio_id))),
    jsonb_build_object('kind', v_monthly, 'price_cents', v_monthly_price, 'source', case when v_pilot.legal_entity_id is not null then 'spend' else 'recurring' end,
      'authorized', case when v_pilot.legal_entity_id is not null
        then exists (select 1 from public.studio_sms_spend_events s where s.legal_entity_id = v_entity and s.kind = v_monthly
                      and s.status = 'authorized' and (s.studio_id is null or s.studio_id = p_studio_id))
        else exists (select 1 from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.studio_id = p_studio_id
                      and r.kind = v_monthly and r.status = 'active' and r.expires_at > now() + interval '28 days' and r.price_cents = v_monthly_price) end));
  -- the pilot business never has a standing authorization: one created before the exception would charge the same month from credit
  if v_blocker is null and v_pilot.legal_entity_id is not null
     and exists (select 1 from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.status = 'active') then v_blocker := 'pilot_recurring'; end if;
  if v_blocker is null and not coalesce((v_components -> 0 ->> 'authorized')::boolean, false) then v_blocker := 'awaiting_authorization'; end if;
  if v_blocker is null and not coalesce((v_components -> 1 ->> 'authorized')::boolean, false) then
    v_blocker := case when v_pilot.legal_entity_id is not null then 'awaiting_authorization' else 'awaiting_recurring' end;
  end if;
  if v_blocker is null then
    select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
    if v_pilot.legal_entity_id is null then
      if a.legal_entity_id is null or a.hold then v_blocker := case when a.hold then 'on_hold' else 'awaiting_funding' end;
      elsif a.balance_cents < 0 or (a.balance_cents - a.reserved_cents) < v_vet_price then v_blocker := 'awaiting_funding'; end if;
    else
      select coalesce(sum(r.amount_cents), 0) into v_pilot_used from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured');
      if a.legal_entity_id is not null and (a.hold or a.balance_cents < 0) then v_blocker := 'on_hold';
      elsif v_pilot_used + v_vet_price + v_monthly_price > v_pilot.ceiling_cents then v_blocker := 'pilot_ceiling'; end if;
    end if;
  end if;
  return jsonb_build_object('path', v_path, 'use_case', public._tw4prov_use_case(v_path), 'pilot', v_pilot.legal_entity_id is not null, 'blocker', v_blocker, 'components', v_components,
                            'total_cents', coalesce(v_vet_price, 0) + case when v_pilot.legal_entity_id is not null then coalesce(v_monthly_price, 0) else 0 end);
end $$;

-- the generic admin resolution never settles a provisioning reservation behind the ledger's back (20261201 body + the prov: refusal)
create or replace function public.tw4_credit_resolve_reservation(p_reservation_id uuid, p_outcome text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_credit_reservations;
  s public.studio_sms_spend_events;
begin
  perform public._tw4c_admin(p_actor);
  if p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'an outcome and a written reason (10+ characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id;
  if r.id is null then
    raise exception 'unknown reservation' using errcode = '22023';
  end if;
  perform public._tw4c_lock(r.legal_entity_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id for update;
  if r.reservation_key like 'commit:%' then
    raise exception 'a recurring set-aside is captured only by its charge and released by revoking the authorization' using errcode = '22023';
  end if;
  if r.reservation_key like 'prov:%' then
    raise exception 'a provisioning reservation is resolved only through tw4_prov_resolve' using errcode = '22023';
  end if;
  if r.reservation_key like 'sms:%' then
    raise exception 'a text''s reservation is resolved only through tw4_usage_resolve' using errcode = '22023';
  end if;
  if (r.status = 'captured' and p_outcome = 'captured') or (r.status = 'released' and p_outcome = 'released') then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
  else
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    end if;
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    select * into s from public.studio_sms_spend_events x where x.credit_reservation_id = r.id;
    if s.id is not null then
      perform set_config('tw4.credit_settle', 'on', true);
      update public.studio_sms_spend_events set status = 'void' where id = s.id;
      perform set_config('tw4.credit_settle', 'off', true);
    end if;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (r.studio_id, null, 'platform_admin', p_actor, case when p_outcome = 'captured' then 'credit_captured' else 'credit_released' end, left('reservation=' || r.id || ';admin', 300));
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- claim (the SAME onboarding lease as the brand runner: the two runners exclude each other)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer default 300, p_mode text default 'run')
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
  if p_mode = 'run' and not exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = p_studio_id and w.expires_at > now()) then
    raise exception 'the runner window for this studio is closed' using errcode = 'TW001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'there is no onboarding to run' using errcode = '22023';
  end if;
  if o.state not in ('service_setup', 'campaign_pending') then
    raise exception 'onboarding state % is not provisionable', o.state using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() and o.lease_owner <> p_lease_owner then
    raise exception 'another run holds the lease' using errcode = '55P03';
  end if;
  update public.studio_sms_onboarding set lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'runner_lease', o.state, o.state, 'claimed provisioning ' || p_mode);
  return jsonb_build_object('onboarding_id', o.id, 'studio_id', o.studio_id, 'state', o.state, 'submission_seq', o.submission_seq);
end $$;

-- everything the provisioning runner needs besides the account and the fee kinds (which have their own functions)
create or replace function public.tw4_prov_context(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  return jsonb_build_object(
    'state', o.state, 'submission_seq', o.submission_seq, 'studio_id', o.studio_id, 'legal_entity_id', v_entity,
    'brand_sid', public._tw4prov_brand(o.studio_id),
    'requirements', public._tw4prov_campaign_requirements(o.studio_id),
    'operations', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.op_kind, 'attempt', p.attempt, 'status', p.status, 'provider_sid', p.provider_sid,
        'fee_bearing', p.fee_bearing, 'age_seconds', floor(extract(epoch from (clock_timestamp() - p.started_at)))::int, 'superseded', p.superseded_at is not null,
        'resource_status', r.status, 'resource_brand', r.brand_sid, 'resource_parent', r.parent_sid) order by p.op_kind, p.attempt)
      from public.studio_sms_prov_operations p left join public.studio_sms_prov_resources r on r.operation_id = p.id where p.studio_id = o.studio_id), '[]'::jsonb),
    'entity_live_elsewhere', coalesce((select jsonb_agg(distinct p.op_kind) from public.studio_sms_prov_operations p
        where p.legal_entity_id = v_entity and p.studio_id <> o.studio_id and p.status in ('in_flight', 'unknown_outcome', 'succeeded') and p.superseded_at is null), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- begin: gate, reserve (campaign) and record the attempt, atomically
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_begin(p_onboarding_id uuid, p_lease_owner text, p_op_kind text, p_friendly_name text, p_request_digest text,
                                                 p_params jsonb, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_live public.studio_sms_prov_operations;
  v_prev public.studio_sms_prov_operations;
  v_ms public.studio_sms_prov_operations;
  v_ms_res public.studio_sms_prov_resources;
  v_req jsonb;
  v_brand text;
  v_kinds text[] := '{}';
  v_attempt int;
  v_id uuid := gen_random_uuid();
  v_use_case text;
  v_kind text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'a platform admin must start a provisioning step' using errcode = '42501';
  end if;
  if p_op_kind is null or p_op_kind not in ('messaging_service', 'campaign') or p_friendly_name is null or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
     or p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid provisioning step' using errcode = '22023';
  end if;
  if o.state not in ('service_setup', 'campaign_pending') then
    raise exception 'onboarding state % cannot take this step', o.state using errcode = 'TW030';
  end if;
  -- the kill switch is a database guarantee for every step, whatever mode the lease was claimed in
  if not exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = o.studio_id and w.expires_at > now()) then
    raise exception 'the runner window for this studio is closed' using errcode = 'TW001';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  select a.twilio_account_sid into v_account from public.studio_sms_twilio_accounts a where a.legal_entity_id = v_entity and a.status = 'active';
  if v_entity is null or v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  -- the entity row first (the order the spend functions use), so concurrent provisioning of two locations of one business serializes
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for no key update;
  update public.studio_sms_onboarding set lease_expires_at = greatest(lease_expires_at, now() + interval '5 minutes') where id = o.id;

  select * into v_live from public.studio_sms_prov_operations x
   where x.studio_id = o.studio_id and x.op_kind = p_op_kind and x.status in ('in_flight', 'unknown_outcome', 'succeeded') and x.superseded_at is null for update;
  -- a campaign the PROVIDER reported failed is not live: it can be replaced (with a fresh fee authorization)
  if v_live.id is not null and p_op_kind = 'campaign' and v_live.status = 'succeeded'
     and exists (select 1 from public.studio_sms_prov_resources rr where rr.operation_id = v_live.id and rr.status = 'failed') then
    v_live := null;
  end if;
  if v_live.id is not null then
    if v_live.status = 'succeeded' then
      return jsonb_build_object('action', 'skip', 'operation_id', v_live.id, 'provider_sid', v_live.provider_sid, 'status', v_live.status);
    end if;
    return jsonb_build_object('action', 'reconcile', 'operation_id', v_live.id, 'provider_sid', v_live.provider_sid, 'status', v_live.status,
                              'fee_bearing', v_live.fee_bearing, 'age_seconds', floor(extract(epoch from (clock_timestamp() - v_live.started_at)))::int);
  end if;
  -- a NEW Messaging Service is made only while the onboarding is still setting up the service
  if p_op_kind = 'messaging_service' and o.state <> 'service_setup' then
    raise exception 'onboarding state % cannot take this step', o.state using errcode = 'TW030';
  end if;
  -- another location of the SAME legal business already has this resource: sharing is a human decision (no duplicate fee, no silent reuse)
  if exists (select 1 from public.studio_sms_prov_operations x where x.legal_entity_id = v_entity and x.studio_id <> o.studio_id and x.op_kind = p_op_kind
               and x.status in ('in_flight', 'unknown_outcome', 'succeeded') and x.superseded_at is null) then
    raise exception 'another location of this legal business already has a %', p_op_kind using errcode = 'TW031';
  end if;

  if p_op_kind = 'campaign' then
    v_brand := public._tw4prov_brand(o.studio_id);
    if v_brand is null then
      raise exception 'the studio''s own brand is not approved' using errcode = 'TW032';
    end if;
    select * into v_ms from public.studio_sms_prov_operations x where x.studio_id = o.studio_id and x.op_kind = 'messaging_service' and x.status = 'succeeded' and x.superseded_at is null;
    select * into v_ms_res from public.studio_sms_prov_resources r where r.operation_id = v_ms.id;
    if v_ms.id is null or v_ms_res.id is null or v_ms_res.status <> 'ready' or v_ms_res.twilio_account_sid <> v_account then
      raise exception 'the Messaging Service is not verified ready' using errcode = 'TW032';
    end if;
    if (p_params ->> 'messaging_service_sid') is distinct from v_ms.provider_sid or (p_params ->> 'brand_sid') is distinct from v_brand then
      raise exception 'the request does not name this studio''s Messaging Service and brand' using errcode = 'TW032';
    end if;
    -- a previous campaign is replaced only when the PROVIDER reported it failed (its fee is spent; the next attempt needs a fresh authorization)
    select * into v_prev from public.studio_sms_prov_operations x where x.studio_id = o.studio_id and x.op_kind = 'campaign' and x.superseded_at is null order by x.attempt desc limit 1;
    v_req := public._tw4prov_campaign_requirements(o.studio_id);
    case v_req ->> 'blocker'
      when 'tier_ineligible' then raise exception 'the location is not on a verified registration path' using errcode = 'TW020';
      when 'unpriced' then raise exception 'a campaign fee has no published price' using errcode = 'TW008';
      when 'awaiting_authorization' then raise exception 'no owner-approved campaign fee' using errcode = 'TW004';
      when 'pilot_recurring' then raise exception 'the pilot business cannot have a standing recurring authorization' using errcode = 'TW011';
      when 'awaiting_recurring' then raise exception 'no active recurring authorization for the campaign monthly fee' using errcode = 'TW033';
      when 'awaiting_funding', 'on_hold', 'pilot_ceiling' then raise exception 'the campaign fee cannot be funded' using errcode = 'TW007';
      else null;
    end case;
    v_use_case := v_req ->> 'use_case';
    if (p_params ->> 'use_case') is distinct from v_use_case then
      raise exception 'the campaign use case does not match the location''s registration path' using errcode = 'TW020';
    end if;
    -- reserve every fee component in THIS transaction: all or none (an authorization is consumed only together with its sibling)
    v_kinds := array['campaign_vetting'];
    if (v_req ->> 'pilot')::boolean then
      v_kinds := v_kinds || ((v_req -> 'components' -> 1 ->> 'kind'));
    end if;
    foreach v_kind in array v_kinds loop
      perform public._tw4prov_reserve(o, v_kind, v_id);
    end loop;
    if not (v_req ->> 'pilot')::boolean then
      -- taken AFTER the credit account lock (the order tw4_recurring_revoke uses: account, then authorization), so begin and a revocation cannot deadlock;
      -- a revocation cannot slip in between the check and the attempt
      perform 1 from public.studio_sms_recurring_authorizations ra where ra.legal_entity_id = v_entity and ra.studio_id = o.studio_id and ra.kind = (v_req -> 'components' -> 1 ->> 'kind') and ra.status = 'active' for share;
      if not found then
        raise exception 'no active recurring authorization for the campaign monthly fee' using errcode = 'TW033';
      end if;
    end if;
    if v_prev.id is not null then
      update public.studio_sms_prov_operations set superseded_at = clock_timestamp() where id = v_prev.id and superseded_at is null;
    end if;
  end if;

  select coalesce(max(x.attempt), 0) + 1 into v_attempt from public.studio_sms_prov_operations x where x.onboarding_id = o.id and x.op_kind = p_op_kind;
  insert into public.studio_sms_prov_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, friendly_name, request_digest, params,
                                                 fee_bearing, fee_kinds, started_by)
  values (v_id, o.id, o.studio_id, v_entity, v_account, p_op_kind, v_attempt, o.submission_seq, left(p_friendly_name, 128), p_request_digest, p_params,
          cardinality(v_kinds) > 0, v_kinds, p_actor)
  returning id into v_id;
  perform public._tw4_r1_audit(o, p_actor, 'prov_started', o.state, o.state, 'op=' || v_id || ';kind=' || p_op_kind || ';attempt=' || v_attempt || ';fee=' || coalesce(array_to_string(v_kinds, ','), ''));
  return jsonb_build_object('action', 'execute', 'operation_id', v_id, 'attempt', v_attempt, 'fee_kinds', to_jsonb(v_kinds), 'account_sid', v_account);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- finish: record the outcome and settle the fee in the same transaction
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_finish(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_status text, p_provider_sid text,
                                                  p_error_code text, p_error_detail text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_prov_operations;
  v_kind text;
  v_from text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_status is null or p_status not in ('succeeded', 'failed', 'unknown_outcome') then
    raise exception 'invalid operation outcome' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  if r.status = 'succeeded' and p_status = 'succeeded' and r.provider_sid is not distinct from p_provider_sid then
    return jsonb_build_object('status', 'succeeded', 'replayed', true);
  end if;
  if r.status not in ('in_flight', 'unknown_outcome') then
    raise exception 'the operation is not open' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (p_provider_sid is null or p_provider_sid !~ case r.op_kind when 'messaging_service' then '^MG[0-9a-fA-F]{32}$' else '^QE[0-9a-fA-F]{32}$' end) then
    raise exception 'a succeeded operation needs a valid provider sid' using errcode = '22023';
  end if;
  -- a fee operation whose outcome is unknown is never closed as failed here (only a human may say it did not happen); a free one only after the provider lookup had time to settle
  if p_status = 'failed' and r.status = 'unknown_outcome' then
    if r.fee_bearing then
      raise exception 'an unknown fee outcome is resolved by a platform admin' using errcode = 'TW034';
    end if;
    if p_error_code = 'reconciled_absent' and clock_timestamp() - r.started_at < interval '120 seconds' then
      raise exception 'too soon to conclude the resource does not exist' using errcode = 'TW034';
    end if;
  end if;
  if p_status = 'failed' and r.fee_bearing and coalesce(p_error_code, '') <> 'api' then
    raise exception 'a fee operation is closed as failed only on a definite provider refusal' using errcode = 'TW034';
  end if;
  v_from := r.status;
  update public.studio_sms_prov_operations set status = p_status, provider_sid = coalesce(p_provider_sid, provider_sid), finished_at = case when p_status = 'unknown_outcome' then null else clock_timestamp() end,
    error_code = left(p_error_code, 64), error_detail_sanitized = left(p_error_detail, 500) where id = r.id;
  if r.fee_bearing and p_status = 'succeeded' then
    foreach v_kind in array r.fee_kinds loop
      -- only the non-refundable vetting fee is spent by a submission; the first month is captured when the provider APPROVES (observe)
      if v_kind = 'campaign_vetting' then
        perform public._tw4prov_settle(r.id, v_kind, 'captured', p_provider_sid);
      end if;
    end loop;
  elsif r.fee_bearing and p_status = 'failed' then
    foreach v_kind in array r.fee_kinds loop
      perform public._tw4prov_settle(r.id, v_kind, 'released', coalesce(p_error_code, 'failed'));
    end loop;
  end if;
  if p_status = 'succeeded' and r.op_kind = 'campaign' and o.state = 'service_setup' then
    update public.studio_sms_onboarding set state = 'campaign_pending', step = 'C1', last_error_code = null, last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, null, 'state_changed', 'service_setup', 'campaign_pending', 'campaign submitted');
  end if;
  perform public._tw4_r1_audit(o, null, 'prov_finished', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';status=' || p_status || coalesce(';code=' || left(p_error_code, 64), ''));
  return jsonb_build_object('status', p_status, 'replayed', false, 'state', o.state);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- observe: the database judges what the PROVIDER reported (the caller supplies normalized read-back facts, never a verdict)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_observe(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_expected_inbound text,
                                                   p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_prov_operations;
  v_ms public.studio_sms_prov_operations;
  v_prev public.studio_sms_prov_resources;
  v_status text;
  v_code text := null;
  v_provider_status text := null;
  v_reasons text := null;
  v_brand text;
  v_path text;
  v_parent text := null;
  v_use text := null;
  v_from_state text;
  v_kind text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or pg_column_size(p_facts) > 8192 then
    raise exception 'invalid observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null or r.status <> 'succeeded' or r.superseded_at is not null then
    raise exception 'only a live, succeeded operation can be observed' using errcode = '22023';
  end if;
  v_from_state := o.state;
  select * into v_prev from public.studio_sms_prov_resources x where x.operation_id = r.id;

  if (p_facts ->> 'sid') is distinct from r.provider_sid then
    v_status := 'mismatch'; v_code := 'sid_mismatch';
  elsif (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
    v_status := 'mismatch'; v_code := 'account_mismatch';
  elsif r.op_kind = 'messaging_service' then
    if p_expected_inbound is null or p_expected_inbound !~ '^https://[^\s]+/api/sms/twilio/inbound$' then
      raise exception 'the expected inbound route is required' using errcode = '22023';
    end if;
    if (p_facts ->> 'use_inbound_webhook_on_number') is distinct from 'false' or (p_facts ->> 'inbound_request_url') is distinct from p_expected_inbound then
      v_status := 'mismatch'; v_code := 'inbound_route';
    else
      v_status := 'ready';
    end if;
  else
    select * into v_ms from public.studio_sms_prov_operations x where x.studio_id = r.studio_id and x.op_kind = 'messaging_service' and x.status = 'succeeded' and x.superseded_at is null;
    v_brand := public._tw4prov_brand(r.studio_id);
    v_path := public.tw4_location_fee_kinds(r.studio_id) ->> 'path';
    v_parent := p_facts ->> 'messaging_service_sid';
    v_use := p_facts ->> 'us_app_to_person_usecase';
    v_provider_status := left(upper(coalesce(p_facts ->> 'campaign_status', '')), 40);
    if v_ms.id is null or v_parent is distinct from v_ms.provider_sid then
      v_status := 'mismatch'; v_code := 'service_mismatch';
    elsif v_brand is null or (p_facts ->> 'brand_registration_sid') is distinct from v_brand then
      v_status := 'mismatch'; v_code := 'brand_mismatch';
    elsif v_use is null or v_use not in ('MIXED', 'LOW_VOLUME') or v_use is distinct from (r.params ->> 'use_case') or v_use is distinct from public._tw4prov_use_case(v_path) then
      v_status := 'mismatch'; v_code := 'use_case_mismatch';
    elsif (p_facts ->> 'mock') is distinct from 'false' then
      v_status := 'mismatch'; v_code := 'mock_or_unknown';
    elsif v_provider_status = 'VERIFIED' then
      v_status := 'verified';
    elsif v_provider_status = 'FAILED' then
      v_status := 'failed';
      v_reasons := left(regexp_replace(coalesce(p_facts ->> 'errors', ''), '[^[:print:]]', ' ', 'g'), 500);
    elsif v_provider_status = 'IN_PROGRESS' then
      v_status := 'pending';
    else
      v_status := 'pending'; v_code := 'status_unrecognized';
    end if;
  end if;

  if v_prev.id is null then
    insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status,
                                                 mismatch_code, provider_status, failure_reasons, source, evidence_digest, verified_at)
    values (r.id, r.legal_entity_id, r.studio_id, r.twilio_account_sid, r.op_kind, r.provider_sid, v_parent, case when r.op_kind = 'campaign' then p_facts ->> 'brand_registration_sid' end,
            v_use, v_status, v_code, v_provider_status, v_reasons, p_source, p_digest, case when v_status = 'verified' then clock_timestamp() end);
  else
    update public.studio_sms_prov_resources set status = v_status, mismatch_code = v_code, provider_status = v_provider_status, failure_reasons = v_reasons, source = p_source,
      evidence_digest = p_digest, observed_at = clock_timestamp(), parent_sid = coalesce(v_parent, parent_sid), use_case = coalesce(v_use, use_case),
      brand_sid = coalesce(case when r.op_kind = 'campaign' then p_facts ->> 'brand_registration_sid' end, brand_sid),
      verified_at = case when v_status = 'verified' then coalesce(verified_at, clock_timestamp()) else null end
    where id = v_prev.id;
  end if;

  -- fees follow provider evidence: the vetting fee is captured once the provider holds the campaign; the first month on approval, released on rejection
  if r.fee_bearing and r.op_kind = 'campaign' and v_status in ('pending', 'verified', 'failed') then
    foreach v_kind in array r.fee_kinds loop
      if exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':' || v_kind and cr.status = 'reserved') then
        if v_kind = 'campaign_vetting' or v_status = 'verified' then
          perform public._tw4prov_settle(r.id, v_kind, 'captured', r.provider_sid);
        elsif v_status = 'failed' then
          perform public._tw4prov_settle(r.id, v_kind, 'released', 'campaign_rejected');
        end if;
      end if;
    end loop;
  end if;
  -- a provider rejection (or a later failure of a campaign that was approved) sends the onboarding to a human; it is never retried or paid again automatically
  if r.op_kind = 'campaign' and v_status = 'failed' and public._sms_onb_transition_allowed(o.state, 'exception') then
    update public.studio_sms_onboarding set state = 'exception', step = 'C1', last_error_code = 'campaign_rejected', last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, null, 'state_changed', v_from_state, 'exception', 'campaign rejected by the provider');
  elsif r.op_kind = 'campaign' and v_status = 'verified' and o.state = 'campaign_pending' then
    update public.studio_sms_onboarding set step = 'N1', last_error_code = null where id = o.id returning * into o;
  end if;
  perform public._tw4_r1_audit(o, null, 'prov_observed', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';status=' || v_status || coalesce(';code=' || v_code, '') || ';src=' || p_source);
  return jsonb_build_object('status', v_status, 'code', v_code, 'state', o.state);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- resolve: a platform admin settles an unknown outcome after checking the provider console (reason required)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_prov_operations;
  o public.studio_sms_onboarding;
  v_kind text;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('created', 'not_created') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a resolution and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id for update;
  if r.status not in ('unknown_outcome', 'in_flight') or (r.status = 'in_flight' and r.started_at > clock_timestamp() - interval '20 minutes') then
    raise exception 'only an unresolved operation can be resolved (an attempt still in flight needs 20 minutes to be considered abandoned)' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease; resolve after it finishes' using errcode = '55P03';
  end if;
  if r.fee_bearing and p_resolution = 'not_created' and r.started_at > clock_timestamp() - interval '20 minutes' then
    raise exception 'a fee operation cannot be declared not created within 20 minutes of its attempt' using errcode = '22023';
  end if;
  if p_resolution = 'created' and (p_provider_sid is null or p_provider_sid !~ case r.op_kind when 'messaging_service' then '^MG[0-9a-fA-F]{32}$' else '^QE[0-9a-fA-F]{32}$' end) then
    raise exception 'the resource sid found at the provider is required' using errcode = '22023';
  end if;
  update public.studio_sms_prov_operations set status = case when p_resolution = 'created' then 'succeeded' else 'abandoned' end,
    provider_sid = case when p_resolution = 'created' then p_provider_sid else provider_sid end, finished_at = clock_timestamp(),
    resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note), error_code = coalesce(error_code, 'resolved') where id = r.id;
  -- 'created' captures nothing here: the typed SID is only a claim until a provider read of THIS account and service confirms it (observe captures)
  if r.fee_bearing and p_resolution = 'not_created' then
    foreach v_kind in array r.fee_kinds loop
      perform public._tw4prov_settle(r.id, v_kind, 'released', 'not_created');
    end loop;
  end if;
  if p_resolution = 'created' and r.op_kind = 'campaign' and o.state = 'service_setup' then
    update public.studio_sms_onboarding set state = 'campaign_pending', step = 'C1' where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'service_setup', 'campaign_pending', 'campaign confirmed by an admin');
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'prov_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';resolution=' || p_resolution);
  return jsonb_build_object('status', case when p_resolution = 'created' then 'succeeded' else 'abandoned' end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reopen: after a provisioning exception was understood (a rejected campaign corrected, an unknown outcome resolved), a platform admin sends the
-- onboarding back to the provisioning state it belongs to. It changes no fee, no authorization and no provider resource.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_reopen(p_studio_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_to text;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state <> 'exception' or coalesce(o.last_error_code, '') not like 'prov\_%' and o.last_error_code is distinct from 'campaign_rejected' then
    raise exception 'there is no provisioning exception to reopen' using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_prov_operations x where x.studio_id = o.studio_id and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null) then
    raise exception 'resolve the unknown outcome first' using errcode = 'TW034';
  end if;
  v_to := case when exists (select 1 from public.studio_sms_prov_operations x where x.studio_id = o.studio_id and x.op_kind = 'campaign' and x.status = 'succeeded' and x.superseded_at is null
                              and not exists (select 1 from public.studio_sms_prov_resources r where r.operation_id = x.id and r.status = 'failed'))
               then 'campaign_pending' else 'service_setup' end;
  update public.studio_sms_prov_operations x set superseded_at = clock_timestamp()
   where x.studio_id = o.studio_id and x.op_kind = 'campaign' and x.status = 'succeeded' and x.superseded_at is null
     and exists (select 1 from public.studio_sms_prov_resources r where r.operation_id = x.id and r.status = 'failed');
  update public.studio_sms_onboarding set state = v_to, last_error_code = null, last_error_field = null where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'exception', v_to, 'provisioning reopened: ' || btrim(p_reason));
  return jsonb_build_object('state', v_to);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- settle_admin: the one way to close a reservation of a SUCCEEDED (or abandoned) operation that provider evidence never settled (a mismatch that
-- stays, a wrong typed SID, a cancelled onboarding). The generic credit resolver refuses provisioning reservations on purpose.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_settle_admin(p_operation_id uuid, p_actor uuid, p_kind text, p_outcome text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_prov_operations;
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an outcome and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id;
  if r.id is null or p_kind is null or not (p_kind = any (r.fee_kinds)) then
    raise exception 'unknown operation or fee kind' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if r.status not in ('succeeded', 'abandoned') then
    raise exception 'an unresolved operation is closed through tw4_prov_resolve' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = r.legal_entity_id for no key update;
  if not exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':' || p_kind and cr.status = 'reserved') then
    raise exception 'no reservation is held for this operation and fee' using errcode = '22023';
  end if;
  perform public._tw4prov_settle(r.id, p_kind, p_outcome, 'admin');
  perform public._tw4_r1_audit(o, p_actor, 'prov_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || p_kind || ';settled=' || p_outcome || ';' || left(btrim(p_note), 150));
  return jsonb_build_object('status', p_outcome);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reads (platform admin)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_status(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  if o.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'onboarding_id', o.id, 'state', o.state, 'step', o.step, 'last_error_code', o.last_error_code, 'leased', o.lease_owner is not null and o.lease_expires_at > now(),
    'window_open', exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = p_studio_id and w.expires_at > now()),
    'brand_sid', public._tw4prov_brand(p_studio_id),
    'requirements', public._tw4prov_campaign_requirements(p_studio_id),
    'operations', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.op_kind, 'attempt', p.attempt, 'status', p.status, 'provider_sid', p.provider_sid,
        'fee_bearing', p.fee_bearing, 'fee_kinds', to_jsonb(p.fee_kinds), 'error_code', p.error_code, 'error_detail', p.error_detail_sanitized, 'started_at', p.started_at,
        'finished_at', p.finished_at, 'superseded', p.superseded_at is not null, 'resolved_by', p.resolved_by, 'resolution_note', p.resolution_note,
        'resource', case when r.id is null then null else jsonb_build_object('status', r.status, 'mismatch_code', r.mismatch_code, 'provider_status', r.provider_status,
          'failure_reasons', r.failure_reasons, 'observed_at', r.observed_at, 'source', r.source, 'use_case', r.use_case, 'verified_at', r.verified_at) end)
        order by p.op_kind, p.attempt)
      from public.studio_sms_prov_operations p left join public.studio_sms_prov_resources r on r.operation_id = p.id where p.studio_id = p_studio_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4prov_guard(), public._tw4prov_use_case(text), public._tw4prov_brand(uuid), public._tw4prov_campaign_requirements(uuid),
  public._tw4prov_reserve(public.studio_sms_onboarding, text, uuid), public._tw4prov_settle(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.tw4_credit_resolve_reservation(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.tw4_credit_resolve_reservation(uuid, text, uuid, text) to service_role;
revoke all on function public.tw4_prov_claim(uuid, uuid, text, integer, text), public.tw4_prov_context(uuid, text), public.tw4_prov_begin(uuid, text, text, text, text, jsonb, uuid),
  public.tw4_prov_finish(uuid, text, uuid, text, text, text, text), public.tw4_prov_observe(uuid, text, uuid, jsonb, text, text, text),
  public.tw4_prov_resolve(uuid, uuid, text, text, text), public.tw4_prov_reopen(uuid, uuid, text), public.tw4_prov_settle_admin(uuid, uuid, text, text, text), public.tw4_prov_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tw4_prov_claim(uuid, uuid, text, integer, text), public.tw4_prov_context(uuid, text), public.tw4_prov_begin(uuid, text, text, text, text, jsonb, uuid),
  public.tw4_prov_finish(uuid, text, uuid, text, text, text, text), public.tw4_prov_observe(uuid, text, uuid, jsonb, text, text, text),
  public.tw4_prov_resolve(uuid, uuid, text, text, text), public.tw4_prov_reopen(uuid, uuid, text), public.tw4_prov_settle_admin(uuid, uuid, text, text, text), public.tw4_prov_status(uuid, uuid) to service_role;

commit;
