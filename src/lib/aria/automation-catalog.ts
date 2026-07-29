export type AriaAutomationRisk = "low" | "medium" | "high";
export type AriaAutomationHandling =
  | "automatic"
  | "automatic_with_notification"
  | "approval_required";

export type AriaAutomationPackKey =
  | "front_desk"
  | "client_relations"
  | "scheduling"
  | "sales_retention"
  | "marketing"
  | "billing_payments"
  | "documents"
  | "events"
  | "staff_payroll"
  | "retail_inventory"
  | "studio_health";

export type AriaAutomationCatalogItem = {
  ruleKey: string;
  legacyRuleKeys?: string[];
  packKey: AriaAutomationPackKey;
  label: string;
  description: string;
  risk: AriaAutomationRisk;
  handling: AriaAutomationHandling;
  executableChannel: "email" | "system" | "none";
  defaultDeliveryMode:
    | "internal_only"
    | "suggestion_only"
    | "draft_for_review"
    | "auto_send";
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
    description: "Routine booking, confirmation, cancellation, and front-desk follow-through.",
    defaultEnabled: true,
  },
  {
    key: "client_relations",
    label: "Client Relationships",
    description: "Welcome, lesson follow-up, service recovery, and relationship care.",
    defaultEnabled: true,
  },
  {
    key: "scheduling",
    label: "Scheduling",
    description: "Booking readiness, conflicts, waitlists, and instructor coverage.",
    defaultEnabled: true,
  },
  {
    key: "sales_retention",
    label: "Sales and Retention",
    description: "Lead conversion, rebooking, renewals, and appropriate reactivation.",
    defaultEnabled: true,
  },
  {
    key: "marketing",
    label: "Marketing",
    description: "Campaign opportunities and drafts prepared for review.",
    defaultEnabled: true,
  },
  {
    key: "billing_payments",
    label: "Billing and Payments",
    description: "Safe reminders and financial exceptions without automatic charges or refunds.",
    defaultEnabled: true,
  },
  {
    key: "documents",
    label: "Documents",
    description: "Signature reminders and document-completion exceptions.",
    defaultEnabled: true,
  },
  {
    key: "events",
    label: "Events",
    description: "Registration, attendance, cost, and profitability exceptions.",
    defaultEnabled: true,
  },
  {
    key: "staff_payroll",
    label: "Staff and Payroll",
    description: "Payroll-prep, ownership, and staff coordination exceptions.",
    defaultEnabled: true,
  },
  {
    key: "retail_inventory",
    label: "Retail and Inventory",
    description: "Inventory, fulfillment, and entitlement exceptions.",
    defaultEnabled: true,
  },
  {
    key: "studio_health",
    label: "Studio Health",
    description: "Data quality, app adoption, onboarding, and migration exceptions.",
    defaultEnabled: true,
  },
];

export const ARIA_AUTOMATION_CATALOG: AriaAutomationCatalogItem[] = [
  {
    ruleKey: "aria_booking_request_aging",
    legacyRuleKeys: ["pending_booking_request"],
    packKey: "front_desk",
    label: "Aging booking requests",
    description:
      "Surface booking requests that have waited too long for staff review.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
  defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_low_package_balance",
    legacyRuleKeys: ["low_package_balance"],
    packKey: "sales_retention",
    label: "Low package balance outreach",
    description:
      "Send a routine renewal reminder before usable lesson credits run out.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
  defaultDeliveryMode: "auto_send",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_package_expiring",
    packKey: "sales_retention",
    label: "Package expiration outreach",
    description:
      "Send a routine reminder when an active package is approaching expiration.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
  defaultDeliveryMode: "auto_send",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_stale_active_student",
    legacyRuleKeys: ["no_upcoming_lesson"],
    packKey: "sales_retention",
    label: "Student momentum outreach",
    description:
      "Send a rebooking prompt to an active dancer with no future appointment.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
  defaultDeliveryMode: "auto_send",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_intro_no_purchase",
    legacyRuleKeys: ["first_lesson_follow_up"],
    packKey: "client_relations",
    label: "Intro conversion follow-up",
    description:
      "Send a routine next-step message after an intro without a recorded purchase.",
    risk: "low",
    handling: "automatic",
    executableChannel: "email",
  defaultDeliveryMode: "auto_send",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_membership_past_due",
    packKey: "billing_payments",
    label: "Past-due membership outreach",
    description:
      "Send a billing follow-up without charging a card or changing access.",
    risk: "medium",
    handling: "automatic_with_notification",
    executableChannel: "email",
  defaultDeliveryMode: "auto_send",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_membership_canceling",
    packKey: "sales_retention",
    label: "Canceling membership outreach",
    description:
      "Send a retention follow-up while leaving plan changes and cancellation decisions to staff.",
    risk: "medium",
    handling: "automatic_with_notification",
    executableChannel: "email",
  defaultDeliveryMode: "auto_send",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_payment_exception",
    packKey: "billing_payments",
    label: "Payment exceptions",
    description:
      "Surface pending or failed payments for staff review. Never charge, retry, refund, or waive automatically.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
  defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_event_unpaid_registration",
    packKey: "billing_payments",
    label: "Unpaid event registrations",
    description:
      "Surface event payment exceptions without modifying registrations or charging customers.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
  defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_event_missing_costs",
    packKey: "events",
    label: "Missing event costs",
    description:
      "Surface incomplete event accounting before profitability is trusted.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
  defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_event_loss",
    packKey: "events",
    label: "Event loss review",
    description:
      "Surface below-break-even events without changing pricing or accounting records.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
  defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_event_low_checkin",
    packKey: "events",
    label: "Low event check-in quality",
    description:
      "Surface attendance-quality exceptions without rewriting attendance records.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
  defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_appointment_confirmation_gap",
    packKey: "front_desk",
    label: "Unconfirmed appointment follow-up",
    description:
      "Surface upcoming appointments that remain unconfirmed inside the reminder window.",
    risk: "low",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "draft_for_review",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_no_show_service_recovery",
    packKey: "client_relations",
    label: "No-show service recovery",
    description:
      "Prepare a supportive follow-up task after a no-show while leaving fees and policy decisions to staff.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "draft_for_review",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_schedule_conflict",
    packKey: "scheduling",
    label: "Schedule conflict review",
    description:
      "Detect overlapping instructor or room assignments before they affect the studio day.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_marketing_opportunity",
    packKey: "marketing",
    label: "Marketing opportunity review",
    description:
      "Surface stale campaign drafts that are ready for a deliberate marketing decision.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "suggestion_only",
    defaultEnabled: true,
    defaultMaxPriority: "normal",
  },
  {
    ruleKey: "aria_payroll_missing_data",
    packKey: "staff_payroll",
    label: "Payroll readiness gaps",
    description:
      "Surface active payroll instructors missing classification or compensation setup.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_inventory_low_stock",
    packKey: "retail_inventory",
    label: "Low inventory review",
    description:
      "Surface active product variants that have reached their reorder threshold.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "suggestion_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_data_quality_exception",
    packKey: "studio_health",
    label: "Data quality exceptions",
    description:
      "Surface import batches with failed rows or unresolved warnings for reconciliation.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },

  {
    ruleKey: "aria_cancellation_follow_up",
    packKey: "front_desk",
    label: "Cancellation follow-up",
    description:
      "Surface recent cancellations that left a client without another future appointment.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "draft_for_review",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_document_expiration",
    packKey: "documents",
    label: "Overdue document exception",
    description:
      "Surface pending required documents after their due date for staff review.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_external_payment_missing",
    packKey: "billing_payments",
    label: "External payment reconciliation gap",
    description:
      "Surface completed or past-due paid-service appointments that still show unpaid or partial payment status.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_lead_acknowledgement",
    packKey: "client_relations",
    label: "New lead acknowledgement gap",
    description:
      "Surface new leads that have no recorded lead activity after their first day.",
    risk: "low",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "draft_for_review",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_lead_follow_up_sequence",
    packKey: "sales_retention",
    label: "Lead follow-up sequence",
    description:
      "Surface overdue lead follow-up activities that still need completion.",
    risk: "low",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "draft_for_review",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_inactive_client_reactivation",
    packKey: "sales_retention",
    label: "Inactive client reactivation",
    description:
      "Surface inactive clients with prior lesson history and no future appointment.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "draft_for_review",
    defaultEnabled: true,
    defaultMaxPriority: "normal",
  },
  {
    ruleKey: "aria_instructor_coverage_gap",
    packKey: "scheduling",
    label: "Instructor coverage gap",
    description:
      "Surface upcoming teaching appointments that do not have an instructor assigned.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_class_capacity",
    packKey: "scheduling",
    label: "Class capacity and waitlist",
    description:
      "Surface upcoming group classes approaching capacity or already using a waitlist.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_event_promotion_gap",
    packKey: "events",
    label: "Event promotion gap",
    description:
      "Surface upcoming public events with weak registration traction close to event day.",
    risk: "medium",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "suggestion_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_staff_task_reminder",
    packKey: "staff_payroll",
    label: "Overdue staff follow-up",
    description:
      "Surface overdue CRM follow-up activities that still need a staff owner to close them.",
    risk: "low",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "high",
  },
  {
    ruleKey: "aria_order_fulfillment_exception",
    packKey: "retail_inventory",
    label: "Order fulfillment exception",
    description:
      "Surface paid commerce orders that remain unfulfilled after the normal fulfillment window.",
    risk: "high",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "internal_only",
    defaultEnabled: true,
    defaultMaxPriority: "urgent",
  },
  {
    ruleKey: "aria_student_app_adoption",
    packKey: "studio_health",
    label: "Student app adoption gap",
    description:
      "Surface active clients who do not yet have a linked DanceFlow account relationship.",
    risk: "low",
    handling: "approval_required",
    executableChannel: "none",
    defaultDeliveryMode: "suggestion_only",
    defaultEnabled: true,
    defaultMaxPriority: "normal",
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
    delivery_mode: item.defaultDeliveryMode,
    pack_key: item.packKey,
  }));
}


export function getDefaultAriaAutomationRuleRows(studioId: string, actorUserId: string) {
  const now = new Date().toISOString();

  return ARIA_AUTOMATION_CATALOG.map((item) => ({
    studio_id: studioId,
    rule_key: item.ruleKey,
    name: item.label,
    description: item.description,
    trigger_key: `aria_${item.ruleKey}`,
    action_key: "create_aria_operations_action",
    enabled: item.defaultEnabled,
    mode:
      item.defaultDeliveryMode === "auto_send"
        ? "auto_send"
        : item.defaultDeliveryMode === "draft_for_review"
          ? "draft"
          : "suggestion",
    trigger_config: {},
    action_config: {
      source: "aria_operations",
      delivery_mode: item.defaultDeliveryMode,
    },
    pack_key: item.packKey,
    default_source: "danceflow_default",
    created_by: actorUserId,
    updated_by: actorUserId,
    updated_at: now,
  }));
}
