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

export type PlanCode = "starter" | "growth" | "pro";

export const PLAN_FEATURES: Record<PlanCode, BillingFeature[]> = {
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
export function requiredPlanForFeature(feature: BillingFeature): PlanCode {
  if (feature === "packages") return "growth";
  if (feature === "memberships") return "growth";
  if (feature === "payments") return "growth";
  return "pro";
}

export function planLabel(plan: PlanCode) {
  if (plan === "starter") return "Starter";
  if (plan === "growth") return "Growth";
  return "Pro";
}