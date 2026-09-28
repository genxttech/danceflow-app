import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";
import {
  handleClientPaymentRequestCheckoutCompleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handlePortalFloorRentalCheckoutCompleted,
  handleStudentMarketplacePaymentIntentSucceeded,
  handleTerminalPaymentIntentSucceeded,
  upsertStripeSubscriptionRecord,
} from "@/app/api/payments/webhook/route";

/**
 * PAY-DC-2B: connected webhook handlers bind event.account to persisted owner or
 * account context before any mutation. Stored ownership stays authoritative.
 */

const A = "acct_ownerA";
const B = "acct_currentB";
const C = "acct_otherC";

function db(rows: Record<string, Row[]>) {
  const fake = createOwnershipFakeSupabase(rows);
  return { fake, supabase: fake.client as unknown as SupabaseClient };
}

function stripeRecorder(subscription?: Record<string, unknown>) {
  const calls: string[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async () => {
        calls.push("subscriptions.retrieve");
        return subscription;
      },
    },
    paymentIntents: {
      retrieve: async () => {
        throw new Error("fee sync not modelled");
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Terminal event.account binding", () => {
  function terminalDb() {
    return db({
      terminal_payment_sessions: [
        {
          id: "tps-1",
          studio_id: "studio-1",
          payment_id: "pay-1",
          amount_cents: 2000,
          currency: "usd",
          stripe_payment_intent_id: "pi_t",
          stripe_account_id: A,
        },
      ],
      payments: [{ id: "pay-1", studio_id: "studio-1", status: "pending", amount: 20 }],
    });
  }

  const intent = {
    id: "pi_t",
    amount_received: 2000,
    currency: "usd",
    metadata: { source: "danceflow_terminal", studioId: "studio-1", paymentId: "pay-1" },
  } as unknown as Stripe.PaymentIntent;

  it.each([
    ["missing event.account", null],
    ["event.account not the session's account", C],
  ])("%s -> terminal_event_account_mismatch, zero mutations", async (_label, account) => {
    const { fake, supabase } = terminalDb();
    await expect(handleTerminalPaymentIntentSucceeded(supabase, intent, account)).rejects.toThrow(
      "terminal_event_account_mismatch",
    );
    expect(fake.mutations).toHaveLength(0);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe("marketplace verify-only (D3)", () => {
  function marketplaceDb(orderAccount = A) {
    return db({
      commerce_orders: [
        {
          id: "order-1",
          studio_id: "studio-1",
          metadata: { stripe_connected_account_id: orderAccount, stripe_payment_intent_id: "pi_m" },
        },
      ],
      studios: [{ id: "studio-1", stripe_connected_account_id: B }],
      payments: [{ id: "pay-m", studio_id: "studio-1", commerce_order_id: "order-1", stripe_account_id: null }],
    });
  }

  function marketplaceIntent(overrides: Record<string, unknown> = {}) {
    return {
      id: "pi_m",
      amount: 1500,
      amount_received: 1500,
      currency: "usd",
      metadata: { source: "commerce_digital_marketplace", order_id: "order-1", studio_id: "studio-1" },
      ...overrides,
    } as unknown as Stripe.PaymentIntent;
  }

  it("matching account + PaymentIntent + studio -> RPC and ownership stamp (stored order owner beats studio's current account)", async () => {
    const { fake, supabase } = marketplaceDb(A);

    await expect(handleStudentMarketplacePaymentIntentSucceeded(supabase, marketplaceIntent(), A)).resolves.toBe(true);

    expect(fake.rpcCalls.map((call) => call.name)).toEqual(["commerce_finalize_student_digital_order"]);
    expect(fake.rows("payments")[0].stripe_account_id).toBe(A);
  });

  it.each([
    ["wrong account", C, {}],
    ["missing account", null, {}],
    ["different PaymentIntent", A, { id: "pi_other" }],
    ["different studio", A, { metadata: { source: "commerce_digital_marketplace", order_id: "order-1", studio_id: "studio-2" } }],
  ])("%s -> marketplace_event_account_mismatch, zero RPC/writes", async (_label, account, overrides) => {
    const { fake, supabase } = marketplaceDb(A);

    await expect(
      handleStudentMarketplacePaymentIntentSucceeded(supabase, marketplaceIntent(overrides), account),
    ).rejects.toThrow("marketplace_event_account_mismatch");

    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.mutations).toHaveLength(0);
  });
});

describe("invoice.payment_failed account symmetry", () => {
  function failedDb(storedAccount: string | null) {
    return db({
      studio_billing_customers: [],
      stripe_subscriptions: [
        {
          id: "ss-1",
          stripe_subscription_id: "sub_1",
          studio_id: "studio-1",
          client_id: "client-1",
          client_membership_id: "mem-1",
          stripe_account_id: storedAccount,
        },
      ],
      client_memberships: [{ id: "mem-1", studio_id: "studio-1", status: "active" }],
    });
  }

  const invoice = { id: "in_f", customer: "cus_1", subscription: "sub_1" } as unknown as Stripe.Invoice;

  it("connected event with matching stored account -> past_due, never touches SaaS billing or the platform", async () => {
    const { fake, supabase } = failedDb(A);
    const { stripe, calls } = stripeRecorder();

    await handleInvoicePaymentFailed(supabase, stripe, invoice, A);

    expect(fake.rows("client_memberships")[0].status).toBe("past_due");
    expect(fake.fromCalls).not.toContain("studio_billing_customers");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["NULL stored account", null],
    ["different stored account", C],
  ])("connected event with %s -> no mutation", async (_label, stored) => {
    const { fake, supabase } = failedDb(stored);
    const { stripe, calls } = stripeRecorder();

    await handleInvoicePaymentFailed(supabase, stripe, invoice, A);

    expect(fake.mutations).toHaveLength(0);
    expect(fake.fromCalls).not.toContain("studio_billing_customers");
    expect(calls).toHaveLength(0);
  });

  it("platform event on a legacy platform subscription (no stored account) -> unchanged past_due", async () => {
    const { fake, supabase } = failedDb(null);
    const { stripe } = stripeRecorder();

    await handleInvoicePaymentFailed(supabase, stripe, invoice, null);

    expect(fake.fromCalls).toContain("studio_billing_customers");
    expect(fake.rows("client_memberships")[0].status).toBe("past_due");
  });

  it("platform event on a connected subscription -> skipped", async () => {
    const { fake, supabase } = failedDb(A);
    const { stripe } = stripeRecorder();

    await handleInvoicePaymentFailed(supabase, stripe, invoice, null);

    expect(fake.mutations).toHaveLength(0);
  });
});

describe("subscription + invoice.paid tenant verification", () => {
  const subscription = {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    latest_invoice: "in_1",
    default_payment_method: null,
    items: { data: [{ price: { id: "price_1" } }] },
    metadata: { studioId: "studio-1", clientId: "client-1", localMembershipId: "mem-1", membershipPlanId: "plan-1" },
  };

  function subDb(stored: Row[] = [], studioAccount: string | null = B) {
    return db({
      studios: [{ id: "studio-1", stripe_connected_account_id: studioAccount }],
      stripe_subscriptions: stored,
      client_memberships: [{ id: "mem-1", studio_id: "studio-1", status: "pending" }],
      payments: [],
      studio_billing_customers: [],
    });
  }

  it("metadata studio whose account differs from event.account (no stored owner) -> throws, zero writes", async () => {
    const { fake, supabase } = subDb([], B);

    await expect(
      upsertStripeSubscriptionRecord(supabase, subscription as unknown as Stripe.Subscription, C),
    ).rejects.toThrow("subscription_event_studio_mismatch");

    expect(fake.mutations).toHaveLength(0);
  });

  it("stored owner match is accepted even after the studio reconnected to another account", async () => {
    const { fake, supabase } = subDb(
      [{ id: "ss-1", stripe_subscription_id: "sub_1", studio_id: "studio-1", stripe_account_id: A }],
      B,
    );

    await upsertStripeSubscriptionRecord(supabase, subscription as unknown as Stripe.Subscription, A);

    expect(fake.rows("stripe_subscriptions")[0]).toMatchObject({ stripe_account_id: A, status: "active" });
    expect(fake.rows("client_memberships")[0].status).not.toBe("pending");
  });

  it("stored owner for a different studio -> throws, zero writes", async () => {
    const { fake, supabase } = subDb(
      [{ id: "ss-1", stripe_subscription_id: "sub_1", studio_id: "studio-2", stripe_account_id: A }],
      A,
    );

    await expect(
      upsertStripeSubscriptionRecord(supabase, subscription as unknown as Stripe.Subscription, A),
    ).rejects.toThrow("subscription_event_studio_mismatch");
    expect(fake.mutations).toHaveLength(0);
  });

  it("connected subscription without DanceFlow studio metadata -> no tenant, no writes", async () => {
    const { fake, supabase } = subDb([], A);

    await upsertStripeSubscriptionRecord(
      supabase,
      { ...subscription, metadata: {} } as unknown as Stripe.Subscription,
      A,
    );

    expect(fake.mutations).toHaveLength(0);
  });

  it("platform event is unchanged (no studio verification)", async () => {
    const { fake, supabase } = subDb([], B);

    await upsertStripeSubscriptionRecord(supabase, subscription as unknown as Stripe.Subscription, null);

    expect(fake.rows("stripe_subscriptions")[0]).toMatchObject({ stripe_subscription_id: "sub_1", stripe_account_id: null });
  });

  const invoice = {
    id: "in_1",
    customer: "cus_1",
    subscription: "sub_1",
    amount_paid: 10000,
    currency: "usd",
  } as unknown as Stripe.Invoice;

  it("invoice.paid metadata fallback: studio not proven for event.account -> throws, zero writes", async () => {
    const { fake, supabase } = subDb([], B);
    const { stripe } = stripeRecorder(subscription);

    await expect(handleInvoicePaid(supabase, stripe, invoice, C)).rejects.toThrow(
      "subscription_event_studio_mismatch",
    );
    expect(fake.mutations).toHaveLength(0);
  });

  it("invoice.paid for a subscription stored under another account -> skipped, zero writes", async () => {
    const { fake, supabase } = subDb(
      [{ id: "ss-1", stripe_subscription_id: "sub_1", studio_id: "studio-1", client_id: "client-1", stripe_account_id: A }],
      A,
    );
    const { stripe, calls } = stripeRecorder(subscription);

    await handleInvoicePaid(supabase, stripe, invoice, C);

    expect(fake.mutations).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("invoice.paid metadata fallback with the studio's own account -> payment recorded", async () => {
    const { fake, supabase } = subDb([], A);
    const { stripe } = stripeRecorder(subscription);

    await handleInvoicePaid(supabase, stripe, invoice, A);

    expect(fake.rows("payments")[0]).toMatchObject({ studio_id: "studio-1", stripe_account_id: A });
  });
});

describe("floor rental + client payment request ownership", () => {
  function clientRequestDb(stored: string | null) {
    return db({
      payments: [
        {
          id: "pay-c",
          studio_id: "studio-1",
          client_id: "client-1",
          client_package_id: null,
          client_membership_id: null,
          amount: 25,
          status: "pending",
          stripe_account_id: stored,
        },
      ],
    });
  }

  const clientSession = {
    id: "cs_c",
    payment_status: "paid",
    payment_intent: "pi_c",
    amount_total: 2500,
    currency: "usd",
    metadata: { source: "client_payment_request", paymentId: "pay-c" },
  } as unknown as Stripe.Checkout.Session;

  it("client payment request: stored A + event A -> paid", async () => {
    const { fake, supabase } = clientRequestDb(A);

    await handleClientPaymentRequestCheckoutCompleted(supabase, clientSession, "evt_1", "checkout.session.completed", A);

    expect(fake.rows("payments")[0]).toMatchObject({ status: "paid", stripe_account_id: A });
  });

  it("client payment request: stored A + event C -> throws, zero mutation", async () => {
    const { fake, supabase } = clientRequestDb(A);

    await expect(
      handleClientPaymentRequestCheckoutCompleted(supabase, clientSession, "evt_1", "checkout.session.completed", C),
    ).rejects.toThrow("payment_event_account_mismatch");
    expect(fake.mutations).toHaveLength(0);
  });

  it("client payment request: NULL owner + event A -> paid and owner stamped", async () => {
    const { fake, supabase } = clientRequestDb(null);

    await handleClientPaymentRequestCheckoutCompleted(supabase, clientSession, "evt_1", "checkout.session.completed", A);

    expect(fake.rows("payments")[0]).toMatchObject({ status: "paid", stripe_account_id: A });
  });

  function floorDb(stored: string | null) {
    return db({
      payments: [
        { id: "pay-f", studio_id: "studio-1", client_id: "client-1", amount: 40, status: "pending", stripe_account_id: stored },
      ],
      appointments: [
        {
          id: "appt-1",
          studio_id: "studio-1",
          client_id: "client-1",
          appointment_type: "floor_space_rental",
          status: "scheduled",
          payment_status: "unpaid",
          price_amount: 40,
        },
      ],
    });
  }

  const floorSession = {
    id: "cs_f",
    payment_status: "paid",
    payment_intent: "pi_f",
    amount_total: 4000,
    currency: "usd",
    metadata: {
      source: "portal_floor_rental_balance_payment",
      studioId: "studio-1",
      clientId: "client-1",
      appointmentIds: "appt-1",
      paymentId: "pay-f",
    },
  } as unknown as Stripe.Checkout.Session;

  it("floor rental: stored A + event C -> throws, zero mutation", async () => {
    const { fake, supabase } = floorDb(A);

    await expect(handlePortalFloorRentalCheckoutCompleted(supabase, floorSession, C)).rejects.toThrow(
      "payment_event_account_mismatch",
    );
    expect(fake.mutations).toHaveLength(0);
  });

  it("floor rental: stored A + event A -> paid", async () => {
    const { fake, supabase } = floorDb(A);

    await handlePortalFloorRentalCheckoutCompleted(supabase, floorSession, A);

    expect(fake.rows("payments")[0]).toMatchObject({ status: "paid", stripe_account_id: A });
  });

  it("floor rental: NULL owner + event A -> paid and owner stamped", async () => {
    const { fake, supabase } = floorDb(null);

    await handlePortalFloorRentalCheckoutCompleted(supabase, floorSession, A);

    expect(fake.rows("payments")[0]).toMatchObject({ status: "paid", stripe_account_id: A });
  });
});
