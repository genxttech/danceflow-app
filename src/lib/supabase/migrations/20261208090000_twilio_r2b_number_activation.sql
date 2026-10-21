-- 20261208090000_twilio_r2b_number_activation.sql
-- TW-4F R2b: phone-number provisioning and sender activation (design docs/twilio/TW-4F_R2b_Number_Activation_Design.md).
--   * number offers (read-only search results, re-filtered here), owner selections (one number, published price + recurring cost disclosed, 24 h),
--     a provider-operation ledger for number purchase / attach (same rules as R2a's ledger), provider-evidence resources,
--     Advanced Opt-Out attestations and compliance validations, and the activation checklist (campaign_pending -> ready_for_activation -> active).
--   * Fee gate (purchase): credit-funded businesses need an ACTIVE `number` recurring authorization (their first month is already set aside; R2b posts no second
--     charge); the ConfiDance pilot business needs a written `number` spend approval reserved atomically inside the cumulative ceiling. Nothing else buys a number.
--   * Nothing here calls Twilio, sends SMS, publishes a price or enables a flag. The sender registry (PR #249) is fed only from this ledger's identifiers.
-- Requires 20261207090000 (R2a) and its predecessors. Independent of 20261205 / 20261206 (new objects only; the audit vocabulary is extended from the live list).
-- Rollback: rollback/20261208090000_twilio_r2b_number_activation_rollback.sql (refuses once any R2b evidence exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_prov_operations') is null or to_regprocedure('public.tw4_prov_begin(uuid,text,text,text,text,jsonb,uuid)') is null
     or to_regprocedure('public._tw4prov_settle(uuid,text,text,text)') is null or to_regprocedure('public.tw4_sender_record(uuid,uuid,text,text,text,text,text)') is null
     or to_regprocedure('public._tw4sr_ready(uuid)') is null or to_regprocedure('public._tw4sr_fake_allowed()') is null then
    raise exception 'R2b precondition failed: 20261207090000 (R2a) and 20261204090000 (sender readiness) are not applied';
  end if;
  if to_regclass('public.studio_sms_num_operations') is not null then
    raise exception 'R2b precondition failed: already applied';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.studio_sms_approval_refs'::regclass and conname in ('studio_sms_approval_refs_source_check', 'studio_sms_approval_refs_shape')
                  group by conrelid having count(*) = 2) then
    raise exception 'R2b precondition failed: the approval reference registry constraints differ from 20261202090000';
  end if;
  -- the readiness function replaced below must still be the 20261204 version
  if position('the location''s path may have changed since' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4sr_ready(uuid)'::regprocedure)) = 0
     or position('num_operations' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4sr_ready(uuid)'::regprocedure)) > 0 then
    raise exception 'R2b precondition failed: _tw4sr_ready differs from 20261204090000';
  end if;
  -- the generic resolver must still refuse provisioning reservations (R2b reservations use the same prov: key prefix and rely on it)
  if position('resolved only through tw4_prov_resolve' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_credit_resolve_reservation(uuid,text,uuid,text)'::regprocedure)) = 0 then
    raise exception 'R2b precondition failed: tw4_credit_resolve_reservation does not refuse provisioning reservations (R2a)';
  end if;
end $$;

-- audit vocabulary: the live list plus the R2b actions (extended, not replaced)
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
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['num_offered', 'num_selected', 'num_withdrawn', 'num_started', 'num_finished', 'num_observed',
    'num_resolved', 'num_retired', 'optout_attested', 'compliance_checked', 'activation_ready', 'activation_done', 'activation_suspended']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- the shared approval-reference registry (20261202) learns a third source: an admin-recorded number approval. One written approval then authorizes one operation, once, in EVERY direction.
alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_source_check;
alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_source_check check (source in ('spend_authorization', 'pilot_exception', 'number_selection'));
alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_shape;
alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_shape check (
  (source = 'spend_authorization' and spend_event_id is not null and kind is not null and amount_cents is not null and funding is not null)
  or (source = 'pilot_exception' and spend_event_id is null and kind is null and amount_cents is null and funding is null and studio_id is null)
  or (source = 'number_selection' and spend_event_id is null and kind is null and amount_cents is null and funding is null and studio_id is not null));

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges; everything goes through the functions below)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_number_offers (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  legal_entity_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  search jsonb not null default '{}'::jsonb check (jsonb_typeof(search) = 'object' and pg_column_size(search) <= 2048),
  candidates jsonb not null check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) between 1 and 25 and pg_column_size(candidates) <= 16384),
  source text not null check (source in ('provider_read', 'fake')),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  requested_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint studio_sms_number_offers_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_number_offers_studio on public.studio_sms_number_offers (studio_id, created_at desc);

create table public.studio_sms_number_selections (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.studio_sms_number_offers(id) on delete restrict,
  studio_id uuid not null,
  legal_entity_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  e164 text not null check (e164 ~ '^\+1[2-9][0-9]{9}$'),
  price_cents int not null check (price_cents > 0),
  funding_mode text not null check (funding_mode in ('credit_recurring', 'pilot')),
  approver_user uuid not null,
  approver_role text not null check (approver_role in ('studio_owner', 'platform_admin_recorded')),
  approval_ref text not null check (char_length(approval_ref) between 10 and 200),
  statement text not null check (char_length(statement) between 40 and 2000),
  approved_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  status text not null default 'approved' check (status in ('approved', 'consumed', 'withdrawn')),
  consumed_at timestamptz null,
  consumed_by_operation uuid null,
  withdrawn_at timestamptz null,
  withdrawn_by uuid null,
  withdrawn_note text null check (withdrawn_note is null or char_length(withdrawn_note) <= 300),
  constraint studio_sms_number_selections_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id),
  constraint studio_sms_number_selections_shape check ((status <> 'consumed' or (consumed_at is not null and consumed_by_operation is not null)) and (status <> 'approved' or consumed_at is null)
    and ((status = 'withdrawn') = (withdrawn_at is not null)))
);
-- one open selection per location; a number is selected by one location at a time (and never again once consumed); an approval reference is used once
create unique index studio_sms_number_selections_open on public.studio_sms_number_selections (studio_id) where status = 'approved';
create unique index studio_sms_number_selections_e164 on public.studio_sms_number_selections (e164) where status in ('approved', 'consumed');
create unique index studio_sms_number_selections_ref on public.studio_sms_number_selections (public._tw4fi_ref_norm(approval_ref));

create table public.studio_sms_num_operations (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  studio_id uuid not null,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  op_kind text not null check (op_kind in ('number_purchase', 'number_attach')),
  attempt int not null check (attempt >= 1),
  submission_seq int not null check (submission_seq >= 0),
  status text not null default 'in_flight' check (status in ('in_flight', 'succeeded', 'failed', 'unknown_outcome', 'abandoned')),
  selection_id uuid null references public.studio_sms_number_selections(id) on delete restrict,
  e164 text not null check (e164 ~ '^\+1[2-9][0-9]{9}$'),
  friendly_name text not null check (char_length(friendly_name) between 3 and 128),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 4096),
  provider_sid text null check (provider_sid is null or provider_sid ~ '^PN[0-9a-fA-F]{32}$'),
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
  constraint studio_sms_num_operations_onboarding_fk foreign key (onboarding_id, studio_id) references public.studio_sms_onboarding (id, studio_id) on delete restrict,
  constraint studio_sms_num_operations_attempt unique (onboarding_id, op_kind, attempt),
  constraint studio_sms_num_operations_succeeded_sid check (status <> 'succeeded' or provider_sid is not null),
  constraint studio_sms_num_operations_purchase_selection check ((op_kind = 'number_purchase') = (selection_id is not null)),
  constraint studio_sms_num_operations_fee_shape check (((op_kind = 'number_purchase') = fee_bearing) and ((fee_bearing and cardinality(fee_kinds) > 0) or (not fee_bearing and cardinality(fee_kinds) = 0))),
  constraint studio_sms_num_operations_resolution check ((resolved_by is null) = (resolved_at is null) and (resolved_by is null or resolution_note is not null))
);
create unique index studio_sms_num_operations_one_live on public.studio_sms_num_operations (studio_id, op_kind)
  where status in ('in_flight', 'unknown_outcome', 'succeeded') and superseded_at is null;
-- a number is bought once, GLOBALLY (two locations or two businesses can never hold a live purchase of the same number)
create unique index studio_sms_num_operations_e164_once on public.studio_sms_num_operations (e164)
  where op_kind = 'number_purchase' and status in ('in_flight', 'unknown_outcome', 'succeeded') and superseded_at is null;
-- one purchase attempt per selection, for the life of the system (a refused purchase needs a NEW approval)
create unique index studio_sms_num_operations_selection_once on public.studio_sms_num_operations (selection_id) where selection_id is not null;
create unique index studio_sms_num_operations_sid_once on public.studio_sms_num_operations (op_kind, provider_sid) where provider_sid is not null and status = 'succeeded';
create index studio_sms_num_operations_entity on public.studio_sms_num_operations (legal_entity_id, op_kind);

create table public.studio_sms_num_resources (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references public.studio_sms_num_operations(id) on delete restrict,
  legal_entity_id uuid not null,
  studio_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  resource_kind text not null check (resource_kind in ('number', 'service_number')),
  provider_sid text not null check (provider_sid ~ '^PN[0-9a-fA-F]{32}$'),
  e164 text not null,
  messaging_service_sid text null,
  status text not null check (status in ('owned', 'attached', 'mismatch')),
  mismatch_code text null check (mismatch_code is null or char_length(mismatch_code) <= 60),
  source text not null check (source in ('provider_read', 'fake')),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default clock_timestamp(),
  verified_at timestamptz null,
  created_at timestamptz not null default clock_timestamp()
);

create table public.studio_sms_optout_attestations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  legal_entity_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  messaging_service_sid text not null check (messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  campaign_sid text not null check (campaign_sid ~ '^QE[0-9a-fA-F]{32}$'),
  attested_by uuid not null,
  checklist jsonb not null check (jsonb_typeof(checklist) = 'object' and pg_column_size(checklist) <= 2048),
  evidence_ref text not null check (char_length(evidence_ref) between 10 and 300),
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_optout_attestations_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_optout_attestations_latest on public.studio_sms_optout_attestations (studio_id, created_at desc);

create table public.studio_sms_compliance_checks (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  legal_entity_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  messaging_service_sid text not null check (messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  campaign_sid text not null check (campaign_sid ~ '^QE[0-9a-fA-F]{32}$'),
  outcome text not null check (outcome in ('passed', 'failed')),
  failure_codes text null check (failure_codes is null or char_length(failure_codes) <= 300),
  facts jsonb not null check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 8192),
  source text not null check (source in ('provider_read', 'fake')),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  expected_inbound text not null,
  actor uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_compliance_checks_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_compliance_checks_latest on public.studio_sms_compliance_checks (studio_id, created_at desc);

-- the canonical origin DanceFlow's inbound route lives at: pinned in the database by a platform admin (append-only; the latest row is current). The compliance validation
-- compares the provider's reported route with THIS, never with a value the caller supplies.
create table public.studio_sms_inbound_route_pins (
  id bigserial primary key,
  origin text not null check (origin ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{2,5})?$' and char_length(origin) <= 255),
  set_by uuid not null,
  reason text not null check (char_length(reason) between 10 and 300),
  created_at timestamptz not null default clock_timestamp()
);

-- a number the provider shows in a business's subaccount that the ledger and the sender registry do not know (bought by hand, a pre-R2b sender): a platform admin
-- acknowledges it ONCE, with a reason, so it no longer blocks purchases. Nothing is bought, released or charged by an acknowledgement.
create table public.studio_sms_num_inventory_acks (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  phone_number_sid text not null check (phone_number_sid ~ '^PN[0-9a-fA-F]{32}$'),
  e164 text null check (e164 is null or e164 ~ '^\+1[2-9][0-9]{9}$'),
  acked_by uuid not null,
  note text not null check (char_length(note) between 10 and 300),
  created_at timestamptz not null default clock_timestamp(),
  unique (twilio_account_sid, phone_number_sid)
);

-- the provider inventory seen under ONE onboarding lease, judged by the database against the numbers it accounts for; tw4_num_begin(number_purchase) requires a clean, fresh stamp from its own lease
create table public.studio_sms_num_inventory_checks (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  lease_owner text not null,
  legal_entity_id uuid not null,
  listed_count int not null check (listed_count >= 0),
  unknown_count int not null check (unknown_count >= 0),
  created_at timestamptz not null default clock_timestamp()
);
create index studio_sms_num_inventory_checks_lease on public.studio_sms_num_inventory_checks (onboarding_id, lease_owner, created_at desc);
revoke all on public.studio_sms_num_inventory_checks from public, anon, authenticated, service_role;
alter table public.studio_sms_num_inventory_checks enable row level security;

revoke all on public.studio_sms_inbound_route_pins, public.studio_sms_num_inventory_acks from public, anon, authenticated, service_role;
revoke all on sequence public.studio_sms_inbound_route_pins_id_seq from public, anon, authenticated, service_role;
alter table public.studio_sms_inbound_route_pins enable row level security;
alter table public.studio_sms_num_inventory_acks enable row level security;

revoke all on public.studio_sms_number_offers, public.studio_sms_number_selections, public.studio_sms_num_operations, public.studio_sms_num_resources,
  public.studio_sms_optout_attestations, public.studio_sms_compliance_checks from public, anon, authenticated, service_role;
alter table public.studio_sms_number_offers enable row level security;
alter table public.studio_sms_number_selections enable row level security;
alter table public.studio_sms_num_operations enable row level security;
alter table public.studio_sms_num_resources enable row level security;
alter table public.studio_sms_optout_attestations enable row level security;
alter table public.studio_sms_compliance_checks enable row level security;

-- history is never deleted; identity never changes
create or replace function public._tw4num_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%: number provisioning evidence is never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name in ('studio_sms_number_offers', 'studio_sms_optout_attestations', 'studio_sms_compliance_checks', 'studio_sms_inbound_route_pins', 'studio_sms_num_inventory_acks', 'studio_sms_num_inventory_checks') then
    raise exception '%: append-only', tg_table_name using errcode = '42501';
  elsif tg_table_name = 'studio_sms_number_selections' then
    if new.id is distinct from old.id or new.offer_id is distinct from old.offer_id or new.studio_id is distinct from old.studio_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.twilio_account_sid is distinct from old.twilio_account_sid or new.e164 is distinct from old.e164 or new.price_cents is distinct from old.price_cents
       or new.funding_mode is distinct from old.funding_mode or new.approver_user is distinct from old.approver_user or new.approver_role is distinct from old.approver_role
       or new.approval_ref is distinct from old.approval_ref or new.statement is distinct from old.statement or new.approved_at is distinct from old.approved_at
       or new.expires_at is distinct from old.expires_at then
      raise exception 'studio_sms_number_selections: an approval is never edited' using errcode = '42501';
    end if;
    -- approved -> consumed | withdrawn; consumed -> withdrawn only when its purchase was definitively refused (tw4_num_finish / tw4_num_resolve free the number)
    if new.status is distinct from old.status and not (old.status = 'approved' or (old.status = 'consumed' and new.status = 'withdrawn')) then
      raise exception 'studio_sms_number_selections: a closed selection is final' using errcode = '42501';
    end if;
    if old.consumed_at is not null and (new.consumed_at is distinct from old.consumed_at or new.consumed_by_operation is distinct from old.consumed_by_operation) then
      raise exception 'studio_sms_number_selections: consumption is fixed' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_num_operations' then
    if new.id is distinct from old.id or new.onboarding_id is distinct from old.onboarding_id or new.studio_id is distinct from old.studio_id
       or new.legal_entity_id is distinct from old.legal_entity_id or new.twilio_account_sid is distinct from old.twilio_account_sid
       or new.op_kind is distinct from old.op_kind or new.attempt is distinct from old.attempt or new.submission_seq is distinct from old.submission_seq
       or new.selection_id is distinct from old.selection_id or new.e164 is distinct from old.e164
       or new.friendly_name is distinct from old.friendly_name or new.request_digest is distinct from old.request_digest or new.params is distinct from old.params
       or new.fee_bearing is distinct from old.fee_bearing or new.fee_kinds is distinct from old.fee_kinds or new.started_by is distinct from old.started_by
       or new.started_at is distinct from old.started_at or new.created_at is distinct from old.created_at then
      raise exception 'studio_sms_num_operations: the identity of an operation is fixed' using errcode = '42501';
    end if;
    if old.provider_sid is not null and new.provider_sid is distinct from old.provider_sid then
      raise exception 'studio_sms_num_operations: a provider sid never changes' using errcode = '42501';
    end if;
    if old.status in ('succeeded', 'failed', 'abandoned') and new.status is distinct from old.status then
      raise exception 'studio_sms_num_operations: a closed operation is final' using errcode = '42501';
    end if;
    if old.status = 'unknown_outcome' and new.status = 'in_flight' then
      raise exception 'studio_sms_num_operations: an unknown outcome is never reopened' using errcode = '42501';
    end if;
    if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
      raise exception 'studio_sms_num_operations: superseding is one-way' using errcode = '42501';
    end if;
  else
    if new.id is distinct from old.id or new.operation_id is distinct from old.operation_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.twilio_account_sid is distinct from old.twilio_account_sid
       or new.resource_kind is distinct from old.resource_kind or new.provider_sid is distinct from old.provider_sid or new.e164 is distinct from old.e164
       or new.created_at is distinct from old.created_at then
      raise exception 'studio_sms_num_resources: the identity of a resource is fixed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_number_offers_guard before update or delete on public.studio_sms_number_offers for each row execute function public._tw4num_guard();
create trigger studio_sms_number_selections_guard before update or delete on public.studio_sms_number_selections for each row execute function public._tw4num_guard();
create trigger studio_sms_num_operations_guard before update or delete on public.studio_sms_num_operations for each row execute function public._tw4num_guard();
create trigger studio_sms_num_resources_guard before update or delete on public.studio_sms_num_resources for each row execute function public._tw4num_guard();
create trigger studio_sms_optout_attestations_guard before update or delete on public.studio_sms_optout_attestations for each row execute function public._tw4num_guard();
create trigger studio_sms_compliance_checks_guard before update or delete on public.studio_sms_compliance_checks for each row execute function public._tw4num_guard();
create trigger studio_sms_inbound_route_pins_guard before update or delete on public.studio_sms_inbound_route_pins for each row execute function public._tw4num_guard();
create trigger studio_sms_num_inventory_acks_guard before update or delete on public.studio_sms_num_inventory_acks for each row execute function public._tw4num_guard();
create trigger studio_sms_num_inventory_checks_guard before update or delete on public.studio_sms_num_inventory_checks for each row execute function public._tw4num_guard();
create trigger studio_sms_num_inventory_checks_truncate before truncate on public.studio_sms_num_inventory_checks for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_inbound_route_pins_truncate before truncate on public.studio_sms_inbound_route_pins for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_num_inventory_acks_truncate before truncate on public.studio_sms_num_inventory_acks for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_number_offers_truncate before truncate on public.studio_sms_number_offers for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_number_selections_truncate before truncate on public.studio_sms_number_selections for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_num_operations_truncate before truncate on public.studio_sms_num_operations for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_num_resources_truncate before truncate on public.studio_sms_num_resources for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_optout_attestations_truncate before truncate on public.studio_sms_optout_attestations for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_compliance_checks_truncate before truncate on public.studio_sms_compliance_checks for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- helpers (no API-role privileges)
-- ---------------------------------------------------------------------------------------------------------------
-- the studio's legal business's ACTIVE subaccount, or null (suspended / closed / absent)
create or replace function public._tw4num_account(p_studio_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select a.twilio_account_sid from public.studio_sms_entity_studios es join public.studio_sms_twilio_accounts a on a.legal_entity_id = es.legal_entity_id and a.status = 'active'
   where es.studio_id = p_studio_id;
$$;

-- R2a's Messaging Service operation, only when the provider read it `ready` on the active account
create or replace function public._tw4num_service(p_studio_id uuid)
returns public.studio_sms_prov_operations language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select x.* from public.studio_sms_prov_operations x join public.studio_sms_prov_resources r on r.operation_id = x.id
   where x.studio_id = p_studio_id and x.op_kind = 'messaging_service' and x.status = 'succeeded' and x.superseded_at is null
     and r.status = 'ready' and r.twilio_account_sid = x.twilio_account_sid and x.twilio_account_sid = public._tw4num_account(p_studio_id);
$$;

-- R2a's campaign, only when the provider read it VERIFIED (not mock) on the active account, on the verified service, with the use case the CURRENT path requires
create or replace function public._tw4num_campaign(p_studio_id uuid)
returns public.studio_sms_prov_operations language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select x.* from public.studio_sms_prov_operations x join public.studio_sms_prov_resources r on r.operation_id = x.id
   where x.studio_id = p_studio_id and x.op_kind = 'campaign' and x.status = 'succeeded' and x.superseded_at is null
     and r.status = 'verified' and r.twilio_account_sid = x.twilio_account_sid and x.twilio_account_sid = public._tw4num_account(p_studio_id)
     and r.parent_sid = (select (public._tw4num_service(p_studio_id)).provider_sid)
     and r.use_case = public._tw4prov_use_case(public._tw4fi_location_path_nolock(p_studio_id));
$$;

-- the number rent kind and the campaign monthly kind this location pays; the published price of a kind
create or replace function public._tw4num_price(p_kind text)
returns int language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select p.customer_price_cents from public.studio_sms_price_list p where p.active and p.kind = p_kind; $$;

-- is this number (E.164 or SID) already spoken for anywhere: another location's sender, a live purchase, or an open / consumed selection?
create or replace function public._tw4num_taken(p_e164 text, p_studio_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_entity_studios es cross join lateral (select * from public.studio_sms_billed_senders s where s.studio_id = es.studio_id order by s.seq desc limit 1) l
                  where l.status <> 'released' and l.sender_e164 = p_e164 and es.studio_id <> p_studio_id)
      or exists (select 1 from public.studio_sms_num_operations o where o.e164 = p_e164 and o.op_kind = 'number_purchase' and o.status in ('in_flight', 'unknown_outcome', 'succeeded') and o.superseded_at is null)
      or exists (select 1 from public.studio_sms_number_selections s where s.e164 = p_e164 and s.status in ('approved', 'consumed') and s.studio_id <> p_studio_id);
$$;

-- SEND GATE. The PR #249 readiness (kept as the core, unchanged) says WHICH sender may send; R2b adds WHEN: a location whose number is managed by this ledger sends
-- only while its onboarding is ACTIVE. So a verified sender never sends before activation (checklist, attestation, compliance, funding continuity), and
-- suspended / exception / ready-for-activation locations stop at once. A location with no R2b operation keeps the PR #249 behaviour exactly.
create or replace function public._tw4sr_ready_core(p_studio_id uuid)
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
revoke all on function public._tw4sr_ready_core(uuid) from public, anon, authenticated, service_role;

create or replace function public._tw4sr_ready(p_studio_id uuid)
returns public.studio_sms_billed_senders language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  none public.studio_sms_billed_senders;
  s public.studio_sms_billed_senders;
  v_p public.studio_sms_num_operations;
  v_a public.studio_sms_num_operations;
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
begin
  if not exists (select 1 from public.studio_sms_num_operations o where o.studio_id = p_studio_id) then
    return public._tw4sr_ready_core(p_studio_id);   -- not an R2b location: PR #249 behaviour exactly
  end if;
  -- an R2b location sends only while ACTIVE ...
  if not exists (select 1 from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state = 'active') then
    return none;
  end if;
  s := public._tw4sr_ready_core(p_studio_id);
  if s.id is null then
    return none;
  end if;
  -- ... and only from the sender its own LEDGER bought and attached (a free-form PR #249 sender row, another service or another number of the business does not send)
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
     and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'owned');
  select * into v_a from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_attach' and x.status = 'succeeded' and x.superseded_at is null
     and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'attached');
  v_ms := public._tw4num_service(p_studio_id);
  v_qe := public._tw4num_campaign(p_studio_id);
  if v_p.id is null or v_a.id is null or v_ms.id is null or v_qe.id is null or v_a.provider_sid is distinct from v_p.provider_sid
     or s.phone_number_sid is distinct from v_p.provider_sid or s.sender_e164 is distinct from v_p.e164 or s.messaging_service_sid is distinct from v_ms.provider_sid
     or s.campaign_sid is distinct from v_qe.provider_sid or s.account_sid is distinct from v_p.twilio_account_sid then
    return none;
  end if;
  return s;
end $$;

-- fee reservation for the pilot business's number: the _tw4prov_reserve logic (20261207 body) fixed to the `number` kind and keyed by the OPERATION
create or replace function public._tw4num_reserve(p_o public.studio_sms_onboarding, p_op uuid, p_expected_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  s public.studio_sms_spend_events;
  pe public.studio_sms_pilot_exceptions;
  v_entity uuid;
  v_key text := 'prov:' || p_op::text || ':number';
  v_res uuid;
  v_pilot_used bigint;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_o.studio_id;
  if v_entity is null then
    raise exception 'the studio has no legal entity' using errcode = 'TW004';
  end if;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.kind = 'number' and x.status = 'authorized' and x.funding = 'pilot' and x.amount_cents = p_expected_cents
     and (x.studio_id is null or x.studio_id = p_o.studio_id) order by (x.studio_id is null), x.authorized_at limit 1 for update;
  if s.id is null then
    raise exception 'no authorized pilot spend for number' using errcode = 'TW004';
  end if;
  if s.amount_cents <> p_expected_cents then
    raise exception 'the approved amount differs from the acknowledged published price' using errcode = 'TW008';
  end if;
  a := public._tw4c_lock(v_entity);
  select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity;
  if pe.legal_entity_id is null or a.hold or a.balance_cents < 0 then
    raise exception 'the pilot exception cannot fund this operation' using errcode = 'TW007';
  end if;
  select coalesce(sum(r.amount_cents), 0) into v_pilot_used from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured');
  if v_pilot_used + s.amount_cents > pe.ceiling_cents then
    raise exception 'the pilot ceiling would be exceeded' using errcode = 'TW007';
  end if;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key) values (v_entity, p_o.studio_id, 'number', s.amount_cents, 'pilot', v_key) returning id into v_res;
  update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_key, reserved_at = now(), credit_reservation_id = v_res where id = s.id;
  perform public._tw4f3a_audit(p_o.studio_id, null, 'spend_reserved', 'entity=' || v_entity || ';kind=number;cents=' || s.amount_cents || ';funding=pilot;op=' || p_op);
  return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', v_res, 'funding', 'pilot');
end $$;

-- credit funding of a number, evaluated now: the account is not on hold or negative, AND either the first month's set-aside is still reserved and the balance covers it,
-- or the current service month of this authorization has been charged. A charge that was `unfunded` / `held` is NOT funding, and a missing set-aside is not funding.
create or replace function public._tw4num_credit_funded(p_entity uuid, p_auth uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_auth public.studio_sms_recurring_authorizations;
  v_res public.studio_sms_credit_reservations;
begin
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = p_entity;
  if a.legal_entity_id is null or a.hold or a.balance_cents < 0 then
    return false;
  end if;
  select * into v_auth from public.studio_sms_recurring_authorizations x where x.id = p_auth;
  if v_auth.id is null then
    return false;
  end if;
  select * into v_res from public.studio_sms_credit_reservations cr where cr.id = v_auth.commitment_reservation_id;
  if v_res.id is not null and v_res.status = 'reserved' and a.balance_cents >= v_res.amount_cents then
    return true;
  end if;
  return exists (select 1 from public.studio_sms_recurring_charges c where c.authorization_id = v_auth.id and c.status = 'charged' and c.period_key = public._tw4ml_month_key(p_entity, now()));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- what a purchase needs before it may start, read-only (tw4_num_begin is the authority and re-checks everything under its locks)
-- blocker: null | campaign_not_verified | unpriced | release_current_number_first | no_selection | selection_expired | price_changed | selection_stale
--          | awaiting_recurring | awaiting_authorization | awaiting_funding | on_hold | pilot_ceiling | pilot_recurring | number_taken | suspended
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4num_requirements(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_price int := public._tw4num_price('number');
  v_pilot public.studio_sms_pilot_exceptions;
  v_sel public.studio_sms_number_selections;
  v_latest public.studio_sms_billed_senders := public._tw4sr_latest(p_studio_id);
  a public.studio_sms_credit_accounts;
  v_auth public.studio_sms_recurring_authorizations;
  v_used bigint;
  v_blocker text := null;
  v_mode text;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  select * into v_pilot from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity;
  v_mode := case when v_pilot.legal_entity_id is not null then 'pilot' else 'credit_recurring' end;
  select * into v_sel from public.studio_sms_number_selections s where s.studio_id = p_studio_id and s.status = 'approved';
  if public._tw4num_account(p_studio_id) is null then
    v_blocker := 'suspended';
  elsif (public._tw4num_campaign(p_studio_id)).id is null then
    v_blocker := 'campaign_not_verified';
  elsif v_price is null then
    v_blocker := 'unpriced';
  elsif v_latest.id is not null and v_latest.status <> 'released' and v_latest.phone_number_sid is not null then
    v_blocker := 'release_current_number_first';
  elsif v_sel.id is null then
    v_blocker := 'no_selection';
  elsif v_sel.expires_at <= now() then
    v_blocker := 'selection_expired';
  elsif v_sel.price_cents <> v_price then
    v_blocker := 'price_changed';
  elsif v_sel.funding_mode <> v_mode then
    v_blocker := 'selection_stale';
  elsif public._tw4num_taken(v_sel.e164, p_studio_id) and not exists (select 1 from public.studio_sms_num_operations o where o.studio_id = p_studio_id and o.e164 = v_sel.e164 and o.superseded_at is null) then
    v_blocker := 'number_taken';
  end if;
  if v_blocker is null then
    select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
    if v_mode = 'credit_recurring' then
      select * into v_auth from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.studio_id = p_studio_id and r.kind = 'number' and r.status = 'active'
         and r.expires_at > now() + interval '28 days' and r.price_cents = v_price;
      if v_auth.id is null then
        v_blocker := 'awaiting_recurring';
      elsif a.legal_entity_id is null or a.hold or a.balance_cents < 0 then
        v_blocker := 'on_hold';
      elsif not public._tw4num_credit_funded(v_entity, v_auth.id) then
        v_blocker := 'awaiting_funding';
      end if;
    else
      if exists (select 1 from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.status = 'active') then
        v_blocker := 'pilot_recurring';
      elsif not exists (select 1 from public.studio_sms_spend_events s where s.legal_entity_id = v_entity and s.kind = 'number' and s.status = 'authorized' and s.funding = 'pilot'
                         and (s.studio_id is null or s.studio_id = p_studio_id) and s.amount_cents = v_price) then
        v_blocker := 'awaiting_authorization';
      elsif a.legal_entity_id is not null and (a.hold or a.balance_cents < 0) then
        v_blocker := 'on_hold';
      else
        select coalesce(sum(r.amount_cents), 0) into v_used from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured');
        if v_used + v_price > v_pilot.ceiling_cents then v_blocker := 'pilot_ceiling'; end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('blocker', v_blocker, 'funding_mode', v_mode, 'price_cents', v_price, 'selection_id', v_sel.id, 'selection_e164', v_sel.e164,
    'ceiling_remaining_cents', case when v_pilot.legal_entity_id is not null then v_pilot.ceiling_cents - coalesce((select sum(r.amount_cents) from public.studio_sms_credit_reservations r
        where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured')), 0) end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- offers: the server's read-only search result, re-filtered by the database. Buys nothing, reserves nothing.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_offer_record(p_studio_id uuid, p_actor uuid, p_account_sid text, p_search jsonb, p_candidates jsonb, p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_clean jsonb;
  v_id uuid;
  v_exp timestamptz := clock_timestamp() + interval '30 minutes';
begin
  perform public._tw4c_admin(p_actor);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_candidates is null or jsonb_typeof(p_candidates) <> 'array'
     or p_search is null or jsonb_typeof(p_search) <> 'object' or pg_column_size(p_candidates) > 65536 or jsonb_array_length(p_candidates) > 50 then
    raise exception 'invalid number search result' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state <> 'campaign_pending' then
    raise exception 'onboarding is not at the number step' using errcode = 'TW030';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  v_account := public._tw4num_account(p_studio_id);
  if v_entity is null or v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  if p_account_sid is distinct from v_account then
    raise exception 'the search ran in a different account' using errcode = 'TW005';
  end if;
  if (public._tw4num_campaign(p_studio_id)).id is null then
    raise exception 'the campaign is not verified' using errcode = 'TW032';
  end if;
  if (select count(*) from public.studio_sms_number_offers x where x.studio_id = p_studio_id and x.created_at > clock_timestamp() - interval '1 hour') >= 20 then
    raise exception 'too many number searches for this location; wait before searching again' using errcode = '54000';
  end if;
  -- the database decides what may be offered: US/Canada E.164, SMS-capable, no address requirement, and not spoken for anywhere
  select coalesce(jsonb_agg(jsonb_build_object('e164', c ->> 'e164', 'locality', left(c ->> 'locality', 60), 'region', left(c ->> 'region', 20), 'mms_capable', coalesce((c ->> 'mms_capable')::boolean, false))), '[]'::jsonb)
    into v_clean
    from (select distinct on (c ->> 'e164') c from jsonb_array_elements(p_candidates) c
           where c ->> 'e164' ~ '^\+1[2-9][0-9]{9}$' and coalesce((c ->> 'sms_capable')::boolean, false) is true and coalesce(c ->> 'address_requirements', 'none') = 'none'
             and not public._tw4num_taken(c ->> 'e164', p_studio_id) order by c ->> 'e164' limit 25) q(c);
  if jsonb_array_length(v_clean) = 0 then
    raise exception 'no eligible number in the search result' using errcode = 'TW043';
  end if;
  insert into public.studio_sms_number_offers (studio_id, legal_entity_id, twilio_account_sid, search, candidates, source, evidence_digest, requested_by, expires_at)
  values (p_studio_id, v_entity, v_account, p_search, v_clean, p_source, p_digest, p_actor, v_exp) returning id into v_id;
  perform public._tw4sr_audit(p_studio_id, p_actor, 'num_offered', 'offer=' || v_id || ';count=' || jsonb_array_length(v_clean));
  return jsonb_build_object('offer_id', v_id, 'count', jsonb_array_length(v_clean), 'expires_at', v_exp, 'candidates', v_clean);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- selection: ONE number approved by the studio owner (in the app) or recorded by a platform admin from the owner's written approval.
-- The price is the published price the approver acknowledged; the recurring cost and the funding are stated in the stored approval text.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_select(p_studio_id uuid, p_actor uuid, p_offer_id uuid, p_e164 text, p_ack_price_cents int, p_approval_ref text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_account text;
  v_offer public.studio_sms_number_offers;
  v_role text;
  v_ref text;
  v_price int := public._tw4num_price('number');
  v_mode text;
  v_latest public.studio_sms_billed_senders;
  v_id uuid := gen_random_uuid();
  v_statement text;
  v_exp timestamptz := clock_timestamp() + interval '24 hours';
  o public.studio_sms_onboarding;
begin
  if p_actor is null or p_e164 is null or p_e164 !~ '^\+1[2-9][0-9]{9}$' or p_offer_id is null then
    raise exception 'an actor, an offer and a number are required' using errcode = '22023';
  end if;
  -- the OWNER path trusts no parameter: the actor must be the authenticated session's own user (auth.uid()), i.e. the call arrives through tw4_num_select_as_owner on the
  -- owner's own token. A service-role call that merely NAMES an owner is refused (a forged owner approval); a platform admin records the owner's written approval instead.
  if auth.uid() is not distinct from p_actor and exists (select 1 from public.user_studio_roles r where r.user_id = p_actor and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    v_role := 'studio_owner';
    v_ref := 'owner-approval:' || v_id::text;
  elsif public._tw4_r1_is_platform_admin(p_actor) then
    v_role := 'platform_admin_recorded';
    if p_approval_ref is null or char_length(public._tw4fi_ref_norm(p_approval_ref)) < 10 then
      raise exception 'a reference to the owner''s written approval (10+ characters) is required' using errcode = '22023';
    end if;
    v_ref := btrim(p_approval_ref);
  else
    raise exception 'only the studio owner, or a platform admin recording the owner''s written approval, can approve a number' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tw4num:e164:' || p_e164, 0));
  v_entity := public._tw4sr_lock(p_studio_id);
  v_account := public._tw4num_account(p_studio_id);
  if v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  if o.id is null or o.state <> 'campaign_pending' then
    raise exception 'onboarding is not at the number step' using errcode = 'TW030';
  end if;
  if (public._tw4num_campaign(p_studio_id)).id is null then
    raise exception 'the campaign is not verified' using errcode = 'TW032';
  end if;
  if v_price is null or p_ack_price_cents is distinct from v_price then
    raise exception 'the price changed or is not published: review and approve again' using errcode = 'TW008';
  end if;
  v_latest := public._tw4sr_latest(p_studio_id);
  if v_latest.id is not null and v_latest.status <> 'released' and v_latest.phone_number_sid is not null then
    raise exception 'release the current number of this location before choosing another' using errcode = 'TW022';
  end if;
  select * into v_offer from public.studio_sms_number_offers x where x.id = p_offer_id and x.studio_id = p_studio_id;
  if v_offer.id is null then
    raise exception 'unknown offer for this location' using errcode = '22023';
  end if;
  if v_offer.twilio_account_sid <> v_account then
    raise exception 'the offer belongs to a different account' using errcode = 'TW005';
  end if;
  if v_offer.expires_at <= now() then
    raise exception 'the offer expired: search again' using errcode = 'TW040';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_offer.candidates) c where c ->> 'e164' = p_e164) then
    raise exception 'that number is not in the offer' using errcode = '22023';
  end if;
  if public._tw4num_taken(p_e164, p_studio_id) then
    raise exception 'that number is no longer available' using errcode = '23505';
  end if;
  -- a stale open selection is closed; a live one must be withdrawn first (one open selection per location)
  update public.studio_sms_number_selections set status = 'withdrawn', withdrawn_at = clock_timestamp(), withdrawn_by = p_actor, withdrawn_note = 'expired'
   where studio_id = p_studio_id and status = 'approved' and expires_at <= now();
  if exists (select 1 from public.studio_sms_number_selections s where s.studio_id = p_studio_id and s.status = 'approved') then
    raise exception 'withdraw the open number approval first' using errcode = '23505';
  end if;
  v_mode := case when exists (select 1 from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity) then 'pilot' else 'credit_recurring' end;
  v_statement := 'I approve DanceFlow acquiring the texting phone number ' || p_e164 || ' for my studio at the published price of ' || public._tw4rc_usd(v_price)
    || ' per month. This is a recurring cost: the rent continues every month until the number is released. '
    || case v_mode when 'pilot' then 'It is covered by my business''s pilot exception, where each purchase needs its own written approval inside the pilot ceiling and nothing renews automatically. '
         else 'It is billed monthly from my business''s prepaid texting credit under my recurring authorization of this charge, within my monthly spending limit. ' end
    || 'DanceFlow buys no number until this approval, the published price and settled funding are all in place. This approval covers this one number and expires after 24 hours.';
  if v_role = 'platform_admin_recorded' then
    -- registered in the shared registry (same advisory lock and ceiling check as every fee approval): a reference used here can never approve a spend, and the reverse
    perform public._tw4fi_register(v_ref, 'number_selection', v_entity, p_studio_id, null, null, null, null, p_actor);
  end if;
  insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at)
  values (v_id, v_offer.id, p_studio_id, v_entity, v_account, p_e164, v_price, v_mode, p_actor, v_role, v_ref, v_statement, v_exp);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, case when v_role = 'studio_owner' then 'user' else 'platform_admin' end, p_actor, 'num_selected', left('selection=' || v_id || ';number=' || p_e164 || ';cents=' || v_price || ';mode=' || v_mode || ';by=' || v_role, 300));
  return jsonb_build_object('selection_id', v_id, 'e164', p_e164, 'price_cents', v_price, 'funding_mode', v_mode, 'expires_at', v_exp, 'statement', v_statement);
end $$;

create or replace function public.tw4_num_withdraw(p_studio_id uuid, p_actor uuid, p_selection_id uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_number_selections;
begin
  if not (public._tw4_r1_is_platform_admin(p_actor) or (auth.uid() is not distinct from p_actor and exists (select 1 from public.user_studio_roles r where r.user_id = p_actor and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner'))) then
    raise exception 'only the studio owner or a platform admin can withdraw an approval' using errcode = '42501';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  select * into s from public.studio_sms_number_selections x where x.id = p_selection_id and x.studio_id = p_studio_id for update;
  if s.id is null then
    raise exception 'unknown approval' using errcode = '22023';
  end if;
  if s.status = 'withdrawn' then
    return jsonb_build_object('status', 'withdrawn', 'replayed', true);
  end if;
  if s.status <> 'approved' then
    raise exception 'a number that was already used for a purchase attempt is not withdrawn here' using errcode = '22023';
  end if;
  update public.studio_sms_number_selections set status = 'withdrawn', withdrawn_at = clock_timestamp(), withdrawn_by = p_actor, withdrawn_note = left(btrim(coalesce(p_note, 'withdrawn')), 300) where id = s.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, case when public._tw4_r1_is_platform_admin(p_actor) then 'platform_admin' else 'user' end, p_actor, 'num_withdrawn', left('selection=' || s.id, 300));
  return jsonb_build_object('status', 'withdrawn', 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- claim (the SAME onboarding lease as the brand and R2a runners: all three exclude each other)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer default 300, p_mode text default 'run')
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
  if o.state <> 'campaign_pending' and not (p_mode = 'refresh' and o.state in ('ready_for_activation', 'active', 'suspended')) then
    raise exception 'onboarding state % is not at the number step', o.state using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() and o.lease_owner <> p_lease_owner then
    raise exception 'another run holds the lease' using errcode = '55P03';
  end if;
  update public.studio_sms_onboarding set lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'runner_lease', o.state, o.state, 'claimed number ' || p_mode);
  return jsonb_build_object('onboarding_id', o.id, 'studio_id', o.studio_id, 'state', o.state, 'submission_seq', o.submission_seq);
end $$;

-- every number SID the system accounts for in a business's subaccount: a live (not retired, not abandoned) ledger purchase or attachment, the CURRENT unreleased sender row of each of its locations,
-- and admin acknowledgements. A retired purchase or a released sender no longer counts: a number that lingers after a "release" trips the inventory check instead of being forgotten.
create or replace function public._tw4num_known(p_entity uuid)
returns text[] language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(distinct k.sid), '{}'::text[]) from (
    select p.provider_sid sid from public.studio_sms_num_operations p where p.legal_entity_id = p_entity and p.provider_sid is not null and p.superseded_at is null and p.status <> 'abandoned'
    union select l.phone_number_sid from public.studio_sms_entity_studios es2 cross join lateral (select * from public.studio_sms_billed_senders b2 where b2.studio_id = es2.studio_id order by b2.seq desc limit 1) l
      where es2.legal_entity_id = p_entity and l.phone_number_sid is not null and l.status <> 'released'
    union select a.phone_number_sid from public.studio_sms_num_inventory_acks a where a.legal_entity_id = p_entity) k;
$$;

create or replace function public.tw4_num_context(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  v_ms := public._tw4num_service(o.studio_id);
  v_qe := public._tw4num_campaign(o.studio_id);
  return jsonb_build_object(
    'state', o.state, 'submission_seq', o.submission_seq, 'studio_id', o.studio_id,
    'messaging_service_sid', v_ms.provider_sid, 'campaign_sid', v_qe.provider_sid,
    'requirements', public._tw4num_requirements(o.studio_id),
    -- every number SID the system accounts for in THIS business's subaccount: any ledger operation (retired included), any sender row of its locations, any acknowledgement
    'known_numbers', to_jsonb(public._tw4num_known((select es.legal_entity_id from public.studio_sms_entity_studios es where es.studio_id = o.studio_id))),
    'operations', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.op_kind, 'attempt', p.attempt, 'status', p.status, 'provider_sid', p.provider_sid, 'e164', p.e164,
        'fee_bearing', p.fee_bearing, 'age_seconds', floor(extract(epoch from (clock_timestamp() - p.started_at)))::int, 'superseded', p.superseded_at is not null,
        'resource_status', r.status) order by p.op_kind, p.attempt)
      from public.studio_sms_num_operations p left join public.studio_sms_num_resources r on r.operation_id = p.id where p.studio_id = o.studio_id), '[]'::jsonb));
end $$;

-- closes the reservation of an operation when one is held (credit-funded purchases hold none: their rent is the recurring authorization's)
create or replace function public._tw4num_settle_if_held(p_op uuid, p_outcome text, p_ref text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
              where se.reservation_key = 'prov:' || p_op::text || ':number' and cr.status = 'reserved') then
    perform public._tw4prov_settle(p_op, 'number', p_outcome, p_ref);
  end if;
end $$;

-- a purchase that provably did not happen frees its number for a NEW approval (the consumed approval itself is never reused)
create or replace function public._tw4num_free_selection(p_selection uuid, p_actor uuid, p_note text)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$
  update public.studio_sms_number_selections set status = 'withdrawn', withdrawn_at = clock_timestamp(), withdrawn_by = p_actor, withdrawn_note = left(p_note, 300)
   where id = p_selection and status = 'consumed';
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- begin: gate, reserve (pilot) and record the attempt, atomically, BEFORE any provider call
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_begin(p_onboarding_id uuid, p_lease_owner text, p_op_kind text, p_friendly_name text, p_request_digest text, p_params jsonb, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_live public.studio_sms_num_operations;
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
  v_sel public.studio_sms_number_selections;
  v_purchase public.studio_sms_num_operations;
  v_req jsonb;
  v_mode text;
  v_price int;
  v_auth public.studio_sms_recurring_authorizations;
  v_kinds text[] := '{}';
  v_attempt int;
  v_id uuid := gen_random_uuid();
  v_e164 text;
  v_selection uuid := null;
  a public.studio_sms_credit_accounts;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'a platform admin must start a number step' using errcode = '42501';
  end if;
  if p_op_kind is null or p_op_kind not in ('number_purchase', 'number_attach') or p_friendly_name is null or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
     or p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid number step' using errcode = '22023';
  end if;
  if o.state <> 'campaign_pending' then
    raise exception 'onboarding state % cannot take this step', o.state using errcode = 'TW030';
  end if;
  if not exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = o.studio_id and w.expires_at > now()) then
    raise exception 'the runner window for this studio is closed' using errcode = 'TW001';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  v_account := public._tw4num_account(o.studio_id);
  if v_entity is null or v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for no key update;
  update public.studio_sms_onboarding set lease_expires_at = greatest(lease_expires_at, now() + interval '5 minutes') where id = o.id;

  select * into v_live from public.studio_sms_num_operations x
   where x.studio_id = o.studio_id and x.op_kind = p_op_kind and x.status in ('in_flight', 'unknown_outcome', 'succeeded') and x.superseded_at is null for update;
  if v_live.id is not null then
    if v_live.status = 'succeeded' then
      return jsonb_build_object('action', 'skip', 'operation_id', v_live.id, 'provider_sid', v_live.provider_sid, 'status', v_live.status);
    end if;
    return jsonb_build_object('action', 'reconcile', 'operation_id', v_live.id, 'provider_sid', v_live.provider_sid, 'status', v_live.status, 'fee_bearing', v_live.fee_bearing,
                              'e164', v_live.e164, 'age_seconds', floor(extract(epoch from (clock_timestamp() - v_live.started_at)))::int);
  end if;

  -- the approved campaign and its verified service are the only things a number may be attached to
  v_ms := public._tw4num_service(o.studio_id);
  v_qe := public._tw4num_campaign(o.studio_id);
  if v_ms.id is null or v_qe.id is null then
    raise exception 'the Messaging Service or the campaign is not verified' using errcode = 'TW032';
  end if;

  if p_op_kind = 'number_purchase' then
    v_req := public._tw4num_requirements(o.studio_id);
    case v_req ->> 'blocker'
      when 'suspended' then raise exception 'the business''s subaccount is not active' using errcode = 'TW005';
      when 'campaign_not_verified' then raise exception 'the campaign is not verified' using errcode = 'TW032';
      when 'unpriced', 'price_changed' then raise exception 'the number has no published price, or it changed since the approval' using errcode = 'TW008';
      when 'release_current_number_first' then raise exception 'release the current number of this location before buying another' using errcode = 'TW022';
      when 'no_selection', 'selection_expired', 'selection_stale' then raise exception 'there is no current owner approval of a number' using errcode = 'TW040';
      when 'number_taken' then raise exception 'that number is no longer available' using errcode = '23505';
      when 'pilot_recurring' then raise exception 'the pilot business cannot have a standing recurring authorization' using errcode = 'TW011';
      when 'awaiting_recurring' then raise exception 'no active recurring authorization for number rent' using errcode = 'TW033';
      when 'awaiting_authorization' then raise exception 'no owner-approved number spend' using errcode = 'TW004';
      when 'awaiting_funding', 'on_hold', 'pilot_ceiling' then raise exception 'the number cannot be funded' using errcode = 'TW007';
      else null;
    end case;
    v_mode := v_req ->> 'funding_mode';
    v_price := (v_req ->> 'price_cents')::int;
    -- the provider inventory of this subaccount must have been reconciled with the ledger UNDER THIS LEASE, a moment ago, with nothing unknown: enforced here, for every caller
    if not exists (select 1 from public.studio_sms_num_inventory_checks c where c.onboarding_id = o.id and c.lease_owner = p_lease_owner and c.unknown_count = 0 and c.created_at > clock_timestamp() - interval '5 minutes') then
      raise exception 'the provider number inventory was not reconciled with the ledger' using errcode = 'TW045';
    end if;
    select * into v_sel from public.studio_sms_number_selections s where s.id = (v_req ->> 'selection_id')::uuid and s.studio_id = o.studio_id and s.status = 'approved' for update;
    if v_sel.id is null or v_sel.expires_at <= now() or v_sel.twilio_account_sid <> v_account or v_sel.legal_entity_id <> v_entity then
      raise exception 'there is no current owner approval of a number' using errcode = 'TW040';
    end if;
    if (p_params ->> 'selection_id') is distinct from v_sel.id::text or (p_params ->> 'e164') is distinct from v_sel.e164 then
      raise exception 'the request does not name the approved number' using errcode = 'TW040';
    end if;
    if v_mode = 'pilot' then
      perform public._tw4num_reserve(o, v_id, v_sel.price_cents);
    else
      -- the account lock first, THEN the authorization (the order tw4_recurring_revoke uses): a revocation cannot slip in between the check and the attempt
      a := public._tw4c_lock(v_entity);
      if a.hold or a.balance_cents < 0 then
        raise exception 'the credit account is on hold' using errcode = 'TW007';
      end if;
      select * into v_auth from public.studio_sms_recurring_authorizations ra where ra.legal_entity_id = v_entity and ra.studio_id = o.studio_id and ra.kind = 'number' and ra.status = 'active'
         and ra.expires_at > now() + interval '28 days' and ra.price_cents = v_sel.price_cents for share;
      if v_auth.id is null then
        raise exception 'no active recurring authorization for number rent' using errcode = 'TW033';
      end if;
      -- the funding condition is decided HERE, under the locks (the earlier read was a preview): an unpaid current month or a missing set-aside is not funding
      if not public._tw4num_credit_funded(v_entity, v_auth.id) then
        raise exception 'the number rent is not funded for this month' using errcode = 'TW007';
      end if;
    end if;
    v_kinds := array['number'];
    v_e164 := v_sel.e164;
    v_selection := v_sel.id;
  else
    select * into v_purchase from public.studio_sms_num_operations x where x.studio_id = o.studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null;
    if v_purchase.id is null or not exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_purchase.id and r.status = 'owned' and r.twilio_account_sid = v_account) then
      raise exception 'the number purchase is not confirmed by the provider' using errcode = 'TW032';
    end if;
    if (p_params ->> 'messaging_service_sid') is distinct from v_ms.provider_sid or (p_params ->> 'phone_number_sid') is distinct from v_purchase.provider_sid then
      raise exception 'the request does not name this location''s Messaging Service and number' using errcode = 'TW032';
    end if;
    v_e164 := v_purchase.e164;
  end if;

  select coalesce(max(x.attempt), 0) + 1 into v_attempt from public.studio_sms_num_operations x where x.onboarding_id = o.id and x.op_kind = p_op_kind;
  insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, selection_id, e164, friendly_name, request_digest,
                                                params, fee_bearing, fee_kinds, started_by)
  values (v_id, o.id, o.studio_id, v_entity, v_account, p_op_kind, v_attempt, o.submission_seq, v_selection, v_e164, left(p_friendly_name, 128), p_request_digest,
          p_params || case when p_op_kind = 'number_purchase' then jsonb_build_object('funding_mode', v_mode) else '{}'::jsonb end, cardinality(v_kinds) > 0, v_kinds, p_actor);
  if v_selection is not null then
    update public.studio_sms_number_selections set status = 'consumed', consumed_at = clock_timestamp(), consumed_by_operation = v_id where id = v_selection;
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'num_started', o.state, o.state, 'op=' || v_id || ';kind=' || p_op_kind || ';attempt=' || v_attempt || ';number=' || v_e164 || coalesce(';mode=' || v_mode, ''));
  return jsonb_build_object('action', 'execute', 'operation_id', v_id, 'attempt', v_attempt, 'fee_kinds', to_jsonb(v_kinds), 'account_sid', v_account, 'e164', v_e164);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- finish: record the outcome (a definite refusal releases a held reservation and frees the number for a NEW approval)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_finish(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_status text, p_provider_sid text, p_error_code text, p_error_detail text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_num_operations;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_status is null or p_status not in ('succeeded', 'failed', 'unknown_outcome') then
    raise exception 'invalid operation outcome' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  if r.status = 'succeeded' and p_status = 'succeeded' and r.provider_sid is not distinct from p_provider_sid then
    return jsonb_build_object('status', 'succeeded', 'replayed', true);
  end if;
  if r.status not in ('in_flight', 'unknown_outcome') then
    raise exception 'the operation is not open' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (p_provider_sid is null or p_provider_sid !~ '^PN[0-9a-fA-F]{32}$') then
    raise exception 'a succeeded operation needs a valid provider sid' using errcode = '22023';
  end if;
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
  update public.studio_sms_num_operations set status = p_status, provider_sid = coalesce(p_provider_sid, provider_sid), finished_at = case when p_status = 'unknown_outcome' then null else clock_timestamp() end,
    error_code = left(p_error_code, 64), error_detail_sanitized = left(p_error_detail, 500) where id = r.id;
  if r.fee_bearing and p_status = 'failed' then
    perform public._tw4num_settle_if_held(r.id, 'released', coalesce(p_error_code, 'failed'));
    perform public._tw4num_free_selection(r.selection_id, null, 'purchase refused by the provider');
  end if;
  -- a purchase that succeeded captures nothing here: ownership must first be confirmed by a provider read (observe)
  perform public._tw4_r1_audit(o, null, 'num_finished', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';status=' || p_status || coalesce(';code=' || left(p_error_code, 64), ''));
  return jsonb_build_object('status', p_status, 'replayed', false, 'state', o.state);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- observe: the database judges what the PROVIDER reported (normalized read-back facts; the caller never supplies a verdict)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_observe(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_num_operations;
  v_purchase public.studio_sms_num_operations;
  v_ms public.studio_sms_prov_operations;
  v_prev public.studio_sms_num_resources;
  v_status text;
  v_code text := null;
  v_kind text;
  v_from_state text;
  v_sender public.studio_sms_billed_senders;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or pg_column_size(p_facts) > 8192 then
    raise exception 'invalid observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null or r.status <> 'succeeded' or r.superseded_at is not null then
    raise exception 'only a live, succeeded operation can be observed' using errcode = '22023';
  end if;
  select * into v_prev from public.studio_sms_num_resources x where x.operation_id = r.id;

  if r.op_kind = 'number_purchase' then
    v_kind := 'number';
    if (p_facts ->> 'sid') is distinct from r.provider_sid then
      v_status := 'mismatch'; v_code := 'sid_mismatch';
    elsif (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
      v_status := 'mismatch'; v_code := 'account_mismatch';
    elsif (p_facts ->> 'phone_number') is distinct from r.e164 then
      v_status := 'mismatch'; v_code := 'number_mismatch';
    elsif (p_facts ->> 'sms_capable') is distinct from 'true' then
      v_status := 'mismatch'; v_code := 'not_sms_capable';
    else
      v_status := 'owned';
    end if;
  else
    v_kind := 'service_number';
    v_ms := public._tw4num_service(r.studio_id);
    select * into v_purchase from public.studio_sms_num_operations x where x.studio_id = r.studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null;
    if v_ms.id is null or v_purchase.id is null or v_purchase.provider_sid is distinct from r.provider_sid then
      v_status := 'mismatch'; v_code := 'ledger_mismatch';
    elsif (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
      v_status := 'mismatch'; v_code := 'account_mismatch';
    elsif (p_facts ->> 'service_sid') is distinct from v_ms.provider_sid then
      v_status := 'mismatch'; v_code := 'service_mismatch';
    elsif jsonb_typeof(p_facts -> 'number_sids') is distinct from 'array' or not (p_facts -> 'number_sids') ? r.provider_sid then
      v_status := 'mismatch'; v_code := 'number_not_in_service';
    else
      v_status := 'attached';
    end if;
  end if;

  if v_prev.id is null then
    insert into public.studio_sms_num_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, messaging_service_sid, status, mismatch_code,
                                                source, evidence_digest, verified_at)
    values (r.id, r.legal_entity_id, r.studio_id, r.twilio_account_sid, v_kind, r.provider_sid, r.e164, case when v_kind = 'service_number' then v_ms.provider_sid end, v_status, v_code,
            p_source, p_digest, case when v_status <> 'mismatch' then clock_timestamp() end);
  else
    update public.studio_sms_num_resources set status = v_status, mismatch_code = v_code, source = p_source, evidence_digest = p_digest, observed_at = clock_timestamp(),
      messaging_service_sid = coalesce(case when v_kind = 'service_number' then v_ms.provider_sid end, messaging_service_sid),
      verified_at = case when v_status <> 'mismatch' then coalesce(verified_at, clock_timestamp()) else null end
    where id = v_prev.id;
  end if;

  -- the fee follows provider evidence: captured once a provider read of THIS account confirms the number is owned
  if r.op_kind = 'number_purchase' and v_status = 'owned' then
    perform public._tw4num_settle_if_held(r.id, 'captured', r.provider_sid);
  end if;
  if v_status = 'mismatch' and public._sms_onb_transition_allowed(o.state, 'exception') then
    v_from_state := o.state;
    -- a location that was ready, active or suspended stops sending at once: the sender is revoked (the exception state alone would not stop PR #249 readiness)
    perform public._tw4sr_lock(r.studio_id);
    v_sender := public._tw4sr_latest(r.studio_id);
    if v_sender.id is not null and v_sender.status in ('pending', 'approved') then
      perform public._tw4sr_append(v_sender, 'revoked', null, 'number read-back mismatch', null);
      perform public._tw4sr_audit(r.studio_id, null, 'sender_revoked', 'sender=' || v_sender.id || ';number read-back mismatch');
    end if;
    update public.studio_sms_onboarding set state = 'exception', step = 'N9', last_error_code = 'num_mismatch', last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, null, 'state_changed', v_from_state, 'exception', 'number read-back mismatch');
  elsif v_status = 'owned' and o.state = 'campaign_pending' then
    update public.studio_sms_onboarding set step = 'N2', last_error_code = null where id = o.id returning * into o;
  elsif v_status = 'attached' and o.state = 'campaign_pending' then
    update public.studio_sms_onboarding set step = 'N3', last_error_code = null where id = o.id returning * into o;
  end if;
  perform public._tw4_r1_audit(o, null, 'num_observed', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';status=' || v_status || coalesce(';code=' || v_code, '') || ';src=' || p_source);
  return jsonb_build_object('status', v_status, 'code', v_code, 'state', o.state);
end $$;

-- a platform admin settles an unknown outcome after checking the provider console (reason required)
create or replace function public.tw4_num_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_num_operations;
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('created', 'not_created') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a resolution and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id for update;
  if r.status not in ('unknown_outcome', 'in_flight') or (r.status = 'in_flight' and r.started_at > clock_timestamp() - interval '20 minutes') then
    raise exception 'only an unresolved operation can be resolved (an attempt still in flight needs 20 minutes to be considered abandoned)' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease; resolve after it finishes' using errcode = '55P03';
  end if;
  if r.fee_bearing and p_resolution = 'not_created' and r.started_at > clock_timestamp() - interval '20 minutes' then
    raise exception 'a fee operation cannot be declared not created within 20 minutes of its attempt' using errcode = '22023';
  end if;
  if p_resolution = 'created' and (p_provider_sid is null or p_provider_sid !~ '^PN[0-9a-fA-F]{32}$') then
    raise exception 'the number sid found at the provider is required' using errcode = '22023';
  end if;
  update public.studio_sms_num_operations set status = case when p_resolution = 'created' then 'succeeded' else 'abandoned' end,
    provider_sid = case when p_resolution = 'created' then p_provider_sid else provider_sid end, finished_at = clock_timestamp(),
    resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note), error_code = coalesce(error_code, 'resolved') where id = r.id;
  -- 'created' captures nothing here: the typed SID is only a claim until a provider read of THIS account confirms it (observe captures)
  if r.fee_bearing and p_resolution = 'not_created' then
    perform public._tw4num_settle_if_held(r.id, 'released', 'not_created');
    perform public._tw4num_free_selection(r.selection_id, p_actor, 'resolved: not created');
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'num_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';resolution=' || p_resolution);
  return jsonb_build_object('status', case when p_resolution = 'created' then 'succeeded' else 'abandoned' end);
end $$;

-- the one ledger-aware way to close a held reservation of a SUCCEEDED (or abandoned) purchase that provider evidence never settled
create or replace function public.tw4_num_settle_admin(p_operation_id uuid, p_actor uuid, p_outcome text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_num_operations;
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an outcome and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id;
  if r.id is null or not r.fee_bearing then
    raise exception 'unknown operation or no fee' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if r.status not in ('succeeded', 'abandoned') then
    raise exception 'an unresolved operation is closed through tw4_num_resolve' using errcode = '22023';
  end if;
  if p_outcome = 'released' and exists (select 1 from public.studio_sms_num_resources x where x.operation_id = r.id and x.status = 'owned') then
    raise exception 'the provider confirmed this number as owned: its fee cannot be released' using errcode = '22023';
  end if;
  if r.status = 'abandoned' and p_outcome = 'captured' then
    raise exception 'an operation declared not created cannot capture a fee' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = r.legal_entity_id for no key update;
  if not exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':number' and cr.status = 'reserved') then
    raise exception 'no reservation is held for this operation' using errcode = '22023';
  end if;
  perform public._tw4prov_settle(r.id, 'number', p_outcome, 'admin');
  perform public._tw4_r1_audit(o, p_actor, 'num_resolved', o.state, o.state, 'op=' || r.id || ';settled=' || p_outcome || ';' || left(btrim(p_note), 150));
  return jsonb_build_object('status', p_outcome);
end $$;

-- after a number exception was understood, a platform admin sends the onboarding back to the number step. Changes no fee and no provider resource.
create or replace function public.tw4_num_reopen(p_studio_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state <> 'exception' or coalesce(o.last_error_code, '') not like 'num\_%' then
    raise exception 'there is no number exception to reopen' using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_num_operations x where x.studio_id = o.studio_id and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null) then
    raise exception 'resolve the unknown outcome first' using errcode = 'TW034';
  end if;
  update public.studio_sms_onboarding set state = 'campaign_pending', last_error_code = null, last_error_field = null where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'exception', 'campaign_pending', 'number step reopened: ' || btrim(p_reason));
  return jsonb_build_object('state', 'campaign_pending');
end $$;

-- the location released its number (PR #249 `released` sender row) and an admin released it at the provider console: the ledger lets the location buy another
create or replace function public.tw4_num_retire(p_studio_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_purchase public.studio_sms_num_operations;
  v_latest public.studio_sms_billed_senders;
  v_from_state text;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a written reason that confirms the number was released at the provider (10-300 characters) is required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'there is no onboarding' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null) then
    raise exception 'resolve the unknown outcome first' using errcode = 'TW034';
  end if;
  select * into v_purchase from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null for update;
  if v_purchase.id is null then
    raise exception 'there is no live number purchase to retire' using errcode = '22023';
  end if;
  v_latest := public._tw4sr_latest(p_studio_id);
  if v_latest.id is not null and v_latest.status <> 'released' and v_latest.phone_number_sid = v_purchase.provider_sid then
    raise exception 'release the sender row first (tw4_sender_revoke with release)' using errcode = 'TW022';
  end if;
  v_from_state := o.state;
  update public.studio_sms_num_operations set superseded_at = clock_timestamp() where studio_id = p_studio_id and op_kind in ('number_purchase', 'number_attach') and status = 'succeeded' and superseded_at is null;
  perform public._tw4_r1_audit(o, p_actor, 'num_retired', o.state, o.state, 'op=' || v_purchase.id || ';number=' || v_purchase.e164 || ';' || left(btrim(p_note), 150));
  -- a location that was ready, active or suspended cannot take the number steps again from there: it goes back through exception (tw4_num_reopen returns it to the number step)
  if o.state in ('ready_for_activation', 'active', 'suspended') then
    update public.studio_sms_onboarding set state = 'exception', step = 'N9', last_error_code = 'num_retired', last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, p_actor, 'state_changed', v_from_state, 'exception', 'number retired');
  end if;
  return jsonb_build_object('retired', v_purchase.provider_sid);
end $$;

-- records the sender (pending) in the PR #249 registry from THIS ledger's identifiers only
create or replace function public.tw4_num_record_sender(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
  v_p public.studio_sms_num_operations;
  v_a public.studio_sms_num_operations;
  v_latest public.studio_sms_billed_senders;
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4sr_lock(p_studio_id);
  v_ms := public._tw4num_service(p_studio_id);
  v_qe := public._tw4num_campaign(p_studio_id);
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
     and x.twilio_account_sid = v_ms.twilio_account_sid and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'owned' and r.twilio_account_sid = x.twilio_account_sid);
  select * into v_a from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_attach' and x.status = 'succeeded' and x.superseded_at is null
     and x.twilio_account_sid = v_ms.twilio_account_sid and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'attached' and r.messaging_service_sid = v_ms.provider_sid);
  if v_ms.id is null or v_qe.id is null or v_p.id is null or v_a.id is null or v_a.provider_sid is distinct from v_p.provider_sid then
    raise exception 'the service, campaign, purchase and attachment are not all confirmed by the provider' using errcode = 'TW032';
  end if;
  v_latest := public._tw4sr_latest(p_studio_id);
  if v_latest.id is not null and v_latest.status in ('pending', 'approved') and v_latest.messaging_service_sid = v_ms.provider_sid and v_latest.campaign_sid = v_qe.provider_sid
     and v_latest.phone_number_sid = v_p.provider_sid and v_latest.sender_e164 = v_p.e164 then
    return jsonb_build_object('sender_id', v_latest.id, 'status', v_latest.status, 'replayed', true);
  end if;
  return public.tw4_sender_record(p_studio_id, p_actor, v_ms.provider_sid, v_qe.provider_sid, v_p.provider_sid, v_p.e164, 'R2b: recorded from the number ledger, purchase ' || v_p.id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reads (platform admin)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_status(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  perform public._tw4c_admin(p_actor);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  if o.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'onboarding_id', o.id, 'state', o.state, 'step', o.step, 'last_error_code', o.last_error_code, 'leased', o.lease_owner is not null and o.lease_expires_at > now(),
    'window_open', exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = p_studio_id and w.expires_at > now()),
    'requirements', public._tw4num_requirements(p_studio_id),
    'operations', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.op_kind, 'attempt', p.attempt, 'status', p.status, 'provider_sid', p.provider_sid, 'e164', p.e164,
        'fee_bearing', p.fee_bearing, 'error_code', p.error_code, 'error_detail', p.error_detail_sanitized, 'started_at', p.started_at, 'finished_at', p.finished_at,
        'superseded', p.superseded_at is not null, 'resolved_by', p.resolved_by, 'resolution_note', p.resolution_note,
        'resource', case when r.id is null then null else jsonb_build_object('status', r.status, 'mismatch_code', r.mismatch_code, 'observed_at', r.observed_at, 'source', r.source) end)
        order by p.op_kind, p.attempt)
      from public.studio_sms_num_operations p left join public.studio_sms_num_resources r on r.operation_id = p.id where p.studio_id = p_studio_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Advanced Opt-Out attestation and compliance validation
-- ---------------------------------------------------------------------------------------------------------------
-- Twilio exposes Advanced Opt-Out only in the console, so a platform admin ATTESTS it for the location's own service and campaign (every item, plus an evidence reference)
create or replace function public.tw4_act_attest(p_studio_id uuid, p_actor uuid, p_checklist jsonb, p_evidence_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
  v_entity uuid;
  v_id uuid;
  v_key text;
begin
  perform public._tw4c_admin(p_actor);
  if p_evidence_ref is null or char_length(btrim(p_evidence_ref)) not between 10 and 300 or p_checklist is null or jsonb_typeof(p_checklist) <> 'object' then
    raise exception 'a complete checklist and an evidence reference (10-300 characters) are required' using errcode = '22023';
  end if;
  foreach v_key in array array['advanced_opt_out_enabled', 'stop_keyword_confirmed', 'start_keyword_confirmed', 'help_keyword_confirmed', 'confirmation_replies_confirmed'] loop
    if (p_checklist ->> v_key) is distinct from 'true' then
      raise exception 'the attestation is incomplete: % is not confirmed', v_key using errcode = '22023';
    end if;
  end loop;
  v_entity := public._tw4sr_lock(p_studio_id);
  v_ms := public._tw4num_service(p_studio_id);
  v_qe := public._tw4num_campaign(p_studio_id);
  if v_ms.id is null or v_qe.id is null then
    raise exception 'the service and campaign are not verified' using errcode = 'TW032';
  end if;
  insert into public.studio_sms_optout_attestations (studio_id, legal_entity_id, twilio_account_sid, messaging_service_sid, campaign_sid, attested_by, checklist, evidence_ref)
  values (p_studio_id, v_entity, v_ms.twilio_account_sid, v_ms.provider_sid, v_qe.provider_sid, p_actor, p_checklist, btrim(p_evidence_ref)) returning id into v_id;
  perform public._tw4sr_audit(p_studio_id, p_actor, 'optout_attested', 'attestation=' || v_id || ';mg=' || v_ms.provider_sid || ';qe=' || v_qe.provider_sid);
  return jsonb_build_object('attestation_id', v_id);
end $$;

-- the database judges the campaign's compliance setup from provider reads. The caller supplies normalized facts, never a verdict.
create or replace function public.tw4_act_compliance_record(p_studio_id uuid, p_actor uuid, p_facts jsonb, p_expected_inbound text, p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
  v_entity uuid;
  c jsonb;
  s jsonb;
  v_codes text[] := '{}';
  v_id uuid;
  v_outcome text;
  v_pin text;
begin
  perform public._tw4c_admin(p_actor);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or pg_column_size(p_facts) > 8192 or p_expected_inbound is null or p_expected_inbound !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{2,5})?/api/sms/twilio/inbound$' then
    raise exception 'invalid compliance observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select pn.origin || '/api/sms/twilio/inbound' into v_pin from public.studio_sms_inbound_route_pins pn order by pn.id desc limit 1;
  if v_pin is null or p_expected_inbound is distinct from v_pin then
    raise exception 'the inbound route is not pinned, or differs from the pinned origin' using errcode = 'TW044';
  end if;
  v_entity := public._tw4sr_lock(p_studio_id);
  v_ms := public._tw4num_service(p_studio_id);
  v_qe := public._tw4num_campaign(p_studio_id);
  if v_ms.id is null or v_qe.id is null then
    raise exception 'the service and campaign are not verified' using errcode = 'TW032';
  end if;
  c := coalesce(p_facts -> 'campaign', '{}'::jsonb);
  s := coalesce(p_facts -> 'service', '{}'::jsonb);
  if s ->> 'sid' is distinct from v_ms.provider_sid or s ->> 'account_sid' is distinct from v_ms.twilio_account_sid then v_codes := array_append(v_codes, 'service_mismatch'); end if;
  if c ->> 'sid' is distinct from v_qe.provider_sid or c ->> 'account_sid' is distinct from v_qe.twilio_account_sid or c ->> 'messaging_service_sid' is distinct from v_ms.provider_sid then
    v_codes := array_append(v_codes, 'campaign_mismatch');
  end if;
  if upper(coalesce(c ->> 'campaign_status', '')) <> 'VERIFIED' then v_codes := array_append(v_codes, 'campaign_not_verified'); end if;
  if (c ->> 'mock') is distinct from 'false' then v_codes := array_append(v_codes, 'mock_or_unknown'); end if;
  if (s ->> 'use_inbound_webhook_on_number') is distinct from 'false' or (s ->> 'inbound_request_url') is distinct from p_expected_inbound then v_codes := array_append(v_codes, 'inbound_route'); end if;
  if jsonb_typeof(c -> 'opt_out_keywords') is distinct from 'array' or not exists (select 1 from jsonb_array_elements_text(c -> 'opt_out_keywords') k where upper(btrim(k)) = 'STOP') then
    v_codes := array_append(v_codes, 'no_stop_keyword');
  end if;
  if jsonb_typeof(c -> 'opt_in_keywords') is distinct from 'array' or not exists (select 1 from jsonb_array_elements_text(c -> 'opt_in_keywords') k where upper(btrim(k)) = 'START') then
    v_codes := array_append(v_codes, 'no_start_keyword');
  end if;
  if jsonb_typeof(c -> 'help_keywords') is distinct from 'array' or not exists (select 1 from jsonb_array_elements_text(c -> 'help_keywords') k where upper(btrim(k)) = 'HELP') then
    v_codes := array_append(v_codes, 'no_help_keyword');
  end if;
  if char_length(btrim(coalesce(c ->> 'opt_out_message', ''))) < 10 then v_codes := array_append(v_codes, 'no_opt_out_message'); end if;
  if char_length(btrim(coalesce(c ->> 'help_message', ''))) < 10 then v_codes := array_append(v_codes, 'no_help_message'); end if;
  if char_length(btrim(coalesce(c ->> 'opt_in_message', ''))) < 10 then v_codes := array_append(v_codes, 'no_opt_in_message'); end if;
  v_outcome := case when cardinality(v_codes) = 0 then 'passed' else 'failed' end;
  insert into public.studio_sms_compliance_checks (studio_id, legal_entity_id, twilio_account_sid, messaging_service_sid, campaign_sid, outcome, failure_codes, facts, source, evidence_digest, expected_inbound, actor)
  values (p_studio_id, v_entity, v_ms.twilio_account_sid, v_ms.provider_sid, v_qe.provider_sid, v_outcome, nullif(array_to_string(v_codes, ','), ''), p_facts, p_source, p_digest, p_expected_inbound, p_actor) returning id into v_id;
  perform public._tw4sr_audit(p_studio_id, p_actor, 'compliance_checked', 'check=' || v_id || ';outcome=' || v_outcome || coalesce(';codes=' || array_to_string(v_codes, ','), ''));
  return jsonb_build_object('check_id', v_id, 'outcome', v_outcome, 'codes', to_jsonb(v_codes));
end $$;

-- the only R2b way to PR #249's tw4_sender_verify: the attestation it passes is derived HERE from a current attestation and a passed compliance check for the sender's OWN service and campaign
create or replace function public.tw4_act_verify_sender(p_studio_id uuid, p_sender_id uuid, p_actor uuid, p_evidence jsonb, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4sr_lock(p_studio_id);
  s := public._tw4sr_latest(p_studio_id);
  if s.id is null or s.id <> p_sender_id then
    raise exception 'this sender row is no longer the current one' using errcode = 'TW021';
  end if;
  if not exists (select 1 from public.studio_sms_optout_attestations a where a.studio_id = p_studio_id and a.twilio_account_sid = s.account_sid and a.messaging_service_sid = s.messaging_service_sid
                  and a.campaign_sid = s.campaign_sid and a.created_at > now() - interval '30 days') then
    raise exception 'an Advanced Opt-Out attestation for this service and campaign is required' using errcode = 'TW041';
  end if;
  if not exists (select 1 from (select * from public.studio_sms_compliance_checks c where c.studio_id = p_studio_id order by c.created_at desc limit 1) l
                  where l.outcome = 'passed' and l.twilio_account_sid = s.account_sid and l.messaging_service_sid = s.messaging_service_sid and l.campaign_sid = s.campaign_sid
                    and l.created_at > now() - interval '24 hours') then
    raise exception 'a passed compliance validation for this service and campaign (24 hours) is required' using errcode = 'TW041';
  end if;
  return public.tw4_sender_verify(p_studio_id, p_sender_id, p_actor, p_evidence, true, p_source);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- activation
-- ---------------------------------------------------------------------------------------------------------------
-- funding continuity (R2a design 6.1/6.2): Twilio keeps billing a live campaign and number whether or not the owner's authorization still stands
create or replace function public._tw4act_funding(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_kind text := public.tw4_location_fee_kinds(p_studio_id) ->> 'campaign_monthly_kind';
  a public.studio_sms_credit_accounts;
  v_c public.studio_sms_recurring_authorizations;
  v_n public.studio_sms_recurring_authorizations;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('ok', false, 'detail', 'no_legal_entity');
  end if;
  if exists (select 1 from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity) then
    -- no standing authorization may exist for the pilot business and no month-two operation exists yet: activation stays blocked (explicit, not silent)
    return jsonb_build_object('ok', false, 'detail', 'pilot_month_two_undefined');
  end if;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'detail', 'no_registration_path');
  end if;
  select * into v_c from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.studio_id = p_studio_id and r.kind = v_kind and r.status = 'active'
     and r.expires_at > now() + interval '35 days' and r.price_cents = public._tw4num_price(v_kind);
  select * into v_n from public.studio_sms_recurring_authorizations r where r.legal_entity_id = v_entity and r.studio_id = p_studio_id and r.kind = 'number' and r.status = 'active'
     and r.expires_at > now() + interval '35 days' and r.price_cents = public._tw4num_price('number');
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  if v_c.id is null then return jsonb_build_object('ok', false, 'detail', 'campaign_authorization_short_or_missing'); end if;
  if v_n.id is null then return jsonb_build_object('ok', false, 'detail', 'number_authorization_short_or_missing'); end if;
  if a.legal_entity_id is null or a.hold or a.balance_cents < 0 then return jsonb_build_object('ok', false, 'detail', 'credit_on_hold'); end if;
  if not public._tw4num_credit_funded(v_entity, v_c.id) then return jsonb_build_object('ok', false, 'detail', 'campaign_rent_unfunded'); end if;
  if not public._tw4num_credit_funded(v_entity, v_n.id) then return jsonb_build_object('ok', false, 'detail', 'number_rent_unfunded'); end if;
  return jsonb_build_object('ok', true, 'detail', 'ok', 'campaign_expires_at', v_c.expires_at, 'number_expires_at', v_n.expires_at);
end $$;

-- every activation condition, evaluated now. [{id, ok, detail}]
create or replace function public._tw4act_items(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_account text := public._tw4num_account(p_studio_id);
  v_ms public.studio_sms_prov_operations := public._tw4num_service(p_studio_id);
  v_qe public.studio_sms_prov_operations := public._tw4num_campaign(p_studio_id);
  v_p public.studio_sms_num_operations;
  v_a public.studio_sms_num_operations;
  v_s public.studio_sms_billed_senders;
  v_ready public.studio_sms_billed_senders;
  v_att public.studio_sms_optout_attestations;
  v_cmp public.studio_sms_compliance_checks;
  v_fund jsonb := public._tw4act_funding(p_studio_id);
  v_sender_ok boolean;
  v_att_ok boolean;
  v_cmp_ok boolean;
begin
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null and x.twilio_account_sid = v_account;
  select * into v_a from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_attach' and x.status = 'succeeded' and x.superseded_at is null and x.twilio_account_sid = v_account;
  v_ready := public._tw4sr_ready_core(p_studio_id);   -- the PR #249 readiness: the activation checklist cannot depend on being active already
  v_sender_ok := v_ready.id is not null and v_ms.id is not null and v_qe.id is not null and v_p.id is not null
    and v_ready.account_sid = v_account and v_ready.messaging_service_sid = v_ms.provider_sid and v_ready.campaign_sid = v_qe.provider_sid
    and v_ready.phone_number_sid = v_p.provider_sid and v_ready.sender_e164 = v_p.e164;
  select * into v_att from public.studio_sms_optout_attestations a where a.studio_id = p_studio_id order by a.created_at desc limit 1;
  v_att_ok := v_att.id is not null and v_att.created_at > now() - interval '30 days' and v_att.twilio_account_sid = v_account
    and v_att.messaging_service_sid = v_ms.provider_sid and v_att.campaign_sid = v_qe.provider_sid;
  select * into v_cmp from public.studio_sms_compliance_checks c where c.studio_id = p_studio_id order by c.created_at desc limit 1;
  v_cmp_ok := v_cmp.id is not null and v_cmp.outcome = 'passed' and v_cmp.created_at > now() - interval '24 hours' and v_cmp.twilio_account_sid = v_account
    and v_cmp.messaging_service_sid = v_ms.provider_sid and v_cmp.campaign_sid = v_qe.provider_sid
    and v_cmp.expected_inbound = (select pn.origin || '/api/sms/twilio/inbound' from public.studio_sms_inbound_route_pins pn order by pn.id desc limit 1);   -- judged against the CURRENT pin
  return jsonb_build_array(
    jsonb_build_object('id', 'subaccount_active', 'ok', v_account is not null, 'detail', case when v_account is null then 'no_active_subaccount' else 'ok' end),
    jsonb_build_object('id', 'service_ready', 'ok', v_ms.id is not null, 'detail', case when v_ms.id is null then 'service_not_ready' else 'ok' end),
    jsonb_build_object('id', 'campaign_verified', 'ok', v_qe.id is not null, 'detail', case when v_qe.id is null then 'campaign_not_verified' else 'ok' end),
    jsonb_build_object('id', 'number_owned', 'ok', v_p.id is not null and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_p.id and r.status = 'owned'),
      'detail', case when v_p.id is null then 'no_purchase' else 'ok' end),
    jsonb_build_object('id', 'number_attached', 'ok', v_a.id is not null and v_p.id is not null and v_a.provider_sid = v_p.provider_sid
      and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = v_a.id and r.status = 'attached'), 'detail', case when v_a.id is null then 'no_attachment' else 'ok' end),
    jsonb_build_object('id', 'sender_ready', 'ok', coalesce(v_sender_ok, false), 'detail', case when coalesce(v_sender_ok, false) then 'ok' when v_ready.id is null then 'sender_not_verified_or_stale' else 'sender_differs_from_ledger' end),
    jsonb_build_object('id', 'opt_out_attested', 'ok', coalesce(v_att_ok, false), 'detail', case when coalesce(v_att_ok, false) then 'ok' else 'attestation_missing_or_stale' end),
    jsonb_build_object('id', 'compliance_passed', 'ok', coalesce(v_cmp_ok, false), 'detail', case when coalesce(v_cmp_ok, false) then 'ok' when v_cmp.id is null then 'no_compliance_check' else 'compliance_failed_or_stale' end),
    jsonb_build_object('id', 'inbound_route_pinned', 'ok', exists (select 1 from public.studio_sms_inbound_route_pins), 'detail', case when exists (select 1 from public.studio_sms_inbound_route_pins) then 'ok' else 'inbound_route_not_pinned' end),
    jsonb_build_object('id', 'funding_continuity', 'ok', (v_fund ->> 'ok')::boolean, 'detail', v_fund ->> 'detail'));
end $$;

create or replace function public.tw4_act_check(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_items jsonb;
  v_p public.studio_sms_num_operations;
  v_s public.studio_sms_billed_senders;
begin
  perform public._tw4c_admin(p_actor);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  v_items := public._tw4act_items(p_studio_id);
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null;
  v_s := public._tw4sr_latest(p_studio_id);
  return jsonb_build_object('state', o.state, 'items', v_items, 'ready', not exists (select 1 from jsonb_array_elements(v_items) i where (i ->> 'ok')::boolean is not true),
    -- the identifiers the ledger holds (the server reads these resources; it never takes an identifier from a form)
    'ledger', jsonb_build_object('account_sid', public._tw4num_account(p_studio_id), 'messaging_service_sid', (public._tw4num_service(p_studio_id)).provider_sid,
      'campaign_sid', (public._tw4num_campaign(p_studio_id)).provider_sid, 'phone_number_sid', v_p.provider_sid, 'e164', v_p.e164,
      'sender_id', case when v_s.id is not null and v_s.status in ('pending', 'approved') then v_s.id end));
end $$;

-- the order begin and tw4_recurring_revoke use: entity row, then the credit account, then the authorizations: a revocation or a hold cannot commit between the read and the state change
create or replace function public._tw4act_lock_funding(p_studio_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return;
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for no key update;
  perform public._tw4c_lock(v_entity);
  perform 1 from public.studio_sms_recurring_authorizations ra where ra.legal_entity_id = v_entity and ra.studio_id = p_studio_id and ra.status = 'active' for share;
end $$;

create or replace function public._tw4act_require(p_studio_id uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_bad text;
begin
  select string_agg(i ->> 'id' || ':' || coalesce(i ->> 'detail', '?'), ',') into v_bad from jsonb_array_elements(public._tw4act_items(p_studio_id)) i where (i ->> 'ok')::boolean is not true;
  if v_bad is not null then
    raise exception 'activation checklist unmet: %', v_bad using errcode = 'TW042';
  end if;
end $$;

create or replace function public.tw4_act_mark_ready(p_studio_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state <> 'campaign_pending' then
    raise exception 'onboarding state % cannot be marked ready', coalesce(o.state, 'none') using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  perform public._tw4act_lock_funding(p_studio_id);
  perform public._tw4act_require(p_studio_id);
  update public.studio_sms_onboarding set state = 'ready_for_activation', step = 'A1', last_error_code = null, last_error_field = null where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'campaign_pending', 'ready_for_activation', left(btrim(p_note), 250));
  perform public._tw4_r1_audit(o, p_actor, 'activation_ready', o.state, o.state, 'checklist passed');
  return jsonb_build_object('state', o.state);
end $$;

create or replace function public.tw4_act_activate(p_studio_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_from text;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state not in ('ready_for_activation', 'suspended') then
    raise exception 'onboarding state % cannot be activated', coalesce(o.state, 'none') using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  -- everything is re-evaluated NOW, in the same transaction as the state change (a verification, attestation or authorization that lapsed since "ready" blocks it)
  perform public._tw4act_lock_funding(p_studio_id);
  perform public._tw4act_require(p_studio_id);
  v_from := o.state;
  update public.studio_sms_onboarding set state = 'active', step = 'A2', last_error_code = null, last_error_field = null where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', v_from, 'active', left(btrim(p_note), 250));
  perform public._tw4_r1_audit(o, p_actor, 'activation_done', o.state, o.state, 'checklist passed');
  return jsonb_build_object('state', o.state);
end $$;

-- immediate stop: the sender is revoked (nothing is sent) and the onboarding is suspended. Reactivation needs the full checklist again.
create or replace function public.tw4_act_suspend(p_studio_id uuid, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  s public.studio_sms_billed_senders;
begin
  perform public._tw4c_admin(p_actor);
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(p_studio_id);
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state <> 'active' then
    raise exception 'only an active onboarding is suspended' using errcode = 'TW030';
  end if;
  s := public._tw4sr_latest(p_studio_id);
  if s.id is not null and s.status in ('pending', 'approved') then
    perform public.tw4_sender_revoke(p_studio_id, p_actor, 'suspended: ' || btrim(p_reason), false);
  end if;
  update public.studio_sms_onboarding set state = 'suspended', step = 'A3' where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'active', 'suspended', left(btrim(p_reason), 250));
  perform public._tw4_r1_audit(o, p_actor, 'activation_suspended', o.state, o.state, 'sender revoked');
  return jsonb_build_object('state', o.state);
end $$;

-- the scheduler's input (R2a design 6.1): ready / active / suspended locations whose funding continuity fails or ends within 35 days. Read-only; nothing here sends or charges.
create or replace function public.tw4_act_exposure(p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(x.j order by x.sid, x.j ->> 'reason') from (
      -- 1. ready / active / suspended locations whose funding continuity fails
      select o.studio_id sid, jsonb_build_object('studio_id', o.studio_id, 'state', o.state, 'reason', 'funding_continuity', 'funding', public._tw4act_funding(o.studio_id)) j
        from public.studio_sms_onboarding o
       where o.state in ('ready_for_activation', 'active', 'suspended') and (public._tw4act_funding(o.studio_id) ->> 'ok')::boolean is not true
      union all
      -- 2. a number that MAY be paid for with no confirmed basis (unknown purchase outcome, ownership not confirmed or lost, attachment lost, subaccount not active, released but not retired)
      select s.sid, jsonb_build_object('studio_id', s.sid, 'reason', 'rent_basis_indeterminate', 'detail', s.b ->> 'reason', 'number', s.b ->> 'e164')
        from (select d.studio_id sid, public.tw4_num_rent_basis(d.studio_id) b from (select distinct studio_id from public.studio_sms_num_operations) d) s
       where s.b ->> 'state' = 'indeterminate'
      union all
      -- 3. a live number of the pilot business: its month two has no approval operation and DanceFlow pays Twilio meanwhile
      select s.sid, jsonb_build_object('studio_id', s.sid, 'reason', 'pilot_number_live', 'number', s.b ->> 'e164')
        from (select d.studio_id sid, public.tw4_num_rent_basis(d.studio_id) b from (select distinct studio_id from public.studio_sms_num_operations) d) s
       where s.b ->> 'state' = 'billable' and (s.b ->> 'pilot')::boolean
      union all
      -- 4. a live number with no active rent authorization (credit businesses): DanceFlow pays Twilio and nothing is collected
      select p.studio_id, jsonb_build_object('studio_id', p.studio_id, 'reason', 'number_without_authorization', 'number', p.e164)
        from public.studio_sms_num_operations p
       where p.op_kind = 'number_purchase' and p.status = 'succeeded' and p.superseded_at is null
         and not exists (select 1 from public.studio_sms_pilot_exceptions y where y.legal_entity_id = p.legal_entity_id)
         and not exists (select 1 from public.studio_sms_recurring_authorizations a where a.studio_id = p.studio_id and a.kind = 'number' and a.status = 'active' and a.expires_at > now())
      union all
      -- 5. an active rent authorization on an R2b-managed location that has no number to bill (rent would be charged for nothing)
      select a.studio_id, jsonb_build_object('studio_id', a.studio_id, 'reason', 'authorization_without_number', 'authorization', a.id)
        from public.studio_sms_recurring_authorizations a
       where a.kind = 'number' and a.status = 'active' and a.expires_at > now()
         and (public.tw4_num_rent_basis(a.studio_id) ->> 'managed')::boolean and public.tw4_num_rent_basis(a.studio_id) ->> 'state' = 'not_billable'
    ) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- owner entry points (the ONLY way an owner approval is made): the actor is auth.uid(), never a parameter
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_select_as_owner(p_studio_id uuid, p_offer_id uuid, p_e164 text, p_ack_price_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in as the studio owner' using errcode = '42501';
  end if;
  return public.tw4_num_select(p_studio_id, auth.uid(), p_offer_id, p_e164, p_ack_price_cents, null);
end $$;

create or replace function public.tw4_num_withdraw_as_owner(p_studio_id uuid, p_selection_id uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in as the studio owner' using errcode = '42501';
  end if;
  if not exists (select 1 from public.user_studio_roles r where r.user_id = auth.uid() and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'only the studio owner withdraws through this entry point' using errcode = '42501';
  end if;
  return public.tw4_num_withdraw(p_studio_id, auth.uid(), p_selection_id, p_note);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the pinned inbound origin and the inventory acknowledgement
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_inbound_route_pin_set(p_actor uuid, p_origin text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_origin is null or p_origin !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{2,5})?$' or p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'an https origin and a written reason (10-300 characters) are required' using errcode = '22023';
  end if;
  insert into public.studio_sms_inbound_route_pins (origin, set_by, reason) values (p_origin, p_actor, btrim(p_reason));
  return jsonb_build_object('origin', p_origin);
end $$;

create or replace function public.tw4_num_inventory_observe(p_onboarding_id uuid, p_lease_owner text, p_sids text[])
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_known text[];
  v_unknown int;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_sids is null or cardinality(p_sids) > 1000 or exists (select 1 from unnest(p_sids) x where x is null or x !~ '^PN[0-9a-fA-F]{32}$') then
    raise exception 'an inventory of number sids is required' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  v_known := public._tw4num_known(v_entity);
  select count(*) into v_unknown from unnest(p_sids) x where not (x = any (v_known));
  insert into public.studio_sms_num_inventory_checks (onboarding_id, lease_owner, legal_entity_id, listed_count, unknown_count) values (o.id, p_lease_owner, v_entity, cardinality(p_sids), v_unknown);
  return jsonb_build_object('listed', cardinality(p_sids), 'unknown', v_unknown);
end $$;

create or replace function public.tw4_num_inventory_ack(p_studio_id uuid, p_actor uuid, p_phone_number_sid text, p_e164 text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_account text;
begin
  perform public._tw4c_admin(p_actor);
  if p_phone_number_sid is null or p_phone_number_sid !~ '^PN[0-9a-fA-F]{32}$' or p_note is null or char_length(btrim(p_note)) not between 10 and 300
     or (p_e164 is not null and p_e164 !~ '^\+1[2-9][0-9]{9}$') then
    raise exception 'a number sid and a written reason (10-300 characters) are required' using errcode = '22023';
  end if;
  v_entity := public._tw4sr_lock(p_studio_id);
  v_account := public._tw4num_account(p_studio_id);
  if v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  -- a number that a purchase declared "not created" turned up: that is a paid number the ledger got wrong, not a foreign one. It is investigated, never acknowledged away.
  if exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.op_kind = 'number_purchase' and x.status = 'abandoned' and (x.e164 = p_e164 or x.provider_sid = p_phone_number_sid)) then
    raise exception 'this number belongs to a purchase that was declared not created: investigate it, do not acknowledge it' using errcode = 'TW034';
  end if;
  insert into public.studio_sms_num_inventory_acks (legal_entity_id, twilio_account_sid, phone_number_sid, e164, acked_by, note)
  values (v_entity, v_account, p_phone_number_sid, p_e164, p_actor, btrim(p_note)) on conflict (twilio_account_sid, phone_number_sid) do nothing;
  return jsonb_build_object('acknowledged', p_phone_number_sid);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- RENT BASIS: the one question the recurring-fee lifecycle must ask before it charges number rent. A read-only contract; R2b changes no fee, charge or authorization.
-- live = this location has a purchase the provider's own read confirmed as OWNED in the business's ACTIVE subaccount, that was not retired, and whose sender row is not
-- released. Anything else (never bought, refused, abandoned, retired, provider ownership lost, subaccount suspended) is not a number to bill rent for.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4num_rent_basis_core(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_account text := public._tw4num_account(p_studio_id);
  p public.studio_sms_num_operations;
  r public.studio_sms_num_resources;
  v_latest public.studio_sms_billed_senders := public._tw4sr_latest(p_studio_id);
  v_pilot boolean;
  v_open public.studio_sms_num_operations;
begin
  select exists (select 1 from public.studio_sms_pilot_exceptions y join public.studio_sms_entity_studios es on es.legal_entity_id = y.legal_entity_id where es.studio_id = p_studio_id) into v_pilot;
  -- A purchase whose outcome is unknown MAY have bought a number: rent that may be owed is held, never forgiven.
  select * into v_open from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null;
  if v_open.id is not null then
    return jsonb_build_object('state', 'indeterminate', 'live', false, 'reason', 'purchase_outcome_unknown', 'pilot', v_pilot, 'e164', v_open.e164);
  end if;
  select * into p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null;
  if p.id is null then
    -- never bought, refused, declared not created, or retired: there is no number to bill rent for
    return jsonb_build_object('state', 'not_billable', 'live', false, 'reason', 'no_live_purchase', 'pilot', v_pilot);
  end if;
  select * into r from public.studio_sms_num_resources x where x.operation_id = p.id;
  -- from here a paid number exists or may exist: Twilio keeps billing it (also in a suspended subaccount), so anything short of "confirmed owned" is HELD, not forgiven
  if v_account is null or p.twilio_account_sid <> v_account then
    return jsonb_build_object('state', 'indeterminate', 'live', false, 'reason', 'subaccount_not_active', 'pilot', v_pilot, 'phone_number_sid', p.provider_sid, 'e164', p.e164);
  end if;
  if r.id is null or r.status <> 'owned' then
    return jsonb_build_object('state', 'indeterminate', 'live', false, 'reason', case when r.id is null then 'ownership_not_confirmed' else 'provider_ownership_lost' end,
      'pilot', v_pilot, 'phone_number_sid', p.provider_sid, 'e164', p.e164);
  end if;
  -- the number is still owned but its attachment read as lost: the sender is revoked and the location is in exception; the rent question is still open
  if exists (select 1 from public.studio_sms_num_operations a join public.studio_sms_num_resources ar on ar.operation_id = a.id
              where a.studio_id = p_studio_id and a.op_kind = 'number_attach' and a.status = 'succeeded' and a.superseded_at is null and ar.status = 'mismatch') then
    return jsonb_build_object('state', 'indeterminate', 'live', false, 'reason', 'attachment_lost', 'pilot', v_pilot, 'phone_number_sid', p.provider_sid, 'e164', p.e164);
  end if;
  if v_latest.id is not null and v_latest.phone_number_sid = p.provider_sid and v_latest.status = 'released' then
    -- released in the sender registry but not retired in the ledger: nobody has confirmed the number left the subaccount
    return jsonb_build_object('state', 'indeterminate', 'live', false, 'reason', 'released_not_retired', 'pilot', v_pilot, 'phone_number_sid', p.provider_sid, 'e164', p.e164);
  end if;
  -- billable on the strength of the LAST provider read (observation_age_seconds says how old it is; R2b has no refresh scheduler: the consumer applies its own freshness policy)
  return jsonb_build_object('state', 'billable', 'live', true, 'reason', 'ok', 'pilot', v_pilot, 'phone_number_sid', p.provider_sid, 'e164', p.e164, 'confirmed_at', r.verified_at,
    'last_observed_at', r.observed_at, 'observation_age_seconds', floor(extract(epoch from (clock_timestamp() - r.observed_at)))::int);
end $$;

-- `managed`: the location has ANY R2b operation. A location with none (a number that predates R2b) has no ledger to judge: its rent is not gated by this contract.
create or replace function public.tw4_num_rent_basis(p_studio_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select public._tw4num_rent_basis_core(p_studio_id) || jsonb_build_object('managed', not exists (
  select 1 from public.studio_sms_billed_senders s where s.studio_id = p_studio_id and s.phone_number_sid is not null
     and not exists (select 1 from public.studio_sms_num_operations o where o.provider_sid = s.phone_number_sid))); $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4num_guard(), public._tw4num_account(uuid), public._tw4num_service(uuid), public._tw4num_campaign(uuid), public._tw4num_price(text),
  public._tw4num_taken(text, uuid), public._tw4num_reserve(public.studio_sms_onboarding, uuid, int), public._tw4num_requirements(uuid), public._tw4num_settle_if_held(uuid, text, text),
  public._tw4num_free_selection(uuid, uuid, text), public._tw4act_funding(uuid), public._tw4act_items(uuid), public._tw4act_require(uuid), public._tw4act_lock_funding(uuid), public._tw4num_credit_funded(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.tw4_num_offer_record(uuid, uuid, text, jsonb, jsonb, text, text), public.tw4_num_select(uuid, uuid, uuid, text, int, text), public.tw4_num_withdraw(uuid, uuid, uuid, text),
  public.tw4_num_claim(uuid, uuid, text, integer, text), public.tw4_num_context(uuid, text), public.tw4_num_begin(uuid, text, text, text, text, jsonb, uuid),
  public.tw4_num_finish(uuid, text, uuid, text, text, text, text), public.tw4_num_observe(uuid, text, uuid, jsonb, text, text), public.tw4_num_resolve(uuid, uuid, text, text, text),
  public.tw4_num_settle_admin(uuid, uuid, text, text), public.tw4_num_reopen(uuid, uuid, text), public.tw4_num_retire(uuid, uuid, text), public.tw4_num_record_sender(uuid, uuid),
  public.tw4_num_status(uuid, uuid), public.tw4_act_attest(uuid, uuid, jsonb, text), public.tw4_act_compliance_record(uuid, uuid, jsonb, text, text, text),
  public.tw4_act_verify_sender(uuid, uuid, uuid, jsonb, text), public.tw4_act_check(uuid, uuid), public.tw4_act_mark_ready(uuid, uuid, text), public.tw4_act_activate(uuid, uuid, text),
  public.tw4_act_suspend(uuid, uuid, text), public.tw4_act_exposure(uuid), public.tw4_inbound_route_pin_set(uuid, text, text), public.tw4_num_inventory_ack(uuid, uuid, text, text, text),
  public.tw4_num_rent_basis(uuid), public._tw4num_rent_basis_core(uuid), public.tw4_num_inventory_observe(uuid, text, text[]), public._tw4num_known(uuid), public.tw4_num_select_as_owner(uuid, uuid, text, int), public.tw4_num_withdraw_as_owner(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.tw4_num_rent_basis(uuid) to service_role;
grant execute on function public.tw4_num_offer_record(uuid, uuid, text, jsonb, jsonb, text, text), public.tw4_num_select(uuid, uuid, uuid, text, int, text), public.tw4_num_withdraw(uuid, uuid, uuid, text),
  public.tw4_num_claim(uuid, uuid, text, integer, text), public.tw4_num_context(uuid, text), public.tw4_num_begin(uuid, text, text, text, text, jsonb, uuid),
  public.tw4_num_finish(uuid, text, uuid, text, text, text, text), public.tw4_num_observe(uuid, text, uuid, jsonb, text, text), public.tw4_num_resolve(uuid, uuid, text, text, text),
  public.tw4_num_settle_admin(uuid, uuid, text, text), public.tw4_num_reopen(uuid, uuid, text), public.tw4_num_retire(uuid, uuid, text), public.tw4_num_record_sender(uuid, uuid),
  public.tw4_num_status(uuid, uuid), public.tw4_act_attest(uuid, uuid, jsonb, text), public.tw4_act_compliance_record(uuid, uuid, jsonb, text, text, text),
  public.tw4_act_verify_sender(uuid, uuid, uuid, jsonb, text), public.tw4_act_check(uuid, uuid), public.tw4_act_mark_ready(uuid, uuid, text), public.tw4_act_activate(uuid, uuid, text),
  public.tw4_act_suspend(uuid, uuid, text), public.tw4_act_exposure(uuid), public.tw4_inbound_route_pin_set(uuid, text, text), public.tw4_num_inventory_ack(uuid, uuid, text, text, text),
  public.tw4_num_rent_basis(uuid), public.tw4_num_inventory_observe(uuid, text, text[]) to service_role;
-- the two owner entry points are the ONLY R2b functions an authenticated user can run; each derives the actor from auth.uid()
grant execute on function public.tw4_num_select_as_owner(uuid, uuid, text, int), public.tw4_num_withdraw_as_owner(uuid, uuid, text) to authenticated;

commit;
