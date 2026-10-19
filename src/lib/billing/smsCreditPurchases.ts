import { randomUUID } from "crypto";
import type Stripe from "stripe";

/**
 * TW-4F-3b-pay: prepaid SMS credit purchases through Stripe Checkout on the PLATFORM account.
 *
 *  - Packs of $25 / $50 / $100 only, cards only, one-time payment mode: nothing is saved, nothing recurs, nothing tops up automatically.
 *  - A purchase is registered as PENDING in the database (not spendable) with a 30 minute expiry; the database enforces the packs and the $500 balance ceiling
 *    over balance + live pending payments + the new pack, under the legal business's account lock (concurrent purchases cannot both pass).
 *  - Credit appears only when the signed webhook reports the Session PAID; the database refuses a Session it never registered, a different amount, business or
 *    location, and credits each payment once however often the event is replayed.
 *  - Refunds apply the charge's cumulative refunded amount; disputes withdraw once per dispute and reinstate only what that dispute withdrew.
 *  - Whether a webhook event belongs to a credit purchase is decided by the DATABASE (the Session id / PaymentIntent we registered), never by metadata alone, and
 *    only platform-scoped events (no Connect account) can ever be credit events. Connect events are not touched.
 */

export const SMS_CREDIT_PACKS_CENTS = [2500, 5000, 10000] as const;
export type SmsCreditPackCents = (typeof SMS_CREDIT_PACKS_CENTS)[number];
export const SMS_CREDIT_PURPOSE = "sms_credit_topup";
/** Stripe requires a Checkout Session to live at least 30 minutes after it is created, so the request must carry a margin above that. */
export const SMS_CREDIT_CHECKOUT_MINUTES = 35;

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
export type SmsCreditAdmin = { rpc(fn: string, args: Record<string, unknown>): RpcResult };

export type SmsCreditErrorCode = "not_authorized" | "no_legal_business" | "invalid_pack" | "ceiling" | "unavailable" | "mismatch" | "unexpected_event";
export class SmsCreditError extends Error {
  constructor(public readonly code: SmsCreditErrorCode, message: string) {
    super(message);
    this.name = "SmsCreditError";
  }
}

class RpcFailure extends Error {
  constructor(public readonly code: string) {
    super(`rpc failure (${code})`);
  }
}

async function rpc<T>(admin: SmsCreditAdmin, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new RpcFailure(String(error.code ?? "unknown"));
  return data as T;
}

export function isSmsCreditPack(cents: unknown): cents is SmsCreditPackCents {
  return typeof cents === "number" && (SMS_CREDIT_PACKS_CENTS as readonly number[]).includes(cents);
}

export function smsCreditPurchasesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.SMS_CREDIT_PURCHASES ?? "").trim().toLowerCase() === "on";
}

/** Creates the Checkout Session and registers it as a pending payment. The caller (a route) has already proven who the user is; the database re-checks the role. */
export async function createSmsCreditCheckout(input: {
  admin: SmsCreditAdmin;
  stripe: Pick<Stripe, "checkout">;
  studioId: string;
  userId: string;
  packCents: number;
  appUrl: string;
  now?: Date;
}): Promise<{ url: string; sessionId: string; expiresAt: string }> {
  const { admin, stripe, studioId, userId, packCents } = input;
  if (!isSmsCreditPack(packCents)) throw new SmsCreditError("invalid_pack", "Choose a $25, $50 or $100 pack.");

  let entityId: string;
  try {
    const context = await rpc<{ legal_entity_id: string }>(admin, "tw4_credit_checkout_context", { p_studio_id: studioId, p_user_id: userId });
    entityId = context.legal_entity_id;
  } catch (error) {
    const code = error instanceof RpcFailure ? error.code : "unknown";
    if (code === "42501") throw new SmsCreditError("not_authorized", "Only a studio owner or administrator can buy SMS credit.");
    if (code === "TW010") throw new SmsCreditError("no_legal_business", "SMS credit is available once your legal business is verified.");
    throw new SmsCreditError("unavailable", "SMS credit is not available right now.");
  }

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + SMS_CREDIT_CHECKOUT_MINUTES * 60_000);
  const metadata = { df_purpose: SMS_CREDIT_PURPOSE, legal_entity_id: entityId, studio_id: studioId, pack_cents: String(packCents) };
  const base = input.appUrl.replace(/\/+$/, "");

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: packCents, product_data: { name: `DanceFlow SMS credit $${packCents / 100}` } } }],
        metadata,
        payment_intent_data: { metadata },
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        success_url: `${base}/app/settings/sms?credit=success`,
        cancel_url: `${base}/app/settings/sms?credit=cancelled`,
      },
      { idempotencyKey: `smscredit:${entityId}:${studioId}:${packCents}:${randomUUID()}` },
    );
  } catch {
    throw new SmsCreditError("unavailable", "We could not start the payment. Nothing was charged.");
  }

  const expire = async () => {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch {
      /* the session expires by itself at expires_at and is not registered, so a late payment would credit nothing */
    }
  };

  if (!session.url) {
    await expire();
    throw new SmsCreditError("unavailable", "We could not start the payment. Nothing was charged.");
  }
  try {
    await rpc(admin, "tw4_credit_topup_pending", {
      p_entity_id: entityId,
      p_paid_by_studio_id: studioId,
      p_provider_ref: session.id,
      p_amount_cents: packCents,
      p_expires_at: expiresAt.toISOString(),
    });
  } catch (error) {
    await expire();
    const code = error instanceof RpcFailure ? error.code : "unknown";
    if (code === "TW009") throw new SmsCreditError("ceiling", "This would take your SMS credit balance above $500. Choose a smaller pack or use some credit first.");
    throw new SmsCreditError("unavailable", "We could not start the payment. Nothing was charged.");
  }
  return { url: session.url, sessionId: session.id, expiresAt: expiresAt.toISOString() };
}

type TopupLookup = { topup_id: string; legal_entity_id: string; paid_by_studio_id: string | null; status: "pending" | "settled" | "failed"; amount_cents: number; provider_ref: string; payment_intent_ref: string | null } | null;

const idOf = (value: unknown): string | null => {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
};

/** PostgREST PGRST202 (function not in the schema cache) / Postgres 42883 / 42P01: the credit objects are not installed in this environment (the app can ship before the migration,
 *  and then the other refund and dispute handlers must keep working). Known gap: for a moment right after the migration PostgREST may still answer PGRST202; Supabase reloads the cache on DDL. */
const NOT_INSTALLED = new Set(["PGRST202", "42883", "42P01"]);

async function lookup(admin: SmsCreditAdmin, ref: string): Promise<TopupLookup> {
  return rpc<TopupLookup>(admin, "tw4_credit_topup_lookup", { p_payment_ref: ref });
}

/** The ownership check for events that are not flagged by metadata. Where credit is not installed no payment can be ours, so the other handlers must keep working. */
async function ownedLookup(admin: SmsCreditAdmin, ref: string): Promise<TopupLookup> {
  try {
    return await lookup(admin, ref);
  } catch (error) {
    if (error instanceof RpcFailure && NOT_INSTALLED.has(error.code)) return null;
    throw error;
  }
}

async function handleCheckout(admin: SmsCreditAdmin, event: Stripe.Event, session: Stripe.Checkout.Session): Promise<void> {
  const topup = await lookup(admin, session.id);
  if (!topup) {
    // a session we flagged but never registered (or registered elsewhere): it credits nothing. Acknowledge; nothing was spendable.
    return;
  }
  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    try {
      await rpc(admin, "tw4_credit_topup_failed", { p_provider_ref: session.id, p_event_id: event.id });
    } catch (error) {
      if (!(error instanceof RpcFailure && error.code === "22023")) throw error; // 22023 = already settled (or failed): nothing to undo
    }
    return;
  }
  // completed / async_payment_succeeded
  if (session.payment_status === "unpaid") return; // a delayed method (ACH): settlement arrives as async_payment_succeeded
  if (session.payment_status !== "paid") throw new SmsCreditError("unexpected_event", "unexpected payment status");
  const paymentIntent = idOf(session.payment_intent);
  const amount = session.amount_total;
  if (session.mode !== "payment" || session.currency !== "usd" || !paymentIntent || typeof amount !== "number" || !isSmsCreditPack(amount)) {
    throw new SmsCreditError("mismatch", "the paid session does not match a credit pack");
  }
  const meta = session.metadata ?? {};
  if (meta.legal_entity_id !== topup.legal_entity_id || meta.studio_id !== topup.paid_by_studio_id || Number(meta.pack_cents) !== topup.amount_cents || amount !== topup.amount_cents) {
    throw new SmsCreditError("mismatch", "the paid session does not match the registered purchase");
  }
  await rpc(admin, "tw4_credit_settle_topup", {
    p_entity_id: topup.legal_entity_id,
    p_paid_by_studio_id: topup.paid_by_studio_id,
    p_provider_ref: session.id,
    p_amount_cents: topup.amount_cents,
    p_event_id: event.id,
    p_payment_intent: paymentIntent,
    p_require_pending: true,
  });
}

async function handleCharge(admin: SmsCreditAdmin, event: Stripe.Event, charge: Stripe.Charge): Promise<boolean> {
  const paymentIntent = idOf(charge.payment_intent);
  if (!paymentIntent) return false;
  const topup = await ownedLookup(admin, paymentIntent);
  if (!topup) {
    // our metadata but no settled payment recorded yet (events can arrive out of order): retry later instead of dropping a refund
    if (charge.metadata?.df_purpose === SMS_CREDIT_PURPOSE) throw new SmsCreditError("unexpected_event", "credit charge event before its settlement; retry");
    return false;
  }
  if (typeof charge.amount_refunded === "number" && charge.amount_refunded > 0) {
    await rpc(admin, "tw4_credit_apply_refund", { p_payment_ref: paymentIntent, p_cumulative_refunded_cents: charge.amount_refunded, p_event_id: event.id, p_reason: "stripe refund" });
  }
  return true;
}

async function handleDispute(admin: SmsCreditAdmin, event: Stripe.Event, dispute: Stripe.Dispute): Promise<boolean> {
  const paymentIntent = idOf(dispute.payment_intent);
  if (!paymentIntent) return false;
  const topup = await ownedLookup(admin, paymentIntent);
  if (!topup) return false;
  // an inquiry (warning_*) opens with dispute.created but moves no money and closes as warning_closed: only real withdrawals take credit back
  const inquiry = typeof dispute.status === "string" && dispute.status.startsWith("warning_");
  const withdrawn = (event.type === "charge.dispute.created" && !inquiry) || event.type === "charge.dispute.funds_withdrawn";
  const reinstated = event.type === "charge.dispute.funds_reinstated" || (event.type === "charge.dispute.closed" && dispute.status === "won");
  if (withdrawn) {
    await rpc(admin, "tw4_credit_apply_dispute", { p_payment_ref: paymentIntent, p_dispute_id: dispute.id, p_amount_cents: dispute.amount, p_action: "withdrawn", p_event_id: event.id });
  } else if (reinstated) {
    // a reinstatement for a dispute whose withdrawal has not been processed yet throws and is retried, never dropped
    await rpc(admin, "tw4_credit_apply_dispute", { p_payment_ref: paymentIntent, p_dispute_id: dispute.id, p_amount_cents: dispute.amount, p_action: "reinstated", p_event_id: event.id });
  }
  return true;
}

/**
 * Handles one VERIFIED Stripe event if (and only if) it concerns an SMS credit purchase. `handled: true` means the event is fully dealt with and the other
 * handlers must not run; thrown errors make the webhook answer 500 so Stripe retries (every database step is idempotent).
 */
export async function handleSmsCreditStripeEvent(input: { admin: SmsCreditAdmin; event: Stripe.Event }): Promise<{ handled: boolean }> {
  const { admin, event } = input;
  if (event.account) return { handled: false }; // Connect (studio) events are never credit purchases
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.df_purpose !== SMS_CREDIT_PURPOSE) return { handled: false };
      await handleCheckout(admin, event, session);
      return { handled: true };
    }
    case "charge.refunded":
    case "charge.updated":
      return { handled: await handleCharge(admin, event, event.data.object as Stripe.Charge) };
    case "refund.created":
    case "refund.updated":
    case "charge.refund.updated": {
      // the cumulative amount arrives with charge.refunded / charge.updated; a refund object alone only needs to be kept away from the other handlers
      const paymentIntent = idOf((event.data.object as Stripe.Refund).payment_intent);
      if (!paymentIntent) return { handled: false };
      return { handled: Boolean(await ownedLookup(admin, paymentIntent)) };
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
      return { handled: await handleDispute(admin, event, event.data.object as Stripe.Dispute) };
    default:
      return { handled: false };
  }
}
