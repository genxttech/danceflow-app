export const MINDBODY_SOURCE_SYSTEM = "mindbody" as const;

export const MINDBODY_STAGE_ORDER = [
  "clients",
  "instructors",
  "packages",
  "memberships",
  "appointments",
  "attendance",
  "payments",
  "account_credits",
] as const;

export type MindbodyStage = (typeof MINDBODY_STAGE_ORDER)[number];

export const MINDBODY_SOURCE_REPORTS = {
  clients: [
    "client_export",
    "client_details",
    "client_contact_log",
    "client_relationships",
  ],
  instructors: ["staff_export", "staff_details", "teacher_export"],
  packages: [
    "pricing_options",
    "client_services",
    "remaining_visits",
    "service_accounting",
  ],
  memberships: [
    "contracts",
    "autopays",
    "client_contracts",
    "billing_periods",
  ],
  appointments: [
    "appointments",
    "classes",
    "enrollments",
    "schedule",
    "booking_history",
  ],
  attendance: ["visits", "attendance", "class_signins"],
  payments: ["sales", "transactions", "payments", "refunds"],
  account_credits: ["account_balance", "client_account", "gift_cards", "credits"],
} as const;

export const MINDBODY_CLIENT_MATCH_PRECEDENCE = [
  "source_external_id",
  "normalized_email",
  "normalized_phone",
  "manual_decision",
] as const;

export const MINDBODY_STAFF_MATCH_PRECEDENCE = [
  "source_external_id",
  "normalized_email",
  "manual_decision",
] as const;

export const MINDBODY_PACKAGE_TEMPLATE_MATCH_PRECEDENCE = [
  "source_external_id",
  "exact_normalized_name_with_manual_confirmation",
  "manual_decision",
] as const;

export const MINDBODY_MEMBERSHIP_PLAN_MATCH_PRECEDENCE = [
  "source_external_id",
  "exact_normalized_name_with_manual_confirmation",
  "manual_decision",
] as const;

export const MINDBODY_PACKAGE_USAGE_TYPES = [
  "private_lesson",
  "group_class",
  "practice_party",
] as const;

export const MINDBODY_CONTRACT_STATUSES = [
  "active",
  "paused",
  "frozen",
  "cancelled",
  "expired",
  "pending",
  "past_due",
  "unpaid",
] as const;

export const MINDBODY_PAYMENT_STATUSES = [
  "due",
  "paid",
  "partial",
  "past_due",
  "refunded",
  "void",
  "waived",
] as const;

export const MINDBODY_BILLING_INTERVALS = [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

export const MINDBODY_APPOINTMENT_KINDS = [
  "private_appointment",
  "class",
  "enrollment",
  "workshop",
] as const;

export const MINDBODY_ATTENDANCE_STATUSES = [
  "attended",
  "no_show",
  "late_cancel",
  "cancelled",
  "waitlisted",
] as const;

export const MINDBODY_EXCEPTION_CODES = {
  ambiguousClient: "mindbody_ambiguous_client",
  ambiguousStaff: "mindbody_ambiguous_staff",
  ambiguousRelationship: "mindbody_ambiguous_relationship",
  ambiguousPackageTemplate: "mindbody_ambiguous_package_template",
  ambiguousMembershipPlan: "mindbody_ambiguous_membership_plan",
  unsupportedServiceType: "mindbody_unsupported_service_type",
  unsupportedBillingInterval: "mindbody_unsupported_billing_interval",
  invalidRemainingBalance: "mindbody_invalid_remaining_balance",
  historicalAttendanceBalanceConflict:
    "mindbody_historical_attendance_balance_conflict",
  unresolvedFutureEntitlement: "mindbody_unresolved_future_entitlement",
  unresolvedClassRoster: "mindbody_unresolved_class_roster",
  duplicateSourceIdentity: "mindbody_duplicate_source_identity",
  accountCreditMismatch: "mindbody_account_credit_mismatch",
  refundMismatch: "mindbody_refund_mismatch",
  storedPaymentMethodUnavailable: "mindbody_stored_payment_method_unavailable",
} as const;

export const MINDBODY_MIGRATION_RULES = {
  sourceSystem: MINDBODY_SOURCE_SYSTEM,

  clientMatching: MINDBODY_CLIENT_MATCH_PRECEDENCE,
  staffMatching: MINDBODY_STAFF_MATCH_PRECEDENCE,
  packageTemplateMatching: MINDBODY_PACKAGE_TEMPLATE_MATCH_PRECEDENCE,
  membershipPlanMatching: MINDBODY_MEMBERSHIP_PLAN_MATCH_PRECEDENCE,

  // A Mindbody client, staff member, pricing option, contract, visit, sale,
  // or ledger row must keep its durable source identity. Names and dates are
  // never sufficient for an automatic merge.
  sourceIdentityMode: "durable_source_id_required_when_available",

  // Family, guardian, payer, household, and related-client links are
  // preserved only when explicit in the source. Ambiguous relationships are
  // reviewed rather than inferred.
  clientRelationshipMode: "preserve_explicit_relationships_only",

  // Remaining visits and current service balances represent the source's
  // current entitlement state. Historical attendance must not consume those
  // balances again.
  historicalAttendanceMode: "history_only_no_balance_deduction",

  // Private appointments, class rosters, enrollments, and workshops remain
  // distinct source concepts even when they eventually share DanceFlow
  // scheduling infrastructure.
  scheduleMode: "preserve_source_booking_kind",

  // Future bookings must retain an entitlement reference when Mindbody
  // identifies a pricing option or contract. Unresolved references become
  // migration exceptions.
  futureEntitlementMode: "require_resolution_when_source_identifies_entitlement",

  // Historical sales, payments, refunds, and chargebacks are imported as
  // history. They must never create new charges.
  historicalPaymentsMode: "history_only",

  // Account credits use the client ledger with source-safe reruns.
  accountCreditMode: "ledger_balance_preservation",

  // Current contract periods preserve amount due, amount paid, and payment
  // state instead of inferring state from the contract alone.
  membershipPeriodMode: "preserve_source_period_and_payment_state",

  // Stored cards, tokens, AutoPay mandates, and recurring billing credentials
  // are never imported. Future billing requires studio approval and a new
  // DanceFlow payment setup.
  recurringBillingMigrationMode:
    "do_not_recreate_autopay_or_stored_payment_method_without_owner_action",
} as const;

export function normalizeMindbodyText(value: unknown, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function normalizeMindbodyEmail(value: unknown) {
  const normalized = normalizeMindbodyText(value, 320).toLowerCase();
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized
    : "";
}

export function normalizeMindbodyPhone(value: unknown) {
  const raw = normalizeMindbodyText(value, 80);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

export function normalizeMindbodyName(value: unknown) {
  return normalizeMindbodyText(value, 180)
    .replace(/\s+/g, " ")
    .toLowerCase();
}
