-- DanceFlow Source-Specific Migration Support
-- Mindbody Slice 1: source audit and canonical mapping foundation v1
--
-- Reuses the durable source identity columns introduced by:
--   20260728000300_wellnessliving_migration_mapping_foundation_v1.sql
--
-- Apply after:
--   20260728000400_wellnessliving_client_relationship_reconciliation_v1.sql

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
    'mindbody',
    'clients',
    'Mindbody Clients',
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
      'notes', 'notes',
      'relationship_source_external_id', 'related_client_id',
      'relationship_type', 'relationship_type'
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
      'relationships', 'preserve_when_explicit',
      'relationship_inference', false
    )
  ),
  (
    null,
    'mindbody',
    'instructors',
    'Mindbody Staff',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'staff_id',
      'first_name', 'first_name',
      'last_name', 'last_name',
      'email', 'email',
      'phone', 'phone',
      'active', 'active',
      'staff_type', 'staff_type'
    ),
    jsonb_build_object(
      'match_precedence', jsonb_build_array(
        'source_external_id',
        'normalized_email',
        'manual_decision'
      ),
      'role_mapping', 'owner_decision_when_ambiguous',
      'grant_admin_access', false
    )
  ),
  (
    null,
    'mindbody',
    'packages',
    'Mindbody Pricing Options and Client Services',
    1,
    'active',
    true,
    jsonb_build_object(
      'template_source_external_id', 'pricing_option_id',
      'client_package_source_external_id', 'client_service_id',
      'client_source_external_id', 'client_id',
      'name', 'pricing_option_name',
      'price', 'price',
      'purchase_date', 'purchase_date',
      'expiration_date', 'expiration_date',
      'usage_type', 'service_type',
      'quantity_total', 'visits_total',
      'quantity_remaining', 'visits_remaining',
      'unlimited', 'unlimited'
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
    'mindbody',
    'memberships',
    'Mindbody Contracts and AutoPays',
    1,
    'active',
    true,
    jsonb_build_object(
      'plan_source_external_id', 'contract_template_id',
      'client_membership_source_external_id', 'client_contract_id',
      'period_source_external_id', 'billing_period_id',
      'client_source_external_id', 'client_id',
      'name', 'contract_name',
      'status', 'contract_status',
      'billing_interval', 'billing_interval',
      'price', 'recurring_amount',
      'starts_on', 'start_date',
      'current_period_start', 'period_start',
      'current_period_end', 'period_end',
      'amount_due', 'amount_due',
      'amount_paid', 'amount_paid',
      'payment_status', 'payment_status',
      'auto_renew', 'autopay'
    ),
    jsonb_build_object(
      'allowed_billing_intervals', jsonb_build_array(
        'weekly',
        'monthly',
        'quarterly',
        'yearly'
      ),
      'period_payment_state', 'preserve_source',
      'stored_payment_method', 'never_import',
      'autopay_credentials', 'never_import',
      'recreate_recurring_billing', 'owner_action_required',
      'unresolved_plan', 'exception'
    )
  ),
  (
    null,
    'mindbody',
    'appointments',
    'Mindbody Appointments, Classes, and Enrollments',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'booking_id',
      'client_source_external_id', 'client_id',
      'instructor_source_external_id', 'staff_id',
      'booking_kind', 'booking_kind',
      'service_name', 'service_name',
      'starts_at', 'start_time',
      'ends_at', 'end_time',
      'status', 'status',
      'location', 'location',
      'room', 'room',
      'package_source_external_id', 'client_service_id',
      'membership_source_external_id', 'client_contract_id'
    ),
    jsonb_build_object(
      'booking_kinds', jsonb_build_array(
        'private_appointment',
        'class',
        'enrollment',
        'workshop'
      ),
      'historical_attendance_mode', 'history_only_no_balance_deduction',
      'future_entitlement_link', 'required_when_source_identifies_entitlement',
      'overlap_conflict', 'exception',
      'roster_conflict', 'exception',
      'timezone', 'studio_timezone'
    )
  ),
  (
    null,
    'mindbody',
    'attendance',
    'Mindbody Visits and Attendance',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'visit_id',
      'appointment_source_external_id', 'booking_id',
      'client_source_external_id', 'client_id',
      'attendance_status', 'attendance_status',
      'attendance_marked_at', 'visit_date'
    ),
    jsonb_build_object(
      'allowed_statuses', jsonb_build_array(
        'attended',
        'no_show',
        'late_cancel',
        'cancelled',
        'waitlisted'
      ),
      'deduct_entitlement', false,
      'history_only', true
    )
  ),
  (
    null,
    'mindbody',
    'payments',
    'Mindbody Sales, Payments, and Refunds',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'transaction_id',
      'sale_source_external_id', 'sale_id',
      'client_source_external_id', 'client_id',
      'amount', 'amount',
      'payment_date', 'transaction_date',
      'payment_method', 'payment_method',
      'status', 'status',
      'reference', 'reference',
      'refund_source_external_id', 'refund_id'
    ),
    jsonb_build_object(
      'mode', 'historical_record_only',
      'duplicate_source_identity', 'skip_or_update',
      'unknown_payment_method', 'other',
      'refunds', 'preserve_source_status_and_reference',
      'chargebacks', 'preserve_source_status_and_reference',
      'create_new_charge', false
    )
  ),
  (
    null,
    'mindbody',
    'account_credits',
    'Mindbody Account Credits',
    1,
    'active',
    true,
    jsonb_build_object(
      'source_external_id', 'ledger_entry_id',
      'client_source_external_id', 'client_id',
      'entry_date', 'entry_date',
      'direction', 'direction',
      'amount', 'amount',
      'entry_type', 'entry_type',
      'description', 'description'
    ),
    jsonb_build_object(
      'mode', 'ledger_balance_preservation',
      'duplicate_source_identity', 'skip_or_update',
      'net_balance', 'reconcile_against_source',
      'create_new_charge', false
    )
  )
on conflict (studio_id, source_system, import_type, name, version)
do update set
  status = excluded.status,
  is_system_template = excluded.is_system_template,
  field_mappings = excluded.field_mappings,
  normalization_rules = excluded.normalization_rules,
  updated_at = now();

update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'Mindbody clients use durable source identity, normalized contact fallback matching, and explicit relationship review.',
  updated_at = now()
where stage_key = 'clients';

update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'Mindbody staff map to DanceFlow instructors without automatically granting administrative access.',
  updated_at = now()
where stage_key = 'instructors';

update public.migration_stage_definitions
set
  description = 'Mindbody pricing options and client services preserve remaining visits and unlimited service state without replaying historical deductions.',
  updated_at = now()
where stage_key = 'packages';

update public.migration_stage_definitions
set
  description = 'Mindbody contracts preserve current billing periods and payment state; stored cards and AutoPay credentials are never imported.',
  updated_at = now()
where stage_key = 'memberships';

update public.migration_stage_definitions
set
  description = 'Mindbody appointments, classes, enrollments, and workshops preserve booking kind, source identity, and entitlement references.',
  updated_at = now()
where stage_key = 'appointments';

update public.migration_stage_definitions
set
  description = 'Mindbody visit history updates attendance state without deducting imported package or membership balances again.',
  updated_at = now()
where stage_key = 'attendance';

update public.migration_stage_definitions
set
  description = 'Mindbody sales, payments, refunds, and chargebacks remain historical records and never recreate charges.',
  updated_at = now()
where stage_key = 'payments';

update public.migration_stage_definitions
set
  description = 'Mindbody client credits use the account ledger with source-safe reruns and net-balance reconciliation.',
  updated_at = now()
where stage_key = 'account_credits';
