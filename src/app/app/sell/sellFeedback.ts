import { resolveFeedbackMessage } from "@/lib/memberships/membershipMessages";

/**
 * PAY-DC-2C: safe feedback for /app/sell. Only mapped codes and a small allowlist of
 * app-authored commerce sentences are shown; anything else (including raw provider
 * or database text) renders generic copy. Values are never decoded a second time.
 */

const SELL_ERROR_MESSAGES: Record<string, string> = {
  missing_client: "Choose a client before completing the sale.",
  invalid_client: "The selected client ID is invalid. Please select the client again.",
  missing_package: "Choose a package before completing the sale.",
  missing_sale_selection: "Choose a client and product before completing the sale.",
  missing_plan: "Choose a membership plan before completing the sale.",
  invalid_plan: "The selected membership plan ID is invalid. Please select the plan again.",
  missing_start: "Choose a membership start date.",
  client_not_found: "The selected client could not be found.",
  plan_not_found: "The selected membership plan could not be found.",
  plan_inactive: "This membership plan is inactive.",
  active_membership_exists: "This client already has an active or pending membership.",
  recurring_consent_required: "Recurring billing consent is required for card reader enrollment.",
  terminal_membership_amount_required: "Card reader enrollment requires a positive first payment amount.",
  membership_confirm_removed_use_single_page_sale: "Use the unified sales page to complete membership sales.",
};

const SELL_SUCCESS_MESSAGES: Record<string, string> = {
  membership_payment_method_saved: "Payment method saved.",
  membership_subscription_created: "Membership subscription created.",
  membership_assigned: "Membership assigned.",
};

// Fixed sentences written by src/app/app/sell/commerceActions.ts and by the commerce
// sale RPCs' own raise exception messages (DanceFlow-authored, not provider text).
const COMMERCE_FIXED_MESSAGES = new Set<string>([
  "Choose a valid product, quantity, payment method, and discount.",
  "Choose a valid client.",
  "Choose a client or enter a walk-in name.",
  "External reference contains invalid characters.",
  "The product sale could not be completed.",
  "Choose a valid product, quantity, and discount.",
  "The card-reader order could not be prepared.",
  "Choose a valid linked student, digital product, and payment method.",
  "The digital sale could not be completed.",
  "That external payment reference is already recorded.",
  "This student already has access to this content.",
  "This client does not have a linked student account.",
  "This client does not have a linked student account for this studio.",
  "Physical product variant was not found.",
  "Published digital product was not found.",
  "Client was not found in this studio.",
  "Payment method is invalid.",
  "Quantity must be between 1 and 1000.",
]);

const RATE_LIMIT_MESSAGE = /^Too many requests\. Please wait \d+ (second|minute)s? and try again\.$/;
const STOCK_AVAILABILITY_MESSAGE = /^Only \d+ (unreserved )?unit\(s\) are available\.$/;

function isAllowedCommerceMessage(value: string) {
  return (
    COMMERCE_FIXED_MESSAGES.has(value) ||
    RATE_LIMIT_MESSAGE.test(value) ||
    STOCK_AVAILABILITY_MESSAGE.test(value)
  );
}

export function sellErrorMessage(value: string | undefined) {
  return resolveFeedbackMessage(value, "error", {
    known: SELL_ERROR_MESSAGES,
    allowText: isAllowedCommerceMessage,
  });
}

export function sellSuccessMessage(value: string | undefined) {
  return resolveFeedbackMessage(value, "success", { known: SELL_SUCCESS_MESSAGES });
}
