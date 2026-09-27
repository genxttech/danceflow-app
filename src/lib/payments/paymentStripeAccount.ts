import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PAY-DC-2A: Stripe account ownership for studio-client payments.
 *
 * A non-NULL stored `stripe_account_id` is the authoritative, immutable owner of a
 * charge. It is never compared to or replaced by the studio's current connected
 * account. The current account is only a proof candidate for rows whose ownership
 * is still NULL, and only a successful account-scoped Stripe retrieve proves it.
 * The platform account is never used.
 */

export type RefundOwnershipErrorCode =
  | "refund_payment_account_mismatch"
  | "refund_payment_account_unverified"
  | "refund_payment_account_unavailable"
  | "refund_ownership_check_failed"
  | "refund_stripe_not_connected";

/** Fixed studio-facing messages for refund ownership codes (no account ids or Stripe text). */
export const REFUND_OWNERSHIP_ERROR_MESSAGES: Record<RefundOwnershipErrorCode, string> = {
  refund_payment_account_unverified:
    "We couldn't confirm which Stripe account holds this payment. Refund it from your Stripe Dashboard, or contact DanceFlow support.",
  refund_payment_account_unavailable:
    "The Stripe account that took this payment isn't available for refunds right now. Refund it from that Stripe Dashboard, or contact DanceFlow support.",
  refund_payment_account_mismatch:
    "This payment's Stripe ownership records conflict. Contact DanceFlow support.",
  refund_ownership_check_failed: "We couldn't verify this payment with Stripe. Please try again.",
  refund_stripe_not_connected: "Stripe is not connected for this studio.",
};

export function isRefundOwnershipErrorCode(value: unknown): value is RefundOwnershipErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(REFUND_OWNERSHIP_ERROR_MESSAGES, value)
  );
}

export type StoredStripeAccountSelection =
  | { kind: "stored"; stripeAccount: string }
  | { kind: "none" }
  | { kind: "conflict" };

/** Pure: exactly one distinct stored owner is authoritative; more than one is a conflict. */
export function selectStoredStripeAccount(
  storedAccountIds: ReadonlyArray<string | null | undefined>,
): StoredStripeAccountSelection {
  const distinct = new Set(
    storedAccountIds
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  );

  if (distinct.size === 0) return { kind: "none" };
  if (distinct.size > 1) return { kind: "conflict" };
  return { kind: "stored", stripeAccount: [...distinct][0] };
}

type StripeErrorLike = { code?: unknown; statusCode?: unknown; type?: unknown };

function stripeErrorFields(error: unknown) {
  const value = (error && typeof error === "object" ? error : {}) as StripeErrorLike;
  return {
    code: typeof value.code === "string" ? value.code : "",
    statusCode: typeof value.statusCode === "number" ? value.statusCode : 0,
    type: typeof value.type === "string" ? value.type : "",
  };
}

function isStripeNotFound(error: unknown) {
  const { code, statusCode } = stripeErrorFields(error);
  return code === "resource_missing" || statusCode === 404;
}

export type StripeOwnershipProof =
  | { ok: true; stripeAccount: string }
  | {
      ok: false;
      code:
        | "refund_stripe_not_connected"
        | "refund_payment_account_unverified"
        | "refund_ownership_check_failed";
    };

/**
 * D1(b): only for rows with no stored owner. Retrieves the PaymentIntent (or Charge)
 * on the candidate account; success proves the object lives there. Never refunds and
 * never calls Stripe without a stripeAccount.
 */
export async function proveStripeAccountOwnership(input: {
  candidateAccountId: string | null | undefined;
  paymentIntentId: string | null | undefined;
  chargeId: string | null | undefined;
  stripe: Stripe;
}): Promise<StripeOwnershipProof> {
  const candidate = input.candidateAccountId?.trim() ?? "";
  if (!candidate) return { ok: false, code: "refund_stripe_not_connected" };

  const paymentIntentId = input.paymentIntentId?.trim() ?? "";
  const chargeId = input.chargeId?.trim() ?? "";
  if (!paymentIntentId && !chargeId) {
    return { ok: false, code: "refund_payment_account_unverified" };
  }

  try {
    const object = paymentIntentId
      ? await input.stripe.paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: candidate })
      : await input.stripe.charges.retrieve(chargeId, {}, { stripeAccount: candidate });

    if (object?.id !== (paymentIntentId || chargeId)) {
      return { ok: false, code: "refund_payment_account_unverified" };
    }

    return { ok: true, stripeAccount: candidate };
  } catch (error) {
    const code = isStripeNotFound(error)
      ? "refund_payment_account_unverified"
      : "refund_ownership_check_failed";
    console.error(code);
    return { ok: false, code };
  }
}

/** Classifies a Stripe refund failure on a stored owner account into a fixed safe code. */
export function classifyRefundStripeError(
  error: unknown,
): "refund_payment_account_unavailable" | "refund_stripe_failed" {
  const { code, statusCode, type } = stripeErrorFields(error);

  if (
    code === "resource_missing" ||
    code === "account_invalid" ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 404 ||
    type === "StripePermissionError" ||
    type === "StripeAuthenticationError"
  ) {
    return "refund_payment_account_unavailable";
  }

  return "refund_stripe_failed";
}

/**
 * Persists a Stripe-proven owner on rows that are still NULL, then requires every row
 * to carry exactly that owner. A concurrent different value (blocked by the
 * immutability trigger) is reported as a failure.
 */
export async function persistProvenStripeAccount(input: {
  supabase: SupabaseClient;
  table: "payments" | "event_payments";
  ids: string[];
  stripeAccount: string;
}): Promise<boolean> {
  if (input.ids.length === 0) return true;

  const { error: updateError } = await input.supabase
    .from(input.table)
    .update({ stripe_account_id: input.stripeAccount })
    .in("id", input.ids)
    .is("stripe_account_id", null);

  if (updateError) return false;

  const { data, error: readError } = await input.supabase
    .from(input.table)
    .select("id, stripe_account_id")
    .in("id", input.ids);

  if (readError || !data || data.length !== input.ids.length) return false;

  return data.every(
    (row: { stripe_account_id?: string | null }) => row.stripe_account_id === input.stripeAccount,
  );
}
