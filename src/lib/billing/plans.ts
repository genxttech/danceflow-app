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
  | "advanced_reporting";

export type PlanCode = "starter" | "growth" | "pro" | "organizer";
export type StudioPlanCode = "starter" | "growth" | "pro";
export type OrganizerPlanCode = "organizer";
export type PlanAudience = "studio" | "organizer";

export type BillingPlan = {
  code: PlanCode;
  label: string;
  audience: PlanAudience;
  amountMonthlyCents: number;
  description: string;
  trialDays: number;
  transparentFeeNote?: string;
  features: BillingFeature[];
  highlights: string[];
};

export const BILLING_PLANS: BillingPlan[] = [
  {
    code: "starter",
    label: "Starter",
    audience: "studio",
    amountMonthlyCents: 4900,
    description: "Core CRM and scheduling for a single studio.",
    trialDays: 14,
    features: ["crm_basic", "schedule_basic"],
    highlights: [
      "Client CRM",
      "Lesson scheduling",
      "Studio calendar",
      "Basic operations",
    ],
  },
  {
    code: "growth",
    label: "Growth",
    audience: "studio",
    amountMonthlyCents: 7900,
    description:
      "Adds stronger operations, packages, memberships, and customer payments.",
    trialDays: 14,
    features: [
      "crm_basic",
      "schedule_basic",
      "packages",
      "memberships",
      "payments",
    ],
    highlights: [
      "Everything in Starter",
      "Packages",
      "Memberships",
      "Customer payments",
      "Stronger day-to-day operations",
    ],
  },
  {
    code: "pro",
    label: "Pro",
    audience: "studio",
    amountMonthlyCents: 12900,
    description:
      "Advanced studio operations plus public event and organizer capabilities.",
    trialDays: 14,
    features: [
      "crm_basic",
      "schedule_basic",
      "packages",
      "memberships",
      "payments",
      "organizer_tools",
      "public_events",
      "ticketing",
      "check_in",
      "waitlist",
      "advanced_reporting",
    ],
    highlights: [
      "Everything in Growth",
      "Organizer tools",
      "Public events",
      "Ticketing and check-in",
      "Waitlist",
      "Advanced reporting",
    ],
  },
  {
    code: "organizer",
    label: "Organizer Suite",
    audience: "organizer",
    amountMonthlyCents: 1200,
    description:
      "All-access event suite for organizers running dance workshops, showcases, competitions, and special events.",
    trialDays: 14,
    transparentFeeNote:
      "Transparent pricing: $12/month plus a 3.5% DanceFlow platform fee per ticket sale. Standard payment processing fees also apply.",
    features: [
      "organizer_tools",
      "public_events",
      "ticketing",
      "check_in",
      "waitlist",
      "advanced_reporting",
    ],
    highlights: [
      "Public event pages",
      "Ticketing and registrations",
      "Check-in",
      "Event schedule / agenda",
      "Guest coach private lesson tools",
      "Coach schedule links and calendar feeds",
      "Organizer marketing and reporting as released",
      "Transparent ticket-sale pricing",
    ],
  },
];

export const PLAN_FEATURES: Record<StudioPlanCode, BillingFeature[]> = {
  starter: ["crm_basic", "schedule_basic"],
  growth: [
    "crm_basic",
    "schedule_basic",
    "packages",
    "memberships",
    "payments",
  ],
  pro: [
    "crm_basic",
    "schedule_basic",
    "packages",
    "memberships",
    "payments",
    "organizer_tools",
    "public_events",
    "ticketing",
    "check_in",
    "waitlist",
    "advanced_reporting",
  ],
};

export const ORGANIZER_PLAN_FEATURES: Record<OrganizerPlanCode, BillingFeature[]> = {
  organizer: [
    "organizer_tools",
    "public_events",
    "ticketing",
    "check_in",
    "waitlist",
    "advanced_reporting",
  ],
};

export function getBillingPlan(planCode: string | null | undefined) {
  if (!planCode) return null;
  return BILLING_PLANS.find((plan) => plan.code === planCode) ?? null;
}

export function getPlansByAudience(audience: PlanAudience) {
  return BILLING_PLANS.filter((plan) => plan.audience === audience);
}

export function planHasFeature(
  planCode: string | null | undefined,
  feature: BillingFeature
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
  feature: BillingFeature
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

  const _exhaustiveCheck: never = feature;
  return _exhaustiveCheck;
}

export function requiredStudioPlanForFeature(feature: BillingFeature): StudioPlanCode {
  if (feature === "crm_basic" || feature === "schedule_basic") return "starter";
  if (feature === "packages") return "growth";
  if (feature === "memberships") return "growth";
  if (feature === "payments") return "growth";
  return "pro";
}

export const requiredPlanForFeature = requiredStudioPlanForFeature;

export function requiredOrganizerPlanForFeature(_feature: BillingFeature): OrganizerPlanCode {
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