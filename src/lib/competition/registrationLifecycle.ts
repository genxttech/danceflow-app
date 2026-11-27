import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/*
  Phase 10C: competition registration lifecycle calls shared by the checkout routes and the Stripe
  webhook (no server-only import, so the webhook module stays testable). Authority is in
  release_competition_registration / finalize_competition_registration (service role only), which
  re-validate the order <-> Checkout Session <-> connected account binding and the amount.
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const COMPETITION_REGISTRATION_SOURCE = "competition_registration";
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export type ReleaseReason = "expired" | "failed" | "abandoned" | "attach_failed" | "signing_expired";

export async function releaseCompetitionRegistration(admin: Db, params: {
  orderId: string;
  reason: ReleaseReason;
  checkoutSessionId?: string | null;
  stripeAccountId?: string | null;
}) {
  const { data, error } = await admin.rpc("release_competition_registration", {
    p_order_id: params.orderId,
    p_reason: params.reason,
    p_checkout_session_id: params.checkoutSessionId ?? null,
    p_stripe_account_id: params.stripeAccountId ?? null,
  });
  if (error) throw new Error(error.message);
  return (data ?? {}) as { outcome?: string };
}

/** The only Stripe call the settlement re-read needs; the real client satisfies it structurally. */
export type SettlementStripeReader = {
  checkout: { sessions: { retrieve(id: string, params: { expand: string[] }, options: { stripeAccount: string }): Promise<Stripe.Checkout.Session> } };
};

export type VerifiedSettlement = { paymentIntentId: string; amountCents: number; currency: string };

/**
 * Settlement authority: a signed webhook event is a NOTIFICATION, never proof of payment. Before any registration is finalized the
 * Checkout Session and its PaymentIntent are read back from Stripe's API on the connected account, and finalization uses only the values read
 * back. Any disagreement between the event and Stripe (or any read failure) throws, so nothing is finalized and the delivery is retried.
 * A replayed, forged-but-validly-signed or stale event therefore cannot finalize an order Stripe does not show as paid.
 */
export async function verifySettlementWithStripe(stripe: SettlementStripeReader, params: {
  eventSession: Stripe.Checkout.Session;
  accountId: string;
  orderId: string;
}): Promise<VerifiedSettlement> {
  const event = params.eventSession;
  const live = await stripe.checkout.sessions.retrieve(event.id, { expand: ["payment_intent"] }, { stripeAccount: params.accountId });
  function fail(why: string): never { throw new Error(`Competition settlement refused: ${why} (the event does not match Stripe's own record).`); }

  if (live.id !== event.id) fail("session id mismatch");
  if (live.metadata?.source !== COMPETITION_REGISTRATION_SOURCE || String(live.metadata?.order_id ?? "") !== params.orderId) fail("order binding mismatch");
  if (live.mode !== "payment") fail("session is not a payment-mode session");
  if (typeof event.livemode === "boolean" && live.livemode !== event.livemode) fail("livemode mismatch");
  if (live.status !== "complete" || live.payment_status !== "paid") fail("Stripe does not show the session as complete and paid");

  const amount = live.amount_total;
  const currency = String(live.currency ?? "").toUpperCase();
  if (typeof amount !== "number" || amount <= 0 || !currency) fail("session has no positive amount or currency");
  if (event.amount_total !== amount || String(event.currency ?? "").toUpperCase() !== currency) fail("amount or currency mismatch");

  const intent = live.payment_intent;
  if (!intent || typeof intent === "string") fail("PaymentIntent was not returned by Stripe");
  const pi = intent as Stripe.PaymentIntent;
  const eventIntentId = typeof event.payment_intent === "string" ? event.payment_intent : event.payment_intent?.id ?? null;
  if (eventIntentId && eventIntentId !== pi.id) fail("PaymentIntent id mismatch");
  if (pi.status !== "succeeded") fail("PaymentIntent has not succeeded");
  if (pi.amount_received !== amount || String(pi.currency ?? "").toUpperCase() !== currency) fail("PaymentIntent amount received does not match the session");

  return { paymentIntentId: pi.id, amountCents: amount, currency };
}

export type WebhookOutcome = "finalized" | "already_finalized" | "already_recorded" | "late_payment_after_release"
  | "signing_incomplete_payment_recorded" | "pending_async" | "released" | "already_released" | "already_paid";

/**
 * Verified Stripe Checkout event for a competition order (Connect event, event.account required).
 * Session ids, account and amount are re-validated by the database against the order binding.
 */
export async function applyCompetitionCheckoutEvent(admin: Db, params: {
  /** Required: finalization re-reads Stripe's own record (see verifySettlementWithStripe). Omitting it is a type error, never a silent skip. */
  stripe: SettlementStripeReader;
  eventType: string;
  session: Stripe.Checkout.Session;
  stripeAccountId: string | null | undefined;
}): Promise<{ orderId: string; outcome: WebhookOutcome; paymentIntentId: string | null }> {
  const orderId = String(params.session.metadata?.order_id ?? "");
  if (!isUuid(orderId)) throw new Error("Competition checkout missing order_id metadata.");
  const accountId = params.stripeAccountId ?? "";
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Competition checkout event is not a connected-account event.");
  const paymentIntentId = typeof params.session.payment_intent === "string"
    ? params.session.payment_intent
    : params.session.payment_intent?.id ?? null;

  if (params.eventType === "checkout.session.expired" || params.eventType === "checkout.session.async_payment_failed") {
    const result = await releaseCompetitionRegistration(admin, {
      orderId,
      reason: params.eventType === "checkout.session.expired" ? "expired" : "failed",
      checkoutSessionId: params.session.id,
      stripeAccountId: accountId,
    });
    return { orderId, outcome: (result.outcome ?? "released") as WebhookOutcome, paymentIntentId };
  }

  // An event that does not itself claim payment moves no money and finalizes nothing; it needs no Stripe read.
  if (params.session.payment_status !== "paid") return { orderId, outcome: "pending_async", paymentIntentId };
  // The event claims payment: confirm it with Stripe before anything is finalized. Finalization uses ONLY the values read back.
  const verified = await verifySettlementWithStripe(params.stripe, { eventSession: params.session, accountId, orderId });
  const { data, error } = await admin.rpc("finalize_competition_registration", {
    p_order_id: orderId,
    p_stripe_account_id: accountId,
    p_checkout_session_id: params.session.id,
    p_payment_intent_id: verified.paymentIntentId,
    p_amount_cents: verified.amountCents,
    p_currency: verified.currency,
  });
  if (error) throw new Error(error.message);
  return { orderId, outcome: String((data as { outcome?: string } | null)?.outcome ?? "finalized") as WebhookOutcome, paymentIntentId: verified.paymentIntentId };
}

