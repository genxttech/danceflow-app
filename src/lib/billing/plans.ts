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
    amountMonthlyCents: 3900,
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
    amountMonthlyCents: 5900,
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
    amountMonthlyCents: 11900,
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
    label: "Organizer",
    audience: "organizer",
    amountMonthlyCents: 1200,
    description:
      "Event-first organizer plan for public listings, registrations, and ticketing.",
    trialDays: 14,
    transparentFeeNote:
      "Transparent fees: 2.5% Square processing fee + 3.5% DanceFlow platform fee on ticket sales.",
    features: [
      "organizer_tools",
      "public_events",
      "ticketing",
      "check_in",
      "waitlist",
    ],
    highlights: [
      "Public event pages",
      "Registrations and ticketing",
      "Check-in",
      "Waitlist",
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
  if (planCode !== "starter" && planCode !== "growth" && planCode !== "pro") {
    return false;
  }

  return PLAN_FEATURES[planCode].includes(feature);
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

export function requiredPlanForFeature(feature: BillingFeature): StudioPlanCode {
  if (feature === "crm_basic" || feature === "schedule_basic") return "starter";
  if (feature === "packages") return "growth";
  if (feature === "memberships") return "growth";
  if (feature === "payments") return "growth";
  return "pro";
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