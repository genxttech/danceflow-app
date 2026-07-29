export const WELLNESSLIVING_SOURCE_SYSTEM = "wellnessliving" as const;

export const WELLNESSLIVING_STAGE_ORDER = [
  "clients",
  "instructors",
  "packages",
  "memberships",
  "appointments",
  "attendance",
  "payments",
  "account_credits",
] as const;

export type WellnessLivingStage = (typeof WELLNESSLIVING_STAGE_ORDER)[number];

export const WELLNESSLIVING_SOURCE_REPORTS = {
  clients: ["client_list", "client_details"],
  instructors: ["staff", "staff_details"],
  packages: ["visits_remaining", "session_passes", "pricing_options"],
  memberships: ["memberships", "autopays", "pricing_options"],
  appointments: ["appointments", "schedule", "booking_history"],
  attendance: ["attendance", "visits"],
  payments: ["purchase_history", "sales", "transactions"],
  account_credits: ["client_account", "account_balance", "transactions"],
} as const;

export const WELLNESSLIVING_CLIENT_MATCH_PRECEDENCE = [
  "source_external_id",
  "normalized_email",
  "normalized_phone",
  "manual_decision",
] as const;

export const WELLNESSLIVING_STAFF_MATCH_PRECEDENCE = [
  "source_external_id",
  "normalized_email",
  "manual_decision",
] as const;

export const WELLNESSLIVING_PACKAGE_TEMPLATE_MATCH_PRECEDENCE = [
  "source_external_id",
  "exact_normalized_name_with_manual_confirmation",
  "manual_decision",
] as const;

export const WELLNESSLIVING_MEMBERSHIP_PLAN_MATCH_PRECEDENCE = [
  "source_external_id",
  "exact_normalized_name_with_manual_confirmation",
  "manual_decision",
] as const;

export const WELLNESSLIVING_PACKAGE_USAGE_TYPES = [
  "private_lesson",
  "group_class",
  "practice_party",
] as const;

export const WELLNESSLIVING_MEMBERSHIP_BENEFIT_TYPES = [
  "included_private_lessons",
  "included_group_classes",
  "discount_percent",
  "discount_amount",
  "floor_rental_discount_percent",
  "floor_rental_discount_amount",
  "other",
] as const;

export const WELLNESSLIVING_MEMBERSHIP_STATUSES = [
  "active",
  "paused",
  "cancelled",
  "expired",
  "pending",
  "past_due",
  "unpaid",
] as const;

export const WELLNESSLIVING_MEMBERSHIP_PAYMENT_STATUSES = [
  "due",
  "paid",
  "partial",
  "past_due",
  "waived",
  "void",
] as const;

export const WELLNESSLIVING_BILLING_INTERVALS = [
  "monthly",
  "quarterly",
  "yearly",
] as const;

export const WELLNESSLIVING_EXCEPTION_CODES = {
  ambiguousClient: "wellnessliving_ambiguous_client",
  ambiguousStaff: "wellnessliving_ambiguous_staff",
  ambiguousPackageTemplate: "wellnessliving_ambiguous_package_template",
  ambiguousMembershipPlan: "wellnessliving_ambiguous_membership_plan",
  unsupportedPackageUsage: "wellnessliving_unsupported_package_usage",
  unsupportedMembershipBenefit: "wellnessliving_unsupported_membership_benefit",
  unsupportedBillingInterval: "wellnessliving_unsupported_billing_interval",
  invalidRemainingBalance: "wellnessliving_invalid_remaining_balance",
  historicalAttendanceBalanceConflict:
    "wellnessliving_historical_attendance_balance_conflict",
  futureAppointmentUnresolvedEntitlement:
    "wellnessliving_future_appointment_unresolved_entitlement",
  duplicateSourceIdentity: "wellnessliving_duplicate_source_identity",
  accountCreditMismatch: "wellnessliving_account_credit_mismatch",
} as const;

export const WELLNESSLIVING_MIGRATION_RULES = {
  sourceSystem: WELLNESSLIVING_SOURCE_SYSTEM,

  // Source identity always wins. Email/phone are fallback matching aids only.
  clientMatching: WELLNESSLIVING_CLIENT_MATCH_PRECEDENCE,
  staffMatching: WELLNESSLIVING_STAFF_MATCH_PRECEDENCE,

  // Product names can be reused across years or locations. Never silently
  // merge package or membership definitions by display name alone.
  packageTemplateMatching: WELLNESSLIVING_PACKAGE_TEMPLATE_MATCH_PRECEDENCE,
  membershipPlanMatching: WELLNESSLIVING_MEMBERSHIP_PLAN_MATCH_PRECEDENCE,

  // Remaining visits are imported as the current entitlement state.
  // Historical attendance must not run DanceFlow deduction logic against an
  // already-migrated remaining balance.
  historicalAttendanceMode: "history_only_no_balance_deduction",

  // Future bookings should be linked to a valid migrated package/membership
  // when the source data identifies one. Unresolved entitlement links are an
  // exception rather than silently converting the booking to free/comped.
  futureAppointmentEntitlementMode: "require_resolution_when_source_identifies_entitlement",

  // Historical financial activity must not recreate charges. Imported
  // payments remain historical records and source-account credits use the
  // client account ledger with durable source identity.
  historicalPaymentsMode: "history_only",
  accountCreditMode: "ledger_balance_preservation",

  // Membership periods are the authoritative current-cycle payment state.
  membershipPeriodMode: "preserve_source_period_and_payment_state",

  // External recurring billing is not automatically re-created. The studio
  // must intentionally establish its future DanceFlow billing method.
  recurringBillingMigrationMode: "do_not_recreate_autopay_without_owner_action",
} as const;

export function normalizeWellnessLivingText(value: unknown, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function normalizeWellnessLivingEmail(value: unknown) {
  const normalized = normalizeWellnessLivingText(value, 320).toLowerCase();
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized
    : "";
}

export function normalizeWellnessLivingPhone(value: unknown) {
  const raw = normalizeWellnessLivingText(value, 80);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

export function normalizeWellnessLivingName(value: unknown) {
  return normalizeWellnessLivingText(value, 180)
    .replace(/\s+/g, " ")
    .toLowerCase();
}
