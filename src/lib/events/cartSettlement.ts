import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PAY-WH-1 -- event cart order lifecycle (server only; service-role client).
 *
 * Every state change of an ordinary event cart order goes through the locked database functions from
 * 20261116092000_paywh1_event_cart_settlement.sql. This module only gathers Stripe evidence (always outside a
 * database transaction) and calls them. Webhook metadata never selects an order: the database resolves the order from
 * the stored payment attempt (Checkout Session / PaymentIntent) and verifies account, amount, currency and state.
 */

/** Capacity hold for a new cart. Longer than Stripe's 30-minute minimum so the Checkout Session can expire first. */
export const EVENT_CART_HOLD_MINUTES = 35;
/** Stripe requires a Checkout Session expiry at least 30 minutes after creation. */
const STRIPE_MIN_SESSION_LIFETIME_SECONDS = 30 * 60;
/** Margin between Session expiry and hold expiry, and slack for Stripe's minimum check. */
const SESSION_EXPIRY_MARGIN_SECONDS = 60;
/** A delayed payment keeps its capacity for this long; the sweeper reconciles it with Stripe when it lapses. */
export const EVENT_CART_PROCESSING_HOLD_DAYS = 7;

export type CartSettlementOutcome = { outcome: string } & Record<string, unknown>;

export class CartSettlementError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "CartSettlementError";
  }
}

async function callRpc(admin: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<CartSettlementOutcome> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    throw new CartSettlementError(`${fn} failed: ${error.message}`, error.code);
  }
  if (!data || typeof data !== "object") {
    throw new CartSettlementError(`${fn} returned no result`);
  }
  return data as CartSettlementOutcome;
}

export function newEventCartHoldUntil(nowMs = Date.now()) {
  return new Date(nowMs + EVENT_CART_HOLD_MINUTES * 60_000).toISOString();
}

/**
 * Checkout Session expiry (unix seconds) that ends before the capacity hold. Returns null when the hold is too short
 * for Stripe's minimum Session lifetime -- the caller must extend the hold first (never create a Session that could
 * still be paid after the capacity it was for has been released).
 */
export function checkoutSessionExpiresAtForHold(holdUntilIso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!holdUntilIso) return null;
  const holdSeconds = Math.floor(Date.parse(holdUntilIso) / 1000);
  if (!Number.isFinite(holdSeconds)) return null;
  const expiresAt = holdSeconds - SESSION_EXPIRY_MARGIN_SECONDS;
  const earliest = Math.ceil(nowMs / 1000) + STRIPE_MIN_SESSION_LIFETIME_SECONDS + SESSION_EXPIRY_MARGIN_SECONDS;
  return expiresAt >= earliest ? expiresAt : null;
}

export function processingHoldUntil(nowMs = Date.now()) {
  return new Date(nowMs + EVENT_CART_PROCESSING_HOLD_DAYS * 86_400_000).toISOString();
}

export function isMismatchOutcome(result: CartSettlementOutcome) {
  return typeof result.outcome === "string" && result.outcome.startsWith("mismatch:");
}

export async function recordEventCartPaymentAttempt(
  admin: SupabaseClient,
  params: {
    orderId: string;
    stripeAccountId: string;
    kind: "checkout_session" | "payment_intent";
    checkoutSessionId?: string | null;
    paymentIntentId?: string | null;
    amountCents: number;
    currency: string;
    surface: string;
    expiresAt?: string | null;
  },
) {
  return callRpc(admin, "record_event_cart_payment_attempt", {
    p_order_id: params.orderId,
    p_stripe_account: params.stripeAccountId,
    p_kind: params.kind,
    p_session_id: params.checkoutSessionId ?? null,
    p_payment_intent_id: params.paymentIntentId ?? null,
    p_amount_cents: params.amountCents,
    p_currency: params.currency.toLowerCase(),
    p_surface: params.surface,
    p_expires_at: params.expiresAt ?? null,
  });
}

export async function extendEventCartOrderHold(admin: SupabaseClient, orderId: string, untilIso: string) {
  return callRpc(admin, "extend_event_cart_order_hold", { p_order_id: orderId, p_until: untilIso });
}

export type StripePaymentEvidence = {
  source: "webhook" | "reconcile";
  stripeEventId: string | null;
  claimOwner: string | null;
  stripeAccountId: string;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  amountCents: number | null;
  currency: string | null;
};

function evidenceArgs(evidence: StripePaymentEvidence) {
  return {
    p_source: evidence.source,
    p_stripe_event_id: evidence.stripeEventId,
    p_claim_owner: evidence.claimOwner,
    p_stripe_account: evidence.stripeAccountId,
    p_session_id: evidence.checkoutSessionId,
    p_payment_intent_id: evidence.paymentIntentId,
  };
}

export async function settleEventCartOrder(admin: SupabaseClient, evidence: StripePaymentEvidence) {
  return callRpc(admin, "settle_event_cart_order", {
    ...evidenceArgs(evidence),
    p_amount_cents: evidence.amountCents,
    p_currency: evidence.currency?.toLowerCase() ?? null,
  });
}

export async function markEventCartOrderProcessing(admin: SupabaseClient, evidence: StripePaymentEvidence, holdUntilIso = processingHoldUntil()) {
  return callRpc(admin, "mark_event_cart_order_processing", {
    ...evidenceArgs(evidence),
    p_amount_cents: evidence.amountCents,
    p_currency: evidence.currency?.toLowerCase() ?? null,
    p_hold_until: holdUntilIso,
  });
}

export async function failEventCartPaymentAttempt(
  admin: SupabaseClient,
  evidence: StripePaymentEvidence,
  failure: { final: boolean; finalState: "failed" | "expired"; reason: string },
) {
  return callRpc(admin, "fail_event_cart_payment_attempt", {
    ...evidenceArgs(evidence),
    p_final: failure.final,
    p_final_state: failure.finalState,
    p_reason: failure.reason,
  });
}

export async function releaseUnattemptedEventCartOrders(admin: SupabaseClient, params: { eventId: string; buyerEmail: string; excludeOrderId: string | null }) {
  const { data, error } = await admin.rpc("release_unattempted_event_cart_orders", {
    p_event_id: params.eventId,
    p_buyer_email: params.buyerEmail,
    p_exclude_order_id: params.excludeOrderId,
  });
  if (error) throw new CartSettlementError(`release_unattempted_event_cart_orders failed: ${error.message}`, error.code);
  return Number(data ?? 0);
}

type ReleaseAttempt = {
  attempt_id: string;
  kind: "checkout_session" | "payment_intent";
  stripe_account_id: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
};

type AttemptFinding = {
  attempt_id: string;
  stripe_state: "closed" | "paid" | "processing" | "open";
  evidence?: StripePaymentEvidence;
};

function stripeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof (value as { id: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

/** Reads (and where still payable, closes) one Stripe payment attempt. Network/API errors leave it "open" (retry). */
async function inspectAndCloseAttempt(stripe: Stripe, attempt: ReleaseAttempt): Promise<AttemptFinding> {
  const options = { stripeAccount: attempt.stripe_account_id };
  try {
    if (attempt.kind === "checkout_session" && attempt.stripe_checkout_session_id) {
      let session = await stripe.checkout.sessions.retrieve(attempt.stripe_checkout_session_id, {}, options);
      if (session.status === "open") {
        try {
          session = await stripe.checkout.sessions.expire(session.id, {}, options);
        } catch {
          // The Session may have completed in the meantime; read it again below.
        }
        session = await stripe.checkout.sessions.retrieve(session.id, {}, options);
      }
      if (session.status === "expired") return { attempt_id: attempt.attempt_id, stripe_state: "closed" };
      if (session.status === "complete") {
        if (session.payment_status === "paid") {
          return {
            attempt_id: attempt.attempt_id,
            stripe_state: "paid",
            evidence: {
              source: "reconcile",
              stripeEventId: null,
              claimOwner: null,
              stripeAccountId: attempt.stripe_account_id,
              checkoutSessionId: session.id,
              paymentIntentId: stripeId(session.payment_intent),
              amountCents: session.amount_total ?? null,
              currency: session.currency ?? null,
            },
          };
        }
        return { attempt_id: attempt.attempt_id, stripe_state: session.payment_status === "unpaid" ? "processing" : "closed" };
      }
      return { attempt_id: attempt.attempt_id, stripe_state: "open" };
    }

    if (attempt.kind === "payment_intent" && attempt.stripe_payment_intent_id) {
      let intent = await stripe.paymentIntents.retrieve(attempt.stripe_payment_intent_id, {}, options);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status)) {
        try {
          intent = await stripe.paymentIntents.cancel(intent.id, {}, options);
        } catch {
          intent = await stripe.paymentIntents.retrieve(intent.id, {}, options);
        }
      }
      if (intent.status === "canceled") return { attempt_id: attempt.attempt_id, stripe_state: "closed" };
      if (intent.status === "processing") return { attempt_id: attempt.attempt_id, stripe_state: "processing" };
      if (intent.status === "succeeded") {
        return {
          attempt_id: attempt.attempt_id,
          stripe_state: "paid",
          evidence: {
            source: "reconcile",
            stripeEventId: null,
            claimOwner: null,
            stripeAccountId: attempt.stripe_account_id,
            checkoutSessionId: null,
            paymentIntentId: intent.id,
            amountCents: intent.amount_received ?? intent.amount ?? null,
            currency: intent.currency ?? null,
          },
        };
      }
      return { attempt_id: attempt.attempt_id, stripe_state: "open" };
    }
  } catch (error) {
    console.error("event cart release: Stripe attempt inspection failed", error instanceof Error ? error.message : error);
  }
  return { attempt_id: attempt.attempt_id, stripe_state: "open" };
}

/**
 * Two-phase release of an event cart order (buyer cancel, checkout failure, expired hold, cleanup):
 *   1. lock + mark 'releasing' (capacity stays held);
 *   2. outside any transaction: expire/cancel every live Stripe attempt and read back its real state;
 *   3. lock again and finalize from that evidence -- settle if Stripe was paid, keep 'processing' if a delayed payment
 *      is in flight, retry later if Stripe could not be reconciled, otherwise release exactly once.
 */
export async function releaseEventCartOrder(params: {
  admin: SupabaseClient;
  stripe: Stripe | null;
  orderId: string;
  reason: string;
  finalState?: "released" | "expired";
}): Promise<CartSettlementOutcome> {
  const begin = await callRpc(params.admin, "begin_event_cart_order_release", {
    p_order_id: params.orderId,
    p_reason: params.reason,
  });
  if (begin.outcome !== "releasing") return begin;

  const attempts = (Array.isArray(begin.attempts) ? begin.attempts : []) as ReleaseAttempt[];
  if (attempts.length > 0 && !params.stripe) {
    return { outcome: "retry", reason: "stripe_unavailable" };
  }
  const findings: AttemptFinding[] = [];
  for (const attempt of attempts) {
    findings.push(await inspectAndCloseAttempt(params.stripe as Stripe, attempt));
  }

  const paid = findings.find((finding) => finding.stripe_state === "paid" && finding.evidence);
  if (paid?.evidence) {
    return settleEventCartOrder(params.admin, paid.evidence);
  }

  return callRpc(params.admin, "finalize_event_cart_order_release", {
    p_order_id: params.orderId,
    p_findings: findings.map(({ attempt_id, stripe_state }) => ({ attempt_id, stripe_state })),
    p_final_state: params.finalState ?? "released",
  });
}

/** Stripe's Checkout Session for a PaymentIntent on the connected account (PaymentIntent-first webhook ordering). */
export async function findCheckoutSessionIdForPaymentIntent(stripe: Stripe, paymentIntentId: string, stripeAccountId: string) {
  const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 }, { stripeAccount: stripeAccountId });
  return sessions.data[0]?.id ?? null;
}

/**
 * Sweeper: an order whose delayed payment hold lapsed. Reads (never closes) each processing attempt from Stripe and
 * settles, fails, or keeps it processing accordingly. Stripe/API errors leave the order untouched for the next run.
 */
export async function reconcileProcessingEventCartOrder(params: { admin: SupabaseClient; stripe: Stripe; orderId: string }) {
  const { data, error } = await params.admin
    .from("event_order_payment_attempts")
    .select("id, kind, stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id")
    .eq("order_id", params.orderId)
    .eq("status", "processing");
  if (error) throw new CartSettlementError(`processing attempts lookup failed: ${error.message}`);
  const results: CartSettlementOutcome[] = [];
  for (const attempt of (data ?? []) as Array<ReleaseAttempt & { id: string }>) {
    const options = { stripeAccount: attempt.stripe_account_id };
    let paymentIntentId = attempt.stripe_payment_intent_id;
    let sessionId: string | null = attempt.stripe_checkout_session_id;
    if (!paymentIntentId && sessionId) {
      const session = await params.stripe.checkout.sessions.retrieve(sessionId, {}, options);
      paymentIntentId = stripeId(session.payment_intent);
    }
    if (!paymentIntentId) continue;
    const intent = await params.stripe.paymentIntents.retrieve(paymentIntentId, {}, options);
    if (attempt.kind === "payment_intent") sessionId = null;
    const evidence: StripePaymentEvidence = {
      source: "reconcile",
      stripeEventId: null,
      claimOwner: null,
      stripeAccountId: attempt.stripe_account_id,
      checkoutSessionId: sessionId,
      paymentIntentId: intent.id,
      amountCents: intent.amount_received || intent.amount || null,
      currency: intent.currency ?? null,
    };
    if (intent.status === "succeeded") {
      results.push(await settleEventCartOrder(params.admin, evidence));
    } else if (intent.status === "processing") {
      results.push(await markEventCartOrderProcessing(params.admin, evidence));
    } else if (intent.status === "canceled" || intent.status === "requires_payment_method") {
      results.push(await failEventCartPaymentAttempt(params.admin, evidence, {
        final: true,
        finalState: "failed",
        reason: `reconcile_${intent.status}`,
      }));
    }
  }
  return results;
}
