import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";

/**
 * REFUND-RECON-1 application refactor: every refund -- staff-issued, Stripe-originated (dashboard / webhook) and the
 * GC-3.5 checkout-conflict refund (groupClassPurchaseWebhook.gc353.test.ts) -- reaches its business effects through the
 * ONE canonical RPC _apply_payment_refund_and_reevaluate. The RPC is simulated with its repaired contract
 * (refundReconciliationRpcFake.ts, proven in SQL by test_T_refund_reconciliation_integrity.sql); these tests prove what
 * the application passes to it and that the application no longer reconciles anything itself.
 *
 *   package full    -> payment 'refunded'; canonical settlement re-evaluation deactivates the package
 *   package partial -> payment 'paid' + cumulative refund_amount; canonical net-settlement rule decides
 *   class full      -> before recorded attendance: attendee cancelled + refunded (seat released);
 *                      after attended/no_show: payment_status refunded, booking/attendance history kept
 *   class partial   -> attendee 'partial', still booked
 *   conflict        -> clientless payment reconciled; no attendee exists
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: "studio_owner" }),
}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => stripeFake }));
// The package-credit ledger (PKG-REFUND-2) is a separate, unchanged webhook concern; isolate it here.
vi.mock("@/lib/payments/package-refund-reconciliation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments/package-refund-reconciliation")>()),
  reconcilePackageStripeRefund: async () => [],
  restorePackageRefundReconciliation: async () => [],
}));

const STUDIO = "studio-1";
const CLIENT = "client-1";
const ACCT = "acct_studio1";
const CLASS = "class-1";

let db: ReturnType<typeof createOwnershipFakeSupabase>;
let rpcFailure: "error" | "conflict" | null;
let refundMode: "ok" | "throw" | "failed_status";
let beforeRefundReturns: ((params: Record<string, unknown>) => void) | null;
let chargeForRetrieve: Partial<Stripe.Charge> | null;
const refundCalls: Array<{ params: Record<string, unknown>; opts: { stripeAccount?: string; idempotencyKey?: string } }> = [];
const refundIdsByKey = new Map<string, string>();

const stripeFake = {
  refunds: {
    async create(params: Record<string, unknown>, opts: { stripeAccount?: string; idempotencyKey?: string }) {
      refundCalls.push({ params, opts });
      if (refundMode === "throw") throw Object.assign(new Error("card_declined raw stripe text acct_SECRET"), { statusCode: 402 });
      const key = opts.idempotencyKey ?? `nokey-${refundCalls.length}`;
      if (!refundIdsByKey.has(key)) refundIdsByKey.set(key, `re_staff_${refundIdsByKey.size + 1}`);
      beforeRefundReturns?.(params);
      return { id: refundIdsByKey.get(key)!, status: refundMode === "failed_status" ? "failed" : "succeeded", amount: params.amount };
    },
  },
  charges: { retrieve: async () => ({ ...(chargeForRetrieve ?? {}) }) },
  paymentIntents: { retrieve: async () => ({}) },
  balanceTransactions: { retrieve: async () => ({ fee: 0 }) },
};

const { refundClientPaymentAction } = await import("@/app/app/clients/[id]/actions");
const { handleChargeRefunded, handleStripeRefundUpdated } = await import("@/app/api/payments/webhook/route");

function basePayment(over: Row = {}): Row {
  return {
    id: "pay-1", studio_id: STUDIO, client_id: CLIENT, appointment_id: null, amount: 50, currency: "usd", status: "paid",
    payment_type: "package", client_package_id: "pkg-1", notes: null, stripe_payment_intent_id: "pi_1",
    stripe_charge_id: null, stripe_refund_id: null, refund_amount: 0, stripe_account_id: ACCT, ...over,
  };
}

function seedPackage(payment: Row = {}, packagePrice = 50) {
  db = createOwnershipFakeSupabase(
    {
      payments: [basePayment(payment)],
      client_packages: [{ id: "pkg-1", studio_id: STUDIO, active: true, price: packagePrice }],
      studios: [{ id: STUDIO, stripe_connected_account_id: ACCT }],
      event_payments: [],
    },
    { rpcOverride },
  );
}

function seedClass(over: { payment?: Row; holdStatus?: string; attendance?: string | null; clientless?: boolean } = {}) {
  db = createOwnershipFakeSupabase(
    {
      payments: [basePayment({
        amount: 25, payment_type: "group_class_direct_payment", client_package_id: null, appointment_id: CLASS,
        ...(over.clientless ? { client_id: null } : {}), ...over.payment,
      })],
      group_class_enrollment_holds: [{
        id: "hold-1", studio_id: STUDIO, appointment_id: CLASS, status: over.holdStatus ?? "converted",
        attendee_id: over.clientless ? null : "att-1", client_id: over.clientless ? null : CLIENT, payment_id: "pay-1",
      }],
      appointment_attendees: [{ id: "att-1", studio_id: STUDIO, appointment_id: CLASS, client_id: CLIENT, status: "booked", payment_status: "paid", cancelled_at: null }],
      attendance_records: over.attendance ? [{ appointment_id: CLASS, client_id: CLIENT, status: over.attendance }] : [],
      studios: [{ id: STUDIO, stripe_connected_account_id: ACCT }],
      event_payments: [],
    },
    { rpcOverride },
  );
}

function rpcOverride(name: string) {
  if (name !== "_apply_payment_refund_and_reevaluate" || !rpcFailure) return undefined;
  return rpcFailure === "error"
    ? { data: null, error: { message: "REFUND_RECON_TEST_FAILURE: internal detail acct_SECRET" } }
    : { data: [{ applied: false, package_deactivated: false, conflict_recorded: true }], error: null };
}

const payment = () => db.rows("payments")[0];
const attendee = () => db.rows("appointment_attendees")[0];
const pkg = () => db.rows("client_packages")[0];
const refundRpcCalls = () => db.rpcCalls.filter((c) => c.name === "_apply_payment_refund_and_reevaluate");
const directRefundStateWrites = () =>
  db.mutations.filter((m) => m.table === "payments" && ("status" in m.values || "refund_amount" in m.values || "stripe_refund_id" in m.values));

async function staffRefund(amount: string, expectedRefundAmount?: string) {
  const form = new FormData();
  form.set("clientId", CLIENT);
  form.set("paymentId", "pay-1");
  form.set("amount", amount);
  form.set("reason", "Customer request");
  form.set("returnTo", `/app/clients/${CLIENT}`);
  if (expectedRefundAmount !== undefined) form.set("expectedRefundAmount", expectedRefundAmount);
  try {
    await refundClientPaymentAction(form);
  } catch (error) {
    return decodeURIComponent(((error as { digest?: string }).digest ?? "").split(";")[2] ?? "");
  }
  throw new Error("expected a redirect");
}

function charge(amountRefundedCents: number, refundId: string | null = "re_hook", paymentIntent = "pi_1") {
  return {
    payment_intent: paymentIntent, amount_refunded: amountRefundedCents,
    refunds: { data: refundId ? [{ id: refundId }] : [] }, balance_transaction: null,
  } as unknown as Stripe.Charge;
}

const chargeRefunded = (amountRefundedCents: number, refundId: string | null = "re_hook", account = ACCT, eventId = "evt_1") =>
  handleChargeRefunded(db.client as never, stripeFake as never, charge(amountRefundedCents, refundId), account, eventId, "charge.refunded");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpcFailure = null;
  refundMode = "ok";
  beforeRefundReturns = null;
  chargeForRetrieve = null;
  refundCalls.length = 0;
  refundIdsByKey.clear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("staff refunds route business effects through the canonical RPC", () => {
  it("A: full staff package refund invokes the RPC (refunded, cumulative 50, Stripe refund id) and deactivates the package", async () => {
    seedPackage();
    expect(await staffRefund("50", "0")).toContain("success=payment_refunded");
    expect(refundRpcCalls()).toHaveLength(1);
    expect(refundRpcCalls()[0].params).toEqual({
      p_payment_id: "pay-1", p_new_status: "refunded", p_refund_amount: 50, p_stripe_refund_id: "re_staff_1",
      p_stripe_event_id: "danceflow_staff_refund:re_staff_1", p_stripe_event_type: "danceflow.staff_refund",
    });
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 50, stripe_refund_id: "re_staff_1" });
    expect(pkg().active).toBe(false);
    expect(directRefundStateWrites()).toEqual([]);
  });

  it("B: package business effects no longer wait for the webhook; the later charge.refunded is a no-op", async () => {
    seedPackage();
    await staffRefund("50", "0");
    expect(pkg().active).toBe(false); // before any webhook
    await chargeRefunded(5000, "re_staff_1");
    expect(refundRpcCalls()).toHaveLength(2);
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 50, stripe_refund_id: "re_staff_1" });
    expect(db.rows("payment_settlement_conflicts")).toEqual([]);
  });

  it("C: partial staff package refund passes 'paid' + cumulative amount; the canonical net-settlement rule decides activation", async () => {
    seedPackage({}, 50);
    expect(await staffRefund("20", "0")).toContain("success=payment_refunded");
    expect(refundRpcCalls()[0].params).toMatchObject({ p_new_status: "paid", p_refund_amount: 20 });
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 20 });
    expect(pkg().active).toBe(false); // net 30 < price 50

    seedPackage({}, 25);
    await staffRefund("20", "0");
    expect(pkg().active).toBe(true); // net 30 >= price 25: still settled
  });

  it("D: full Group Class staff refund invokes the RPC; the DB cancels the enrollment (no app-side enrollment write)", async () => {
    seedClass();
    expect(await staffRefund("25", "0")).toContain("success=payment_refunded");
    expect(refundRpcCalls()[0].params).toMatchObject({ p_new_status: "refunded", p_refund_amount: 25 });
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
    expect(db.mutations.filter((m) => m.table === "appointment_attendees")).toEqual([]);
  });

  it("E: partial Group Class staff refund keeps the dancer booked with payment 'partial'", async () => {
    seedClass();
    expect(await staffRefund("10", "0")).toContain("success=payment_refunded");
    expect(refundRpcCalls()[0].params).toMatchObject({ p_new_status: "paid", p_refund_amount: 10 });
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 10 });
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "partial" });
  });

  it("F: Stripe refund failure (thrown or reported failed) never reconciles and never claims success", async () => {
    seedPackage();
    refundMode = "throw";
    const thrown = await staffRefund("50", "0");
    expect(thrown).toContain("error=refund_");
    expect(thrown).not.toContain("success");
    expect(thrown).not.toMatch(/card_declined|acct_SECRET/);
    refundMode = "failed_status";
    expect(await staffRefund("50", "0")).toContain("error=refund_stripe_failed");
    expect(refundRpcCalls()).toEqual([]);
    expect(db.mutations).toEqual([]);
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 0 });
  });

  it("G: Stripe succeeded but reconciliation failed -> bounded error, no success, no fallback write, safe log", async () => {
    seedPackage();
    rpcFailure = "error";
    const url = await staffRefund("50", "0");
    expect(url).toContain("error=refund_reconciliation_failed");
    expect(url).not.toContain("success");
    expect(refundCalls).toHaveLength(1);
    expect(db.mutations).toEqual([]);
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 0 });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("REFUND_RECON_TEST_FAILURE");
    expect(logged).not.toMatch(/internal detail|acct_SECRET/);

    seedPackage();
    rpcFailure = "conflict";
    expect(await staffRefund("50", "0")).toContain("error=refund_reconciliation_conflict");
    expect(db.mutations).toEqual([]);
  });

  it("H: stale / double staff refunds are guarded", async () => {
    // a stale form (rendered before another refund was recorded) is refused before Stripe
    seedPackage({ refund_amount: 10 });
    expect(await staffRefund("10", "0")).toContain("error=refund_payment_changed");
    expect(refundCalls).toEqual([]);

    // after a full refund, a second submit is refused before Stripe
    seedPackage();
    await staffRefund("50", "0");
    expect(await staffRefund("50")).toContain("error=refund_payment_not_paid");
    expect(refundCalls).toHaveLength(1);

    // a concurrent double submit: same state -> same idempotency key -> same Stripe refund; whichever reconciles
    // second is a no-op and still succeeds, with a single note
    seedPackage();
    refundCalls.length = 0;
    refundIdsByKey.clear();
    beforeRefundReturns = () => {
      // the parallel request (same key, same refund) already reconciled while this one waited on Stripe
      Object.assign(payment(), { refund_amount: 20, stripe_refund_id: "re_staff_1", notes: "Refunded 20.00 via Stripe (re_staff_1). Reason: Customer request" });
    };
    expect(await staffRefund("20", "0")).toContain("success=payment_refunded");
    expect(refundCalls[0].opts.idempotencyKey).toBe("danceflow_client_refund_pay-1_2000_0");
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 20 });
    expect(String(payment().notes).match(/re_staff_1/g)).toHaveLength(1);
  });

  it("I: the refund is issued on the payment's stored connected account, never another", async () => {
    seedPackage();
    await staffRefund("50", "0");
    expect(refundCalls.map((c) => c.opts.stripeAccount)).toEqual([ACCT]);
    expect(payment().stripe_account_id).toBe(ACCT);
  });

  it("J: the CUMULATIVE refund is passed (prior refunds included), reaching 'refunded' at the full amount", async () => {
    seedPackage({ refund_amount: 10 }, 0);
    await staffRefund("15", "10");
    expect(refundRpcCalls()[0].params).toMatchObject({ p_new_status: "paid", p_refund_amount: 25 });
    expect(refundCalls[0].params.amount).toBe(1500);
    await staffRefund("25", "25");
    expect(refundRpcCalls()[1].params).toMatchObject({ p_new_status: "refunded", p_refund_amount: 50 });
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 50 });
  });

  it("K: the actual Stripe refund id is passed and stored; staff metadata never touches refund state or Stripe identity", async () => {
    seedPackage();
    await staffRefund("20", "0");
    expect(refundRpcCalls()[0].params.p_stripe_refund_id).toBe("re_staff_1");
    expect(payment().stripe_refund_id).toBe("re_staff_1");
    const metadata = db.mutations.filter((m) => m.table === "payments");
    expect(metadata).toHaveLength(1);
    expect(Object.keys(metadata[0].values).sort()).toEqual(["notes", "refunded_at"]);
    expect(String(payment().notes)).toContain("Refunded 20.00 via Stripe (re_staff_1). Reason: Customer request");
    // a later webhook without a refund id never erases it
    await chargeRefunded(2000, null);
    expect(payment().stripe_refund_id).toBe("re_staff_1");
  });
});

describe("Stripe-originated refunds (webhook) use the same canonical RPC", () => {
  it("package full: refunded + package deactivated", async () => {
    seedPackage();
    await chargeRefunded(5000);
    expect(refundRpcCalls()[0].params).toMatchObject({ p_new_status: "refunded", p_refund_amount: 50, p_stripe_refund_id: "re_hook", p_stripe_event_id: "evt_1" });
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 50 });
    expect(pkg().active).toBe(false);
  });

  it("package partial: 'paid' with cumulative refund_amount; canonical net-settlement rule", async () => {
    seedPackage({}, 25);
    await chargeRefunded(2000);
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 20 });
    expect(pkg().active).toBe(true);
  });

  it("class full before attendance: payment refunded, attendee cancelled + refunded (seat released)", async () => {
    seedClass();
    await chargeRefunded(2500);
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 25 });
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
  });

  it("class partial: payment stays 'paid'; attendee 'partial', still booked", async () => {
    seedClass();
    await chargeRefunded(1000);
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 10 });
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "partial" });
  });

  it.each(["attended", "no_show"])("class full after %s: refunded, booking and attendance history kept", async (status) => {
    seedClass({ attendance: status });
    await chargeRefunded(2500);
    expect(payment()).toMatchObject({ status: "refunded" });
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "refunded", cancelled_at: null });
    expect(db.rows("attendance_records")).toHaveLength(1);
  });

  it("clientless GC-3.5 conflict payment: reconciled, no attendee touched", async () => {
    seedClass({ clientless: true, holdStatus: "conflict" });
    await chargeRefunded(2500);
    expect(payment()).toMatchObject({ status: "refunded", client_id: null });
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "paid" });
  });

  it("replay and stale/lower cumulative events never lower the refund or downgrade the enrollment", async () => {
    seedClass();
    await chargeRefunded(2500, "re_full", ACCT, "evt_full");
    await chargeRefunded(1000, "re_partial", ACCT, "evt_late_partial");
    await chargeRefunded(2500, "re_full", ACCT, "evt_full_replay");
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 25, stripe_refund_id: "re_full" });
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
    expect(db.rows("payment_settlement_conflicts")).toEqual([]);

    seedPackage({}, 0);
    await chargeRefunded(3000, "re_b");
    await chargeRefunded(1000, "re_a");
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 30, stripe_refund_id: "re_b" });
  });

  it("an event from another connected account changes nothing", async () => {
    seedClass();
    await chargeRefunded(2500, "re_x", "acct_other");
    expect(refundRpcCalls()).toEqual([]);
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 0 });
  });

  it("refund.updated uses the charge's cumulative amount_refunded, not the single refund amount", async () => {
    seedPackage({}, 0);
    payment().refund_amount = 10;
    chargeForRetrieve = { payment_intent: "pi_1", amount_refunded: 3000, balance_transaction: null } as never;
    const refund = { id: "re_2", amount: 2000, status: "succeeded", payment_intent: "pi_1", charge: "ch_1" } as Stripe.Refund;
    await handleStripeRefundUpdated(db.client as never, stripeFake as never, refund, ACCT, "evt_r", "refund.updated");
    expect(refundRpcCalls()[0].params).toMatchObject({ p_new_status: "paid", p_refund_amount: 30, p_stripe_refund_id: "re_2" });
  });

  it("a failed/canceled refund is never recorded as money returned", async () => {
    seedPackage();
    // charge unavailable: the failed refund's own amount is not evidence
    const failed = { id: "re_f", amount: 5000, status: "failed", payment_intent: "pi_1", charge: null } as unknown as Stripe.Refund;
    await handleStripeRefundUpdated(db.client as never, stripeFake as never, failed, ACCT, "evt_f", "refund.updated");
    // charge available: amount_refunded already excludes the failed refund
    chargeForRetrieve = { payment_intent: "pi_1", amount_refunded: 0, balance_transaction: null } as never;
    const canceled = { id: "re_c", amount: 5000, status: "canceled", payment_intent: "pi_1", charge: "ch_1" } as Stripe.Refund;
    await handleStripeRefundUpdated(db.client as never, stripeFake as never, canceled, ACCT, "evt_c", "refund.updated");
    expect(refundRpcCalls()).toEqual([]);
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 0 });
    expect(pkg().active).toBe(true);
  });
});

describe("source invariants", () => {
  it("no payment-type-specific refund branch or direct refund write remains in the webhook or staff action", () => {
    const route = readFileSync("src/app/api/payments/webhook/route.ts", "utf8");
    const actions = readFileSync("src/app/app/clients/[id]/actions.ts", "utf8");
    for (const source of [route, actions]) {
      expect(source).not.toMatch(/groupClassPurchaseRefund|applyGroupClassPurchaseRefundEffects|GROUP_CLASS_PURCHASE_PAYMENT_TYPE/);
    }
    const action = actions.slice(actions.indexOf("export async function refundClientPaymentAction"));
    const body = action.slice(0, action.indexOf("\nexport async function", 10));
    expect(body).toMatch(/rpc\(\s*"_apply_payment_refund_and_reevaluate"/);
    expect(body).not.toMatch(/\bstatus:\s*nextStatus/);
    expect(body).not.toMatch(/refund_amount:\s*next/);
    expect(body.indexOf("stripe.refunds")).toBeLessThan(body.indexOf('"_apply_payment_refund_and_reevaluate"'));
  });
});
