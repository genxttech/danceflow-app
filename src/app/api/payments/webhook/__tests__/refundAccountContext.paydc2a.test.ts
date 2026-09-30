import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";
import {
  handleChargeRefunded,
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handleStripeRefundUpdated,
} from "@/app/api/payments/webhook/route";

/**
 * PAY-DC-2A: refund webhooks only reconcile a row with a stored owner when the
 * event comes from that same Stripe account (legacy NULL rows unchanged), and
 * connected webhook writes persist the Stripe-signed event.account as owner.
 */

const A = "acct_storedA";
const C = "acct_otherC";

function fakeStripe() {
  return {
    charges: { retrieve: async () => ({ payment_intent: "pi_1", amount_refunded: 5000 }) },
    paymentIntents: {
      retrieve: async () => {
        throw new Error("fee sync not modelled");
      },
    },
  } as unknown as Stripe;
}

function charge(): Stripe.Charge {
  return {
    id: "ch_1",
    payment_intent: "pi_1",
    amount_refunded: 5000,
    refunds: { data: [{ id: "re_1" }] },
  } as unknown as Stripe.Charge;
}

function seed(rows: { payments?: Row[]; eventPayments?: Row[] }) {
  return createOwnershipFakeSupabase({
    payments: rows.payments ?? [],
    event_payments: rows.eventPayments ?? [],
    event_registrations: [{ id: "reg-1", payment_status: "paid", status: "confirmed" }],
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refund webhook stored-owner checks", () => {
  it("payments: stored owner A + event.account A -> reconciled", async () => {
    const db = seed({ payments: [{ id: "pay-1", amount: 50, stripe_payment_intent_id: "pi_1", stripe_account_id: A }] });

    await handleChargeRefunded(db.client as unknown as SupabaseClient, fakeStripe(), charge(), A);

    expect(db.rpcCalls.map((call) => call.name)).toEqual(["_apply_payment_refund_and_reevaluate"]);
  });

  it("payments: stored owner A + event.account C -> zero mutation", async () => {
    const db = seed({ payments: [{ id: "pay-1", amount: 50, stripe_payment_intent_id: "pi_1", stripe_account_id: A }] });

    await handleChargeRefunded(db.client as unknown as SupabaseClient, fakeStripe(), charge(), C);

    expect(db.rpcCalls).toHaveLength(0);
    expect(db.mutations).toHaveLength(0);
  });

  it("payments: stored owner A + platform-scoped event (no account) -> zero mutation", async () => {
    const db = seed({ payments: [{ id: "pay-1", amount: 50, stripe_payment_intent_id: "pi_1", stripe_account_id: A }] });

    await handleChargeRefunded(db.client as unknown as SupabaseClient, fakeStripe(), charge(), null);

    expect(db.rpcCalls).toHaveLength(0);
  });

  it("payments: legacy NULL owner -> unchanged legacy reconciliation", async () => {
    const db = seed({ payments: [{ id: "pay-1", amount: 50, stripe_payment_intent_id: "pi_1", stripe_account_id: null }] });

    await handleChargeRefunded(db.client as unknown as SupabaseClient, fakeStripe(), charge(), C);

    expect(db.rpcCalls).toHaveLength(1);
  });

  it("event_payments: stored owner A + event.account C -> zero mutation", async () => {
    const db = seed({
      eventPayments: [
        { id: "ep-1", registration_id: "reg-1", amount: 50, refund_amount: 0, stripe_payment_intent_id: "pi_1", stripe_account_id: A },
      ],
    });

    await handleChargeRefunded(db.client as unknown as SupabaseClient, fakeStripe(), charge(), C);

    expect(db.mutations).toHaveLength(0);
    expect(db.rows("event_payments")[0]).not.toHaveProperty("stripe_refund_id");
  });

  it("event_payments: stored owner A + event.account A -> reconciled", async () => {
    const db = seed({
      eventPayments: [
        { id: "ep-1", registration_id: "reg-1", amount: 50, refund_amount: 0, stripe_payment_intent_id: "pi_1", stripe_account_id: A },
      ],
    });

    await handleChargeRefunded(db.client as unknown as SupabaseClient, fakeStripe(), charge(), A);

    expect(db.rows("event_payments")[0]).toMatchObject({ status: "refunded", stripe_refund_id: "re_1" });
    expect(db.rows("event_registrations")[0]).toMatchObject({ payment_status: "refunded" });
  });

  it("refund.* events apply the same stored-owner check", async () => {
    const db = seed({ payments: [{ id: "pay-1", amount: 50, stripe_payment_intent_id: "pi_1", stripe_account_id: A }] });
    const refund = { id: "re_1", amount: 5000, status: "succeeded", payment_intent: "pi_1", charge: "ch_1" } as Stripe.Refund;

    await handleStripeRefundUpdated(db.client as unknown as SupabaseClient, fakeStripe(), refund, C);

    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe("connected webhook writes persist the owner", () => {
  function invoiceStripe() {
    return {
      subscriptions: {
        retrieve: async () => ({
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          default_payment_method: null,
          cancel_at_period_end: false,
          latest_invoice: "in_1",
          items: { data: [{ price: { id: "price_1" } }] },
          metadata: {
            studioId: "studio-1",
            clientId: "11111111-1111-4111-8111-111111111111",
            localMembershipId: "mem-1",
            membershipPlanId: "plan-1",
          },
        }),
      },
      paymentIntents: {
        retrieve: async () => {
          throw new Error("fee sync not modelled");
        },
      },
    } as unknown as Stripe;
  }

  function invoice(): Stripe.Invoice {
    return {
      id: "in_1",
      customer: "cus_1",
      subscription: "sub_1",
      amount_paid: 10000,
      currency: "usd",
      number: "INV-1",
    } as unknown as Stripe.Invoice;
  }

  function invoiceDb() {
    return createOwnershipFakeSupabase({
      studios: [{ id: "studio-1", stripe_connected_account_id: A }],
      stripe_subscriptions: [],
      studio_billing_customers: [],
      payments: [],
      client_membership_periods: [],
      clients: [{ id: "11111111-1111-4111-8111-111111111111", studio_id: "studio-1" }],
      client_memberships: [
        { id: "mem-1", studio_id: "studio-1", client_id: "11111111-1111-4111-8111-111111111111" },
      ],
    });
  }

  it("membership invoice.paid on a connected account stores stripe_account_id = event.account", async () => {
    const db = invoiceDb();

    await handleInvoicePaid(db.client as unknown as SupabaseClient, invoiceStripe(), invoice(), A);

    expect(db.rows("payments")[0]).toMatchObject({ studio_id: "studio-1", stripe_account_id: A });
  });

  it("event registration checkout stores stripe_account_id = event.account on event_payments", async () => {
    // PAY-DC-2D fixture: the registration carries its server-stored checkout
    // session and event studio, whose connected account is the event account.
    const db = createOwnershipFakeSupabase({
      event_registrations: [
        {
          id: "reg-1",
          total_amount: 40,
          total_price: 40,
          currency: "usd",
          payment_status: "pending",
          stripe_checkout_session_id: "cs_evt",
          events: { studio_id: "studio-1" },
        },
      ],
      studios: [{ id: "studio-1", stripe_connected_account_id: A }],
      event_payments: [],
    });
    const session = {
      id: "cs_evt",
      mode: "payment",
      payment_status: "paid",
      payment_intent: "pi_evt",
      amount_total: 4000,
      currency: "usd",
      metadata: { source: "event_registration", registration_id: "reg-1" },
    } as unknown as Stripe.Checkout.Session;

    await handleCheckoutSessionCompleted(
      db.client as unknown as SupabaseClient,
      { paymentIntents: { retrieve: async () => { throw new Error("fee sync not modelled"); } } } as unknown as Stripe,
      session,
      A,
    ).catch(() => undefined);

    expect(db.rows("event_payments")[0]).toMatchObject({
      registration_id: "reg-1",
      stripe_payment_intent_id: "pi_evt",
      stripe_account_id: A,
    });
  });
});
