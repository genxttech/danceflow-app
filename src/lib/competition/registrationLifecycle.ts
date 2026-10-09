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

export type WebhookOutcome = "finalized" | "already_finalized" | "already_recorded" | "late_payment_after_release"
  | "signing_incomplete_payment_recorded" | "pending_async" | "released" | "already_released" | "already_paid";

/**
 * Verified Stripe Checkout event for a competition order (Connect event, event.account required).
 * Session ids, account and amount are re-validated by the database against the order binding.
 */
export async function applyCompetitionCheckoutEvent(admin: Db, params: {
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

  if (params.session.payment_status !== "paid") return { orderId, outcome: "pending_async", paymentIntentId };
  const { data, error } = await admin.rpc("finalize_competition_registration", {
    p_order_id: orderId,
    p_stripe_account_id: accountId,
    p_checkout_session_id: params.session.id,
    p_payment_intent_id: paymentIntentId,
    p_amount_cents: params.session.amount_total ?? null,
    p_currency: (params.session.currency ?? "").toUpperCase(),
  });
  if (error) throw new Error(error.message);
  return { orderId, outcome: String((data as { outcome?: string } | null)?.outcome ?? "finalized") as WebhookOutcome, paymentIntentId };
}

