/**
 * PAY-DC-2C: fixed, user-facing copy for membership feedback codes. Pages render only
 * mapped copy; an unknown error renders a generic message and an unknown success
 * renders nothing. Query values are never decoded again or echoed back.
 */

export const GENERIC_FEEDBACK_ERROR = "Something went wrong. Please try again.";

export const MEMBERSHIP_ERROR_MESSAGES: Record<string, string> = {
  membership_unauthorized: "You don't have permission to sell or manage memberships.",
  invalid_client: "The selected client ID is invalid. Please select the client again.",
  invalid_start: "Choose a valid membership start date.",
  missing_membership_details: "Choose a client, membership plan, and start date.",
  membership_lookup_failed: "We couldn't check this client's existing memberships. Please try again.",
  membership_card_setup_failed: "We couldn't start card setup. Please try again.",
  stripe_session_failed: "We couldn't start card setup. Please try again.",
  membership_sale_failed: "We couldn't start the membership checkout. Please try again.",
  terminal_membership_failed: "We couldn't prepare the card reader enrollment. Please try again.",
  assign_failed: "We couldn't assign the membership. Please try again.",
  membership_payment_method_update_failed:
    "We couldn't start the payment method update. Please try again.",
  membership_stripe_settings_unavailable:
    "We couldn't load your studio's payment settings. Please try again.",
  membership_stripe_not_connected: "Connect Stripe in Settings before selling memberships online.",
  membership_stripe_setup_incomplete:
    "Finish your Stripe payment setup in Settings before selling memberships online.",
  membership_payment_failed: "We couldn't record the membership payment. Please try again.",
  membership_payment_unauthorized: "You don't have permission to record membership payments.",
  membership_payment_invalid_amount: "Enter a valid payment amount greater than zero.",
  membership_payment_invalid_method: "Choose a valid payment method.",
  membership_payment_duplicate_reference:
    "A payment with this external reference was already recorded.",
  membership_client_membership_not_found: "Membership was not found for this client.",
  membership_period_already_settled:
    "The membership period covering this payment is already paid or waived.",
  membership_payment_exceeds_balance:
    "This payment is greater than the remaining membership balance.",
  membership_reconcile_failed: "We couldn't reconcile membership renewals. Please try again.",
  membership_reconcile_unauthorized: "You don't have permission to reconcile membership renewals.",
  membership_waiver_unauthorized: "You don't have permission to waive membership periods.",
  membership_waiver_missing_fields: "Choose the membership period and add a reason for the waiver.",
  membership_waiver_failed: "We couldn't waive this membership period. Please try again.",
};

export const MEMBERSHIP_SUCCESS_MESSAGES: Record<string, string> = {
  membership_external_payment_recorded: "Membership payment recorded.",
  membership_period_waived: "Membership period waived.",
  membership_renewals_reconciled: "Membership renewals reconciled.",
};

function lookup(map: Record<string, string>, value: string) {
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : null;
}

/**
 * Resolves a feedback query value to fixed copy. `allowText` may accept specific
 * app-authored sentences (never provider text) for callers that still pass them.
 */
export function resolveFeedbackMessage(
  value: string | undefined | null,
  kind: "error" | "success",
  options: { known?: Record<string, string>; allowText?: (value: string) => boolean } = {},
): string | null {
  if (!value) return null;

  const known = options.known ?? {};
  const mapped =
    lookup(known, value) ??
    lookup(kind === "error" ? MEMBERSHIP_ERROR_MESSAGES : MEMBERSHIP_SUCCESS_MESSAGES, value);
  if (mapped) return mapped;

  if (options.allowText?.(value)) return value;

  return kind === "error" ? GENERIC_FEEDBACK_ERROR : null;
}
