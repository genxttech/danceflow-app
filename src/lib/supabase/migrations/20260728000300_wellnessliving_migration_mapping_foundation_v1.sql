-- DanceFlow Source-Specific Migration Support
-- WellnessLiving Slice 1: source audit and canonical mapping foundation v1
--
-- Adds durable source identity to package, membership, membership-period,
-- and client-account-credit records so WellnessLiving imports can be rerun
-- safely without duplicating active entitlements or account balances.
--
-- Apply after:
--   20260727000300_migration_center_mapping_reconciliation_v1.sql
--   20260721000100_membership_period_payment_entitlement_reconciliation_v1.sql
--   20260728000200_square_migration_pilot_reconciliation_v1.sql

create extension if not exists pgcrypto;

alter table public.package_templates
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

alter table public.client_packages
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

alter table public.membership_plans
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

alter table public.client_memberships
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

alter table public.client_membership_periods
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

alter table public.client_account_ledger
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

create unique index if not exists package_templates_source_identity_unique
  on public.package_templates(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists client_packages_source_identity_unique
  on public.client_packages(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists membership_plans_source_identity_unique
  on public.membership_plans(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists client_memberships_source_identity_unique
  on public.client_memberships(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists client_membership_periods_source_identity_unique
  on public.client_membership_periods(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists client_account_ledger_source_identity_unique
  on public.client_account_ledger(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create index if not exists package_templates_import_source_idx
  on public.package_templates(studio_id, source_system, imported_at desc);

create index if not exists client_packages_import_source_idx
  on public.client_packages(studio_id, source_system, imported_at desc);

create index if not exists membership_plans_import_source_idx
  on public.membership_plans(studio_id, source_system, imported_at desc);

create index if not exists client_memberships_import_source_idx
  on public.client_memberships(studio_id, source_system, imported_at desc);

create index if not exists client_membership_periods_import_source_idx
  on public.client_membership_periods(studio_id, source_system, imported_at desc);

create index if not exists client_account_ledger_import_source_idx
  on public.client_account_ledger(studio_id, source_system, imported_at desc);

-- Canonical WellnessLiving mapping contracts. Export headers can differ by
-- report/version; execution slices normalize aliases before applying these
-- destination mappings.
insert into public.import_mapping_templates (
  studio_id,
  source_system,
  import_type,
  name,
  version,
  status,
  is_system_template,
  field_mappings,
  normalization_rules
)
values
  (
    null,
    'wellnessliving',
    'clients',
    'WellnessLiving Clients',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'client_id',
      'first_name', 'first_name',
      'last_name', 'last_name',
      'email', 'email',
      'phone', 'phone',
      'status', 'status',
      'notes', 'notes'
    ),
    jsonb_build_object(
      'match_precedence', jsonb_build_array(
        'source_external_id',
        'normalized_email',
        'normalized_phone',
        'manual_decision'
      ),
      'duplicate_email', 'exception',
      'duplicate_phone', 'manual_review',
      'family_relationships', 'preserve_when_explicit'
    )
  ),
  (
    null,
    'wellnessliving',
    'instructors',
    'WellnessLiving Staff',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'staff_id',
      'first_name', 'first_name',
      'last_name', 'last_name',
      'email', 'email',
      'phone', 'phone',
      'active', 'active'
    ),
    jsonb_build_object(
      'match_precedence', jsonb_build_array(
        'source_external_id',
        'normalized_email',
        'manual_decision'
      ),
      'role_mapping', 'owner_decision_when_ambiguous'
    )
  ),
  (
    null,
    'wellnessliving',
    'packages',
    'WellnessLiving Session Passes and Visits Remaining',
    1,
    'active',
    true,
    jsonb_build_object(
      'template_source_external_id', 'pricing_option_id',
      'client_package_source_external_id', 'client_pricing_option_id',
      'client_source_external_id', 'client_id',
      'name', 'pricing_option_name',
      'price', 'price',
      'purchase_date', 'purchase_date',
      'expiration_date', 'expiration_date',
      'usage_type', 'usage_type',
      'quantity_total', 'visits_total',
      'quantity_remaining', 'visits_remaining'
    ),
    jsonb_build_object(
      'match_precedence', jsonb_build_array(
        'source_external_id',
        'exact_normalized_name_with_manual_confirmation',
        'manual_decision'
      ),
      'allowed_usage_types', jsonb_build_array(
        'private_lesson',
        'group_class',
        'practice_party'
      ),
      'remaining_balance', 'authoritative_source_state',
      'historical_attendance_deduction', false,
      'negative_remaining', 'exception'
    )
  ),
  (
    null,
    'wellnessliving',
    'memberships',
    'WellnessLiving Memberships and AutoPays',
    1,
    'active',
    true,
    jsonb_build_object(
      'plan_source_external_id', 'pricing_option_id',
      'client_membership_source_external_id', 'client_membership_id',
      'period_source_external_id', 'billing_period_id',
      'client_source_external_id', 'client_id',
      'name', 'membership_name',
      'status', 'status',
      'billing_interval', 'billing_interval',
      'price', 'price',
      'starts_on', 'start_date',
      'current_period_start', 'period_start',
      'current_period_end', 'period_end',
      'amount_due', 'amount_due',
      'amount_paid', 'amount_paid',
      'payment_status', 'payment_status',
      'auto_renew', 'auto_renew'
    ),
    jsonb_build_object(
      'allowed_billing_intervals', jsonb_build_array(
        'monthly',
        'quarterly',
        'yearly'
      ),
      'period_payment_state', 'preserve_source',
      'autopay_credentials', 'never_import',
      'recreate_recurring_billing', 'owner_action_required',
      'unresolved_plan', 'exception'
    )
  ),
  (
    null,
    'wellnessliving',
    'appointments',
    'WellnessLiving Schedule and Booking History',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'appointment_id',
      'client_source_external_id', 'client_id',
      'instructor_source_external_id', 'staff_id',
      'appointment_type', 'service_name',
      'starts_at', 'start_time',
      'ends_at', 'end_time',
      'status', 'status',
      'billing_type', 'billing_type',
      'package_source_external_id', 'client_pricing_option_id',
      'membership_source_external_id', 'client_membership_id'
    ),
    jsonb_build_object(
      'historical_attendance_mode', 'history_only_no_balance_deduction',
      'future_entitlement_link', 'required_when_source_identifies_entitlement',
      'overlap_conflict', 'exception',
      'timezone', 'studio_timezone'
    )
  ),
  (
    null,
    'wellnessliving',
    'payments',
    'WellnessLiving Purchase History',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'transaction_id',
      'client_source_external_id', 'client_id',
      'amount', 'amount',
      'payment_date', 'transaction_date',
      'payment_method', 'payment_method',
      'status', 'status',
      'reference', 'reference',
      'appointment_source_external_id', 'appointment_id'
    ),
    jsonb_build_object(
      'mode', 'historical_record_only',
      'duplicate_source_identity', 'skip_or_update',
      'unknown_payment_method', 'other',
      'refunds', 'preserve_source_status_and_reference'
    )
  )
on conflict (studio_id, source_system, import_type, name, version)
do update set
  status = excluded.status,
  is_system_template = excluded.is_system_template,
  field_mappings = excluded.field_mappings,
  normalization_rules = excluded.normalization_rules,
  updated_at = now();

-- Existing core import execution already supports clients, instructors,
-- appointments, and payments. Package and membership live execution follows
-- in source-specific slices.
update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'WellnessLiving client records use durable source identity with normalized email/phone fallback matching and exception handling.',
  updated_at = now()
where stage_key = 'clients';

update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'WellnessLiving staff records map into DanceFlow instructors; ambiguous role assignment remains an owner decision.',
  updated_at = now()
where stage_key = 'instructors';

update public.migration_stage_definitions
set
  execution_status = 'assisted',
  description = 'WellnessLiving session passes and Visits Remaining map to package templates, client packages, and current package-item balances.',
  updated_at = now()
where stage_key = 'packages';

update public.migration_stage_definitions
set
  execution_status = 'assisted',
  description = 'WellnessLiving memberships and AutoPays map to membership plans, client memberships, current billing periods, and explicit future billing decisions.',
  updated_at = now()
where stage_key = 'memberships';

update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'WellnessLiving appointments use existing source-aware appointment import with overlap detection and relationship matching.',
  updated_at = now()
where stage_key = 'appointments';

update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'WellnessLiving historical payments use source-aware payment import and do not recreate source charges.',
  updated_at = now()
where stage_key = 'payments';

comment on column public.client_packages.source_external_id is
  'Durable external entitlement identifier used for idempotent source-system package imports.';

comment on column public.client_memberships.source_external_id is
  'Durable external membership identifier used for idempotent source-system membership imports.';

comment on column public.client_membership_periods.source_external_id is
  'External membership billing-period identifier when supplied by a migration source.';

comment on column public.client_account_ledger.source_external_id is
  'External credit/adjustment identifier used to prevent duplicate migrated client account balances.';
