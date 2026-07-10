export type BillingFeature =
  | "crm_basic"
  | "schedule_basic"
  | "packages"
  | "memberships"
  | "payments"
  | "organizer_tools"
  | "public_events"
  | "ticketing"
  | "check_in"
  | "waitlist"
  | "basic_reporting"
  | "advanced_reporting"
  | "report_exports"
  | "wave_accounting"
  | "marketing_campaigns"
  | "marketing_event_audiences"
  | "ai_assistant"
  | "documents"
  | "event_waivers"
  | "organizer_contacts"
  | "organizer_campaigns"
  | "guest_coach_slots";

export type PlanCode = "starter" | "growth" | "pro" | "organizer";
export type StudioPlanCode = "starter" | "growth" | "pro";
export type OrganizerPlanCode = "organizer";
export type PlanAudience = "studio" | "organizer";

export type BillingPlan = {
  code: PlanCode;
  label: string;
  audience: PlanAudience;
  amountMonthlyCents: number;
  regularAmountMonthlyCents?: number;
  description: string;
  trialDays: number;
  transparentFeeNote?: string;
  founderOfferNote?: string;
  features: BillingFeature[];
  highlights: string[];
};

export const FOUNDER_STUDIO_SPOTS = 25;
export const STUDIO_TRIAL_DAYS = 30;
export const ORGANIZER_TRIAL_DAYS = 30;

export const BILLING_PLANS: BillingPlan[] = [
  {
    code: "starter",
    label: "Starter",
    audience: "studio",
    amountMonthlyCents: 4900,
    regularAmountMonthlyCents: 5900,
    description:
      "Core CRM, scheduling, client portals, and simple studio operations for independent instructors and smaller studios.",
    trialDays: STUDIO_TRIAL_DAYS,
    founderOfferNote:
      "Founder pricing is available for the first 25 studios and lasts for 12 months after your free trial.",
    features: [
      "crm_basic",
      "schedule_basic",
      "public_events",
      "basic_reporting",
    ],
    highlights: [
      "Client CRM and lead records",
      "Lesson scheduling and studio calendar",
      "Client portal access",
      "Basic packages, payments, and reports",
      "Basic public event listings for DanceFlow Discovery",
      "Basic email campaign tools",
      "Syllabus tracking basics",
    ],
  },
  {
    code: "growth",
    label: "Growth",
    audience: "studio",
    amountMonthlyCents: 7900,
    regularAmountMonthlyCents: 9900,
    description:
      "Growth tools for studios that want stronger retention, packages, memberships, reporting, marketing, and AI assistance.",
    trialDays: STUDIO_TRIAL_DAYS,
    founderOfferNote:
      "Founder pricing is available for the first 25 studios and lasts for 12 months after your free trial.",
    features: [
      "crm_basic",
      "schedule_basic",
      "packages",
      "memberships",
      "payments",
      "public_events",
      "basic_reporting",
      "advanced_reporting",
      "marketing_campaigns",
      "ai_assistant",
      "documents",
    ],
    highlights: [
      "Everything in Starter",
      "Packages, memberships, and customer payments",
      "Targeted CRM campaign audiences",
      "AI report insights and campaign drafting",
      "AI follow-up suggestions",
      "Instructor and client growth reporting",
      "Basic public event listings for socials, open houses, and workshops",
    ],
  },
  {
    code: "pro",
    label: "Pro",
    audience: "studio",
    amountMonthlyCents: 12900,
    regularAmountMonthlyCents: 15900,
    description:
      "Advanced studio growth with stronger reporting, automations, documents, marketing, ARIA insights, and larger AI usage without forcing full event-commerce tools.",
    trialDays: STUDIO_TRIAL_DAYS,
    founderOfferNote:
      "Founder pricing is available for the first 25 studios and lasts for 12 months after your free trial.",
    features: [
      "crm_basic",
      "schedule_basic",
      "packages",
      "memberships",
      "payments",
      "public_events",
      "basic_reporting",
      "advanced_reporting",
      "report_exports",
      "wave_accounting",
      "marketing_campaigns",
      "ai_assistant",
      "documents",
    ],
    highlights: [
      "Everything in Growth",
      "Advanced reports and CSV exports",
      "Read-only Wave accounting connection and posting previews",
      "Advanced automations, documents, and team controls",
      "Studio ARIA insights and larger AI allowance",
      "Basic public event listings for DanceFlow Discovery",
      "Add Organizer Suite for ticketing, QR check-in, settlements, event campaigns, and event ARIA",
    ],
  },
  {
    code: "organizer",
    label: "Organizer Suite",
    audience: "organizer",
    amountMonthlyCents: 1200,
    regularAmountMonthlyCents: 1900,
    description:
      "All-access event suite for organizers running dance workshops, showcases, competitions, festivals, and special events.",
    trialDays: ORGANIZER_TRIAL_DAYS,
    founderOfferNote:
      "Founder organizer pricing is available during launch and lasts for 12 months after your free trial.",
    transparentFeeNote:
      "Transparent pricing: founder pricing is $12/month, regularly $19/month, plus a 3.5% DanceFlow platform fee per ticket sale for standalone organizer workspaces. Standard payment processing fees also apply.",
    features: [
      "organizer_tools",
      "public_events",
      "ticketing",
      "check_in",
      "waitlist",
      "basic_reporting",
      "advanced_reporting",
      "report_exports",
      "marketing_campaigns",
      "marketing_event_audiences",
      "ai_assistant",
      "documents",
      "event_waivers",
      "organizer_contacts",
      "organizer_campaigns",
      "guest_coach_slots",
    ],
    highlights: [
      "Public event pages",
      "Ticketing and registrations",
      "Ticket codes and QR check-in",
      "Event schedule / agenda",
      "Guest coach private lesson tools",
      "Coach schedule links and calendar feeds",
      "Organizer contacts and marketing campaigns",
      "Event reporting, profitability, and settlement tools",
    ],
  },
];

export const PLAN_FEATURES: Record<StudioPlanCode, BillingFeature[]> = {
  starter: ["crm_basic", "schedule_basic", "public_events", "basic_reporting"],
  growth: [
    "crm_basic",
    "schedule_basic",
    "packages",
    "memberships",
    "payments",
    "public_events",
    "basic_reporting",
    "advanced_reporting",
    "marketing_campaigns",
    "ai_assistant",
    "documents",
  ],
  pro: [
    "crm_basic",
    "schedule_basic",
    "packages",
    "memberships",
    "payments",
    "public_events",
    "basic_reporting",
    "advanced_reporting",
    "report_exports",
    "wave_accounting",
    "marketing_campaigns",
    "ai_assistant",
    "documents",
  ],
};

export const ORGANIZER_PLAN_FEATURES: Record<
  OrganizerPlanCode,
  BillingFeature[]
> = {
  organizer: [
    "organizer_tools",
    "public_events",
    "ticketing",
    "check_in",
    "waitlist",
    "basic_reporting",
    "advanced_reporting",
    "report_exports",
    "marketing_campaigns",
    "marketing_event_audiences",
    "ai_assistant",
    "documents",
    "event_waivers",
    "organizer_contacts",
    "organizer_campaigns",
    "guest_coach_slots",
  ],
};

export const BASIC_EVENT_LISTING_FEATURES: BillingFeature[] = ["public_events"];

export const ORGANIZER_SUITE_FEATURES: BillingFeature[] = [
  "organizer_tools",
  "ticketing",
  "check_in",
  "waitlist",
  "marketing_event_audiences",
  "event_waivers",
  "organizer_contacts",
  "organizer_campaigns",
  "guest_coach_slots",
];

export const EVENT_COMMERCE_FEATURES: BillingFeature[] = [
  "ticketing",
  "check_in",
  "waitlist",
  "event_waivers",
  "guest_coach_slots",
];

export const EVENT_OPERATIONS_FEATURES: BillingFeature[] = [
  "organizer_tools",
  "marketing_event_audiences",
  "organizer_contacts",
  "organizer_campaigns",
];

export function isOrganizerSuiteFeature(feature: BillingFeature) {
  return ORGANIZER_SUITE_FEATURES.includes(feature);
}

export function isBasicEventListingFeature(feature: BillingFeature) {
  return BASIC_EVENT_LISTING_FEATURES.includes(feature);
}

export function planHasBasicEventListings(planCode: string | null | undefined) {
  return planHasFeature(planCode, "public_events");
}

export function planHasOrganizerSuite(planCode: string | null | undefined) {
  return planCode === "organizer";
}

export function planHasEventCommerce(planCode: string | null | undefined) {
  return planHasOrganizerSuite(planCode);
}

export function planHasEventOperations(planCode: string | null | undefined) {
  return planHasOrganizerSuite(planCode);
}

export function getBillingPlan(planCode: string | null | undefined) {
  if (!planCode) return null;
  return BILLING_PLANS.find((plan) => plan.code === planCode) ?? null;
}

export function getPlansByAudience(audience: PlanAudience) {
  return BILLING_PLANS.filter((plan) => plan.audience === audience);
}

export function planHasFeature(
  planCode: string | null | undefined,
  feature: BillingFeature,
) {
  if (!planCode) return false;

  if (planCode === "starter" || planCode === "growth" || planCode === "pro") {
    return PLAN_FEATURES[planCode].includes(feature);
  }

  if (planCode === "organizer") {
    return ORGANIZER_PLAN_FEATURES.organizer.includes(feature);
  }

  return false;
}

export function organizerPlanHasFeature(
  planCode: string | null | undefined,
  feature: BillingFeature,
) {
  if (planCode !== "organizer") return false;
  return ORGANIZER_PLAN_FEATURES.organizer.includes(feature);
}

export function featureLabel(feature: BillingFeature) {
  if (feature === "crm_basic") return "CRM";
  if (feature === "schedule_basic") return "Scheduling";
  if (feature === "packages") return "Packages";
  if (feature === "memberships") return "Memberships";
  if (feature === "payments") return "Customer Payments";
  if (feature === "organizer_tools") return "Organizer Tools";
  if (feature === "public_events") return "Public Events";
  if (feature === "ticketing") return "Ticketing";
  if (feature === "check_in") return "Check-In";
  if (feature === "waitlist") return "Waitlist";
  if (feature === "advanced_reporting") return "Advanced Reporting";
  if (feature === "basic_reporting") return "Basic Reporting";
  if (feature === "report_exports") return "Report Exports";
  if (feature === "wave_accounting") return "Wave Accounting";
  if (feature === "marketing_campaigns") return "Marketing Campaigns";
  if (feature === "marketing_event_audiences")
    return "Event Marketing Audiences";
  if (feature === "ai_assistant") return "AI Assistant";
  if (feature === "documents") return "Documents & E-Signatures";
  if (feature === "event_waivers") return "Event Waivers";
  if (feature === "organizer_contacts") return "Organizer Contacts";
  if (feature === "organizer_campaigns") return "Organizer Campaigns";
  if (feature === "guest_coach_slots") return "Guest Coach Lesson Slots";

  const _exhaustiveCheck: never = feature;
  return _exhaustiveCheck;
}

export function requiredStudioPlanForFeature(
  feature: BillingFeature,
): StudioPlanCode {
  if (feature === "crm_basic" || feature === "schedule_basic") return "starter";
  if (feature === "public_events") return "starter";
  if (feature === "basic_reporting") return "starter";
  if (feature === "packages") return "growth";
  if (feature === "memberships") return "growth";
  if (feature === "payments") return "growth";
  if (feature === "advanced_reporting") return "growth";
  if (feature === "marketing_campaigns") return "growth";
  if (feature === "ai_assistant") return "growth";
  if (feature === "documents") return "growth";
  return "pro";
}

export const requiredPlanForFeature = requiredStudioPlanForFeature;

export function requiredOrganizerPlanForFeature(
  _feature: BillingFeature,
): OrganizerPlanCode {
  return "organizer";
}

export function planLabel(plan: PlanCode) {
  const found = getBillingPlan(plan);
  return found?.label ?? "Plan";
}

export function formatPlanMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
