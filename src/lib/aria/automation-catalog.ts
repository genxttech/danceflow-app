export type AriaAutomationRisk = "low" | "medium" | "high";
export type AriaAutomationHandling =
  | "automatic"
  | "automatic_with_notification"
  | "approval_required";

export type AriaAutomationPackKey =
  | "front_desk"
  | "lead_follow_up"
  | "schedule_readiness"
  | "client_retention"
  | "documents"
  | "membership_package_care"
  | "post_lesson_closeout"
  | "payment_follow_up";

export type AriaAutomationCatalogItem = {
  ruleKey: string;
  legacyRuleKeys?: string[];
  packKey: AriaAutomationPackKey;
  label: string;
  description: string;
  risk: AriaAutomationRisk;
  handling: AriaAutomationHandling;
  executableChannel: "email" | "system" | "none";
  defaultEnabled: boolean;
  defaultMaxPriority: "low" | "normal" | "high" | "urgent";
};

export const ARIA_AUTOMATION_PACKS: Array<{
  key: AriaAutomationPackKey;
  label: string;
  description: string;
  defaultEnabled: boolean;
}> = [
  {
    key: "front_desk",
    label: "Front Desk",
    description:
      "Routine booking, appointment, cancellation, and schedule communication.",
    defaultEnabled: true,
  },
  {
    key: "lead_follow_up",
    label: "Lead Follow-Up",
    description:
      "Acknowledgements and follow-up that protect new-dancer momentum.",
    defaultEnabled: true,
  },
  {
    key: "schedule_readiness",
    label: "Schedule Readiness",
    description:
      "Operational checks that surface unresolved booking and schedule issues.",
    defaultEnabled: true,
  },
  {
    key: "client_retention",
    label: "Client Retention",
    description:
      "Rebooking and momentum outreach for active dancers.",
    defaultEnabled: true,
  },
  {
    key: "documents",
    label: "Documents",
    description:
      "Routine reminders and safe cleanup for outstanding documents.",
    defaultEnabled: true,
  },
  {
    key: "membership_package_care",
    label: "Membership and Package Care",
    description:
      "Low-balance, expiration, renewal, and past-due communication.",
    defaultEnabled: true,
  },
  {
    key: "post_lesson_closeout",
    label: "Post-Lesson Closeout",
    description:
      "Deterministic follow-up and closeout steps after confirmed attendance.",
    defaultEnabled: true,
  },
  {
    key: "payment_follow_up",
    label: "Payment Follow-Up",
    description:
      "Safe payment reminders and exact-match reconciliation while keeping financial actions approval-gated.",
    defaultEnabled: true,
  },
];

export const ARIA_AUTOMATION_CATALOG: AriaAutomationCatalogItem[] = [
  {
    ruleKey: "aria_booking_request_aging",
    legacyRuleKeys: ["pending_booking_request"],
    packKey: "schedule_readiness",
    label: "Aging booking requests",
    description:
      "Surface booking requests that have waited too long for staff review.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_low_package_balance",
    legacyRuleKeys: ["low_package_balance"],
    packKey: "membership_package_care",
    label: "Low package balance outreach",
    description:
      "Send a routine renewal reminder before usable lesson credits run out.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_package_expiring",
    packKey: "membership_package_care",
    label: "Package expiration outreach",
    description:
      "Send a routine reminder when an active package is approaching expiration.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_stale_active_student",
    legacyRuleKeys: ["no_upcoming_lesson"],
    packKey: "client_retention",
    label: "Student momentum outreach",
    description:
      "Send a rebooking prompt to an active dancer with no future appointment.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_intro_no_purchase",
    legacyRuleKeys: ["first_lesson_follow_up"],
    packKey: "lead_follow_up",
    label: "Intro conversion follow-up",
    description:
      "Send a routine next-step message after an intro without a recorded purchase.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_membership_past_due",
    packKey: "membership_package_care",
    label: "Past-due membership outreach",
    description:
      "Send a billing follow-up without charging a card or changing access.",
    risk: "medium",
    handling: "automatic_with_notification",
    executableChannel: "email",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_membership_canceling",
    packKey: "membership_package_care",
    label: "Canceling membership outreach",
    description:
      "Send a retention follow-up while leaving plan changes and cancellation decisions to staff.",
    risk: "medium",
    handling: "automatic_with_notification",
    executableChannel: "email",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_payment_exception",
    packKey: "payment_follow_up",
    label: "Payment exceptions",
    description:
      "Surface pending or failed payments for staff review. Never charge, retry, refund, or waive automatically.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_event_unpaid_registration",
    packKey: "payment_follow_up",
    label: "Unpaid event registrations",
    description:
      "Surface event payment exceptions without modifying registrations or charging customers.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_event_missing_costs",
    packKey: "post_lesson_closeout",
    label: "Missing event costs",
    description:
      "Surface incomplete event accounting before profitability is trusted.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_event_loss",
    packKey: "post_lesson_closeout",
    label: "Event loss review",
    description:
      "Surface below-break-even events without changing pricing or accounting records.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_event_low_checkin",
    packKey: "post_lesson_closeout",
    label: "Low event check-in quality",
    description:
      "Surface attendance-quality exceptions without rewriting attendance records.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
];

export function getAriaAutomationCatalogItem(ruleKey: string) {
  return (
    ARIA_AUTOMATION_CATALOG.find(
      (item) =>
        item.ruleKey === ruleKey || item.legacyRuleKeys?.includes(ruleKey),
    ) ?? null
  );
}

export function getDefaultAriaPolicyRows(studioId: string) {
  return ARIA_AUTOMATION_CATALOG.map((item) => ({
    studio_id: studioId,
    rule_key: item.ruleKey,
    enabled: item.defaultEnabled,
    auto_approve: item.handling !== "approval_required",
    max_auto_approve_priority: item.defaultMaxPriority,
    require_assignment: false,
    default_source: "danceflow_default",
    handling_mode: item.handling,
    pack_key: item.packKey,
  }));
}
