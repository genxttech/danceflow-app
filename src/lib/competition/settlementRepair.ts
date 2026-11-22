import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyCompetitionCheckoutEvent,
  COMPETITION_REGISTRATION_SOURCE,
  isUuid,
  type SettlementStripeReader,
  type WebhookOutcome,
} from "@/lib/competition/registrationLifecycle";

/*
  CF1 settlement repair (dark). A competition order whose payment webhook never arrived (or whose retries were exhausted) stays 'pending'.
  This reads Stripe's own record for orders that ALREADY carry a bound Checkout Session and, only when Stripe shows the session complete and
  paid, finalizes through the existing applyCompetitionCheckoutEvent path.

  Authority: the "event" handed to applyCompetitionCheckoutEvent is built FROM the Stripe read (never from caller input), and that function
  re-reads Stripe again (verifySettlementWithStripe) and then calls finalize_competition_registration, which re-validates the order <->
  session <-> account binding and the amount and is idempotent. A synthetic event can therefore never authorize fulfillment by itself.
  This module never releases, expires or cancels anything, and never touches an order without a bound session / account.
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/;

export const SETTLEMENT_REPAIR_ENV = "COMPETITION_SETTLEMENT_REPAIR";
export const DEFAULT_MIN_AGE_MINUTES = 15;
export const DEFAULT_BATCH_SIZE = 20;
export const MAX_BATCH_SIZE = 50;
/** Orders last changed longer ago than this are left to staff. */
export const MAX_AGE_DAYS = 14;

export function settlementRepairEnabled(env: Record<string, string | undefined> = process.env) {
  return String(env[SETTLEMENT_REPAIR_ENV] ?? "").trim().toLowerCase() === "on";
}

export type RepairOutcome =
  | WebhookOutcome
  | "not_paid"
  | "binding_invalid"
  | "stripe_read_failed"
  | "refused"
  | "error";

export type RepairSummary = {
  scanned: number;
  processed: number;
  outcomes: Record<string, number>;
};

export type RepairCandidate = { id: string; stripe_checkout_session_id: string | null; metadata: Record<string, unknown> | null };

/** Short masked form for logs: never the full identifier. */
export function maskId(value: string | null | undefined) {
  const text = String(value ?? "");
  return text.length <= 8 ? "***" : `${text.slice(0, 3)}...${text.slice(-4)}`;
}

function shuffle<T>(items: T[], random: () => number) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Candidates: still-pending competition orders with a bound Checkout Session, whose last change is older than minAgeMinutes (a live
 * webhook gets time to arrive first) and younger than MAX_AGE_DAYS. The oldest pool is sampled randomly so a few permanently
 * unresolvable orders cannot starve the rest.
 */
export async function listRepairCandidates(admin: Db, params: { batchSize: number; minAgeMinutes: number; now: number; random: () => number }) {
  const olderThan = new Date(params.now - params.minAgeMinutes * 60_000).toISOString();
  const newerThan = new Date(params.now - MAX_AGE_DAYS * 86_400_000).toISOString();
  // Two-ended pool (oldest AND newest): orders that stay pending without ever being payable (open/expired, expiry webhook also missed)
  // pile up at the old end and must not hide a newer paid order, nor the reverse. Each end is bounded; the union is sampled randomly.
  const query = (ascending: boolean) => admin
    .from("event_orders")
    .select("id, stripe_checkout_session_id, metadata")
    .eq("status", "pending")
    .eq("payment_status", "pending")
    .eq("metadata->>source", COMPETITION_REGISTRATION_SOURCE)
    .not("stripe_checkout_session_id", "is", null)
    .lt("updated_at", olderThan)
    .gt("updated_at", newerThan)
    .order("updated_at", { ascending })
    .limit(params.batchSize * 2);
  const [oldest, newest] = await Promise.all([query(true), query(false)]);
  if (oldest.error || newest.error) throw new Error("settlement repair candidate query failed");
  const byId = new Map<string, RepairCandidate>();
  for (const candidate of [...((oldest.data ?? []) as RepairCandidate[]), ...((newest.data ?? []) as RepairCandidate[])]) byId.set(candidate.id, candidate);
  return shuffle([...byId.values()], params.random).slice(0, params.batchSize);
}

/** Repair one order. Fails closed: any read error, mismatch or unpaid state returns without finalizing and without releasing anything. */
export async function repairCompetitionOrder(admin: Db, stripe: SettlementStripeReader, order: RepairCandidate): Promise<{ outcome: RepairOutcome; paymentIntentId: string | null; accountId: string }> {
  const accountId = String(order.metadata?.stripe_account_id ?? "");
  const done = (outcome: RepairOutcome, paymentIntentId: string | null = null) => ({ outcome, paymentIntentId, accountId });
  const sessionId = String(order.stripe_checkout_session_id ?? "");
  if (!isUuid(order.id) || !ACCOUNT_ID_PATTERN.test(accountId) || !SESSION_ID_PATTERN.test(sessionId)) return done("binding_invalid");

  let live: Stripe.Checkout.Session;
  try {
    live = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] }, { stripeAccount: accountId });
  } catch {
    return done("stripe_read_failed");
  }
  // Stripe's record must itself name this order and session; anything else is another order's object.
  if (live.id !== sessionId || live.metadata?.source !== COMPETITION_REGISTRATION_SOURCE || String(live.metadata?.order_id ?? "") !== order.id) return done("binding_invalid");
  if (live.status !== "complete" || live.payment_status !== "paid") return done("not_paid");

  try {
    // The event is derived from Stripe's own record, then verified again (and bound again by the database) by the existing path.
    const result = await applyCompetitionCheckoutEvent(admin, {
      stripe,
      eventType: "checkout.session.completed",
      session: live,
      stripeAccountId: accountId,
    });
    return done(result.outcome, result.paymentIntentId);
  } catch (error) {
    return done(/Competition settlement refused/.test(error instanceof Error ? error.message : "") ? "refused" : "error");
  }
}

export async function runCompetitionSettlementRepair(admin: Db, stripe: SettlementStripeReader, options: {
  batchSize?: number;
  minAgeMinutes?: number;
  now?: number;
  random?: () => number;
  /** Called after an order is finalized by this run (the fee sync and confirmation the webhook would have performed). */
  onFinalized?: (info: { orderId: string; paymentIntentId: string | null; accountId: string }) => Promise<void>;
} = {}): Promise<RepairSummary> {
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  const minAgeMinutes = Math.max(Math.trunc(options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES) || DEFAULT_MIN_AGE_MINUTES, 5);
  const candidates = await listRepairCandidates(admin, { batchSize, minAgeMinutes, now: options.now ?? Date.now(), random: options.random ?? Math.random });
  const summary: RepairSummary = { scanned: candidates.length, processed: 0, outcomes: {} };
  for (const order of candidates.slice(0, batchSize)) {
    const { outcome, paymentIntentId, accountId } = await repairCompetitionOrder(admin, stripe, order);
    summary.processed += 1;
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    if (outcome === "finalized" && options.onFinalized) {
      try { await options.onFinalized({ orderId: order.id, paymentIntentId, accountId }); } catch (error) { console.error("comp_settlement_repair_followup_failed", maskId(order.id), error instanceof Error ? error.name : "unknown"); }
    }
    if (outcome !== "not_paid" && outcome !== "already_finalized" && outcome !== "finalized") {
      console.warn("comp_settlement_repair_outcome", { order: maskId(order.id), outcome });
    }
  }
  return summary;
}
