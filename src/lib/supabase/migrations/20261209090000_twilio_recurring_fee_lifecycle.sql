-- 20261209090000_twilio_recurring_fee_lifecycle.sql
-- TW-4F recurring provider-fee lifecycle integrity (design docs/twilio/TW-4F_Recurring_Fee_Lifecycle_Design.md).
-- Twilio keeps billing a live campaign / phone number to the subaccount whether or not the owner's recurring authorization is still valid, the prepaid credit is
-- exhausted, or DanceFlow stopped sending. This layer makes that exposure VISIBLE, BOUNDED and ACTIONABLE without inventing consent and without touching Twilio:
--   * studio_sms_provider_resources   inventory of the recurring-fee provider resources (campaign, number; the free Messaging Service is tracked for identity), stamped
--                                     with the legal business's ACTIVE subaccount. provider_state ('active' | 'cancelled') is what Twilio is doing; DanceFlow's own sending
--                                     state (sender approved / credit hold / service state) is a SEPARATE axis and is never inferred from it.
--   * studio_sms_provider_cover       first-period cover (an existing fee reservation) and the pilot business's per-period written approvals (the pilot ceiling is
--                                     consumed through the same credit reservations: no standing authorization, no new money path).
--   * studio_sms_provider_exposure    one row per (resource, service period) that is NOT covered by an owner authorization / approval past the same 7-day grace the
--                                     sending gate uses, plus any provider bill recorded against an uncovered period or after a confirmed cancellation. Exposure is
--                                     closed by cover or by an explicit, written administrator disposition; it is never closed silently by time.
--   * studio_sms_provider_cancel_ops  the auditable path for an authorized provider cancellation: authorized (explicit written decision + irreversibility
--                                     acknowledgement) -> in_flight (single claim) -> confirmed | refused | unknown_outcome -> resolved. A number is never cancelled on a
--                                     "policy" decision, never while it is the live sender, and nothing here calls Twilio: the platform administrator performs the console
--                                     step and records the evidence.
--   * studio_sms_provider_alerts      de-duplicated alert outbox (owner / platform administrators), claimed and delivered by the application runner.
--   * The sending gate: _tw4rc_service_state (consulted by every billed send, never by STOP/START/HELP compliance replies) now also reports 'suspended' when a
--     registered live resource has an uncovered period past grace. Suspension stops DanceFlow's sending ONLY; it never cancels or releases anything at Twilio.
-- Nothing here extends an authorization, borrows against a negative balance, charges Stripe, buys, cancels or releases a Twilio resource, or sends an SMS.
-- Requires 20261205090000 (and its predecessors). Independent of PR #251 (20261206), R2a (20261207) and R2b (20261208): soft links only (source_operation_id has no FK).
-- Rollback: rollback/20261209090000_twilio_recurring_fee_lifecycle_rollback.sql (refuses once any resource / cover / exposure / cancel operation / alert exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_reconcile_runs') is null or to_regprocedure('public._tw4rc_service_state(uuid)') is null
     or to_regprocedure('public.tw4_sender_revoke(uuid,uuid,text,boolean)') is null or to_regprocedure('public.tw4_credit_set_hold(uuid,boolean,text,uuid)') is null
     or to_regprocedure('public.tw4_spend_authorize(uuid,text,integer,text,uuid,text,uuid)') is null or to_regprocedure('public._tw4ml_month_key(uuid,timestamptz)') is null
     or to_regprocedure('public.tw4_recurring_charge(uuid,text,uuid)') is null
     or to_regprocedure('public.tw4_location_fee_kinds(uuid)') is null or to_regprocedure('public.tw4_credit_record_provider_charge(uuid,uuid,text,text,integer,uuid)') is null then
    raise exception 'recurring-fee-lifecycle precondition failed: 20261205090000 (and its predecessors) are not applied';
  end if;
  if to_regclass('public.studio_sms_provider_resources') is not null then
    raise exception 'recurring-fee-lifecycle precondition failed: already applied';
  end if;
  -- the sending gate replaced below must still be the 20261128 version (another slice must not be clobbered silently)
  if position('a pilot business is governed by per-operation approvals' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4rc_service_state(uuid)'::regprocedure)) = 0
     or position('_tw4ml_month_key' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4rc_service_state(uuid)'::regprocedure)) = 0 then
    raise exception 'recurring-fee-lifecycle precondition failed: _tw4rc_service_state differs from 20261128090000';
  end if;
  if position('owner decision (PR 248)' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_recurring_charge(uuid,text,uuid)'::regprocedure)) = 0 then
    raise exception 'recurring-fee-lifecycle precondition failed: tw4_recurring_charge differs from 20261203090000';
  end if;
end $$;

-- the permanent approval-reference registry (20261202) also holds cancellation decisions: one written reference authorizes one thing, once, across fees, pilot,
-- spending limits and provider cancellations. The constraints are EXTENDED from their live definitions (never rebuilt from a fixed list), so a sibling migration
-- that added its own source (R2b: 'number_selection') keeps it, in either apply order.
do $$
declare
  v_src text;
  v_shape text;
  v_sources text[];
begin
  select pg_get_constraintdef(c.oid) into v_src from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_source_check';
  select pg_get_constraintdef(c.oid) into v_shape from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_shape';
  if v_src is null or v_shape is null then
    raise exception 'recurring-fee-lifecycle precondition failed: the approval-reference constraints are missing';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_sources from regexp_matches(substring(v_src from 'ANY ((.*))'), '([a-z_]+)', 'g') m where m[1] not in ('text', 'array');
  if v_sources is null or cardinality(v_sources) < 2 then
    raise exception 'could not read the approval-reference sources from %', v_src;
  end if;
  v_sources := (select array_agg(distinct x order by x) from unnest(v_sources || array['cancellation']) x);
  alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_source_check;
  execute format('alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_source_check check (source = any (%L::text[]))', v_sources);
  if position('cancellation' in v_shape) = 0 then
    alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_shape;
    execute 'alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_shape ' || left(v_shape, length(v_shape) - 1)
      || ' OR (source = ''cancellation''::text AND spend_event_id IS NULL AND kind IS NULL AND amount_cents IS NULL AND funding IS NULL AND studio_id IS NOT NULL))';
  end if;
end $$;

-- audit vocabulary: the live list plus the lifecycle actions (extended, not replaced)
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
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array[
    'rfl_registered', 'rfl_cover_recorded', 'rfl_exposure_opened', 'rfl_exposure_closed', 'rfl_exposure_disposed', 'rfl_provider_billed', 'rfl_df_suspended',
    'rfl_cancel_authorized', 'rfl_cancel_started', 'rfl_cancel_confirmed', 'rfl_cancel_refused', 'rfl_cancel_unknown', 'rfl_cancel_resolved', 'rfl_cancel_withdrawn']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges; everything goes through the functions below)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_provider_resources (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  studio_id uuid not null,   -- the LOCATION the resource serves (a number is per location)
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),   -- the business's ACTIVE subaccount at registration; never changes
  resource_kind text not null check (resource_kind in ('messaging_service', 'campaign', 'number')),
  provider_sid text not null,
  e164 text null check (e164 is null or e164 ~ '^\+[1-9][0-9]{7,14}$'),
  fee_kind text null check (fee_kind in ('number', 'monthly', 'monthly_low_volume')),   -- derived by the database from the kind and the location's verified path
  source text not null check (source in ('r2a', 'r2b', 'admin')),
  source_operation_id uuid null,   -- soft link to the provisioning ledger row (R2a / R2b); no foreign key so this layer stands alone
  provider_state text not null default 'active' check (provider_state in ('active', 'cancelled')),
  registered_by uuid not null,
  registered_at timestamptz not null default clock_timestamp(),
  cancelled_at timestamptz null,
  cancel_evidence_digest text null check (cancel_evidence_digest is null or cancel_evidence_digest ~ '^[0-9a-f]{64}$'),
  constraint studio_sms_provider_resources_sid_shape check (
    (resource_kind = 'messaging_service' and provider_sid ~ '^MG[0-9a-fA-F]{32}$') or (resource_kind = 'campaign' and provider_sid ~ '^QE[0-9a-fA-F]{32}$')
    or (resource_kind = 'number' and provider_sid ~ '^PN[0-9a-fA-F]{32}$')),
  constraint studio_sms_provider_resources_fee_shape check (
    (resource_kind = 'messaging_service' and fee_kind is null) or (resource_kind = 'campaign' and fee_kind in ('monthly', 'monthly_low_volume'))
    or (resource_kind = 'number' and fee_kind = 'number')),
  constraint studio_sms_provider_resources_e164_shape check ((resource_kind = 'number') = (e164 is not null)),
  constraint studio_sms_provider_resources_cancelled check ((provider_state = 'cancelled') = (cancelled_at is not null and cancel_evidence_digest is not null)),
  constraint studio_sms_provider_resources_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
-- one provider resource is one inventory row, forever (a cancelled one stays as history)
create unique index studio_sms_provider_resources_sid on public.studio_sms_provider_resources (provider_sid);
-- ONE live resource of each kind per location: the authorization and the fee are per location and kind, so a second live number or campaign would be provider spending
-- no owner authorized. A replacement is registered only after the first is confirmed cancelled.
create unique index studio_sms_provider_resources_one_live on public.studio_sms_provider_resources (studio_id, resource_kind) where provider_state = 'active';
create index studio_sms_provider_resources_entity on public.studio_sms_provider_resources (legal_entity_id) where provider_state = 'active';
create index studio_sms_provider_resources_studio on public.studio_sms_provider_resources (studio_id);

create table public.studio_sms_provider_cover (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.studio_sms_provider_resources(id) on delete restrict,
  legal_entity_id uuid not null,
  studio_id uuid not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  basis text not null check (basis in ('initial_reservation', 'pilot_approval')),
  reservation_id uuid not null references public.studio_sms_credit_reservations(id) on delete restrict,
  spend_event_id uuid null references public.studio_sms_spend_events(id) on delete restrict,
  approval_ref text null,
  recorded_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_provider_cover_period unique (resource_id, period_key),
  constraint studio_sms_provider_cover_reservation unique (reservation_id),
  constraint studio_sms_provider_cover_shape check ((basis = 'pilot_approval') = (spend_event_id is not null and approval_ref is not null)),
  constraint studio_sms_provider_cover_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);

create table public.studio_sms_provider_exposure (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.studio_sms_provider_resources(id) on delete restrict,
  legal_entity_id uuid not null,
  studio_id uuid not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  state text not null default 'open' check (state in ('open', 'closed')),
  reason text not null check (reason in ('no_authorization', 'authorization_expired', 'authorization_revoked', 'not_authorized_period', 'awaiting_charge', 'charge_unfunded',
    'charge_held', 'charge_refused', 'no_pilot_approval', 'provider_billed_uncovered', 'billed_after_cancellation', 'replacement_unfunded')),
  expected_provider_cents int null check (expected_provider_cents is null or expected_provider_cents >= 0),   -- the published expected provider cost (internal)
  provider_billed_cents int not null default 0 check (provider_billed_cents >= 0),   -- what Twilio actually billed, from recorded provider-charge evidence
  provider_charge_refs text[] not null default '{}',
  first_detected_at timestamptz not null default clock_timestamp(),
  last_detected_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz null,
  disposition text null check (disposition in ('covered_by_charge', 'covered_by_reservation', 'covered_by_pilot_approval', 'provider_resource_cancelled', 'absorbed', 'not_billed_confirmed')),
  disposed_by uuid null,
  disposition_note text null check (disposition_note is null or char_length(disposition_note) between 10 and 500),
  constraint studio_sms_provider_exposure_period unique (resource_id, period_key),
  constraint studio_sms_provider_exposure_closed check ((state = 'closed') = (closed_at is not null and disposition is not null)),
  constraint studio_sms_provider_exposure_manual check ((disposition in ('absorbed', 'not_billed_confirmed')) = (disposed_by is not null and disposition_note is not null)
    or disposition is null),
  constraint studio_sms_provider_exposure_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_provider_exposure_open on public.studio_sms_provider_exposure (legal_entity_id) where state = 'open';

create table public.studio_sms_provider_cancel_ops (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.studio_sms_provider_resources(id) on delete restrict,
  legal_entity_id uuid not null,
  studio_id uuid not null,
  status text not null default 'authorized' check (status in ('authorized', 'in_flight', 'unknown_outcome', 'confirmed', 'refused', 'abandoned', 'withdrawn')),
  decided_by text not null check (decided_by in ('owner_written', 'founder_written', 'policy_lapse')),
  approval_ref text not null check (char_length(btrim(approval_ref)) between 10 and 200),
  ref_norm text not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 500),
  irreversible_ack boolean not null check (irreversible_ack),
  authorized_by uuid not null,
  authorized_at timestamptz not null default clock_timestamp(),
  started_by uuid null,
  started_at timestamptz null,
  finished_at timestamptz null,
  evidence_digest text null check (evidence_digest is null or evidence_digest ~ '^[0-9a-f]{64}$'),
  error_code text null check (error_code is null or char_length(error_code) <= 64),
  resolved_by uuid null,
  resolved_at timestamptz null,
  resolution_note text null check (resolution_note is null or char_length(resolution_note) between 10 and 500),
  constraint studio_sms_provider_cancel_ops_ref unique (ref_norm),
  constraint studio_sms_provider_cancel_ops_confirmed check (status <> 'confirmed' or evidence_digest is not null),
  constraint studio_sms_provider_cancel_ops_started check ((status in ('authorized', 'withdrawn')) or (started_by is not null and started_at is not null)),
  constraint studio_sms_provider_cancel_ops_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
-- one OPEN cancellation per resource: a duplicate claim or a second authorization can never be recorded
create unique index studio_sms_provider_cancel_ops_one_open on public.studio_sms_provider_cancel_ops (resource_id) where status in ('authorized', 'in_flight', 'unknown_outcome');

create table public.studio_sms_provider_alerts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  studio_id uuid null,
  resource_id uuid null references public.studio_sms_provider_resources(id) on delete restrict,
  kind text not null check (kind in ('authorization_expiring', 'next_period_uncovered', 'pilot_approval_needed', 'funding_low', 'negative_balance', 'account_on_hold',
    'exposure_open', 'provider_variance', 'inventory_gap', 'cancel_unknown', 'cancelled_authorization_active', 'charged_after_cancellation', 'released_resource_active')),
  dedupe_key text not null check (char_length(dedupe_key) between 3 and 200),
  audience text not null check (audience in ('owner', 'admin', 'both')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  summary text not null check (char_length(summary) between 5 and 300),   -- never a provider cost, a token or a message body
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts int not null default 0 check (attempts >= 0),
  claim_token uuid null,
  claimed_at timestamptz null,
  delivered_at timestamptz null,
  last_error text null check (last_error is null or char_length(last_error) <= 120),
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_provider_alerts_once unique (kind, dedupe_key),
  constraint studio_sms_provider_alerts_delivered check ((status = 'delivered') = (delivered_at is not null))
);
create index studio_sms_provider_alerts_pending on public.studio_sms_provider_alerts (created_at) where status in ('pending', 'sending', 'failed');

revoke all on public.studio_sms_provider_resources, public.studio_sms_provider_cover, public.studio_sms_provider_exposure, public.studio_sms_provider_cancel_ops,
  public.studio_sms_provider_alerts from public, anon, authenticated, service_role;
alter table public.studio_sms_provider_resources enable row level security;
alter table public.studio_sms_provider_cover enable row level security;
alter table public.studio_sms_provider_exposure enable row level security;
alter table public.studio_sms_provider_cancel_ops enable row level security;
alter table public.studio_sms_provider_alerts enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- guards: history is never deleted; identity never changes; every state moves only along its graph
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4rfl_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%: lifecycle evidence is never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_provider_resources' then
    if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.twilio_account_sid is distinct from old.twilio_account_sid or new.resource_kind is distinct from old.resource_kind or new.provider_sid is distinct from old.provider_sid
       or new.e164 is distinct from old.e164 or new.fee_kind is distinct from old.fee_kind or new.source is distinct from old.source
       or new.source_operation_id is distinct from old.source_operation_id or new.registered_by is distinct from old.registered_by or new.registered_at is distinct from old.registered_at then
      raise exception 'studio_sms_provider_resources: the identity of a resource is fixed' using errcode = '42501';
    end if;
    if old.provider_state = 'cancelled' and new is distinct from old then
      raise exception 'studio_sms_provider_resources: a cancelled resource is final' using errcode = '42501';
    end if;
    if new.provider_state is distinct from old.provider_state and coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_resources: the provider state changes only through the cancellation functions' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_provider_cover' then
    raise exception 'studio_sms_provider_cover: cover records are permanent' using errcode = '42501';
  elsif tg_table_name = 'studio_sms_provider_exposure' then
    if new.id is distinct from old.id or new.resource_id is distinct from old.resource_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.period_key is distinct from old.period_key or new.first_detected_at is distinct from old.first_detected_at
       or new.provider_billed_cents < old.provider_billed_cents or coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_exposure: identity is fixed, billed evidence never decreases, rows change only through the lifecycle functions' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_provider_cancel_ops' then
    if new.id is distinct from old.id or new.resource_id is distinct from old.resource_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.studio_id is distinct from old.studio_id or new.decided_by is distinct from old.decided_by or new.approval_ref is distinct from old.approval_ref
       or new.ref_norm is distinct from old.ref_norm or new.reason is distinct from old.reason or new.irreversible_ack is distinct from old.irreversible_ack
       or new.authorized_by is distinct from old.authorized_by or new.authorized_at is distinct from old.authorized_at or coalesce(current_setting('tw4.rfl_write', true), '') <> 'on' then
      raise exception 'studio_sms_provider_cancel_ops: the decision is fixed' using errcode = '42501';
    end if;
    if (old.status in ('confirmed', 'refused', 'withdrawn') or (old.status = 'abandoned' and new.status <> 'confirmed')) and new.status is distinct from old.status then
      raise exception 'studio_sms_provider_cancel_ops: % is final', old.status using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'authorized' and new.status in ('in_flight', 'withdrawn')) or (old.status = 'in_flight' and new.status in ('confirmed', 'refused', 'unknown_outcome'))
         or (old.status = 'unknown_outcome' and new.status in ('confirmed', 'abandoned')) or (old.status = 'in_flight' and new.status = 'abandoned')
         or (old.status = 'abandoned' and new.status = 'confirmed')) then
      raise exception 'studio_sms_provider_cancel_ops: % -> % is not a legal transition', old.status, new.status using errcode = '42501';
    end if;
  else
    -- alerts: identity and text are fixed; only the delivery fields move
    if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.resource_id is distinct from old.resource_id or new.kind is distinct from old.kind or new.dedupe_key is distinct from old.dedupe_key
       or new.audience is distinct from old.audience or new.severity is distinct from old.severity or new.summary is distinct from old.summary
       or new.created_at is distinct from old.created_at or new.attempts < old.attempts or (old.status = 'delivered' and new is distinct from old) then
      raise exception 'studio_sms_provider_alerts: only delivery fields change, and a delivered alert is final' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_provider_resources_guard before update or delete on public.studio_sms_provider_resources for each row execute function public._tw4rfl_guard();
create trigger studio_sms_provider_cover_guard before update or delete on public.studio_sms_provider_cover for each row execute function public._tw4rfl_guard();
create trigger studio_sms_provider_exposure_guard before update or delete on public.studio_sms_provider_exposure for each row execute function public._tw4rfl_guard();
create trigger studio_sms_provider_cancel_ops_guard before update or delete on public.studio_sms_provider_cancel_ops for each row execute function public._tw4rfl_guard();
create trigger studio_sms_provider_alerts_guard before update or delete on public.studio_sms_provider_alerts for each row execute function public._tw4rfl_guard();
create trigger studio_sms_provider_resources_truncate before truncate on public.studio_sms_provider_resources for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_provider_cover_truncate before truncate on public.studio_sms_provider_cover for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_provider_exposure_truncate before truncate on public.studio_sms_provider_exposure for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_provider_cancel_ops_truncate before truncate on public.studio_sms_provider_cancel_ops for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_provider_alerts_truncate before truncate on public.studio_sms_provider_alerts for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- internal helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4rfl_audit(p_studio uuid, p_actor uuid, p_action text, p_note text)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio, null, case when p_actor is null then 'system' else 'platform_admin' end, p_actor, p_action, left(p_note, 300));
$$;

-- lock order for every function here: the legal business row, then its credit account (the order tw4_spend_reserve uses), then the resource / operation rows
create or replace function public._tw4rfl_lock(p_entity uuid)
returns public.studio_sms_credit_accounts language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform 1 from public.studio_sms_legal_entities e where e.id = p_entity for no key update;
  return public._tw4c_lock(p_entity);
end $$;

-- the recurring-charge kinds that pay for a fee kind (a campaign's monthly kind follows its path; both are one fee)
create or replace function public._tw4rfl_charge_kinds(p_fee_kind text)
returns text[] language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select case p_fee_kind when 'number' then array['number'] when 'monthly' then array['monthly', 'monthly_low_volume'] when 'monthly_low_volume' then array['monthly', 'monthly_low_volume'] else array[]::text[] end; $$;

-- the grace after a period starts (or the resource is registered) before an uncovered period is exposure / suspends sending: the same 7 days _tw4rc_service_state uses
create or replace function public._tw4rfl_due_from(r public.studio_sms_provider_resources, p_key text)
returns timestamptz language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select greatest(public._tw4ml_month_start(r.legal_entity_id, p_key), r.registered_at) + interval '7 days'; $$;

-- Is the service period covered by an OWNER's explicit act? 'covered:<basis>' or 'uncovered:<reason>'. Time alone never covers anything.
create or replace function public._tw4rfl_cover(r public.studio_sms_provider_resources, p_key text)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_kinds text[] := public._tw4rfl_charge_kinds(r.fee_kind);
  v_start timestamptz;
  v_repl boolean;
  a public.studio_sms_recurring_authorizations;
  c public.studio_sms_recurring_charges;
begin
  if r.fee_kind is null then
    return 'covered:free';
  end if;
  v_start := public._tw4ml_month_start(r.legal_entity_id, p_key);
  -- a charge pays ONE resource's period: a replacement registered after its predecessor was cancelled inside the same period is a second bill Twilio sends
  v_repl := public._tw4rfl_replacement(r, p_key);
  if not v_repl and exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds)
              and x.period_key = p_key and x.status = 'charged') then
    return 'covered:charge';
  end if;
  if exists (select 1 from public.studio_sms_provider_cover pc join public.studio_sms_credit_reservations cr on cr.id = pc.reservation_id
              where pc.resource_id = r.id and pc.period_key = p_key and cr.status in ('reserved', 'captured')) then
    return 'covered:' || (select pc.basis from public.studio_sms_provider_cover pc where pc.resource_id = r.id and pc.period_key = p_key);
  end if;
  -- the authorization's first month is set aside from settled credit when the owner authorizes (the commitment), until the scheduler's charge takes its place
  if exists (select 1 from public.studio_sms_recurring_authorizations x join public.studio_sms_credit_reservations cr on cr.id = x.commitment_reservation_id
              where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds) and x.status = 'active' and x.expires_at > now()
                and cr.status = 'reserved' and public._tw4ml_month_key(r.legal_entity_id, x.starts_at) = p_key
                and not exists (select 1 from public.studio_sms_recurring_charges ch where ch.authorization_id = x.id and ch.period_key = p_key and ch.status <> 'charged')
                and not v_repl) then
    return 'covered:commitment';
  end if;
  if exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = r.legal_entity_id) then
    return 'uncovered:no_pilot_approval';   -- the pilot business has no standing authorization: every period needs its own written approval
  end if;
  if v_repl then
    return 'uncovered:replacement_unfunded';   -- the predecessor's charge paid the predecessor; the owner never authorized a second fee for this period
  end if;
  select * into a from public.studio_sms_recurring_authorizations x
   where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds) and x.status = 'active' and x.expires_at > now()
   order by x.created_at desc limit 1;
  if a.id is not null then
    if a.expires_at <= v_start then
      return 'uncovered:authorization_expired';
    end if;
    if a.starts_at >= public._tw4ml_month_start(r.legal_entity_id, public._tw4ml_key_add(p_key, 1)) then
      return 'uncovered:not_authorized_period';
    end if;
    select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = p_key;
    if c.id is null then
      return 'uncovered:awaiting_charge';
    end if;
    return 'uncovered:' || case c.status when 'unfunded' then 'charge_unfunded' when 'held' then 'charge_held' when 'refused' then 'charge_refused' else 'awaiting_charge' end;
  end if;
  if exists (select 1 from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds)
              and x.status = 'revoked') and not exists (select 1 from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id
              and x.studio_id = r.studio_id and x.kind = any (v_kinds) and x.status = 'active') then
    return 'uncovered:authorization_revoked';
  end if;
  if exists (select 1 from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id and x.kind = any (v_kinds)) then
    return 'uncovered:authorization_expired';
  end if;
  return 'uncovered:no_authorization';
end $$;

-- A period in which NO resource of this fee was live at the provider (before the first was registered, or in a gap between a cancelled one and its replacement):
-- there is nothing to charge for.
-- (A location that never registered a resource is NOT retired: charges before provisioning completes are unchanged.)
create or replace function public._tw4rfl_retired(p_entity uuid, p_studio uuid, p_kinds text[], p_key text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_provider_resources o
                  where o.studio_id = p_studio and o.legal_entity_id = p_entity and o.fee_kind = any (p_kinds))
     and not exists (select 1 from public.studio_sms_provider_resources o
                      where o.studio_id = p_studio and o.legal_entity_id = p_entity and o.fee_kind = any (p_kinds)
                        and o.registered_at < public._tw4ml_month_start(p_entity, public._tw4ml_key_add(p_key, 1))
                        and (o.provider_state = 'active' or o.cancelled_at >= public._tw4ml_month_start(p_entity, p_key)));
$$;

-- a resource registered after its predecessor (same location and kind) was cancelled inside this period: Twilio bills it separately from the predecessor
create or replace function public._tw4rfl_replacement(r public.studio_sms_provider_resources, p_key text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_provider_resources o
                  where o.studio_id = r.studio_id and o.resource_kind = r.resource_kind and o.id <> r.id and o.provider_state = 'cancelled'
                    and o.cancelled_at >= public._tw4ml_month_start(r.legal_entity_id, p_key) and r.registered_at >= o.cancelled_at);
$$;

-- is the number the location's live (or about to be live) sender? (looked at directly: the pending-cancellation gate must not make this check vacuous)
create or replace function public._tw4rfl_live_sender(r public.studio_sms_provider_resources)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_billed_senders s
                  where s.id = (select x.id from public.studio_sms_billed_senders x where x.studio_id = r.studio_id order by x.seq desc limit 1)
                    and s.status in ('approved', 'pending') and (s.phone_number_sid = r.provider_sid or s.sender_e164 = r.e164));
$$;

-- the sending gate: a registered LIVE recurring-fee resource of this location has an uncovered service period past grace (and no explicit administrator
-- disposition has accepted it). It stops DanceFlow's sending only.
create or replace function public._tw4rfl_gate_suspended(p_studio uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  v_cur text;
  v_first text;
  k text;
begin
  -- a cancellation that is authorized, claimed or unknown for any resource of this location: DanceFlow does not send through a resource that is being removed
  -- (a sender approval, a hold lift or a charge cannot reopen sending while the operation is open)
  if exists (select 1 from public.studio_sms_provider_cancel_ops o where o.studio_id = p_studio and o.status in ('authorized', 'in_flight', 'unknown_outcome')) then
    return true;
  end if;
  for r in select * from public.studio_sms_provider_resources x where x.studio_id = p_studio and x.provider_state = 'active' and x.fee_kind is not null order by x.id loop
    v_cur := public._tw4ml_month_key(r.legal_entity_id, now());
    v_first := public._tw4ml_month_key(r.legal_entity_id, r.registered_at);
    foreach k in array array[public._tw4ml_key_add(v_cur, -1), v_cur] loop
      continue when k < v_first;
      -- a past registration period that nothing covered is recorded as exposure but cannot suspend sending: the owner can no longer fix a period that began before
      -- their authorization could (the recurring charge refuses it); an administrator's disposition settles it
      continue when k = v_first and (k < v_cur or public._tw4rfl_replacement(r, k));
      continue when exists (select 1 from public.studio_sms_provider_exposure e where e.resource_id = r.id and e.period_key = k and e.state = 'closed' and e.disposition in ('absorbed', 'not_billed_confirmed'));
      if public._tw4rfl_cover(r, k) like 'uncovered:%' and now() > public._tw4rfl_due_from(r, k) then
        return true;
      end if;
    end loop;
  end loop;
  return false;
end $$;

create or replace function public._tw4rfl_alert(p_entity uuid, p_studio uuid, p_resource uuid, p_kind text, p_dedupe text, p_audience text, p_severity text, p_summary text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  insert into public.studio_sms_provider_alerts (legal_entity_id, studio_id, resource_id, kind, dedupe_key, audience, severity, summary)
  values (p_entity, p_studio, p_resource, p_kind, p_dedupe, p_audience, p_severity, left(p_summary, 300))
  on conflict (kind, dedupe_key) do nothing returning id into v_id;
  return v_id is not null;
end $$;

-- is DanceFlow sending for this location? (approved sender AND no credit hold AND the service state is not suspended). Independent of the provider state.
create or replace function public._tw4rfl_df_sending(p_studio uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v_entity uuid;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio;
  select * into s from public.studio_sms_billed_senders x where x.studio_id = p_studio order by x.seq desc limit 1;
  return s.id is not null and s.status = 'approved' and v_entity is not null
         and not coalesce((select a.hold from public.studio_sms_credit_accounts a where a.legal_entity_id = v_entity), false)
         and public._tw4rc_service_state(p_studio) is distinct from 'suspended';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the sending gate (replaces the 20261128 body; only the first statement is new)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4rc_service_state(p_studio_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  v_cur text;
  k text;
  v_state text := 'none';
  v_grace_from timestamptz;
begin
  if public._tw4rfl_gate_suspended(p_studio_id) then
    return 'suspended';   -- 20261209: a live recurring-fee resource whose period is not covered by an owner authorization / approval
  end if;
  for a in select * from public.studio_sms_recurring_authorizations x where x.studio_id = p_studio_id and x.status = 'active' and x.expires_at > now()
                and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = x.legal_entity_id) loop   -- a pilot business is governed by per-operation approvals, not by this state
    v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
    if v_state = 'none' then v_state := 'active'; end if;
    -- the current and the previous service month are the ones that can still be charged: an unpaid one that is still collectible keeps the service in its state
    foreach k in array array[public._tw4ml_key_add(v_cur, -1), v_cur] loop
      continue when k < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) or public._tw4ml_month_start(a.legal_entity_id, k) >= a.expires_at;
      -- paid under THIS or an earlier authorization of the same location and fee (revoke + authorize again must not make a paid month look overdue)
      continue when exists (select 1 from public.studio_sms_recurring_charges c where c.legal_entity_id = a.legal_entity_id and c.studio_id = a.studio_id and c.kind = a.kind and c.period_key = k and c.status = 'charged');
      continue when public._tw4rfl_retired(a.legal_entity_id, a.studio_id, public._tw4rfl_charge_kinds(a.kind), k);   -- 20261209: nothing left at the provider to pay for
      v_grace_from := greatest(public._tw4ml_month_start(a.legal_entity_id, k), a.starts_at);
      if now() > v_grace_from + interval '7 days' then
        return 'suspended';
      end if;
      v_state := 'past_due';
    end loop;
  end loop;
  return v_state;
end $$;

-- as of 20261203090000, with TWO added 'held' branches (an open cancellation of the location's resource; no resource of the fee live in the period): the first month's
-- commitment, limits, holds and funding checks are unchanged
create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_recurring_authorizations;
  acct public.studio_sms_credit_accounts;
  p public.studio_sms_price_list;
  c public.studio_sms_recurring_charges;
  cr public.studio_sms_credit_reservations;
  v_cur text;
  v_spent bigint;
  v_status text;
  v_reason text;
  v_res uuid;
  v_key text;
begin
  if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id;
  if a.id is null then
    raise exception 'unknown authorization' using errcode = '22023';
  end if;
  -- entity row first (the order tw4_spend_reserve / tw4_spend_authorize use), then the account row
  perform 1 from public.studio_sms_legal_entities le where le.id = a.legal_entity_id for no key update;
  acct := public._tw4c_lock(a.legal_entity_id);   -- the one lock every credit mutation takes: charges, top-ups, holds, limit changes and revocations are serialized
  -- a scheduler run is fenced by its lease and by the kill switch, checked AFTER the locks
  if p_run_id is not null and not exists (select 1 from public.studio_sms_recurring_runs r where r.id = p_run_id and r.status = 'running' and r.lease_expires_at > clock_timestamp()) then
    raise exception 'the scheduler run is not active' using errcode = '22023';
  end if;
  if p_run_id is not null and not coalesce((select l.enabled from public.studio_sms_recurring_switch_log l order by l.changed_at desc, l.id desc limit 1), false) then
    raise exception 'the scheduler is switched off' using errcode = '22023';
  end if;
  perform public._tw4ml_ensure_tz(a.legal_entity_id);
  v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
  -- only the current or the previous service month (in the business's timezone) can be charged: never the future, never ancient history
  if p_period_key <> v_cur and p_period_key <> public._tw4ml_key_add(v_cur, -1) then
    raise exception 'this period cannot be charged now' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id for update;
  select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = p_period_key for update;
  if c.id is not null and c.status = 'charged' then
    return jsonb_build_object('outcome', 'charged', 'replayed', true);
  end if;

  v_status := null;
  select coalesce(sum(x.amount_cents), 0) into v_spent from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.status = 'charged';
  select * into p from public.studio_sms_price_list x where x.kind = a.kind and x.active;
  -- the first month's set-aside funds, if still held, are what this charge captures (no second reservation); they are already counted in the month they were set aside in, so capturing them needs no new room
  if a.commitment_reservation_id is not null then
    select * into cr from public.studio_sms_credit_reservations x where x.id = a.commitment_reservation_id for update;
    if cr.id is not null and cr.status = 'reserved' then
    else
      cr := null;
    end if;
  end if;
  if a.status <> 'active' then
    v_status := 'refused'; v_reason := 'revoked';
  elsif a.expires_at <= now() or public._tw4ml_month_start(a.legal_entity_id, p_period_key) >= a.expires_at or p_period_key < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) then
    v_status := 'refused'; v_reason := 'outside the authorized term';
  elsif p.id is null or p.customer_price_cents <> a.price_cents then
    v_status := 'refused'; v_reason := 'price changed: the owner must authorize again';
  elsif exists (select 1 from public.studio_sms_provider_cancel_ops co join public.studio_sms_provider_resources cr2 on cr2.id = co.resource_id
                 where co.studio_id = a.studio_id and co.legal_entity_id = a.legal_entity_id and co.status in ('authorized', 'in_flight', 'unknown_outcome')
                   and cr2.fee_kind = any (public._tw4rfl_charge_kinds(a.kind))) then
    v_status := 'held'; v_reason := 'a cancellation of this location''s provider resource is open';   -- 20261209: retried once it is resolved; nothing is taken for a resource being removed
  elsif public._tw4rfl_retired(a.legal_entity_id, a.studio_id, public._tw4rfl_charge_kinds(a.kind), p_period_key) then
    v_status := 'held'; v_reason := 'no provider resource of this fee was live in that period: nothing left to charge for';   -- 20261209: never charge for a retired resource; held (not refused) so a later replacement is charged
  elsif exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id) then
    v_status := 'refused'; v_reason := 'pilot business: each recurring operation needs its own approval';   -- the pilot ceiling is never consumed by a schedule
  elsif exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = p_period_key and x.status = 'charged' and x.authorization_id <> a.id) then
    v_status := 'refused'; v_reason := 'this period was already charged under another authorization';   -- revoke + authorize again never charges one period twice
  elsif v_spent + a.price_cents > a.total_limit_cents then
    v_status := 'refused'; v_reason := 'authorized spending limit reached';
  -- owner decision (PR 248): an authorized recurring fee is checked against the month's spending WITHOUT inbound texts, so inbound volume (which can
  -- never be refused) cannot hold the business's phone number or messaging service; inbound still counts for everything else
  elsif cr.id is null and public._tw4in_spend_without_inbound(a.legal_entity_id, v_cur) + a.price_cents > public._tw4ml_effective_limit(a.legal_entity_id, v_cur) then
    v_status := 'held'; v_reason := 'monthly spending limit reached';   -- retried: next month, or when the owner raises the limit
  elsif acct.hold then
    v_status := 'held'; v_reason := 'the credit account is on hold';
  elsif (cr.id is null and (acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < a.price_cents))
     or (cr.id is not null and (acct.balance_cents < 0 or acct.balance_cents < cr.amount_cents)) then
    v_status := 'unfunded'; v_reason := 'insufficient settled credit';   -- settled credit only: a refunded or reversed top-up can leave a set-aside with nothing behind it; there is no fallback funding of any kind
  end if;

  if v_status is not null then
    if c.id is null then
      insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason, run_id)
      values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, v_status, v_reason, p_run_id);
    else
      update public.studio_sms_recurring_charges set status = v_status, reason = v_reason, attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
    end if;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (a.studio_id, null, 'system', null, 'recurring_' || v_status, left('authorization=' || a.id || ';period=' || p_period_key || ';' || v_reason, 300));
    return jsonb_build_object('outcome', v_status, 'reason', v_reason, 'replayed', false);
  end if;

  if cr.id is not null then
    -- capture the funds that were set aside when the owner authorized
    v_res := cr.id;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -cr.amount_cents, -cr.amount_cents, 'capture:' || cr.reservation_key, cr.id, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = cr.id;
  else
    -- funded and within the authorization: reserve and capture in one transaction (no reservation is ever left open by a charge)
    v_key := 'rec:' || a.id || ':' || p_period_key;
    insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
    values (a.legal_entity_id, a.studio_id, a.kind, a.price_cents, 'credit', v_key) returning id into v_res;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'reserve', 0, a.price_cents, 'reserve:' || v_key, v_res, 'recurring=' || a.id, null, null);
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -a.price_cents, -a.price_cents, 'capture:' || v_key, v_res, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = v_res;
  end if;
  if c.id is null then
    insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, charged_at, run_id)
    values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, 'charged', v_res, clock_timestamp(), p_run_id);
  else
    update public.studio_sms_recurring_charges set status = 'charged', reason = null, reservation_id = v_res, charged_at = clock_timestamp(), attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'system', null, 'recurring_charged', left('authorization=' || a.id || ';period=' || p_period_key || ';cents=' || a.price_cents, 300));
  return jsonb_build_object('outcome', 'charged', 'replayed', false, 'amount_cents', a.price_cents);
end $$;

-- a credit-funded ONE-OFF spend or reservation of a recurring fee kind is refused while the location holds a standing authorization of that fee: the same month
-- would be paid twice (the authorization's commitment and charges are the only way such a fee is paid from credit)
create or replace function public._tw4rfl_oneoff_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.kind not in ('number', 'monthly', 'monthly_low_volume') or new.funding is distinct from 'credit' then
    return new;
  end if;
  if tg_table_name = 'studio_sms_credit_reservations' and new.reservation_key ~ '^(rec|commit|rfl):' then
    return new;
  end if;
  if exists (select 1 from public.studio_sms_recurring_authorizations a
              where a.legal_entity_id = new.legal_entity_id and (new.studio_id is null or a.studio_id = new.studio_id) and a.status = 'active' and a.expires_at > now()
                and a.kind = any (public._tw4rfl_charge_kinds(new.kind))) then
    raise exception 'this fee is already covered by a standing authorization: a separate one-off credit approval would pay it twice' using errcode = 'TW041';
  end if;
  return new;
end $$;
create trigger studio_sms_spend_events_35_rfl before insert on public.studio_sms_spend_events for each row execute function public._tw4rfl_oneoff_guard();
create trigger studio_sms_credit_reservations_35_rfl before insert on public.studio_sms_credit_reservations for each row execute function public._tw4rfl_oneoff_guard();

-- a NEW authorization (a renewal, or a replacement) is refused while a cancellation of the same fee's resource at the location is open: the owner's explicit
-- decision to remove it comes first
create or replace function public._tw4rfl_auth_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (select 1 from public.studio_sms_provider_cancel_ops o join public.studio_sms_provider_resources r on r.id = o.resource_id
              where o.studio_id = new.studio_id and o.legal_entity_id = new.legal_entity_id and o.status in ('authorized', 'in_flight', 'unknown_outcome')
                and r.fee_kind = any (public._tw4rfl_charge_kinds(new.kind))) then
    raise exception 'a cancellation of this location''s provider resource is open: the authorization cannot be renewed until it is resolved' using errcode = 'TW041';
  end if;
  -- the reverse of _tw4rfl_oneoff_guard: a separate credit one-off of this fee (approved, reserved, or captured this month) would pay the same month a second time
  if exists (select 1 from public.studio_sms_spend_events e where e.legal_entity_id = new.legal_entity_id and (e.studio_id is null or e.studio_id = new.studio_id) and e.funding = 'credit'
               and e.status = 'authorized' and e.kind = any (public._tw4rfl_charge_kinds(new.kind)))   -- a reserved / captured one-off is judged by its reservation below (a spend event stays 'reserved' forever)
     or exists (select 1 from public.studio_sms_credit_reservations r where r.legal_entity_id = new.legal_entity_id and r.studio_id = new.studio_id and r.funding = 'credit'
               and r.kind = any (public._tw4rfl_charge_kinds(new.kind)) and r.reservation_key !~ '^(rec|commit|rfl):'
               and (r.status = 'reserved' or (r.status = 'captured' and r.created_at >= public._tw4ml_month_start(new.legal_entity_id, public._tw4ml_month_key(new.legal_entity_id, now()))))) then
    raise exception 'a separate one-off credit approval of this fee exists for the location: the standing authorization would pay the same month twice' using errcode = 'TW041';
  end if;
  return new;
end $$;
create trigger studio_sms_recurring_authorizations_30_rfl before insert on public.studio_sms_recurring_authorizations for each row execute function public._tw4rfl_auth_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- inventory
-- ---------------------------------------------------------------------------------------------------------------
-- Registers a provider resource that carries (or may carry) a recurring fee. Called by the provisioning flows (R2a/R2b) in the same transaction as the evidence
-- that the resource exists, or by a platform administrator for a resource found at the provider. The fee kind is derived HERE from the kind and the location's
-- verified registration path; the subaccount must be the business's ACTIVE one. An initial reservation (the first period's fee, already set aside or captured)
-- covers the registration period. Idempotent by provider sid; the same sid with different facts is refused.
create or replace function public.tw4_rfl_register(p_studio_id uuid, p_actor uuid, p_kind text, p_provider_sid text, p_account_sid text, p_e164 text, p_source text,
  p_source_operation uuid, p_initial_reservation uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_active text;
  v_fee text;
  v_path jsonb;
  r public.studio_sms_provider_resources;
  v_res public.studio_sms_credit_reservations;
  v_key text;
begin
  perform public._tw4c_admin(p_actor);
  if p_kind is null or p_kind not in ('messaging_service', 'campaign', 'number') or p_source is null or p_source not in ('r2a', 'r2b', 'admin')
     or p_provider_sid is null or p_account_sid is null then
    raise exception 'invalid resource' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'the studio is not linked to a verified legal business' using errcode = 'TW010';
  end if;
  perform public._tw4rfl_lock(v_entity);
  select t.twilio_account_sid into v_active from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status = 'active';
  if v_active is null or v_active <> p_account_sid then
    raise exception 'the resource is not on the business''s active subaccount' using errcode = 'TW040';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.provider_sid = p_provider_sid;
  if r.id is not null then
    if r.legal_entity_id <> v_entity or r.studio_id <> p_studio_id or r.resource_kind <> p_kind or r.twilio_account_sid <> p_account_sid or r.e164 is distinct from p_e164 then
      raise exception 'this provider resource is already registered with different facts' using errcode = 'TW040';
    end if;
    return jsonb_build_object('resource_id', r.id, 'replayed', true);
  end if;
  if exists (select 1 from public.studio_sms_provider_resources x where x.studio_id = p_studio_id and x.resource_kind = p_kind and x.provider_state = 'active') then
    raise exception 'this location already has a live % registered: cancel it (with evidence) before registering a replacement', p_kind using errcode = 'TW040';
  end if;
  if p_kind = 'number' then
    v_fee := 'number';
    if p_e164 is null then
      raise exception 'a number is registered with its E.164' using errcode = '22023';
    end if;
  elsif p_kind = 'campaign' then
    v_path := public.tw4_location_fee_kinds(p_studio_id);
    v_fee := v_path ->> 'campaign_monthly_kind';
    if v_fee is null then
      raise exception 'the location''s registration path is not verified: the campaign''s monthly kind is unknown' using errcode = 'TW040';
    end if;
  else
    v_fee := null;
  end if;
  insert into public.studio_sms_provider_resources (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, e164, fee_kind, source, source_operation_id, registered_by)
  values (v_entity, p_studio_id, p_account_sid, p_kind, p_provider_sid, p_e164, v_fee, p_source, p_source_operation, p_actor) returning * into r;
  if p_initial_reservation is not null then
    if v_fee is null then
      raise exception 'a free resource has no fee to cover' using errcode = '22023';
    end if;
    -- only the pilot business funds a registration period from a one-off reservation. Every other business's registration period is covered by its standing
    -- authorization (the first-month commitment, then the charge): a SECOND set-aside for the same month would be paid twice (the owner must hold the
    -- authorization BEFORE the resource is registered, as R2a already requires; R2b must not reserve a separate first-month fee for such a business)
    if not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity) then
      raise exception 'a business with standing authorizations is covered by them: no separate initial reservation' using errcode = 'TW040';
    end if;
    select * into v_res from public.studio_sms_credit_reservations x where x.id = p_initial_reservation for share;
    if v_res.id is null or v_res.legal_entity_id <> v_entity or v_res.studio_id <> p_studio_id or v_res.status not in ('reserved', 'captured')
       or v_res.kind <> v_fee or v_res.reservation_key ~ '^(rfl|rec|commit):' then
      raise exception 'the initial reservation does not belong to this resource''s fee' using errcode = 'TW040';
    end if;
    v_key := public._tw4ml_month_key(v_entity, r.registered_at);
    insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, recorded_by)
    values (r.id, v_entity, p_studio_id, v_key, 'initial_reservation', v_res.id, p_actor);
  end if;
  perform public._tw4rfl_audit(p_studio_id, p_actor, 'rfl_registered', 'resource=' || r.id || ';kind=' || p_kind || ';fee=' || coalesce(v_fee, 'none') || ';initial_cover=' || (p_initial_reservation is not null));
  return jsonb_build_object('resource_id', r.id, 'fee_kind', v_fee, 'replayed', false);
end $$;

-- the pilot business's written approval of ONE service period of ONE resource: authorized and reserved/captured through the existing pilot path, so the
-- permanent approval reference, the published price, the spend cap and the cumulative $150 ceiling all apply. Current or next period only (no retroactive approvals).
create or replace function public.tw4_rfl_pilot_cover(p_resource_id uuid, p_period_key text, p_approval_ref text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  pc public.studio_sms_provider_cover;
  a public.studio_sms_credit_accounts;
  pe public.studio_sms_pilot_exceptions;
  p public.studio_sms_price_list;
  v_cur text;
  v_spend uuid;
  v_res uuid;
  v_used bigint;
  v_rkey text;
begin
  perform public._tw4c_admin(p_actor);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null or p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_approval_ref is null then
    raise exception 'invalid pilot approval' using errcode = '22023';
  end if;
  a := public._tw4rfl_lock(r.legal_entity_id);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id for update;
  if r.provider_state <> 'active' or r.fee_kind is null then
    raise exception 'only a live recurring-fee resource needs a period approval' using errcode = 'TW041';
  end if;
  select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = r.legal_entity_id;
  if pe.legal_entity_id is null then
    raise exception 'period approvals are for the pilot business; every other business authorizes recurring charges itself' using errcode = 'TW042';
  end if;
  v_cur := public._tw4ml_month_key(r.legal_entity_id, now());
  if p_period_key < v_cur or p_period_key > public._tw4ml_key_add(v_cur, 1) then
    raise exception 'a period approval covers the current or the next service period only' using errcode = 'TW042';
  end if;
  select * into pc from public.studio_sms_provider_cover x where x.resource_id = r.id and x.period_key = p_period_key;
  if pc.id is not null then
    if pc.basis = 'pilot_approval' and pc.approval_ref = btrim(p_approval_ref) and pc.recorded_by = p_actor then
      return jsonb_build_object('cover_id', pc.id, 'replayed', true);
    end if;
    raise exception 'this period is already covered' using errcode = 'TW043';
  end if;
  if a.hold or a.balance_cents < 0 then
    raise exception 'the pilot exception cannot fund this period while the account is on hold or negative' using errcode = 'TW007';
  end if;
  select * into p from public.studio_sms_price_list x where x.kind = r.fee_kind and x.active;
  if p.id is null then
    raise exception 'no published price for %', r.fee_kind using errcode = 'TW008';
  end if;
  select coalesce(sum(cr.amount_cents), 0) into v_used from public.studio_sms_credit_reservations cr where cr.legal_entity_id = r.legal_entity_id and cr.funding = 'pilot' and cr.status in ('reserved', 'captured');
  if v_used + p.customer_price_cents > pe.ceiling_cents then
    raise exception 'the pilot ceiling would be exceeded' using errcode = 'TW007';
  end if;
  -- the permanent, location-attributed approval (replay-safe, price-checked, cap-checked, one written approval = one operation)
  v_spend := (public.tw4_spend_authorize(r.legal_entity_id, r.fee_kind, p.customer_price_cents, p_approval_ref, p_actor, 'pilot', r.studio_id) ->> 'spend_event_id')::uuid;
  v_rkey := 'rfl:' || r.id || ':' || p_period_key;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (r.legal_entity_id, r.studio_id, r.fee_kind, p.customer_price_cents, 'pilot', v_rkey) returning id into v_res;
  update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_rkey, reserved_at = now(), credit_reservation_id = v_res where id = v_spend;
  update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = v_res;   -- a recurring period fee is committed once approved
  insert into public.studio_sms_provider_cover (resource_id, legal_entity_id, studio_id, period_key, basis, reservation_id, spend_event_id, approval_ref, recorded_by)
  values (r.id, r.legal_entity_id, r.studio_id, p_period_key, 'pilot_approval', v_res, v_spend, btrim(p_approval_ref), p_actor) returning * into pc;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = 'covered_by_pilot_approval'
   where resource_id = r.id and period_key = p_period_key and state = 'open' and reason <> 'billed_after_cancellation';
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cover_recorded', 'resource=' || r.id || ';period=' || p_period_key || ';cents=' || p.customer_price_cents);
  return jsonb_build_object('cover_id', pc.id, 'amount_cents', p.customer_price_cents, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- scan: exposure and upcoming-charge alerts, one legal business at a time (under that business's account lock, so it serializes with recurring charges)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_scan_entities()
returns table (legal_entity_id uuid) language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select distinct x.legal_entity_id from (
    select r.legal_entity_id from public.studio_sms_provider_resources r where r.provider_state = 'active'
    union select e.legal_entity_id from public.studio_sms_provider_exposure e where e.state = 'open') x
  order by 1;
$$;

create or replace function public.tw4_rfl_scan_entity(p_entity_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  r public.studio_sms_provider_resources;
  v_cov text;
  v_cur text;
  v_nxt text;
  v_first text;
  k text;
  v_i int;
  v_reason text;
  v_expected int;
  v_opened int := 0;
  v_closed int := 0;
  v_alerts int := 0;
  v_pilot boolean;
  v_auth public.studio_sms_recurring_authorizations;
  v_next_total bigint := 0;
  e public.studio_sms_provider_exposure;
  v_exp_id uuid;
  v_charge record;
begin
  a := public._tw4rfl_lock(p_entity_id);
  v_pilot := exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = p_entity_id);
  v_cur := public._tw4ml_month_key(p_entity_id, now());
  v_nxt := public._tw4ml_key_add(v_cur, 1);
  for r in select * from public.studio_sms_provider_resources x where x.legal_entity_id = p_entity_id and x.provider_state = 'active' and x.fee_kind is not null order by x.id loop
    v_first := public._tw4ml_month_key(p_entity_id, r.registered_at);
    select p.provider_cost_cents into v_expected from public.studio_sms_price_list p where p.kind = r.fee_kind and p.active;
    -- catch-up: every period since registration (at most the last 12) is judged, so a scan that did not run for a while still records what went uncovered; the
    -- sending gate looks only at the previous and the current period (history never suspends by itself)
    for v_i in -11..0 loop
      k := public._tw4ml_key_add(v_cur, v_i);
      continue when k < v_first;
      v_cov := public._tw4rfl_cover(r, k);
      select * into e from public.studio_sms_provider_exposure x where x.resource_id = r.id and x.period_key = k for update;
      if v_cov like 'covered:%' then
        if e.id is not null and e.state = 'open' and e.reason <> 'billed_after_cancellation' then
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), last_detected_at = now(),
                 disposition = case v_cov when 'covered:charge' then 'covered_by_charge' when 'covered:pilot_approval' then 'covered_by_pilot_approval' else 'covered_by_reservation' end where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_closed', 'resource=' || r.id || ';period=' || k || ';by=' || v_cov);
          v_closed := v_closed + 1;
        end if;
      elsif now() > public._tw4rfl_due_from(r, k) or (e.id is not null and e.provider_billed_cents > 0) then
        v_reason := substr(v_cov, 11);
        if e.id is null then
          insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents)
          values (r.id, r.legal_entity_id, r.studio_id, k, v_reason, v_expected) returning id into v_exp_id;
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_opened', 'resource=' || r.id || ';period=' || k || ';reason=' || v_reason);
          perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'exposure_open', 'exposure:' || v_exp_id, 'both', 'critical',
            'A recurring provider fee is running without a current authorization (' || replace(v_reason, '_', ' ') || '). Texting for this location is suspended while its current or previous period stays uncovered.');
          v_opened := v_opened + 1;
        elsif e.state = 'open' then
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set last_detected_at = now(), reason = case when e.reason = 'billed_after_cancellation' then e.reason else v_reason end where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
        elsif e.disposition in ('covered_by_charge', 'covered_by_reservation', 'covered_by_pilot_approval') then
          -- cover disappeared (a released reservation): the period is exposed again; an administrator's written disposition is final and is not reopened by time
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set state = 'open', closed_at = null, disposition = null, reason = v_reason, last_detected_at = now() where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_opened', 'resource=' || r.id || ';period=' || k || ';reason=' || v_reason || ';reopened=true');
          v_opened := v_opened + 1;
        end if;
      end if;
    end loop;
    -- upcoming: will the NEXT period be covered by an owner act? (alerts only; nothing is extended or charged here)
    v_cov := public._tw4rfl_cover(r, v_nxt);
    if v_cov like 'uncovered:%' then
      if v_pilot then
        if public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'pilot_approval_needed', r.id || ':' || v_nxt, 'both', 'warning',
             'The ' || replace(r.resource_kind, '_', ' ') || ' fee for ' || v_nxt || ' needs a recorded written approval before that period starts.') then v_alerts := v_alerts + 1; end if;
      else
        select * into v_auth from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id
           and x.kind = any (public._tw4rfl_charge_kinds(r.fee_kind)) and x.status = 'active' and x.expires_at > now() order by x.created_at desc limit 1;
        if v_auth.id is not null and v_auth.expires_at > public._tw4ml_month_start(p_entity_id, v_nxt) and v_auth.total_limit_cents
             - coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = v_auth.id and c.status = 'charged'), 0) >= v_auth.price_cents then
          v_next_total := v_next_total + v_auth.price_cents;   -- the standing authorization will charge it: only funding can stop it
        else
          if public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'next_period_uncovered', r.id || ':' || v_nxt, 'both', 'warning',
               'The authorization for the ' || replace(r.resource_kind, '_', ' ') || ' fee ends or reaches its limit before ' || v_nxt || '. Renew it in your texting settings to keep texting on.') then v_alerts := v_alerts + 1; end if;
        end if;
      end if;
    end if;
  end loop;
  -- authorizations ending within 35 days (once per authorization)
  for v_auth in select x.* from public.studio_sms_recurring_authorizations x where x.legal_entity_id = p_entity_id and x.status = 'active' and x.expires_at > now()
                   and x.expires_at <= now() + interval '35 days' and exists (select 1 from public.studio_sms_provider_resources rr where rr.legal_entity_id = x.legal_entity_id
                   and rr.studio_id = x.studio_id and rr.provider_state = 'active' and rr.fee_kind = any (array[x.kind, case when x.kind = 'monthly' then 'monthly_low_volume' when x.kind = 'monthly_low_volume' then 'monthly' end])) loop
    if public._tw4rfl_alert(p_entity_id, v_auth.studio_id, null, 'authorization_expiring', 'auth:' || v_auth.id, 'both', 'warning',
         'A recurring texting authorization ends on ' || to_char(v_auth.expires_at at time zone public._tw4ml_tz_for(p_entity_id, v_cur), 'YYYY-MM-DD') || '. Reauthorize it before then; DanceFlow never extends it for you.') then v_alerts := v_alerts + 1; end if;
  end loop;
  -- funding: the next period's authorized charges versus spendable credit; negative balance; hold
  if exists (select 1 from public.studio_sms_provider_resources x where x.legal_entity_id = p_entity_id and x.provider_state = 'active' and x.fee_kind is not null) then
    if a.balance_cents < 0 then
      if public._tw4rfl_alert(p_entity_id, null, null, 'negative_balance', p_entity_id || ':' || v_cur, 'admin', 'critical', 'A business with live recurring provider resources has a negative credit balance.') then v_alerts := v_alerts + 1; end if;
    end if;
    if a.hold then
      if public._tw4rfl_alert(p_entity_id, null, null, 'account_on_hold', p_entity_id || ':' || v_cur, 'both', 'warning', 'The credit account is on hold while recurring provider resources are live.') then v_alerts := v_alerts + 1; end if;
    end if;
    if v_next_total > 0 and now() >= public._tw4ml_month_start(p_entity_id, v_nxt) - interval '7 days' and (a.balance_cents - a.reserved_cents) < v_next_total then
      if public._tw4rfl_alert(p_entity_id, null, null, 'funding_low', p_entity_id || ':' || v_nxt, 'both', 'warning',
           'Prepaid credit does not cover the recurring charges due for ' || v_nxt || '. Add credit before that period starts.') then v_alerts := v_alerts + 1; end if;
    end if;
  end if;
  -- provider-cost discrepancies on recurring kinds (once per recorded charge)
  for v_charge in select c.id from public.studio_sms_provider_charges c where c.legal_entity_id = p_entity_id and c.status = 'variance' and c.kind in ('number', 'monthly', 'monthly_low_volume') loop
    if public._tw4rfl_alert(p_entity_id, null, null, 'provider_variance', 'charge:' || v_charge.id, 'admin', 'warning', 'A recurring provider charge differs from its published expected cost.') then v_alerts := v_alerts + 1; end if;
  end loop;
  return jsonb_build_object('opened', v_opened, 'closed', v_closed, 'alerts', v_alerts);
end $$;

-- live billed senders whose number / campaign is not in the inventory: nothing monitors them (admin alert; R2b registers in the same flow)
create or replace function public.tw4_rfl_inventory_gaps()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s record;
  v_gaps int := 0;
begin
  for s in select distinct on (b.studio_id) b.* from public.studio_sms_billed_senders b order by b.studio_id, b.seq desc loop
    if s.status = 'released' then
      -- a release recorded through the sender path leaves the inventory untouched: the owner would keep paying for a resource nobody removed here
      if exists (select 1 from public.studio_sms_provider_resources r where r.legal_entity_id = s.legal_entity_id and r.provider_state = 'active' and r.provider_sid in (coalesce(s.phone_number_sid, ''), coalesce(s.campaign_sid, ''))) then
        v_gaps := v_gaps + 1;
        perform public._tw4rfl_alert(s.legal_entity_id, s.studio_id, null, 'released_resource_active', 'sender:' || s.id, 'admin', 'critical',
          'A sender was released but its number or campaign is still live in the recurring-fee inventory: cancel it through the lifecycle (with evidence) or correct the inventory.');
      end if;
      continue;
    end if;
    if (s.phone_number_sid is not null and not exists (select 1 from public.studio_sms_provider_resources r where r.provider_sid = s.phone_number_sid and r.resource_kind = 'number' and r.legal_entity_id = s.legal_entity_id))
       or (s.campaign_sid is not null and not exists (select 1 from public.studio_sms_provider_resources r where r.provider_sid = s.campaign_sid and r.resource_kind = 'campaign' and r.legal_entity_id = s.legal_entity_id)) then
      v_gaps := v_gaps + 1;
      perform public._tw4rfl_alert(s.legal_entity_id, s.studio_id, null, 'inventory_gap', 'sender:' || s.id, 'admin', 'critical',
        'A sender''s phone number or campaign is not in the recurring-fee inventory, so its fees cannot be monitored.');
    end if;
  end loop;
  return jsonb_build_object('gaps', v_gaps);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- provider bill evidence ("the provider is still billing"): recorded against a period, never charged to the studio
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_observe_provider_bill(p_resource_id uuid, p_period_key text, p_provider_ref text, p_cost_cents int, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  e public.studio_sms_provider_exposure;
  v_cov text;
  v_reason text;
  v_expected int;
begin
  perform public._tw4c_admin(p_actor);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null or r.fee_kind is null or p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_cost_cents is null or p_cost_cents <= 0
     or p_provider_ref is null or char_length(btrim(p_provider_ref)) < 3 then
    raise exception 'invalid provider bill' using errcode = '22023';
  end if;
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id for update;
  select * into e from public.studio_sms_provider_exposure x where x.resource_id = r.id and x.period_key = p_period_key for update;
  if e.id is not null and btrim(p_provider_ref) = any (e.provider_charge_refs) then
    return jsonb_build_object('exposure_id', e.id, 'replayed', true);
  end if;
  -- one provider bill line belongs to one period: the same reference on another period would count its cents twice
  if exists (select 1 from public.studio_sms_provider_exposure x where x.legal_entity_id = r.legal_entity_id and (x.resource_id <> r.id or x.period_key <> p_period_key) and btrim(p_provider_ref) = any (x.provider_charge_refs)) then
    raise exception 'this provider bill reference is already recorded for another period or resource of this business' using errcode = 'TW043';
  end if;
  -- the reconciliation record (unique per kind + reference; a different amount for the same reference is refused by it)
  perform public.tw4_credit_record_provider_charge(r.legal_entity_id, r.studio_id, r.fee_kind, btrim(p_provider_ref), p_cost_cents, p_actor);
  select p.provider_cost_cents into v_expected from public.studio_sms_price_list p where p.kind = r.fee_kind and p.active;
  v_cov := public._tw4rfl_cover(r, p_period_key);
  if r.provider_state = 'cancelled' and p_period_key > public._tw4ml_month_key(r.legal_entity_id, r.cancelled_at) then
    v_reason := 'billed_after_cancellation';
  elsif v_cov like 'uncovered:%' then
    v_reason := 'provider_billed_uncovered';
  else
    return jsonb_build_object('recorded', true, 'exposure', false, 'replayed', false);   -- a covered period's bill is expected; the variance record above is the reconciliation
  end if;
  if e.id is null then
    insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents, provider_billed_cents, provider_charge_refs)
    values (r.id, r.legal_entity_id, r.studio_id, p_period_key, v_reason, v_expected, p_cost_cents, array[btrim(p_provider_ref)]) returning * into e;
  else
    if e.state = 'closed' then
      -- a new bill reopens a closed period; the closing decision and its written note stay in the audit trail
      perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_exposure_opened', 'resource=' || r.id || ';period=' || p_period_key || ';reopened_by_bill;was=' || coalesce(e.disposition, '-')
        || ';note=' || left(coalesce(e.disposition_note, ''), 150));
    end if;
    perform set_config('tw4.rfl_write', 'on', true);
    update public.studio_sms_provider_exposure set state = 'open', closed_at = null, disposition = null, disposed_by = null, disposition_note = null, reason = v_reason,
           provider_billed_cents = e.provider_billed_cents + p_cost_cents, provider_charge_refs = e.provider_charge_refs || btrim(p_provider_ref), last_detected_at = now()
     where id = e.id returning * into e;
    perform set_config('tw4.rfl_write', 'off', true);
  end if;
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_provider_billed', 'resource=' || r.id || ';period=' || p_period_key || ';reason=' || v_reason || ';cents=' || p_cost_cents);
  perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'exposure_open', 'exposure:' || e.id, 'both', 'critical',
    'The provider billed a recurring fee that no owner authorization covers (' || replace(v_reason, '_', ' ') || ').');
  return jsonb_build_object('exposure_id', e.id, 'reason', v_reason, 'replayed', false);
end $$;

-- an administrator's written, final decision about an exposure that cover cannot close (the loss is accepted, or Twilio is confirmed not to have billed)
create or replace function public.tw4_rfl_exposure_dispose(p_resource_id uuid, p_period_key text, p_actor uuid, p_disposition text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  e public.studio_sms_provider_exposure;
begin
  perform public._tw4c_admin(p_actor);
  if p_disposition is null or p_disposition not in ('absorbed', 'not_billed_confirmed') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a disposition (absorbed | not_billed_confirmed) needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null then
    raise exception 'unknown resource' using errcode = '22023';
  end if;
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into e from public.studio_sms_provider_exposure x where x.resource_id = p_resource_id and x.period_key = p_period_key for update;
  if e.id is null then
    -- the scan may not have run yet: an uncovered, past-grace period of a known resource is recorded here, then dispositioned (a covered or in-grace one is not exposure)
    if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or r.fee_kind is null or p_period_key < public._tw4ml_month_key(r.legal_entity_id, r.registered_at)
       or public._tw4rfl_cover(r, p_period_key) like 'covered:%' or now() <= public._tw4rfl_due_from(r, p_period_key) then
      raise exception 'no exposure is recorded for that period' using errcode = 'TW041';
    end if;
    insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents)
    values (r.id, r.legal_entity_id, r.studio_id, p_period_key, substr(public._tw4rfl_cover(r, p_period_key), 11),
            (select p.provider_cost_cents from public.studio_sms_price_list p where p.kind = r.fee_kind and p.active)) returning * into e;
  end if;
  if e.state = 'closed' and e.disposition = p_disposition and e.disposed_by = p_actor and e.disposition_note = btrim(p_note) then
    return jsonb_build_object('exposure_id', e.id, 'replayed', true);
  end if;
  if e.state <> 'open' then
    raise exception 'the exposure is already closed (%)', e.disposition using errcode = 'TW041';
  end if;
  if p_disposition = 'not_billed_confirmed' and e.provider_billed_cents > 0 then
    raise exception 'the provider bill is recorded as evidence: this exposure can only be absorbed' using errcode = 'TW042';
  end if;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = p_disposition, disposed_by = p_actor, disposition_note = btrim(p_note) where id = e.id;
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_exposure_disposed', 'resource=' || r.id || ';period=' || p_period_key || ';disposition=' || p_disposition || ';billed_cents=' || e.provider_billed_cents);
  return jsonb_build_object('exposure_id', e.id, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- DanceFlow suspension (sending) -- explicitly NOT a provider cancellation
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_suspend_df(p_studio_id uuid, p_actor uuid, p_reason text, p_hold boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  s public.studio_sms_billed_senders;
  v_live int;
  v_others int;
begin
  perform public._tw4c_admin(p_actor);
  if p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a written reason (10+ characters) is required' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'the studio is not linked to a verified legal business' using errcode = 'TW010';
  end if;
  perform public._tw4sr_lock(p_studio_id);   -- location link, then business row, then credit account: the order R2b's activation uses (and sender revocation needs the link)
  perform public._tw4rfl_lock(v_entity);
  select * into s from public.studio_sms_billed_senders x where x.studio_id = p_studio_id order by x.seq desc limit 1;
  if s.id is not null and s.status in ('approved', 'pending') then
    perform public.tw4_sender_revoke(p_studio_id, p_actor, p_reason, false);   -- stops sending; identifiers stay reserved and inbound-mapped
  end if;
  if coalesce(p_hold, false) then
    perform public.tw4_credit_set_hold(v_entity, true, p_reason, p_actor);
  end if;
  select count(*) into v_live from public.studio_sms_provider_resources r where r.studio_id = p_studio_id and r.provider_state = 'active' and r.fee_kind is not null;
  select count(distinct r.studio_id) into v_others from public.studio_sms_provider_resources r
   where r.legal_entity_id = v_entity and r.studio_id <> p_studio_id and r.provider_state = 'active' and r.fee_kind is not null;
  perform public._tw4rfl_audit(p_studio_id, p_actor, 'rfl_df_suspended', 'hold=' || coalesce(p_hold, false) || ';live_fee_resources=' || v_live || ';other_locations_affected=' || case when coalesce(p_hold, false) then v_others else 0 end);
  -- a credit hold is per LEGAL BUSINESS: it also stops the recurring charges of every other location, which then become uncovered after their grace
  return jsonb_build_object('df_sending', false, 'credit_hold', coalesce(p_hold, false), 'provider_resources_unchanged', true, 'provider_fees_continue_for', v_live,
                            'hold_affects_other_locations', case when coalesce(p_hold, false) then v_others else 0 end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- provider cancellation: authorization -> single claim -> evidence. Nothing here calls Twilio.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4rfl_mark_cancelled(r public.studio_sms_provider_resources, p_actor uuid, p_evidence text, p_op uuid, p_not_before timestamptz default null)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s public.studio_sms_billed_senders;
  v_at timestamptz;
  v_month text;
  v_late int;
begin
  -- the provider removed it when the operation STARTED, not when someone got round to recording the evidence
  -- (an operation first abandoned on evidence that the resource was still PRESENT cannot be backdated to before that finding: p_not_before)
  select least(now(), greatest(r.registered_at, coalesce(o.started_at, now()), coalesce(p_not_before, '-infinity'::timestamptz))) into v_at from (select 1) q left join public.studio_sms_provider_cancel_ops o on o.id = p_op;
  v_month := public._tw4ml_month_key(r.legal_entity_id, v_at);
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = v_at, cancel_evidence_digest = p_evidence where id = r.id;
  -- accruing rows after the cancellation month with no bill evidence stop accruing; earlier uncovered periods are real provider cost and stay open for an
  -- administrator's disposition, as does any recorded provider bill
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = 'provider_resource_cancelled'
   where resource_id = r.id and state = 'open' and provider_billed_cents = 0 and period_key > v_month;
  -- any other operation still open on this resource is superseded by this one's evidence (it can never close otherwise)
  update public.studio_sms_provider_cancel_ops set status = case when status = 'authorized' then 'withdrawn' else 'abandoned' end, finished_at = now(), resolved_by = p_actor, resolved_at = now(),
         resolution_note = 'superseded: the resource was confirmed cancelled by operation ' || p_op
   where resource_id = r.id and id <> p_op and status in ('authorized', 'in_flight', 'unknown_outcome');
  perform set_config('tw4.rfl_write', 'off', true);
  -- charges taken for months after the cancellation month (while the outcome was open or unknown) are the administrators' to review and refund
  select count(*) into v_late from public.studio_sms_recurring_charges c
   where c.legal_entity_id = r.legal_entity_id and c.studio_id = r.studio_id and c.kind = any (public._tw4rfl_charge_kinds(r.fee_kind)) and c.status = 'charged' and c.period_key > v_month;
  if v_late > 0 then
    perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'charged_after_cancellation', 'late:' || r.id, 'admin', 'warning',
      'Recurring charges were taken for months after a provider resource was cancelled: review and refund them through the credit adjustment path.');
  end if;
  -- the owner's authorization for this fee stays until THEY revoke it; no further charge is taken for the retired resource
  if r.fee_kind is not null and exists (select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = r.legal_entity_id and a.studio_id = r.studio_id and a.status = 'active'
              and a.kind = any (public._tw4rfl_charge_kinds(r.fee_kind))) then
    perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'cancelled_authorization_active', 'cancelled:' || r.id, 'both', 'info',
      'A provider resource was cancelled. The recurring authorization for it stays until you revoke it, and no further charge will be taken for it.');
  end if;
  -- DanceFlow must not keep sending through a resource Twilio no longer has
  select * into s from public.studio_sms_billed_senders x where x.studio_id = r.studio_id order by x.seq desc limit 1;
  if s.id is not null and s.status in ('approved', 'pending') and (s.phone_number_sid = r.provider_sid or s.campaign_sid = r.provider_sid or s.messaging_service_sid = r.provider_sid) then
    perform public.tw4_sender_revoke(r.studio_id, p_actor, 'provider resource cancelled (operation ' || p_op || ')', false);
  end if;
end $$;

create or replace function public.tw4_rfl_cancel_authorize(p_resource_id uuid, p_actor uuid, p_approval_ref text, p_decided_by text, p_reason text, p_irreversible_ack boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  o public.studio_sms_provider_cancel_ops;
  v_norm text;
  v_oldest timestamptz;
begin
  perform public._tw4c_admin(p_actor);
  if p_decided_by is null or p_decided_by not in ('owner_written', 'founder_written', 'policy_lapse') or p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10
     or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a cancellation needs a decision type, a written approval reference (10+ characters) and a written reason (10+ characters)' using errcode = '22023';
  end if;
  if p_irreversible_ack is distinct from true then
    raise exception 'cancelling a provider resource cannot be undone: the irreversibility acknowledgement is required' using errcode = 'TW042';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null then
    raise exception 'unknown resource' using errcode = '22023';
  end if;
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id for update;
  if r.provider_state <> 'active' then
    raise exception 'the resource is already cancelled' using errcode = 'TW041';
  end if;
  v_norm := public._tw4fi_ref_norm(p_approval_ref);
  select * into o from public.studio_sms_provider_cancel_ops x where x.ref_norm = v_norm;
  if o.id is not null then
    if o.resource_id = r.id and o.authorized_by = p_actor and o.decided_by = p_decided_by and o.status = 'authorized' then
      return jsonb_build_object('operation_id', o.id, 'replayed', true);
    end if;
    raise exception 'this approval reference was already used: one written decision authorizes one cancellation, once' using errcode = 'TW043';
  end if;
  if exists (select 1 from public.studio_sms_provider_cancel_ops x where x.resource_id = r.id and x.status in ('authorized', 'in_flight', 'unknown_outcome')) then
    raise exception 'a cancellation of this resource is already open' using errcode = 'TW043';
  end if;
  if r.resource_kind = 'number' then
    -- a phone number is valuable and unrecoverable: only an explicit owner / founder decision, and never while it is the live sender
    if p_decided_by = 'policy_lapse' then
      raise exception 'a phone number is never released on a policy decision: it needs the owner''s or the founder''s written decision' using errcode = 'TW042';
    end if;
    if public._tw4rfl_live_sender(r) then
      raise exception 'suspend DanceFlow sending for this location before cancelling its number' using errcode = 'TW041';
    end if;
  end if;
  if p_decided_by = 'policy_lapse' then
    select min(e.first_detected_at) into v_oldest from public.studio_sms_provider_exposure e where e.resource_id = r.id and e.state = 'open';
    if v_oldest is null or v_oldest > now() - interval '14 days' then
      raise exception 'a lapse cancellation needs an exposure open for at least 14 days' using errcode = 'TW042';
    end if;
  end if;
  perform public._tw4fi_register(p_approval_ref, 'cancellation', r.legal_entity_id, r.studio_id, null, null, null, null, p_actor);   -- the permanent, shared reference namespace (TW019 when used anywhere)
  insert into public.studio_sms_provider_cancel_ops (resource_id, legal_entity_id, studio_id, decided_by, approval_ref, ref_norm, reason, irreversible_ack, authorized_by)
  values (r.id, r.legal_entity_id, r.studio_id, p_decided_by, btrim(p_approval_ref), v_norm, btrim(p_reason), true, p_actor) returning * into o;
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cancel_authorized', 'operation=' || o.id || ';resource=' || r.id || ';kind=' || r.resource_kind || ';by=' || p_decided_by);
  return jsonb_build_object('operation_id', o.id, 'replayed', false);
end $$;

create or replace function public.tw4_rfl_cancel_withdraw(p_operation_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_provider_cancel_ops;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'a written note (10+ characters) is required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id;
  if o.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  perform public._tw4rfl_lock(o.legal_entity_id);
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id for update;
  if o.status = 'withdrawn' then
    return jsonb_build_object('status', 'withdrawn', 'replayed', true);
  end if;
  if o.status <> 'authorized' then
    raise exception 'only an unclaimed authorization can be withdrawn (this one is %)', o.status using errcode = 'TW041';
  end if;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_cancel_ops set status = 'withdrawn', resolved_by = p_actor, resolved_at = now(), resolution_note = btrim(p_note), finished_at = now() where id = o.id;
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(o.studio_id, p_actor, 'rfl_cancel_withdrawn', 'operation=' || o.id);
  return jsonb_build_object('status', 'withdrawn', 'replayed', false);
end $$;

-- the single claim: only the first caller gets 'execute'; everyone else sees what is already happening
create or replace function public.tw4_rfl_cancel_begin(p_operation_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_provider_cancel_ops;
  r public.studio_sms_provider_resources;
begin
  perform public._tw4c_admin(p_actor);
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id;
  if o.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  perform public._tw4rfl_lock(o.legal_entity_id);
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id for update;
  select * into r from public.studio_sms_provider_resources x where x.id = o.resource_id for update;
  if o.status = 'in_flight' then
    return jsonb_build_object('action', 'in_progress');
  end if;
  if o.status = 'unknown_outcome' then
    return jsonb_build_object('action', 'reconcile');   -- never repeat an irreversible step whose outcome is unknown: look it up, then resolve
  end if;
  if o.status <> 'authorized' then
    return jsonb_build_object('action', 'skip', 'status', o.status);
  end if;
  if r.provider_state <> 'active' then
    raise exception 'the resource is already cancelled' using errcode = 'TW041';
  end if;
  if r.resource_kind = 'number' and public._tw4rfl_live_sender(r) then
    raise exception 'suspend DanceFlow sending for this location before cancelling its number' using errcode = 'TW041';
  end if;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_cancel_ops set status = 'in_flight', started_by = p_actor, started_at = clock_timestamp() where id = o.id;
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(o.studio_id, p_actor, 'rfl_cancel_started', 'operation=' || o.id);
  return jsonb_build_object('action', 'execute', 'provider_sid', r.provider_sid, 'resource_kind', r.resource_kind);
end $$;

create or replace function public.tw4_rfl_cancel_finish(p_operation_id uuid, p_actor uuid, p_outcome text, p_evidence_digest text, p_error_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_provider_cancel_ops;
  r public.studio_sms_provider_resources;
  v_abandoned_at timestamptz;
begin
  perform public._tw4c_admin(p_actor);
  if p_outcome is null or p_outcome not in ('confirmed', 'refused', 'unknown') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id;
  if o.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(o.studio_id);   -- location link, then business row, then credit account (R2b's order; sender revocation below takes the link)
  perform public._tw4rfl_lock(o.legal_entity_id);
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id for update;
  select * into r from public.studio_sms_provider_resources x where x.id = o.resource_id for update;
  v_abandoned_at := case when o.status = 'abandoned' then o.resolved_at end;
  if p_outcome = 'confirmed' and r.provider_state = 'cancelled' and o.status in ('abandoned', 'withdrawn', 'confirmed') then
    return jsonb_build_object('status', o.status, 'replayed', true, 'resource_already_cancelled', true);   -- another operation's evidence already recorded it
  end if;
  if (p_outcome = 'confirmed' and o.status = 'confirmed') or (p_outcome = 'refused' and o.status = 'refused') or (p_outcome = 'unknown' and o.status = 'unknown_outcome') then
    return jsonb_build_object('status', o.status, 'replayed', true);
  end if;
  -- an operation abandoned as "still active" may still be completed by the operator who was mid-step: the provider evidence (below) is what counts
  if o.status <> 'in_flight' and not (o.status = 'abandoned' and p_outcome = 'confirmed') then
    raise exception 'the operation is % (only a claimed operation is finished)', o.status using errcode = 'TW041';
  end if;
  if p_outcome = 'confirmed' then
    if p_evidence_digest is null or p_evidence_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'a confirmed cancellation needs the evidence digest of the provider read showing the resource gone' using errcode = 'TW043';
    end if;
    perform set_config('tw4.rfl_write', 'on', true);
    update public.studio_sms_provider_cancel_ops set status = 'confirmed', finished_at = now(), evidence_digest = p_evidence_digest where id = o.id;
    perform set_config('tw4.rfl_write', 'off', true);
    perform public._tw4rfl_mark_cancelled(r, p_actor, p_evidence_digest, o.id, v_abandoned_at);
    perform public._tw4rfl_audit(o.studio_id, p_actor, 'rfl_cancel_confirmed', 'operation=' || o.id || ';resource=' || r.id);
  elsif p_outcome = 'refused' then
    -- only a definite provider refusal proves nothing changed
    if p_error_code is distinct from 'api' then
      raise exception 'only a definite provider refusal (code api) closes an operation as refused; anything else is an unknown outcome' using errcode = 'TW043';
    end if;
    perform set_config('tw4.rfl_write', 'on', true);
    update public.studio_sms_provider_cancel_ops set status = 'refused', finished_at = now(), error_code = 'api' where id = o.id;
    perform set_config('tw4.rfl_write', 'off', true);
    perform public._tw4rfl_audit(o.studio_id, p_actor, 'rfl_cancel_refused', 'operation=' || o.id);
  else
    perform set_config('tw4.rfl_write', 'on', true);
    update public.studio_sms_provider_cancel_ops set status = 'unknown_outcome', finished_at = now(), error_code = left(coalesce(p_error_code, 'unknown'), 64) where id = o.id;
    perform set_config('tw4.rfl_write', 'off', true);
    perform public._tw4rfl_audit(o.studio_id, p_actor, 'rfl_cancel_unknown', 'operation=' || o.id);
    perform public._tw4rfl_alert(o.legal_entity_id, o.studio_id, o.resource_id, 'cancel_unknown', 'op:' || o.id, 'admin', 'critical', 'A provider cancellation has an unknown outcome and needs a provider lookup before anything is repeated.');
  end if;
  return jsonb_build_object('status', (select x.status from public.studio_sms_provider_cancel_ops x where x.id = o.id), 'replayed', false);
end $$;

-- an unknown (or a claimed-for-over-20-minutes) outcome is closed only by provider evidence or a written finding that nothing happened
create or replace function public.tw4_rfl_cancel_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_evidence_digest text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_provider_cancel_ops;
  r public.studio_sms_provider_resources;
begin
  perform public._tw4c_admin(p_actor);
  if p_resolution is null or p_resolution not in ('cancelled', 'still_active') or p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'a resolution (cancelled | still_active) and a written note (10+ characters) are required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id;
  if o.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(o.studio_id);   -- location link first (see finish)
  perform public._tw4rfl_lock(o.legal_entity_id);
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id for update;
  select * into r from public.studio_sms_provider_resources x where x.id = o.resource_id for update;
  if (p_resolution = 'cancelled' and o.status = 'confirmed' and o.resolved_by = p_actor) or (p_resolution = 'still_active' and o.status = 'abandoned' and o.resolved_by = p_actor) then
    return jsonb_build_object('status', o.status, 'replayed', true);
  end if;
  if o.status not in ('unknown_outcome', 'in_flight') or (o.status = 'in_flight' and o.started_at > now() - interval '20 minutes') then
    raise exception 'only an unknown outcome (or an operation claimed for over 20 minutes) is resolved' using errcode = 'TW041';
  end if;
  if p_resolution = 'cancelled' then
    if p_evidence_digest is null or p_evidence_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'provider evidence (a digest of the read showing the resource gone) is required' using errcode = 'TW043';
    end if;
    perform set_config('tw4.rfl_write', 'on', true);
    update public.studio_sms_provider_cancel_ops set status = 'confirmed', finished_at = coalesce(finished_at, now()), evidence_digest = p_evidence_digest,
           resolved_by = p_actor, resolved_at = now(), resolution_note = btrim(p_note) where id = o.id;
    perform set_config('tw4.rfl_write', 'off', true);
    perform public._tw4rfl_mark_cancelled(r, p_actor, p_evidence_digest, o.id);
  else
    -- "still active" is a finding about the provider, so it too needs the digest of the provider read that showed the resource present
    if p_evidence_digest is null or p_evidence_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'provider evidence (a digest of the read showing the resource still present) is required' using errcode = 'TW043';
    end if;
    perform set_config('tw4.rfl_write', 'on', true);
    update public.studio_sms_provider_cancel_ops set status = 'abandoned', evidence_digest = p_evidence_digest, finished_at = coalesce(finished_at, now()), resolved_by = p_actor, resolved_at = now(), resolution_note = btrim(p_note) where id = o.id;
    perform set_config('tw4.rfl_write', 'off', true);
  end if;
  perform public._tw4rfl_audit(o.studio_id, p_actor, 'rfl_cancel_resolved', 'operation=' || o.id || ';resolution=' || p_resolution);
  return jsonb_build_object('status', (select x.status from public.studio_sms_provider_cancel_ops x where x.id = o.id), 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- activation readiness (R2b's activation checklist calls this; it returns blockers, never a pass by default)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_studio_ready(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  r public.studio_sms_provider_resources;
  v_cur text;
  v_nxt text;
  v_blockers text[] := '{}';
  v_have_number boolean := false;
  v_have_campaign boolean := false;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('studio_not_linked'));
  end if;
  v_cur := public._tw4ml_month_key(v_entity, now());
  v_nxt := public._tw4ml_key_add(v_cur, 1);
  for r in select * from public.studio_sms_provider_resources x where x.studio_id = p_studio_id and x.provider_state = 'active' order by x.id loop
    v_have_number := v_have_number or r.resource_kind = 'number';
    v_have_campaign := v_have_campaign or r.resource_kind = 'campaign';
    if r.fee_kind is not null then
      if public._tw4rfl_cover(r, v_cur) like 'uncovered:%' then
        v_blockers := v_blockers || (r.resource_kind || '_current_period_uncovered');
      end if;
      -- a standing authorization must also cover the next period (a business with no authorization is blocked above; the pilot business needs the approval on file)
      if public._tw4rfl_cover(r, v_nxt) like 'uncovered:%' and not exists (
           select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = r.legal_entity_id and a.studio_id = r.studio_id and a.status = 'active'
              and a.kind = any (public._tw4rfl_charge_kinds(r.fee_kind)) and a.expires_at > public._tw4ml_month_start(r.legal_entity_id, v_nxt) + interval '28 days'
              and a.price_cents = (select pl.customer_price_cents from public.studio_sms_price_list pl where pl.kind = a.kind and pl.active)
              and a.total_limit_cents - coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0)
                  - case when exists (select 1 from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.period_key = v_cur and c.status = 'charged') then 0 else a.price_cents end >= a.price_cents
              and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = r.legal_entity_id)) then
        v_blockers := v_blockers || (r.resource_kind || '_next_period_uncovered');
      end if;
    end if;
  end loop;
  if not v_have_number then v_blockers := v_blockers || 'number_not_in_inventory'::text; end if;
  if not v_have_campaign then v_blockers := v_blockers || 'campaign_not_in_inventory'::text; end if;
  if exists (select 1 from public.studio_sms_provider_exposure e where e.legal_entity_id = v_entity and e.studio_id = p_studio_id and e.state = 'open') then
    v_blockers := v_blockers || 'open_exposure'::text;
  end if;
  if exists (select 1 from public.studio_sms_provider_cancel_ops o where o.studio_id = p_studio_id and o.status in ('authorized', 'in_flight', 'unknown_outcome')) then
    v_blockers := v_blockers || 'cancellation_pending'::text;
  end if;
  return jsonb_build_object('ready', cardinality(v_blockers) = 0, 'blockers', to_jsonb(v_blockers));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- alert outbox (claimed and delivered by the application runner; at-least-once with a bounded retry)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_alerts_claim(p_limit int)
returns table (alert_id uuid, claim_token uuid, legal_entity_id uuid, studio_id uuid, kind text, audience text, severity text, summary text)
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_token uuid := gen_random_uuid();
begin
  return query
  with c as (
    select x.id from public.studio_sms_provider_alerts x
     where (x.status in ('pending', 'failed') or (x.status = 'sending' and x.claimed_at < now() - interval '15 minutes')) and x.attempts < 5
     order by x.created_at, x.id limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked),
  u as (
    update public.studio_sms_provider_alerts a set status = 'sending', attempts = a.attempts + 1, claim_token = v_token, claimed_at = now()
     from c where a.id = c.id returning a.*)
  select u.id, u.claim_token, u.legal_entity_id, u.studio_id, u.kind, u.audience, u.severity, u.summary from u;
end $$;

create or replace function public.tw4_rfl_alert_finish(p_alert_id uuid, p_claim_token uuid, p_delivered boolean, p_error text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare x public.studio_sms_provider_alerts;
begin
  select * into x from public.studio_sms_provider_alerts a where a.id = p_alert_id for update;
  if x.id is null or x.claim_token is distinct from p_claim_token then
    return jsonb_build_object('updated', false);   -- not this claim (a newer claim owns it, or it was delivered)
  end if;
  if x.status = 'delivered' then
    return jsonb_build_object('updated', false);
  end if;
  update public.studio_sms_provider_alerts set status = case when coalesce(p_delivered, false) then 'delivered' else 'failed' end,
         delivered_at = case when coalesce(p_delivered, false) then now() end, last_error = case when coalesce(p_delivered, false) then null else left(coalesce(p_error, 'failed'), 120) end
   where id = x.id;
  return jsonb_build_object('updated', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reads
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_admin_overview(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  perform public._tw4c_admin(p_actor);
  select jsonb_build_object(
    'resources', coalesce((select jsonb_agg(jsonb_build_object(
        'resource_id', r.id, 'legal_entity_id', r.legal_entity_id, 'studio_id', r.studio_id, 'kind', r.resource_kind, 'fee_kind', r.fee_kind, 'provider_state', r.provider_state,
        'df_sending', public._tw4rfl_df_sending(r.studio_id),
        'current_period', public._tw4rfl_cover(r, public._tw4ml_month_key(r.legal_entity_id, now())),
        'next_period', public._tw4rfl_cover(r, public._tw4ml_key_add(public._tw4ml_month_key(r.legal_entity_id, now()), 1)),
        'open_cancel_operation', (select o.status from public.studio_sms_provider_cancel_ops o where o.resource_id = r.id and o.status in ('authorized', 'in_flight', 'unknown_outcome')))
        order by r.registered_at, r.id) from public.studio_sms_provider_resources r), '[]'::jsonb),
    'open_exposure', coalesce((select jsonb_agg(jsonb_build_object('resource_id', e.resource_id, 'period_key', e.period_key, 'reason', e.reason, 'expected_provider_cents', e.expected_provider_cents,
        'provider_billed_cents', e.provider_billed_cents, 'first_detected_at', e.first_detected_at) order by e.first_detected_at) from public.studio_sms_provider_exposure e where e.state = 'open'), '[]'::jsonb),
    'open_exposure_expected_cents', coalesce((select sum(coalesce(e.expected_provider_cents, 0)) from public.studio_sms_provider_exposure e where e.state = 'open'), 0),
    'open_exposure_billed_cents', coalesce((select sum(e.provider_billed_cents) from public.studio_sms_provider_exposure e where e.state = 'open'), 0),
    'alerts_waiting', (select count(*) from public.studio_sms_provider_alerts a where a.status <> 'delivered'),
    'cancel_operations_open', (select count(*) from public.studio_sms_provider_cancel_ops o where o.status in ('authorized', 'in_flight', 'unknown_outcome'))) into v;
  return v;
end $$;

-- the owner's view of their own location (no provider cost, no other tenant's anything)
create or replace function public.sms_rfl_owner_overview(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'texting_suspended_for_uncovered_fee', public._tw4rfl_gate_suspended(p_studio_id),
    'resources', coalesce((select jsonb_agg(jsonb_build_object('kind', r.resource_kind, 'provider_state', r.provider_state, 'fee_kind', r.fee_kind,
        'current_period_covered', public._tw4rfl_cover(r, public._tw4ml_month_key(r.legal_entity_id, now())) like 'covered:%',
        'next_period_covered', public._tw4rfl_cover(r, public._tw4ml_key_add(public._tw4ml_month_key(r.legal_entity_id, now()), 1)) like 'covered:%',
        'open_exposure', exists (select 1 from public.studio_sms_provider_exposure e where e.resource_id = r.id and e.state = 'open')) order by r.registered_at, r.id)
        from public.studio_sms_provider_resources r where r.studio_id = p_studio_id), '[]'::jsonb)) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4rfl_guard(), public._tw4rfl_audit(uuid, uuid, text, text), public._tw4rfl_charge_kinds(text),
  public._tw4rfl_due_from(public.studio_sms_provider_resources, text), public._tw4rfl_cover(public.studio_sms_provider_resources, text), public._tw4rfl_gate_suspended(uuid), public._tw4rfl_lock(uuid),
  public._tw4rfl_alert(uuid, uuid, uuid, text, text, text, text, text), public._tw4rfl_df_sending(uuid),
  public._tw4rfl_mark_cancelled(public.studio_sms_provider_resources, uuid, text, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public._tw4rc_service_state(uuid), public._tw4rfl_retired(uuid, uuid, text[], text), public._tw4rfl_auth_guard(), public._tw4rfl_oneoff_guard(),
  public._tw4rfl_replacement(public.studio_sms_provider_resources, text), public._tw4rfl_live_sender(public.studio_sms_provider_resources) from public, anon, authenticated, service_role;
revoke all on function public.tw4_rfl_register(uuid, uuid, text, text, text, text, text, uuid, uuid), public.tw4_rfl_pilot_cover(uuid, text, text, uuid),
  public.tw4_rfl_scan_entities(), public.tw4_rfl_scan_entity(uuid), public.tw4_rfl_inventory_gaps(), public.tw4_rfl_observe_provider_bill(uuid, text, text, int, uuid),
  public.tw4_rfl_exposure_dispose(uuid, text, uuid, text, text), public.tw4_rfl_suspend_df(uuid, uuid, text, boolean), public.tw4_rfl_cancel_authorize(uuid, uuid, text, text, text, boolean),
  public.tw4_rfl_cancel_withdraw(uuid, uuid, text), public.tw4_rfl_cancel_begin(uuid, uuid), public.tw4_rfl_cancel_finish(uuid, uuid, text, text, text),
  public.tw4_rfl_cancel_resolve(uuid, uuid, text, text, text), public.tw4_rfl_studio_ready(uuid), public.tw4_rfl_alerts_claim(int), public.tw4_rfl_alert_finish(uuid, uuid, boolean, text),
  public.tw4_rfl_admin_overview(uuid), public.sms_rfl_owner_overview(uuid) from public, anon, authenticated;
grant execute on function public.tw4_rfl_register(uuid, uuid, text, text, text, text, text, uuid, uuid), public.tw4_rfl_pilot_cover(uuid, text, text, uuid),
  public.tw4_rfl_scan_entities(), public.tw4_rfl_scan_entity(uuid), public.tw4_rfl_inventory_gaps(), public.tw4_rfl_observe_provider_bill(uuid, text, text, int, uuid),
  public.tw4_rfl_exposure_dispose(uuid, text, uuid, text, text), public.tw4_rfl_suspend_df(uuid, uuid, text, boolean), public.tw4_rfl_cancel_authorize(uuid, uuid, text, text, text, boolean),
  public.tw4_rfl_cancel_withdraw(uuid, uuid, text), public.tw4_rfl_cancel_begin(uuid, uuid), public.tw4_rfl_cancel_finish(uuid, uuid, text, text, text),
  public.tw4_rfl_cancel_resolve(uuid, uuid, text, text, text), public.tw4_rfl_studio_ready(uuid), public.tw4_rfl_alerts_claim(int), public.tw4_rfl_alert_finish(uuid, uuid, boolean, text),
  public.tw4_rfl_admin_overview(uuid) to service_role;
grant execute on function public.sms_rfl_owner_overview(uuid) to authenticated;

commit;
