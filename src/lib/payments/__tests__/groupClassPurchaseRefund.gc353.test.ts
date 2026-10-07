import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";

/**
 * GC-3.5-3 locked refund behavior for Group Class direct-payment enrollments.
 *   FULL refund    -> payment refunded; attendee cancelled + payment_status 'refunded'; seat released; rows kept.
 *   PARTIAL refund -> payment stays 'paid' with refund_amount; attendee payment_status 'partial'; still booked.
 *   Checkout conflict refund -> no attendee exists, nothing to cancel.
 * Covered for the shared effects helper, the staff refund action and the Stripe refund webhooks.
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

const STUDIO = "studio-1";
const CLIENT = "client-1";
const ACCT = "acct_studio1";
const PAYMENT = "pay-1";
const ATTENDEE = "att-1";
const CLASS = "class-1";

let db: ReturnType<typeof createOwnershipFakeSupabase>;
let attendanceRecorded = false;
const refundCalls: Array<Record<string, unknown>> = [];
const stripeFake = {
  refunds: {
    async create(params: Record<string, unknown>) {
      refundCalls.push(params);
      return { id: `re_${refundCalls.length}`, status: "succeeded" };
    },
  },
  balanceTransactions: { retrieve: async () => ({ fee: 0 }) },
  charges: { retrieve: async () => ({}) },
  paymentIntents: { retrieve: async () => ({}) },
};

const { applyGroupClassPurchaseRefundEffects } = await import("../groupClassPurchaseRefund");
const { refundClientPaymentAction } = await import("@/app/app/clients/[id]/actions");
const { handleChargeRefunded } = await import("@/app/api/payments/webhook/route");

function seed(over: { payment?: Row; attendee?: Row; holdStatus?: string } = {}) {
  db = createOwnershipFakeSupabase(
    {
      payments: [{
        id: PAYMENT, studio_id: STUDIO, client_id: CLIENT, appointment_id: CLASS, amount: 25, currency: "usd", status: "paid",
        payment_type: "group_class_direct_payment", notes: null, stripe_payment_intent_id: "pi_1", stripe_charge_id: null,
        stripe_refund_id: null, refund_amount: 0, stripe_account_id: ACCT, ...over.payment,
      }],
      studios: [{ id: STUDIO, stripe_connected_account_id: ACCT }],
      group_class_enrollment_holds: [{ id: "hold-1", studio_id: STUDIO, appointment_id: CLASS, status: over.holdStatus ?? "converted", attendee_id: ATTENDEE, payment_id: PAYMENT, client_id: CLIENT }],
      appointment_attendees: [{ id: ATTENDEE, studio_id: STUDIO, appointment_id: CLASS, client_id: CLIENT, status: "booked", payment_status: "paid", billing_type: "pay_as_you_go", cancelled_at: null, ...over.attendee }],
      event_payments: [],
    },
    {
      // The database's GCSD1 rule: a dancer with recorded attendance cannot be cancelled.
      rowGuard: (table, before, after) =>
        table === "appointment_attendees" && attendanceRecorded && before?.status === "booked" && after.status === "cancelled"
          ? "GCSD1_ATTENDEE_ATTENDANCE_RECORDED: This dancer already has attendance recorded for this class."
          : null,
    },
  );
}

const attendee = () => db.tables.appointment_attendees.find((r) => r.id === ATTENDEE)!;
const payment = () => db.tables.payments.find((r) => r.id === PAYMENT)!;
const admin = () => db.client as unknown as SupabaseClient;

async function staffRefund(amount: string) {
  const form = new FormData();
  form.set("clientId", CLIENT);
  form.set("paymentId", PAYMENT);
  form.set("amount", amount);
  form.set("reason", "Customer request");
  form.set("returnTo", `/app/clients/${CLIENT}`);
  try {
    await refundClientPaymentAction(form);
  } catch (error) {
    return decodeURIComponent(((error as { digest?: string }).digest ?? "").split(";")[2] ?? "");
  }
  throw new Error("expected a redirect");
}

function charge(amountRefundedCents: number, refundId = "re_hook") {
  return { payment_intent: "pi_1", amount_refunded: amountRefundedCents, refunds: { data: [{ id: refundId }] }, balance_transaction: null } as unknown as Stripe.Charge;
}

beforeEach(() => {
  attendanceRecorded = false;
  refundCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  seed();
});

describe("effects helper", () => {
  it("FULL: cancels the enrollment, marks it refunded and keeps the row (seat released by the capacity model)", async () => {
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: true })).toBe("cancelled");
    expect(attendee()).toMatchObject({ id: ATTENDEE, status: "cancelled", payment_status: "refunded" });
    expect(attendee().cancelled_at).toBeTruthy();
    expect(db.tables.appointment_attendees).toHaveLength(1);
  });

  it("PARTIAL: payment_status 'partial', still booked, seat kept, never cancelled", async () => {
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: false })).toBe("partial");
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "partial", cancelled_at: null });
  });

  it("is idempotent, and a late partial never downgrades a refunded/cancelled enrollment", async () => {
    await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: true });
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: true })).toBe("already_applied");
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: false })).toBe("already_applied");
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
  });

  it("partial then full: booked/partial, then cancelled/refunded", async () => {
    await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: false });
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: true })).toBe("cancelled");
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
  });

  it("FULL after attendance was recorded: the database rule keeps the enrollment; the refund is recorded on it", async () => {
    attendanceRecorded = true;
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: true })).toBe("refunded_attendance_recorded");
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "refunded" });
  });

  it("a checkout-conflict payment (no converted hold / no attendee) has nothing to cancel", async () => {
    seed({ holdStatus: "conflict" });
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: true })).toBe("not_group_class_purchase");
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "paid" });
  });

  it("only the enrollment bound to THIS payment by its converted hold is touched", async () => {
    db.tables.appointment_attendees.push({ id: "att-other", studio_id: STUDIO, appointment_id: CLASS, client_id: "client-2", status: "booked", payment_status: "paid" });
    await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: PAYMENT, fullyRefunded: true });
    expect(db.tables.appointment_attendees.find((r) => r.id === "att-other")).toMatchObject({ status: "booked", payment_status: "paid" });
    expect(await applyGroupClassPurchaseRefundEffects(admin(), { paymentId: "pay-unrelated", fullyRefunded: true })).toBe("not_group_class_purchase");
  });
});

describe("staff refund action (canonical client refund)", () => {
  it("FULL refund: payment refunded, enrollment cancelled + refunded", async () => {
    expect(await staffRefund("25")).toContain("success=payment_refunded");
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 25 });
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
  });

  it("PARTIAL refund: payment stays 'paid' with the refunded amount; enrollment stays booked with 'partial'", async () => {
    expect(await staffRefund("10")).toContain("success=payment_refunded");
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 10 });
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "partial" });
  });

  it("other payment types are never touched by the class-enrollment rule", async () => {
    seed({ payment: { payment_type: "package" } });
    await staffRefund("25");
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "paid" });
  });
});

describe("Stripe refund webhooks (dashboard / external refunds)", () => {
  it("FULL charge.refunded: payment refunded and enrollment cancelled + refunded (no shared refund RPC)", async () => {
    await handleChargeRefunded(db.client as never, stripeFake as never, charge(2500), ACCT, "evt_r1", "charge.refunded");
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 25, stripe_refund_id: "re_hook" });
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
  });

  it("PARTIAL charge.refunded: payment stays 'paid' with refund_amount; enrollment booked + 'partial'", async () => {
    await handleChargeRefunded(db.client as never, stripeFake as never, charge(1000), ACCT, "evt_r2", "charge.refunded");
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 10 });
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "partial" });
  });

  it("replays and out-of-order events are safe (monotonic refund_amount; no downgrade)", async () => {
    await handleChargeRefunded(db.client as never, stripeFake as never, charge(2500), ACCT, "evt_r3", "charge.refunded");
    await handleChargeRefunded(db.client as never, stripeFake as never, charge(1000), ACCT, "evt_r2_late", "charge.refunded");
    await handleChargeRefunded(db.client as never, stripeFake as never, charge(2500), ACCT, "evt_r3_replay", "charge.refunded");
    expect(payment()).toMatchObject({ status: "refunded", refund_amount: 25 });
    expect(attendee()).toMatchObject({ status: "cancelled", payment_status: "refunded" });
  });

  it("an event from another connected account changes nothing", async () => {
    await handleChargeRefunded(db.client as never, stripeFake as never, charge(2500), "acct_other", "evt_x", "charge.refunded");
    expect(payment()).toMatchObject({ status: "paid", refund_amount: 0 });
    expect(attendee()).toMatchObject({ status: "booked", payment_status: "paid" });
  });

  it("the webhook routes Group Class purchase payments to the effects helper before the shared RPC", () => {
    const route = readFileSync("src/app/api/payments/webhook/route.ts", "utf8");
    const branch = route.indexOf("payment_type === GROUP_CLASS_PURCHASE_PAYMENT_TYPE");
    const rpc = route.indexOf('"_apply_payment_refund_and_reevaluate"');
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(rpc);
  });
});
