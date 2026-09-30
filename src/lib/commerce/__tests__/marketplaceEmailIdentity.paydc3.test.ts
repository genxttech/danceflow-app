import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";

/** PAY-DC-3 (D-B / D-F): marketplace purchase email merchant identity and ordering. */

const queued = vi.hoisted(() => ({
  calls: [] as Array<{ params: Record<string, unknown>; ownerAtQueueTime: unknown }>,
  rows: null as null | (() => Row[]),
}));

vi.mock("@/lib/notifications/outbound", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/notifications/outbound")>();
  return {
    ...original,
    queueOutboundDelivery: async (params: Record<string, unknown>) => {
      queued.calls.push({
        params,
        ownerAtQueueTime: queued.rows?.()?.[0]?.stripe_account_id ?? null,
      });
      return { queued: true, skipped: false };
    },
  };
});

import { handleStudentMarketplacePaymentIntentSucceeded } from "@/app/api/payments/webhook/route";
import { finalizeStudentMarketplacePayment } from "@/lib/commerce/studentMarketplace";

const OWNER = "acct_1AcmeOwner";
const MADE_TO =
  "Your payment was made to Acme Dance. DanceFlow provides the software used to manage this transaction.";

function db(overrides: { orderMetadataAccount?: string; paymentOwner?: string | null; paymentStatus?: string; total?: number } = {}) {
  const fake = createOwnershipFakeSupabase({
    commerce_orders: [
      {
        id: "order-1",
        studio_id: "studio-1",
        client_id: "client-1",
        order_number: "ORD-1001",
        total: overrides.total ?? 49,
        currency: "usd",
        payment_status: overrides.paymentStatus ?? "paid",
        metadata: {
          stripe_connected_account_id: overrides.orderMetadataAccount ?? OWNER,
          stripe_payment_intent_id: "pi_m",
        },
      },
    ],
    commerce_order_items: [{ id: "item-1", order_id: "order-1", name_snapshot: "Technique Masterclass" }],
    studios: [{ id: "studio-1", name: "Acme Dance LLC", public_name: "Acme Dance", public_logo_url: null }],
    clients: [{ id: "client-1", studio_id: "studio-1", first_name: "Jamie", email: "jamie@example.com" }],
    payments: [
      {
        id: "pay-1",
        studio_id: "studio-1",
        commerce_order_id: "order-1",
        stripe_account_id: overrides.paymentOwner === undefined ? null : overrides.paymentOwner,
      },
    ],
  });
  queued.rows = () => fake.rows("payments");
  return { fake, supabase: fake.adminClient as unknown as SupabaseClient };
}

function intent() {
  return {
    id: "pi_m",
    amount: 4900,
    amount_received: 4900,
    currency: "usd",
    metadata: { source: "commerce_digital_marketplace", order_id: "order-1", studio_id: "studio-1" },
  } as unknown as Stripe.PaymentIntent;
}

beforeEach(() => {
  queued.calls = [];
  queued.rows = null;
});

describe("webhook ordering (D-B)", () => {
  it("stamps the trusted payment owner before queueing, and the email states the studio merchant", async () => {
    const { fake, supabase } = db();

    await expect(handleStudentMarketplacePaymentIntentSucceeded(supabase, intent(), OWNER)).resolves.toBe(true);

    expect(fake.rows("payments")[0].stripe_account_id).toBe(OWNER);
    expect(queued.calls).toHaveLength(1);
    expect(queued.calls[0].ownerAtQueueTime).toBe(OWNER);

    const params = queued.calls[0].params as { bodyText: string; bodyHtml: string; subject: string; dedupeKey: string };
    expect(params.bodyText).toContain(MADE_TO);
    expect(params.bodyHtml).toContain(MADE_TO);
    expect(params.subject).toBe("Your purchase from Acme Dance: Technique Masterclass");
    expect(params.dedupeKey).toBe("commerce_digital_purchase_confirmed:order-1");
    // No Stripe ids anywhere; GenX only via the canonical HTML legal footer, never in the body text.
    expect(`${params.bodyText}${params.bodyHtml}`).not.toMatch(/acct_|pi_m/);
    expect(params.bodyText).not.toContain("GenX");
  });
});

describe("fail-safe paths", () => {
  it("the student confirm path (no stamped owner) queues without a merchant line, ignoring order metadata", async () => {
    const { supabase } = db({ orderMetadataAccount: OWNER, paymentOwner: null });

    await finalizeStudentMarketplacePayment({
      supabase,
      orderId: "order-1",
      paymentIntentId: "pi_m",
      amount: 49,
      currency: "usd",
    });

    expect(queued.calls).toHaveLength(1);
    const params = queued.calls[0].params as { bodyText: string; subject: string };
    expect(params.bodyText).not.toContain("payment was made to");
    expect(params.subject).toBe("Your purchase from Acme Dance: Technique Masterclass");
  });

  it("queueConfirmation: false defers the email to the caller", async () => {
    const { supabase } = db();
    await finalizeStudentMarketplacePayment({
      supabase,
      orderId: "order-1",
      paymentIntentId: "pi_m",
      amount: 49,
      currency: "usd",
      queueConfirmation: false,
    });
    expect(queued.calls).toHaveLength(0);
  });

  it.each([
    ["unpaid order", { paymentOwner: OWNER, paymentStatus: "pending" }],
    ["zero total", { paymentOwner: OWNER, total: 0 }],
  ])("%s → no merchant line even with a stamped owner", async (_label, overrides) => {
    const { supabase } = db(overrides);
    await finalizeStudentMarketplacePayment({
      supabase,
      orderId: "order-1",
      paymentIntentId: "pi_m",
      amount: 49,
      currency: "usd",
    });
    expect((queued.calls[0].params as { bodyText: string }).bodyText).not.toContain("payment was made to");
  });
});
