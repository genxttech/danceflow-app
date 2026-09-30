import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";
import { handleInvoicePaid, upsertStripeSubscriptionRecord } from "@/app/api/payments/webhook/route";

/**
 * PAY-DC-4A (G1): a connected subscription/invoice event may only reference a client and membership of
 * the verified studio. A mismatch throws subscription_event_membership_mismatch with 0 writes; platform
 * (legacy) events are unchanged.
 */

const A = "acct_studioA";
const MISMATCH = "subscription_event_membership_mismatch";

function db(stored: Row[] = []) {
  const fake = createOwnershipFakeSupabase({
    studios: [
      { id: "studio-1", stripe_connected_account_id: A },
      { id: "studio-2", stripe_connected_account_id: "acct_studioB" },
    ],
    stripe_subscriptions: stored,
    clients: [
      { id: "client-1", studio_id: "studio-1" },
      { id: "client-3", studio_id: "studio-1" },
      { id: "client-2", studio_id: "studio-2" },
    ],
    client_memberships: [
      { id: "mem-1", studio_id: "studio-1", client_id: "client-1", status: "pending" },
      { id: "mem-2", studio_id: "studio-2", client_id: "client-2", status: "active" },
    ],
    client_membership_periods: [
      { id: "period-2", studio_id: "studio-2", client_membership_id: "mem-2", period_start: "2026-10-01", period_end: "2026-11-01" },
    ],
    payments: [],
    studio_billing_customers: [],
  });
  return { fake, supabase: fake.client as unknown as SupabaseClient };
}

function subscription(metadata: Record<string, string>) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    current_period_start: 1790000000,
    current_period_end: 1792600000,
    cancel_at_period_end: false,
    latest_invoice: "in_1",
    default_payment_method: null,
    items: { data: [{ price: { id: "price_1" } }] },
    metadata: { studioId: "studio-1", membershipPlanId: "plan-1", ...metadata },
  } as unknown as Stripe.Subscription;
}

function stripeWith(sub: Stripe.Subscription) {
  return {
    subscriptions: { retrieve: async () => sub },
    paymentIntents: {
      retrieve: async () => {
        throw new Error("fee sync not modelled");
      },
    },
  } as unknown as Stripe;
}

const invoice = {
  id: "in_1",
  customer: "cus_1",
  subscription: "sub_1",
  amount_paid: 10000,
  currency: "usd",
  lines: { data: [{ period: { start: 1790000000, end: 1792600000 } }] },
} as unknown as Stripe.Invoice;

describe("customer.subscription.* (connected)", () => {
  it.each([
    ["foreign client", { clientId: "client-2", localMembershipId: "mem-1" }],
    ["foreign membership", { clientId: "client-1", localMembershipId: "mem-2" }],
    ["membership of another client in the same studio", { clientId: "client-3", localMembershipId: "mem-1" }],
    ["unknown membership", { clientId: "client-1", localMembershipId: "mem-missing" }],
  ])("%s -> throws the fixed code, 0 writes", async (_label, metadata) => {
    const { fake, supabase } = db();
    await expect(upsertStripeSubscriptionRecord(supabase, subscription(metadata), A)).rejects.toThrow(MISMATCH);
    expect(fake.mutations).toHaveLength(0);
  });

  it("valid references write as before", async () => {
    const { fake, supabase } = db();
    await upsertStripeSubscriptionRecord(supabase, subscription({ clientId: "client-1", localMembershipId: "mem-1" }), A);
    expect(fake.rows("stripe_subscriptions")[0]).toMatchObject({ studio_id: "studio-1", client_id: "client-1", stripe_account_id: A });
    expect(fake.rows("client_memberships")[0].status).not.toBe("pending");
  });

  it("missing client/membership metadata is not an error (nothing to validate)", async () => {
    const { fake, supabase } = db();
    await upsertStripeSubscriptionRecord(supabase, subscription({}), A);
    expect(fake.rows("stripe_subscriptions")[0]).toMatchObject({ client_id: null, client_membership_id: null });
  });

  it("platform (legacy) events are unchanged by the check", async () => {
    const { fake, supabase } = db();
    await upsertStripeSubscriptionRecord(supabase, subscription({ clientId: "client-2", localMembershipId: "mem-2" }), null);
    expect(fake.rows("stripe_subscriptions")[0]).toMatchObject({ client_id: "client-2", stripe_account_id: null });
  });
});

describe("invoice.paid (connected)", () => {
  it("metadata path with a foreign membership -> throws, no stripe_subscriptions/payments/period write", async () => {
    const { fake, supabase } = db();
    await expect(
      handleInvoicePaid(supabase, stripeWith(subscription({ clientId: "client-1", localMembershipId: "mem-2" })), invoice, A),
    ).rejects.toThrow(MISMATCH);
    expect(fake.mutations).toHaveLength(0);
    expect(fake.rows("client_membership_periods")).toHaveLength(1);
    expect(fake.rows("client_membership_periods")[0].studio_id).toBe("studio-2");
  });

  it("stored-row path written before the fix with foreign references -> throws, 0 writes", async () => {
    const { fake, supabase } = db([
      {
        id: "ss-1",
        stripe_subscription_id: "sub_1",
        studio_id: "studio-1",
        client_id: "client-2",
        client_membership_id: "mem-2",
        stripe_account_id: A,
      },
    ]);
    await expect(handleInvoicePaid(supabase, stripeWith(subscription({})), invoice, A)).rejects.toThrow(MISMATCH);
    expect(fake.mutations).toHaveLength(0);
    expect(fake.rows("payments")).toHaveLength(0);
  });

  it("valid connected invoice still books the payment", async () => {
    const { fake, supabase } = db();
    // No period lines: the shared fake does not model upsert; the period write is covered by existing suites.
    const invoiceWithoutPeriod = { ...invoice, lines: { data: [] } } as unknown as Stripe.Invoice;
    await handleInvoicePaid(
      supabase,
      stripeWith(subscription({ clientId: "client-1", localMembershipId: "mem-1" })),
      invoiceWithoutPeriod,
      A,
    );
    expect(fake.rows("payments")[0]).toMatchObject({
      studio_id: "studio-1",
      client_id: "client-1",
      client_membership_id: "mem-1",
      stripe_account_id: A,
    });
    expect(fake.mutations.some((mutation) => mutation.table === "payments")).toBe(true);
  });
});
