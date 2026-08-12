import { describe, expect, it, beforeEach } from "vitest";
import type Stripe from "stripe";
import { handlePortalFloorRentalCheckoutCompleted } from "@/app/api/payments/webhook/route";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";

/**
 * Regression coverage for the portal floor-rental balance checkout
 * fulfillment fix: the webhook now transitions the single pending
 * `payments` row the route created/reused (identified via
 * metadata.paymentId) from pending -> paid, instead of blind-inserting a
 * second `payments` row on every completed session. This is what makes the
 * route-side reuse-or-create design (portal-floor-rental-checkout-session.ts)
 * actually prevent a duplicate charge end to end: even if two live sessions
 * somehow both completed, only one can win the pending -> paid transition,
 * and no completed session can ever produce a second payments row for the
 * same floor-rental balance.
 */

let paymentsTable: FakeTable;
let appointmentsTable: FakeTable;

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const PAYMENT_ID = "payment-1";

function seedPendingPayment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: PAYMENT_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    source: "floor_rental",
    payment_type: "floor_fee",
    status: "pending",
    amount: 150,
    stripe_payment_intent_id: null,
    ...overrides,
  };
  paymentsTable.rows.push(row);
  return row;
}

function seedAppointment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `apt-${appointmentsTable.rows.length + 1}`,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    appointment_type: "floor_space_rental",
    status: "scheduled",
    payment_status: "unpaid",
    price_amount: 150,
    ...overrides,
  };
  appointmentsTable.rows.push(row);
  return row;
}

function fakeSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_1",
    payment_status: "paid",
    payment_intent: "pi_1",
    amount_total: 15000,
    metadata: {
      source: "portal_floor_rental_balance_payment",
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      appointmentIds: "apt-1",
      paymentId: PAYMENT_ID,
    },
    ...overrides,
  } as Stripe.Checkout.Session;
}

beforeEach(() => {
  paymentsTable = new FakeTable();
  appointmentsTable = new FakeTable();
});

function fakeSupabase() {
  return createFakeAdminClient({
    payments: paymentsTable,
    appointments: appointmentsTable,
  }) as never;
}

describe("handlePortalFloorRentalCheckoutCompleted", () => {
  it("transitions the referenced pending payment to paid and marks the payable appointments paid", async () => {
    seedPendingPayment();
    seedAppointment();

    const result = await handlePortalFloorRentalCheckoutCompleted(fakeSupabase(), fakeSession());

    expect(result).toBe(true);
    const payment = paymentsTable.rows.find((r) => r.id === PAYMENT_ID)!;
    expect(payment.status).toBe("paid");
    expect(payment.stripe_payment_intent_id).toBe("pi_1");
    expect(payment.stripe_checkout_session_id).toBe("cs_1");
    const appointment = appointmentsTable.rows.find((r) => r.id === "apt-1")!;
    expect(appointment.payment_status).toBe("paid");
    // Exactly one payments row still exists -- fulfillment transitioned the
    // pending row rather than inserting a second one.
    expect(paymentsTable.rows).toHaveLength(1);
  });

  it("redelivery of the same webhook event does not create or transition another payment", async () => {
    seedPendingPayment({ status: "paid", stripe_payment_intent_id: "pi_1" });
    seedAppointment({ payment_status: "paid" });

    const result = await handlePortalFloorRentalCheckoutCompleted(fakeSupabase(), fakeSession());

    expect(result).toBe(true);
    expect(paymentsTable.rows).toHaveLength(1);
    expect(paymentsTable.rows[0].status).toBe("paid");
  });

  it("a second, genuinely different completed session for the same (already-paid) pending row is a safe no-op, not a second payment", async () => {
    seedPendingPayment({ status: "paid", stripe_payment_intent_id: "pi_1" });
    seedAppointment({ payment_status: "paid" });

    // A different session/payment_intent than the one that already paid
    // this row -- the stripe_payment_intent_id dedupe guard above would not
    // catch this on its own, but the payment.status !== "pending" guard
    // does.
    const result = await handlePortalFloorRentalCheckoutCompleted(
      fakeSupabase(),
      fakeSession({ id: "cs_2", payment_intent: "pi_2" }),
    );

    expect(result).toBe(true);
    expect(paymentsTable.rows).toHaveLength(1);
  });

  it("throws on an amount mismatch and does not transition the payment", async () => {
    seedPendingPayment({ amount: 200 });
    seedAppointment();

    await expect(
      handlePortalFloorRentalCheckoutCompleted(fakeSupabase(), fakeSession()),
    ).rejects.toThrow(/amount mismatch/i);

    expect(paymentsTable.rows.find((r) => r.id === PAYMENT_ID)!.status).toBe("pending");
  });

  it("throws when no payable appointments remain and does not transition the payment", async () => {
    seedPendingPayment();
    seedAppointment({ payment_status: "paid" });

    await expect(
      handlePortalFloorRentalCheckoutCompleted(fakeSupabase(), fakeSession()),
    ).rejects.toThrow(/no payable floor rentals/i);

    expect(paymentsTable.rows.find((r) => r.id === PAYMENT_ID)!.status).toBe("pending");
  });

  it("throws when the referenced pending payment cannot be found", async () => {
    seedAppointment();

    await expect(
      handlePortalFloorRentalCheckoutCompleted(fakeSupabase(), fakeSession()),
    ).rejects.toThrow(/payment record not found/i);
  });

  it("is a no-op for a session that is not yet paid", async () => {
    seedPendingPayment();
    seedAppointment();

    const result = await handlePortalFloorRentalCheckoutCompleted(
      fakeSupabase(),
      fakeSession({ payment_status: "unpaid" }),
    );

    expect(result).toBe(true);
    expect(paymentsTable.rows.find((r) => r.id === PAYMENT_ID)!.status).toBe("pending");
  });

  it("ignores sessions from other checkout sources", async () => {
    const result = await handlePortalFloorRentalCheckoutCompleted(
      fakeSupabase(),
      fakeSession({ metadata: { source: "client_payment_request" } }),
    );

    expect(result).toBe(false);
  });
});
