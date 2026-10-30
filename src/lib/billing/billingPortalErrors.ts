/**
 * D7-1: customer-visible messages for every error code the billing portal route
 * can redirect with, and the plan-change contact path used until a controlled
 * plan-change workflow exists (D7-2, O11).
 */
export const BILLING_SUPPORT_EMAIL = "support@idanceflow.com";

export const BILLING_PORTAL_ERROR_MESSAGES: Record<string, string> = {
  billing_portal_failed:
    "The billing portal could not be opened. No billing change has been made. Please try again in a few minutes; if it keeps happening, contact support@idanceflow.com.",
  billing_customer_missing:
    "No billing account is linked to this workspace yet, so the billing portal cannot be opened. Contact support@idanceflow.com.",
  billing_owner_required:
    "Only the workspace owner can manage billing. Ask the owner to open the billing portal.",
};

export type PlanCardCta =
  | { kind: "current"; label: string }
  | { kind: "contact_support"; label: string; mailto: string }
  | { kind: "start_trial"; label: string };

/**
 * An existing subscriber's plan card never submits the clicked plan anywhere:
 * the checkout route would only open the generic Stripe portal and discard the
 * selection, so the card sends them to support instead (reviewed, authorized
 * changes only).
 */
export function resolvePlanCardCta(params: {
  isCurrent: boolean;
  hasManagedSubscription: boolean;
  planLabel: string;
}): PlanCardCta {
  if (params.isCurrent) return { kind: "current", label: "Current Plan" };

  if (params.hasManagedSubscription) {
    const subject = encodeURIComponent(`Plan change request: ${params.planLabel}`);
    return {
      kind: "contact_support",
      label: "Contact support to change plan",
      mailto: `mailto:${BILLING_SUPPORT_EMAIL}?subject=${subject}`,
    };
  }

  return { kind: "start_trial", label: `Start ${params.planLabel} Trial` };
}

/** D7-3a: checkout refusals for studios that already have, or are mid-way through, a subscription. */
export const BILLING_CHECKOUT_BLOCK_MESSAGES: Record<string, string> = {
  plan_change_requires_support:
    "This workspace already has a subscription. Plan changes are handled by DanceFlow support so your current price and terms are protected. Contact support@idanceflow.com. Nothing has been changed.",
  subscription_needs_support:
    "This workspace's subscription is paused or incomplete, so a new checkout can't be started. Contact support@idanceflow.com. No new subscription or trial has been created.",
};
