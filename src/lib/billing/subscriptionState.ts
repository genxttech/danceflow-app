/**
 * D7-3a: one definition of "does this studio already have a SaaS subscription"
 * shared by the billing page and the checkout route, so they cannot disagree
 * (a studio the page treats as new but checkout treats as subscribed, or the
 * reverse).
 *
 * - managed: a live, billable subscription (plan changes go through support).
 * - hold: paused or incomplete. Not live, but not terminal either: a new
 *   Checkout would add a second subscription and a second trial, so it is
 *   blocked and routed to support (fail closed).
 * - none: no subscription, or only terminal ones (canceled, incomplete_expired).
 */
export type SubscriptionStateKind = "managed" | "hold" | "none";

const MANAGED_STATUSES = ["active", "trialing", "past_due", "unpaid"];
const HOLD_STATUSES = ["paused", "incomplete"];

export function classifySubscriptionStatus(
  status: string | null | undefined,
): SubscriptionStateKind {
  if (MANAGED_STATUSES.includes(status ?? "")) return "managed";
  if (HOLD_STATUSES.includes(status ?? "")) return "hold";
  return "none";
}

export function isManagedSubscriptionStatus(status: string | null | undefined) {
  return classifySubscriptionStatus(status) === "managed";
}

/** The strongest state across several subscriptions: managed, then hold, then none. */
export function strongestSubscriptionState(
  statuses: Array<string | null | undefined>,
): SubscriptionStateKind {
  const kinds = statuses.map(classifySubscriptionStatus);
  if (kinds.includes("managed")) return "managed";
  if (kinds.includes("hold")) return "hold";
  return "none";
}

/** True when a new plan Checkout must not be started. */
export function blocksNewCheckout(kind: SubscriptionStateKind) {
  return kind !== "none";
}
