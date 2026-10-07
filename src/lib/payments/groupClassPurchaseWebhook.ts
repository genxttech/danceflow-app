import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { getStripe } from "@/lib/payments/stripe";
import { CLASS_PURCHASE_SOURCE, formatUsdCents } from "@/lib/public/classPurchase";
import {
  notifyGroupClassEnrolled,
  notifyStudioOfExternalGroupClassEnrollment,
  notifyStudioOfPublicPurchaseRefundIssue,
} from "@/lib/notifications/groupClassNotices";

/*
  GC-3.5-3: the public paid Group Class branch of the canonical Stripe webhook
  (src/app/api/payments/webhook/route.ts). The router has already verified
  the signature and the platform/connect scope; this branch owns sessions
  whose metadata.source is "group_class_direct_payment".

  Settlement evidence comes ONLY from the signature-verified Checkout Session
  in its connected-account scope: event.account, session.id,
  session.payment_intent, session.amount_total (integer cents) and
  session.currency. Metadata only locates the hold; it can't switch the
  studio or the hold, because finalize_public_class_purchase compares every
  value with what the hold has stored (account, session, amount, currency) and
  binds the PaymentIntent exactly once.

  Outcomes:
    converted -> the database already created/reused the client, the self
                 link, the paid attendee and the payment; here only post-commit
                 notifications (idempotent on the attendee id).
    conflict  -> no enrollment; truthful paid evidence exists; refund the
                 payment on the SAME connected account (deterministic
                 idempotency key), record it through the canonical refund
                 reconciliation RPC. A failed refund keeps the conflict, alerts
                 studio staff once and throws so Stripe retries the event.
  Idempotency is the database's (hold state, unique session/PaymentIntent,
  one payment per hold, finalize replay), not payment_provider_events.
*/

type StripeClient = ReturnType<typeof getStripe>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;

type FinalizeRow = {
  outcome: "converted" | "conflict";
  hold_id: string;
  client_id: string | null;
  link_id: string | null;
  attendee_id: string | null;
  payment_id: string | null;
  conflict_reason: string | null;
};

type HoldContext = {
  id: string;
  studio_id: string;
  appointment_id: string;
  amount_cents: number;
  dancer_first_name: string;
  dancer_last_name: string;
};

export function isGroupClassPurchaseSession(session: Pick<Stripe.Checkout.Session, "metadata">) {
  return session.metadata?.source === CLASS_PURCHASE_SOURCE;
}

export function conflictRefundIdempotencyKey(holdId: string) {
  return `gc35-hold:${holdId}:conflict-refund`;
}

export function unmatchedRefundIdempotencyKey(sessionId: string) {
  return `gc35-session:${sessionId}:unmatched-refund`;
}

function paymentIntentIdOf(session: Stripe.Checkout.Session): string | null {
  const value = session.payment_intent;
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.id === "string" ? value.id : null;
}

/** Errors that mean "this verified paid session does not belong to any purchase we can settle": refund it, never enroll. */
const UNMATCHED_SETTLEMENT = /GC35_(HOLD_NOT_FOUND|ACCOUNT_MISMATCH|SESSION_MISMATCH|AMOUNT_MISMATCH|CURRENCY_MISMATCH)/;
/** Errors meaning this PaymentIntent is already accounted for elsewhere: never refund (it would undo a real purchase). */
const ALREADY_ACCOUNTED = /GC35_(PAYMENT_INTENT_IN_USE|PAYMENT_INTENT_MISMATCH)/;

/**
 * Returns false when the session is not a GC-3.5 purchase (the router tries its other branches), true when handled.
 * Throws (-> HTTP 500 -> Stripe retry) only for transient failures and failed refunds.
 */
export async function handleGroupClassPurchaseCheckout(params: {
  supabase: Db;
  stripe: StripeClient;
  session: Stripe.Checkout.Session;
  stripeAccountId: string | null | undefined;
  eventId: string;
  eventType: string;
}): Promise<boolean> {
  const { session, supabase, stripe } = params;
  if (!isGroupClassPurchaseSession(session)) return false;

  // GC-3.5 sessions exist only on studio connected accounts: a platform-scoped one is never settled here.
  const stripeAccountId = params.stripeAccountId ?? null;
  if (!stripeAccountId || !ACCOUNT_ID_PATTERN.test(stripeAccountId)) {
    console.error("gc35_webhook_missing_account");
    return true;
  }

  // Unpaid/incomplete completion: nothing settles (card only, so no async success path is expected).
  if (session.payment_status !== "paid") return true;

  const paymentIntentId = paymentIntentIdOf(session);
  const amountCents = typeof session.amount_total === "number" ? session.amount_total : null;
  const currency = typeof session.currency === "string" ? session.currency.toLowerCase() : null;
  const holdId = typeof session.metadata?.hold_id === "string" ? session.metadata.hold_id : "";

  if (!paymentIntentId || amountCents === null || !currency) {
    // Paid but unreadable: let Stripe retry rather than guess.
    throw new Error("gc35_webhook_incomplete_paid_session");
  }

  if (!UUID.test(holdId)) {
    await refundUnmatchedSession({ stripe, stripeAccountId, session, paymentIntentId, amountCents, reason: "missing_hold" });
    return true;
  }

  const { data, error } = await supabase.rpc("finalize_public_class_purchase", {
    p_hold_id: holdId,
    p_stripe_account_id: stripeAccountId,
    p_checkout_session_id: session.id,
    p_payment_intent_id: paymentIntentId,
    p_amount_cents: amountCents,
    p_currency: currency,
  });

  if (error) {
    const message = error.message ?? "";
    const code = /^(GC35_[A-Z_]+)/.exec(message)?.[1] ?? "unknown";
    if (UNMATCHED_SETTLEMENT.test(message)) {
      console.error("gc35_webhook_unmatched_settlement", { code });
      await refundUnmatchedSession({ stripe, stripeAccountId, session, paymentIntentId, amountCents, reason: code });
      return true;
    }
    if (ALREADY_ACCOUNTED.test(message)) {
      console.error("gc35_webhook_payment_intent_already_bound", { code });
      return true;
    }
    console.error("gc35_webhook_finalize_failed", { code });
    throw new Error("gc35_finalize_failed");
  }

  const result = ((Array.isArray(data) ? data[0] : data) ?? null) as FinalizeRow | null;
  if (!result?.outcome) throw new Error("gc35_finalize_empty");

  const hold = await loadHoldContext(supabase, holdId);
  if (!hold) throw new Error("gc35_hold_context_missing");

  if (result.outcome === "converted") {
    await notifyConverted({ supabase, hold, result, amountCents });
    return true;
  }

  // Conflict: never enrolled; refund the verified payment on the same connected account.
  await refundConflict({ supabase, stripe, stripeAccountId, hold, result, paymentIntentId, amountCents });
  return true;
}

async function loadHoldContext(supabase: Db, holdId: string): Promise<HoldContext | null> {
  const { data, error } = await supabase
    .from("group_class_enrollment_holds")
    .select("id, studio_id, appointment_id, amount_cents, dancer_first_name, dancer_last_name")
    .eq("id", holdId)
    .maybeSingle();
  if (error) throw new Error("gc35_hold_lookup_failed");
  return (data as HoldContext | null) ?? null;
}

async function notifyConverted(params: { supabase: Db; hold: HoldContext; result: FinalizeRow; amountCents: number }) {
  const { hold, result, supabase } = params;
  if (!result.attendee_id || !result.client_id) return;
  const amountLabel = formatUsdCents(params.amountCents);

  // New client (created from this purchase) vs. the purchaser's own self link acquired while paying.
  let newClient = false;
  try {
    const { data } = await supabase
      .from("clients")
      .select("referral_source")
      .eq("id", result.client_id)
      .eq("studio_id", hold.studio_id)
      .maybeSingle();
    newClient = (data as { referral_source?: string | null } | null)?.referral_source === "Public class registration";
  } catch {
    newClient = false;
  }

  // Idempotent on the attendee id (outbound dedupe key + push notice key): a webhook replay sends nothing new.
  try {
    await notifyGroupClassEnrolled({
      studioId: hold.studio_id,
      clientId: result.client_id,
      appointmentIds: [hold.appointment_id],
      eventId: result.attendee_id,
      series: false,
      selfEnrolled: true,
      paymentLabel: `${amountLabel} paid online`,
    });
  } catch {
    console.error("gc35_dancer_notice_failed");
  }
  try {
    await notifyStudioOfExternalGroupClassEnrollment({
      studioId: hold.studio_id,
      attendeeId: result.attendee_id,
      publicPaidRegistration: { amountLabel, newClient },
    });
  } catch {
    console.error("gc35_studio_notice_failed");
  }
}

function refundSucceeded(refund: Stripe.Refund | null | undefined) {
  return !!refund?.id && (refund.status === "succeeded" || refund.status === "pending");
}

async function refundConflict(params: {
  supabase: Db;
  stripe: StripeClient;
  stripeAccountId: string;
  hold: HoldContext;
  result: FinalizeRow;
  paymentIntentId: string;
  amountCents: number;
}) {
  const { hold, result } = params;
  let refund: Stripe.Refund | null = null;
  try {
    refund = await params.stripe.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        reason: "requested_by_customer",
        metadata: { source: "gc35_conflict_refund", hold_id: hold.id, studio_id: hold.studio_id },
      },
      { stripeAccount: params.stripeAccountId, idempotencyKey: conflictRefundIdempotencyKey(hold.id) },
    );
  } catch {
    refund = null;
  }

  if (!refundSucceeded(refund)) {
    console.error("gc35_conflict_refund_failed", { reason: result.conflict_reason ?? "unknown" });
    // The conflict and its paid evidence stay; staff are alerted once (deduped per hold); Stripe retries this event.
    await notifyStudioOfPublicPurchaseRefundIssue({
      studioId: hold.studio_id,
      holdId: hold.id,
      appointmentId: hold.appointment_id,
      dancerName: [hold.dancer_first_name, hold.dancer_last_name].filter(Boolean).join(" "),
      amountLabel: formatUsdCents(params.amountCents),
    });
    throw new Error("gc35_conflict_refund_failed");
  }

  // Record the refund on the conflict payment the same way the canonical staff refund action does (direct payment-row
  // write, compare-and-swap on 'paid' so a replay or an earlier reconciliation is a no-op). Clientless and package-free,
  // so there is nothing to re-evaluate. NOTE: the shared RPC _apply_payment_refund_and_reevaluate currently fails on a
  // text -> payment_status cast (pre-existing, tracked separately), so it is deliberately not used here.
  if (result.payment_id) {
    const { error } = await params.supabase
      .from("payments")
      .update({
        status: "refunded",
        refund_amount: Math.round(params.amountCents) / 100,
        refunded_at: new Date().toISOString(),
        stripe_refund_id: refund!.id,
      })
      .eq("id", result.payment_id)
      .eq("studio_id", hold.studio_id)
      .eq("stripe_payment_intent_id", params.paymentIntentId)
      .eq("status", "paid");
    if (error) {
      // The refund itself went through at Stripe; the payment row can be reconciled from the refund id later.
      console.error("gc35_conflict_refund_record_failed");
    }
  }
}

async function refundUnmatchedSession(params: {
  stripe: StripeClient;
  stripeAccountId: string;
  session: Stripe.Checkout.Session;
  paymentIntentId: string;
  amountCents: number;
  reason: string;
}) {
  // A verified, paid GC-3.5 session that no purchase can settle: return the money on the account that took it.
  let refund: Stripe.Refund | null = null;
  try {
    refund = await params.stripe.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        reason: "requested_by_customer",
        metadata: { source: "gc35_unmatched_refund", reason: params.reason },
      },
      { stripeAccount: params.stripeAccountId, idempotencyKey: unmatchedRefundIdempotencyKey(params.session.id) },
    );
  } catch {
    refund = null;
  }
  if (!refundSucceeded(refund)) {
    console.error("gc35_unmatched_refund_failed", { reason: params.reason });
    throw new Error("gc35_unmatched_refund_failed");
  }
}
