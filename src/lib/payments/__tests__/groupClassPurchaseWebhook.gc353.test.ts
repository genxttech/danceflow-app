import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { FakeTable, createFakeEntitlementClient, type Row } from "@/lib/packages/__tests__/fakeEntitlementSupabase";
import { createFakeStripe } from "./gc353FakeStripe";

const h = vi.hoisted(() => ({
  notifyDancer: vi.fn(),
  notifyStudio: vi.fn(),
  notifyRefundIssue: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/notifications/groupClassNotices", () => ({
  notifyGroupClassEnrolled: (...args: unknown[]) => h.notifyDancer(...args),
  notifyStudioOfExternalGroupClassEnrollment: (...args: unknown[]) => h.notifyStudio(...args),
  notifyStudioOfPublicPurchaseRefundIssue: (...args: unknown[]) => h.notifyRefundIssue(...args),
}));

const { handleGroupClassPurchaseCheckout, conflictRefundIdempotencyKey, unmatchedRefundIdempotencyKey } = await import(
  "../groupClassPurchaseWebhook"
);

/**
 * GC-3.5-3 webhook branch. finalize_public_class_purchase is simulated with its GC-3.5-2 contract (proven against Postgres
 * by sql-tests/test_T_gc352_public_class_purchase.sql): exact account/session/amount/currency match, PaymentIntent bound
 * once, idempotent replay of the stored outcome, conflict with clientless paid evidence.
 */

const ACCT = "acct_studioA";
const OTHER_ACCT = "acct_studioB";
const HOLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_HOLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cs_test_hold1";

let holds: FakeTable;
let clients: FakeTable;
let payments: FakeTable;
let finalizeCalls: Array<Record<string, unknown>>;
let applyCalls: Array<Record<string, unknown>>;
let conflictReason: string | null;
let fake: ReturnType<typeof createFakeStripe>;

function finalize(args: Record<string, unknown>) {
  finalizeCalls.push(args);
  const hold = holds.rows.find((r) => r.id === args.p_hold_id);
  const err = (message: string) => ({ error: { message } });
  if (!hold) return err("GC35_HOLD_NOT_FOUND: Purchase hold not found.");
  if (hold.stripe_account_id !== args.p_stripe_account_id) return err("GC35_ACCOUNT_MISMATCH: x");
  if (hold.stripe_checkout_session_id !== args.p_checkout_session_id) return err("GC35_SESSION_MISMATCH: x");
  if (Number(args.p_amount_cents) !== hold.amount_cents) return err("GC35_AMOUNT_MISMATCH: x");
  if (String(args.p_currency).toLowerCase() !== "usd") return err("GC35_CURRENCY_MISMATCH: x");
  if (hold.stripe_payment_intent_id && hold.stripe_payment_intent_id !== args.p_payment_intent_id) return err("GC35_PAYMENT_INTENT_MISMATCH: x");
  if (holds.rows.some((r) => r.id !== hold.id && r.stripe_payment_intent_id === args.p_payment_intent_id)) return err("GC35_PAYMENT_INTENT_IN_USE: x");
  if (hold.status === "converted" || hold.status === "conflict") {
    return { data: [{ outcome: hold.status, hold_id: hold.id, client_id: hold.client_id ?? null, link_id: hold.link_id ?? null, attendee_id: hold.attendee_id ?? null, payment_id: hold.payment_id, conflict_reason: hold.conflict_reason ?? null }] };
  }
  hold.stripe_payment_intent_id = args.p_payment_intent_id;
  const reason = hold.status === "released" ? "hold_released" : conflictReason;
  if (reason) {
    Object.assign(hold, { status: "conflict", conflict_reason: reason, payment_id: "pay-conflict-1" });
    payments.rows.push({ id: "pay-conflict-1", studio_id: hold.studio_id, client_id: null, status: "paid", stripe_payment_intent_id: args.p_payment_intent_id, refund_amount: 0 });
    return { data: [{ outcome: "conflict", hold_id: hold.id, client_id: null, link_id: null, attendee_id: null, payment_id: "pay-conflict-1", conflict_reason: reason }] };
  }
  clients.rows.push({ id: "client-new", studio_id: hold.studio_id, referral_source: "Public class registration" });
  Object.assign(hold, { status: "converted", client_id: "client-new", link_id: "link-new", attendee_id: "attendee-new", payment_id: "pay-1" });
  return { data: [{ outcome: "converted", hold_id: hold.id, client_id: "client-new", link_id: "link-new", attendee_id: "attendee-new", payment_id: "pay-1", conflict_reason: null }] };
}

function db() {
  return createFakeEntitlementClient(
    { group_class_enrollment_holds: holds, clients, payments },
    {
      finalize_public_class_purchase: finalize,
      // The shared refund RPC is deliberately NOT used (pre-existing cast defect); calling it fails the test.
      _apply_payment_refund_and_reevaluate: (args) => {
        applyCalls.push(args);
        return { error: { message: "must not be called" } };
      },
    },
  ) as unknown as SupabaseClient;
}

function paidSession(over: Partial<Stripe.Checkout.Session> & { metadata?: Record<string, string> } = {}) {
  return {
    id: SESSION,
    payment_status: "paid",
    status: "complete",
    payment_intent: "pi_test_1",
    amount_total: 2500,
    currency: "usd",
    metadata: { source: "group_class_direct_payment", hold_id: HOLD, studio_id: "studio-a", appointment_id: "class-1" },
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

function run(session: Stripe.Checkout.Session, account: string | null = ACCT) {
  return handleGroupClassPurchaseCheckout({
    supabase: db(),
    stripe: fake.stripe as never,
    session,
    stripeAccountId: account,
    eventId: "evt_1",
    eventType: "checkout.session.completed",
  });
}

beforeEach(() => {
  holds = new FakeTable();
  clients = new FakeTable();
  payments = new FakeTable();
  holds.rows.push({
    id: HOLD, studio_id: "studio-a", appointment_id: "class-1", status: "held", amount_cents: 2500,
    stripe_account_id: ACCT, stripe_checkout_session_id: SESSION, stripe_payment_intent_id: null,
    dancer_first_name: "Ada", dancer_last_name: "Lovelace",
  });
  finalizeCalls = [];
  applyCalls = [];
  conflictReason = null;
  fake = createFakeStripe();
  h.notifyDancer.mockReset();
  h.notifyStudio.mockReset();
  h.notifyRefundIssue.mockReset();
});

describe("routing and settlement evidence", () => {
  it("ignores sessions that are not GC-3.5 purchases (other branches handle them)", async () => {
    expect(await run(paidSession({ metadata: { source: "client_payment_request" } }))).toBe(false);
    expect(finalizeCalls).toHaveLength(0);
  });

  it("K: an unpaid Checkout completion never finalizes", async () => {
    expect(await run(paidSession({ payment_status: "unpaid" }))).toBe(true);
    expect(finalizeCalls).toHaveLength(0);
  });

  it("a platform-scoped (no connected account) GC-3.5 session is never settled", async () => {
    expect(await run(paidSession(), null)).toBe(true);
    expect(finalizeCalls).toHaveLength(0);
  });

  it("J: a paid session finalizes with values taken ONLY from the verified session + event account", async () => {
    const session = paidSession({ metadata: { source: "group_class_direct_payment", hold_id: HOLD, amount: "1", currency: "eur", stripe_account_id: OTHER_ACCT } as never });
    expect(await run(session)).toBe(true);
    expect(finalizeCalls).toEqual([
      { p_hold_id: HOLD, p_stripe_account_id: ACCT, p_checkout_session_id: SESSION, p_payment_intent_id: "pi_test_1", p_amount_cents: 2500, p_currency: "usd" },
    ]);
  });

  it("an expanded payment_intent object is reduced to its id", async () => {
    await run(paidSession({ payment_intent: { id: "pi_test_1" } as never }));
    expect(finalizeCalls[0].p_payment_intent_id).toBe("pi_test_1");
  });

  it("a paid session with unreadable evidence is retried, not guessed", async () => {
    await expect(run(paidSession({ payment_intent: null }))).rejects.toThrow("gc35_webhook_incomplete_paid_session");
    expect(finalizeCalls).toHaveLength(0);
  });
});

describe("converted (R-T, M)", () => {
  it("R/S/T: conversion makes no application writes and notifies dancer and studio once each, keyed by the attendee", async () => {
    await run(paidSession());
    expect(fake.calls.refunds).toHaveLength(0);
    expect(applyCalls).toHaveLength(0);
    expect(h.notifyDancer).toHaveBeenCalledTimes(1);
    expect(h.notifyDancer.mock.calls[0][0]).toMatchObject({
      studioId: "studio-a", clientId: "client-new", appointmentIds: ["class-1"], eventId: "attendee-new", series: false,
      selfEnrolled: true, paymentLabel: "$25.00 paid online",
    });
    expect(h.notifyStudio).toHaveBeenCalledTimes(1);
    expect(h.notifyStudio.mock.calls[0][0]).toEqual({
      studioId: "studio-a", attendeeId: "attendee-new", publicPaidRegistration: { amountLabel: "$25.00", newClient: true },
    });
  });

  it("M: a webhook replay returns the stored conversion; notifications reuse the same attendee-keyed dedupe identity", async () => {
    await run(paidSession());
    await run(paidSession());
    expect(finalizeCalls).toHaveLength(2);
    expect(holds.rows[0].status).toBe("converted");
    expect(clients.rows).toHaveLength(1);
    const dancerIds = h.notifyDancer.mock.calls.map((c) => c[0].eventId);
    const studioIds = h.notifyStudio.mock.calls.map((c) => c[0].attendeeId);
    expect(new Set(dancerIds)).toEqual(new Set(["attendee-new"]));
    expect(new Set(studioIds)).toEqual(new Set(["attendee-new"]));
  });

  it("a notification failure never undoes or fails the committed conversion", async () => {
    h.notifyDancer.mockRejectedValue(new Error("smtp down"));
    h.notifyStudio.mockRejectedValue(new Error("smtp down"));
    await expect(run(paidSession())).resolves.toBe(true);
    expect(holds.rows[0].status).toBe("converted");
  });
});

describe("mismatches (N-Q) and metadata substitution", () => {
  it("N: a session from another connected account is rejected and refunded on the account that took it", async () => {
    await run(paidSession(), OTHER_ACCT);
    expect(holds.rows[0].status).toBe("held");
    expect(holds.rows[0].stripe_payment_intent_id).toBeNull();
    expect(fake.calls.refunds).toHaveLength(1);
    expect(fake.calls.refunds[0].opts).toMatchObject({ stripeAccount: OTHER_ACCT, idempotencyKey: unmatchedRefundIdempotencyKey(SESSION) });
    expect(h.notifyDancer).not.toHaveBeenCalled();
  });

  it("O/P/Q: wrong session, amount or currency never settle the hold", async () => {
    for (const session of [paidSession({ id: "cs_test_other" }), paidSession({ amount_total: 100 }), paidSession({ currency: "eur" })]) {
      await run(session);
    }
    expect(holds.rows[0].status).toBe("held");
    expect(holds.rows[0].stripe_payment_intent_id).toBeNull();
    expect(h.notifyDancer).not.toHaveBeenCalled();
    expect(fake.calls.refunds.every((c) => c.opts?.stripeAccount === ACCT)).toBe(true);
  });

  it("metadata pointing at another hold cannot switch the hold or the studio", async () => {
    holds.rows.push({ id: OTHER_HOLD, studio_id: "studio-b", appointment_id: "class-9", status: "held", amount_cents: 2500, stripe_account_id: OTHER_ACCT, stripe_checkout_session_id: "cs_test_other_hold", stripe_payment_intent_id: null, dancer_first_name: "X", dancer_last_name: "Y" });
    await run(paidSession({ metadata: { source: "group_class_direct_payment", hold_id: OTHER_HOLD } }));
    expect(holds.rows.find((r) => r.id === OTHER_HOLD)!.status).toBe("held");
    expect(h.notifyDancer).not.toHaveBeenCalled();
  });

  it("a PaymentIntent already bound to another purchase is never refunded (it would undo a real purchase)", async () => {
    holds.rows.push({ id: OTHER_HOLD, studio_id: "studio-a", appointment_id: "class-1", status: "converted", amount_cents: 2500, stripe_account_id: ACCT, stripe_checkout_session_id: "cs_x", stripe_payment_intent_id: "pi_test_1" });
    await expect(run(paidSession())).resolves.toBe(true);
    expect(fake.calls.refunds).toHaveLength(0);
  });

  it("a transient finalize failure is retried by Stripe (throws), nothing refunded", async () => {
    const broken = createFakeEntitlementClient({ group_class_enrollment_holds: holds, clients }, {
      finalize_public_class_purchase: () => ({ error: { message: "connection reset" } }),
    }) as unknown as SupabaseClient;
    await expect(
      handleGroupClassPurchaseCheckout({ supabase: broken, stripe: fake.stripe as never, session: paidSession(), stripeAccountId: ACCT, eventId: "e", eventType: "t" }),
    ).rejects.toThrow("gc35_finalize_failed");
    expect(fake.calls.refunds).toHaveLength(0);
  });
});

describe("conflict refunds (U-X)", () => {
  it("U/V: a conflict refunds the full payment on the same connected account and records it on the clientless payment", async () => {
    conflictReason = "class_cancelled";
    await run(paidSession());
    expect(fake.calls.refunds).toHaveLength(1);
    expect(fake.calls.refunds[0].params).toMatchObject({ payment_intent: "pi_test_1", reason: "requested_by_customer" });
    expect(fake.calls.refunds[0].opts).toEqual({ stripeAccount: ACCT, idempotencyKey: conflictRefundIdempotencyKey(HOLD) });
    expect(applyCalls).toHaveLength(0);
    expect(payments.rows[0]).toMatchObject({ id: "pay-conflict-1", status: "refunded", refund_amount: 25, client_id: null, stripe_refund_id: expect.stringMatching(/^re_/) });
    expect(payments.rows[0].refunded_at).toBeTruthy();
    expect(h.notifyDancer).not.toHaveBeenCalled();
    expect(h.notifyStudio).not.toHaveBeenCalled();
  });

  it("W: conflict refund is idempotent across webhook replays (same key -> same refund)", async () => {
    conflictReason = "class_full";
    await run(paidSession());
    await run(paidSession());
    expect(fake.calls.refunds).toHaveLength(2);
    expect(new Set(fake.calls.refunds.map((c) => c.opts?.idempotencyKey))).toEqual(new Set([conflictRefundIdempotencyKey(HOLD)]));
    expect(payments.rows).toHaveLength(1);
    expect(payments.rows[0].status).toBe("refunded");
    // both deliveries got the SAME Stripe refund back for the same idempotency key, and that is the one recorded
    const replayRefund = await fake.stripe.refunds.create({ payment_intent: "pi_test_1" }, { stripeAccount: ACCT, idempotencyKey: conflictRefundIdempotencyKey(HOLD) });
    expect(payments.rows[0].stripe_refund_id).toBe(replayRefund.id);
  });

  it("X: refund failure keeps the conflict, alerts staff once (deduped per hold) and makes Stripe retry", async () => {
    conflictReason = "hold_expired";
    fake.failures.refund = true;
    await expect(run(paidSession())).rejects.toThrow("gc35_conflict_refund_failed");
    expect(holds.rows[0].status).toBe("conflict");
    expect(h.notifyRefundIssue).toHaveBeenCalledWith({
      studioId: "studio-a", holdId: HOLD, appointmentId: "class-1", dancerName: "Ada Lovelace", amountLabel: "$25.00",
    });
    expect(payments.rows[0].status).toBe("paid");
  });

  it("late paid webhook after the purchaser released the hold becomes a conflict and is refunded", async () => {
    holds.rows[0].status = "released";
    await run(paidSession());
    expect(holds.rows[0]).toMatchObject({ status: "conflict", conflict_reason: "hold_released" });
    expect(fake.calls.refunds).toHaveLength(1);
    expect(fake.calls.refunds[0].opts?.stripeAccount).toBe(ACCT);
  });
});

describe("router wiring", () => {
  it("the canonical webhook routes GC-3.5 sessions before the generic membership fallthrough", () => {
    const route = readFileSync("src/app/api/payments/webhook/route.ts", "utf8");
    const branch = route.indexOf("await handleGroupClassPurchaseCheckout({");
    const fallthrough = route.indexOf("const studioId = getString(session.metadata?.studioId);", route.indexOf("export async function handleCheckoutSessionCompleted"));
    expect(branch).toBeGreaterThan(route.indexOf("export async function handleCheckoutSessionCompleted"));
    expect(branch).toBeLessThan(fallthrough);
    expect(route).toContain("stripeAccountId,");
  });

  it("the browser-return path never finalizes: only the webhook module calls finalize_public_class_purchase", () => {
    const page = readFileSync("src/app/studios/[studioSlug]/classes/[appointmentId]/register/page.tsx", "utf8");
    const actions = readFileSync("src/app/studios/[studioSlug]/classes/[appointmentId]/register/actions.ts", "utf8");
    const service = readFileSync("src/lib/payments/groupClassPurchase.ts", "utf8");
    for (const source of [page, actions, service]) expect(source).not.toMatch(/rpc\(\s*"finalize_public_class_purchase"/);
    const webhook = readFileSync("src/lib/payments/groupClassPurchaseWebhook.ts", "utf8");
    expect(webhook).toMatch(/rpc\(\s*"finalize_public_class_purchase"/);
  });
});

export type { Row };
