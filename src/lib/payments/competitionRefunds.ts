import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

/**
 * CI-D / Competition R2: service module for competition order refunds (docs/competition/r2-entry-refunds.md §7).
 *
 * Money moves only through `createCompetitionStripeRefund` (server action, Stripe test mode locally). Every
 * Stripe-side state change — the create response and every webhook delivery — enters the database through the
 * single writer `observe_competition_stripe_refund` (service role). Caps, authority and idempotency live in SQL.
 */

export type CompetitionRefundLine = {
  orderItemId: string;
  amountCents: number;
  withdrawEntry: boolean;
};

export type CompetitionRefundRequest = {
  refundId: string;
  replay: boolean;
  status: string;
  amountCents: number;
  currency: string;
  paymentIntentId: string;
  stripeAccountId: string;
  stripeRefundId: string | null;
};

export type CompetitionRefundObservation = {
  handled: boolean;
  outcome?: "applied" | "no_change" | "account_mismatch";
  refundId?: string;
  status?: string;
};

export const COMPETITION_REFUND_METADATA_KEY = "danceflow_refund_request_id";

/** Stripe refund statuses the ledger mirrors (anything else fails closed in SQL). */
const STRIPE_REFUND_STATUSES = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);

/**
 * Stripe parameters for one staff refund request. D3: no `refund_application_fee` (the connected account funds the
 * whole refund). The idempotency key is the request id, so a retried server action can never create a second refund.
 */
export function buildCompetitionStripeRefundParams(requestId: string, request: CompetitionRefundRequest) {
  if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) {
    throw new Error("A competition refund needs a positive integer amount in cents.");
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(request.stripeAccountId)) {
    throw new Error("A competition refund needs the payment's stored Stripe account.");
  }
  const params: Stripe.RefundCreateParams = {
    payment_intent: request.paymentIntentId,
    amount: request.amountCents,
    metadata: { [COMPETITION_REFUND_METADATA_KEY]: requestId, danceflow_refund_id: request.refundId },
  };
  const options: Stripe.RequestOptions = {
    stripeAccount: request.stripeAccountId,
    idempotencyKey: `comp-refund:${requestId}`,
  };
  return { params, options };
}

type StripeErrorLike = { type?: unknown; statusCode?: unknown; code?: unknown };

/**
 * A definitive Stripe refusal means no refund object exists, so the request is marked failed (releasing its cap).
 * Anything else (network, timeout, 5xx, rate limit) is UNKNOWN: Stripe may have created the refund, so the request
 * keeps holding its cap until the webhook (or a retry with the same idempotency key) reports the real state.
 */
export function classifyCompetitionRefundStripeError(error: unknown): "definitive" | "unknown" {
  const value = (error && typeof error === "object" ? error : {}) as StripeErrorLike;
  const type = typeof value.type === "string" ? value.type : "";
  const statusCode = typeof value.statusCode === "number" ? value.statusCode : 0;
  if (type === "StripeConnectionError" || type === "StripeAPIError" || type === "StripeRateLimitError") return "unknown";
  if (statusCode === 409 || statusCode === 429 || statusCode >= 500 || statusCode === 0) return "unknown";
  if (["StripeInvalidRequestError", "StripeCardError", "StripePermissionError", "StripeAuthenticationError"].includes(type)) {
    return "definitive";
  }
  return statusCode >= 400 && statusCode < 500 ? "definitive" : "unknown";
}

export async function requestCompetitionOrderRefund(
  userClient: SupabaseClient,
  input: { eventId: string; orderId: string; requestId: string; lines: CompetitionRefundLine[]; reason: string },
): Promise<CompetitionRefundRequest> {
  const { data, error } = await userClient.rpc("request_competition_order_refund", {
    p_event_id: input.eventId,
    p_order_id: input.orderId,
    p_request_id: input.requestId,
    p_lines: input.lines,
    p_reason: input.reason,
  });
  if (error) throw new CompetitionRefundError(refundErrorCode(error.message), error.message);
  return data as CompetitionRefundRequest;
}

export async function observeCompetitionStripeRefund(
  serviceClient: SupabaseClient,
  input: {
    paymentIntentId: string;
    stripeAccountId: string | null;
    stripeRefundId: string | null;
    requestId: string | null;
    amountCents: number | null;
    status: string;
    stripeEventId: string | null;
  },
): Promise<CompetitionRefundObservation> {
  const { data, error } = await serviceClient.rpc("observe_competition_stripe_refund", {
    p_payment_intent_id: input.paymentIntentId,
    p_stripe_account_id: input.stripeAccountId,
    p_stripe_refund_id: input.stripeRefundId,
    p_request_id: input.requestId,
    p_amount_cents: input.amountCents,
    p_status: input.status,
    p_stripe_event_id: input.stripeEventId,
  });
  if (error) throw new Error(error.message);
  return (data ?? { handled: false }) as CompetitionRefundObservation;
}

/** Map a Stripe Refund (webhook or create response) onto the observe RPC. Unknown statuses are not forwarded. */
export function competitionObservationFromStripeRefund(refund: Stripe.Refund) {
  const status = typeof refund.status === "string" && STRIPE_REFUND_STATUSES.has(refund.status) ? refund.status : null;
  const requestId = refund.metadata?.[COMPETITION_REFUND_METADATA_KEY] ?? null;
  return {
    status,
    stripeRefundId: refund.id ?? null,
    amountCents: typeof refund.amount === "number" ? refund.amount : null,
    requestId: requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : null,
  };
}

/**
 * Webhook entry (refund.created / refund.updated / charge.refund.updated): observe this single refund object.
 * Returns true when the PaymentIntent belongs to a competition order, so the caller skips its pro-rata event path.
 */
export async function observeCompetitionRefundFromWebhook(
  serviceClient: SupabaseClient,
  refund: Stripe.Refund,
  paymentIntentId: string,
  stripeAccountId: string | null,
  stripeEventId: string | null,
): Promise<boolean> {
  const mapped = competitionObservationFromStripeRefund(refund);
  if (!mapped.status) {
    return isCompetitionOrderPaymentIntent(serviceClient, paymentIntentId);
  }
  const result = await observeCompetitionStripeRefund(serviceClient, {
    paymentIntentId,
    stripeAccountId,
    stripeRefundId: mapped.stripeRefundId,
    requestId: mapped.requestId,
    amountCents: mapped.amountCents,
    status: mapped.status,
    stripeEventId,
  });
  if (result.outcome === "account_mismatch") console.error("competition_refund_webhook_account_mismatch");
  return result.handled;
}

export async function isCompetitionOrderPaymentIntent(serviceClient: SupabaseClient, paymentIntentId: string) {
  const { data, error } = await serviceClient.rpc("is_competition_order_payment_intent", { p_payment_intent_id: paymentIntentId });
  if (error) throw new Error(error.message);
  return data === true;
}

export class CompetitionRefundError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The stable COMP_REFUND_* code from an RPC error message (page copy is keyed on it). */
export function refundErrorCode(message: string | null | undefined): string {
  const match = /COMP_REFUND_[A-Z0-9_]+/.exec(message ?? "");
  return match ? match[0] : "COMP_REFUND_FAILED";
}

export const COMPETITION_REFUND_ERROR_COPY: Record<string, string> = {
  COMP_REFUND_NOT_AUTHORIZED: "Only studio or organizer owners and admins can refund competition orders.",
  COMP_REFUND_ORDER_NOT_IN_EVENT: "That order does not belong to this event.",
  COMP_REFUND_ITEM_NOT_IN_ORDER: "A selected line is not part of this order.",
  COMP_REFUND_EXCEEDS_LINE_CAP: "A line was refunded for more than its remaining refundable amount.",
  COMP_REFUND_EXCEEDS_ORDER_CAP: "The refund exceeds what remains refundable on this payment.",
  COMP_REFUND_LINE_INVALID: "Each line needs a positive amount; only entry lines can withdraw an entry.",
  COMP_REFUND_LINE_DUPLICATE: "A line was selected twice.",
  COMP_REFUND_LINES_REQUIRED: "Select at least one line to refund.",
  COMP_REFUND_REASON_REQUIRED: "A reason is required.",
  COMP_REFUND_ORDER_NOT_PAID: "Only a settled, paid order can be refunded.",
  COMP_REFUND_PAYMENT_OWNER_UNVERIFIED: "The payment has no verified Stripe account, so it cannot be refunded here.",
  COMP_REFUND_REQUEST_REPLAY_MISMATCH: "This refund form was already submitted with different lines. Reload and try again.",
  COMP_REFUND_STRIPE_REFUSED: "Stripe refused the refund. Nothing was refunded.",
  COMP_REFUND_STRIPE_UNCONFIRMED: "Stripe did not confirm the refund yet. It stays pending until Stripe reports it; do not refund again.",
  COMP_REFUND_RETRY_NOT_PENDING: "That refund is no longer waiting for Stripe.",
  COMP_REFUND_RETRY_EXPIRED: "This request is older than Stripe's 24-hour retry window. Check the payment in Stripe; the webhook records any refund Stripe made.",
  COMP_REFUND_SCOPE_GATE: "This exception cannot be resolved that way yet.",
  COMP_REFUND_K0_CORRECTION_UNAVAILABLE: "No results correction exists for this round yet.",
  COMP_REFUND_FAILED: "The refund could not be completed.",
};
