import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
} from "@/app/api/payments/webhook/route";

/**
 * PAY-DC-1: connected membership webhook paths operate only in event.account, verified
 * against the studio's connected account; SaaS (platform) billing stays separate.
 */

const STUDIO_ACCOUNT = "acct_studio_1";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

type StripeCall = { method: string; args: unknown[] };

function makeStripe() {
  const calls: StripeCall[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const stripe = {
    setupIntents: { retrieve: record("setupIntents.retrieve", { id: "seti_1", payment_method: "pm_1" }) },
    paymentMethods: {
      retrieve: record("paymentMethods.retrieve", {
        id: "pm_1",
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
      }),
    },
    customers: {
      update: record("customers.update", { id: "cus_studio_1" }),
      retrieve: record("customers.retrieve", {
        id: "cus_studio_1",
        invoice_settings: { default_payment_method: "pm_1" },
      }),
    },
    subscriptions: {
      retrieve: record("subscriptions.retrieve", {
        id: "sub_1",
        status: "active",
        default_payment_method: null,
        cancel_at_period_end: false,
        latest_invoice: "in_1",
        items: { data: [{ price: { id: "price_1" } }] },
        metadata: { studioId: "studio-1", clientId: CLIENT_ID, localMembershipId: "mem_1", membershipPlanId: "plan_1" },
      }),
    },
  };

  return { stripe: stripe as unknown as Stripe, calls };
}

function seedDb(rows: Record<string, FakeRow[]> = {}) {
  const db = createFakeSupabase({
    studios: [{ id: "studio-1", stripe_connected_account_id: STUDIO_ACCOUNT }],
    stripe_payment_methods: [],
    stripe_subscriptions: [],
    payments: [],
    ...rows,
  });
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      return db.client.from(table);
    },
  };
  return { db, tables, supabase: client as unknown as SupabaseClient };
}

function membershipSession(mode: "setup" | "subscription"): Stripe.Checkout.Session {
  return {
    id: `cs_${mode}`,
    object: "checkout.session",
    mode,
    customer: "cus_studio_1",
    setup_intent: mode === "setup" ? "seti_1" : null,
    subscription: mode === "subscription" ? "sub_1" : null,
    metadata: {
      studioId: "studio-1",
      clientId: CLIENT_ID,
      source: mode === "setup" ? "membership_payment_method_setup" : "membership_sale",
      chargeModel: "direct",
    },
  } as unknown as Stripe.Checkout.Session;
}

function invoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: "in_1",
    object: "invoice",
    customer: "cus_studio_1",
    subscription: "sub_1",
    amount_paid: 10000,
    currency: "usd",
    number: "INV-0001",
    ...overrides,
  } as unknown as Stripe.Invoice;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connected membership Checkout Sessions use event.account", () => {
  it("setup session: SetupIntent, PaymentMethod and Customer calls use the studio account", async () => {
    const { supabase, db } = seedDb();
    const { stripe, calls } = makeStripe();

    await handleCheckoutSessionCompleted(supabase, stripe, membershipSession("setup"), STUDIO_ACCOUNT);

    expect(calls.map((call) => call.method)).toEqual([
      "setupIntents.retrieve",
      "paymentMethods.retrieve",
      "customers.update",
    ]);
    for (const call of calls) {
      expect(call.args[call.args.length - 1]).toEqual({ stripeAccount: STUDIO_ACCOUNT });
    }
    expect(db.rows("stripe_payment_methods")[0]).toMatchObject({
      studio_id: "studio-1",
      client_id: CLIENT_ID,
      stripe_payment_method_id: "pm_1",
    });
  });

  it("subscription session: Subscription and Customer retrieval use the studio account", async () => {
    const { supabase } = seedDb();
    const { stripe, calls } = makeStripe();

    await handleCheckoutSessionCompleted(supabase, stripe, membershipSession("subscription"), STUDIO_ACCOUNT);

    expect(calls.map((call) => call.method)).toEqual([
      "subscriptions.retrieve",
      "customers.retrieve",
      "paymentMethods.retrieve",
      "customers.update",
    ]);
    for (const call of calls) {
      expect(call.args[call.args.length - 1]).toEqual({ stripeAccount: STUDIO_ACCOUNT });
    }
  });

  it.each([
    ["missing event.account", null],
    ["event.account that is not the studio's account", "acct_other"],
  ])("%s -> throws before any Stripe call", async (_label, account) => {
    for (const mode of ["setup", "subscription"] as const) {
      const { supabase, db } = seedDb();
      const { stripe, calls } = makeStripe();

      await expect(
        handleCheckoutSessionCompleted(supabase, stripe, membershipSession(mode), account),
      ).rejects.toThrow("membership_payment_account_unverified");

      expect(calls).toHaveLength(0);
      expect(db.mutations).toHaveLength(0);
    }
  });
});

describe("invoice.paid account context", () => {
  it("connected invoice stores stripe_account_id = event.account and never reads SaaS or legacy tables", async () => {
    const { supabase, db, tables } = seedDb({
      stripe_customers: [{ studio_id: "studio-other", client_id: "client-other", stripe_customer_id: "cus_studio_1" }],
    });
    const { stripe, calls } = makeStripe();

    await handleInvoicePaid(supabase, stripe, invoice(), STUDIO_ACCOUNT);

    expect(db.rows("stripe_subscriptions")[0]).toMatchObject({
      stripe_subscription_id: "sub_1",
      studio_id: "studio-1",
      stripe_account_id: STUDIO_ACCOUNT,
    });
    const retrieve = calls.find((call) => call.method === "subscriptions.retrieve");
    expect(retrieve?.args[retrieve.args.length - 1]).toEqual({ stripeAccount: STUDIO_ACCOUNT });
    expect(tables).not.toContain("stripe_customers");
    expect(tables).not.toContain("studio_billing_customers");
    expect(db.rows("payments")[0]).toMatchObject({ studio_id: "studio-1", client_id: CLIENT_ID });
  });

  it("connected invoice with no resolvable subscription metadata does not fall back to stripe_customers", async () => {
    const { supabase, db, tables } = seedDb({
      stripe_customers: [{ studio_id: "studio-1", client_id: CLIENT_ID, stripe_customer_id: "cus_studio_1" }],
    });
    const { stripe } = makeStripe();

    await handleInvoicePaid(supabase, stripe, invoice({ subscription: null }), STUDIO_ACCOUNT);

    expect(tables).not.toContain("stripe_customers");
    expect(db.rows("payments")).toHaveLength(0);
  });

  it("platform-scoped legacy invoice may still resolve via stripe_customers (until PAY-DC-4)", async () => {
    const { supabase, db, tables } = seedDb({
      stripe_customers: [{ studio_id: "studio-1", client_id: CLIENT_ID, stripe_customer_id: "cus_legacy" }],
    });
    const { stripe } = makeStripe();

    await handleInvoicePaid(supabase, stripe, invoice({ subscription: null, customer: "cus_legacy" }), null);

    expect(tables).toContain("stripe_customers");
    expect(db.rows("payments")[0]).toMatchObject({ studio_id: "studio-1", client_id: CLIENT_ID });
  });

  it("platform-scoped invoices still go through DanceFlow SaaS billing first (unchanged)", async () => {
    const { supabase, tables } = seedDb({
      stripe_customers: [{ studio_id: "studio-1", client_id: CLIENT_ID, stripe_customer_id: "cus_legacy" }],
    });
    const { stripe } = makeStripe();

    await handleInvoicePaid(supabase, stripe, invoice({ subscription: null, customer: "cus_legacy" }), null);

    expect(tables[0]).toBe("studio_billing_customers");
  });
});
