/** The one rule for whether a studio plan includes LUMI: Growth or Pro, on an active or trialing subscription. */
export function isLumiPlanAllowed(resolution: { planCode?: string | null; status?: string | null }) {
  const active = resolution.status === "active" || resolution.status === "trialing";
  return active && (resolution.planCode === "growth" || resolution.planCode === "pro");
}
