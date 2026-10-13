import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  failEventCartPaymentAttempt,
  findCheckoutSessionIdForPaymentIntent,
  isMismatchOutcome,
  markEventCartOrderProcessing,
  settleEventCartOrder,
  type CartSettlementOutcome,
  type StripePaymentEvidence,
} from "@/lib/events/cartSettlement";
import { drainSettlementExceptionAlerts } from "@/lib/events/settlementAlerts";
import { drainEventSettlementOutbox } from "@/lib/events/settlementOutbox";

/**
 * PAY-WH-1 -- ordinary event cart events from Stripe (Connect scope). The routing hint is the Stripe object's
 * metadata.source; the ORDER is always resolved by the database from the stored payment attempt and verified there.
 * Mismatches throw (the webhook records the delivery as failed and Stripe keeps retrying, so they stay visible) and
 * are also recorded as settlement exceptions by the database. Business outcomes such as a late payment after release or
 * a duplicate payment are recorded as exceptions and acknowledged.
 */

export const EVENT_CART_ORDER_SOURCE = "event_cart_order";

export type WebhookClaim = { eventId: string; owner: string };

export class EventCartWebhookMismatch extends Error {
  constructor(readonly outcome: string) {
    super(`event_cart_${outcome.replace(":", "_")}`);
    this.name = "EventCartWebhookMismatch";
  }
}

function metadataSource(value: { metadata?: Stripe.Metadata | null } | null | undefined) {
  const source = value?.metadata?.source;
  return typeof source === "string" ? source : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof (value as { id: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function requireAccount(stripeAccountId: string | null | undefined) {
  if (!stripeAccountId) {
    // Event checkouts are direct charges on the studio's connected account; a platform-scoped one is never valid.
    throw new EventCartWebhookMismatch("mismatch:account");
  }
  return stripeAccountId;
}

async function afterOutcome(
  admin: SupabaseClient,
  stripe: Stripe,
  result: CartSettlementOutcome,
): Promise<CartSettlementOutcome> {
  if (typeof result.exception_id === "string") {
    // PAY-WH-1A: a payment exception was recorded (and its staff alert queued) in the same transaction. Make it visible
    // in the logs and deliver the alert now; the cron delivers it otherwise.
    console.error("event cart payment exception recorded", result.outcome, result.exception_id);
    try {
      await drainSettlementExceptionAlerts({ admin, limit: 5 });
    } catch (alertError) {
      console.error("payment exception alert delivery deferred to cron", alertError instanceof Error ? alertError.message : alertError);
    }
  }
  if (isMismatchOutcome(result)) {
    throw new EventCartWebhookMismatch(result.outcome);
  }
  if (result.outcome === "settled" && typeof result.order_id === "string") {
    try {
      await drainEventSettlementOutbox({ admin, stripe, orderId: result.order_id });
    } catch (error) {
      // Effects are durable in the outbox; the cron drain retries them.
      console.error("event settlement outbox drain after settlement failed", error instanceof Error ? error.message : error);
    }
  }
  return result;
}

export async function handleEventCartCheckoutSessionEvent(params: {
  admin: SupabaseClient;
  stripe: Stripe;
  session: Stripe.Checkout.Session;
  eventType: string;
  stripeAccountId: string | null | undefined;
  claim: WebhookClaim | null;
}): Promise<CartSettlementOutcome | null> {
  const { admin, stripe, session } = params;
  if (metadataSource(session) !== EVENT_CART_ORDER_SOURCE) return null;
  if (!params.claim) throw new Error("event cart settlement requires a webhook claim");
  const account = requireAccount(params.stripeAccountId);

  const evidence: StripePaymentEvidence = {
    source: "webhook",
    stripeEventId: params.claim.eventId,
    claimOwner: params.claim.owner,
    stripeAccountId: account,
    checkoutSessionId: session.id,
    paymentIntentId: idOf(session.payment_intent),
    amountCents: session.amount_total ?? null,
    currency: session.currency ?? null,
  };

  switch (params.eventType) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (session.payment_status === "paid") {
        return afterOutcome(admin, stripe, await settleEventCartOrder(admin, evidence));
      }
      if (params.eventType === "checkout.session.completed" && session.payment_status === "unpaid") {
        // Delayed payment method: the Session is complete but the money is still in flight.
        return afterOutcome(admin, stripe, await markEventCartOrderProcessing(admin, evidence));
      }
      throw new EventCartWebhookMismatch(`mismatch:session_payment_status_${session.payment_status}`);
    }
    case "checkout.session.async_payment_failed":
      return afterOutcome(admin, stripe, await failEventCartPaymentAttempt(admin, evidence, {
        final: true,
        finalState: "failed",
        reason: "checkout_session_async_payment_failed",
      }));
    case "checkout.session.expired":
      return afterOutcome(admin, stripe, await failEventCartPaymentAttempt(admin, evidence, {
        final: true,
        finalState: "expired",
        reason: "checkout_session_expired",
      }));
    default:
      return null;
  }
}

export async function handleEventCartPaymentIntentEvent(params: {
  admin: SupabaseClient;
  stripe: Stripe;
  paymentIntent: Stripe.PaymentIntent;
  eventType: string;
  stripeAccountId: string | null | undefined;
  claim: WebhookClaim | null;
}): Promise<CartSettlementOutcome | null> {
  const { admin, stripe, paymentIntent } = params;
  if (metadataSource(paymentIntent) !== EVENT_CART_ORDER_SOURCE) return null;
  if (!params.claim) throw new Error("event cart settlement requires a webhook claim");
  const account = requireAccount(params.stripeAccountId);

  // PaymentIntent-first ordering: a Checkout PaymentIntent is only known to the order through its Session, so ask
  // Stripe (on the signed connected account) which Session owns it; the database then matches that Session against
  // the stored attempt. A native (PaymentSheet) PaymentIntent has no Session and is its own stored attempt.
  const checkoutSessionId = await findCheckoutSessionIdForPaymentIntent(stripe, paymentIntent.id, account);

  const evidence: StripePaymentEvidence = {
    source: "webhook",
    stripeEventId: params.claim.eventId,
    claimOwner: params.claim.owner,
    stripeAccountId: account,
    checkoutSessionId,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount_received || paymentIntent.amount || null,
    currency: paymentIntent.currency ?? null,
  };

  switch (params.eventType) {
    case "payment_intent.succeeded":
      return afterOutcome(admin, stripe, await settleEventCartOrder(admin, evidence));
    case "payment_intent.processing":
      return afterOutcome(admin, stripe, await markEventCartOrderProcessing(admin, evidence));
    case "payment_intent.payment_failed":
      // The buyer can retry on the same Session / PaymentIntent: record only, never release.
      return afterOutcome(admin, stripe, await failEventCartPaymentAttempt(admin, evidence, {
        final: false,
        finalState: "failed",
        reason: paymentIntent.last_payment_error?.code ?? "payment_failed",
      }));
    case "payment_intent.canceled":
      if (checkoutSessionId) {
        // A Checkout PaymentIntent is canceled when its Session expires; checkout.session.expired finalizes that.
        return afterOutcome(admin, stripe, await failEventCartPaymentAttempt(admin, evidence, {
          final: false,
          finalState: "failed",
          reason: "payment_intent_canceled",
        }));
      }
      return afterOutcome(admin, stripe, await failEventCartPaymentAttempt(admin, evidence, {
        final: true,
        finalState: "failed",
        reason: "payment_intent_canceled",
      }));
    default:
      return null;
  }
}
