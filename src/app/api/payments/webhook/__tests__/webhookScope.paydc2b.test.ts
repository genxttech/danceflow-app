import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * PAY-DC-2B: POST rejects an event whose verifying secret does not match its
 * scope with 400 before any Supabase work (no dedupe insert, no handler), and
 * lets correctly scoped platform and Connect events reach the dedupe step.
 */

const PLATFORM_SECRET = "whsec_paydc2b_platform_test";
const CONNECT_SECRET = "whsec_paydc2b_connect_test";
const realStripe = new Stripe("sk_test_paydc2b_not_a_real_key");

let signatureHeader: string | null = null;
const supabaseTables: string[] = [];

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => realStripe }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      supabaseTables.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        // Dedupe lookup: treat the event as already processed so no handler runs.
        maybeSingle: async () => ({ data: { id: "ppe-1", status: "processed" }, error: null }),
      };
      return chain;
    },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");

function payload(account?: string) {
  return JSON.stringify({
    id: "evt_paydc2b_post",
    object: "event",
    type: "invoice.paid",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "in_1", object: "invoice" } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...(account ? { account } : {}),
  });
}

type TestHeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

async function post(body: string, secret: string) {
  // Stripe fills timestamp/scheme/signature/cryptoProvider defaults at runtime.
  signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret } as TestHeaderOptions);
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  supabaseTables.length = 0;
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST webhook secret scope", () => {
  it("platform-signed event carrying event.account -> 400 before any Supabase call", async () => {
    const result = await post(payload("acct_studio_1"), PLATFORM_SECRET);
    expect(result).toEqual({ status: 400, text: "Invalid webhook scope." });
    expect(supabaseTables).toEqual([]);
  });

  it("Connect-signed event without event.account -> 400 before any Supabase call", async () => {
    const result = await post(payload(), CONNECT_SECRET);
    expect(result).toEqual({ status: 400, text: "Invalid webhook scope." });
    expect(supabaseTables).toEqual([]);
  });

  it("scope mismatch logs a fixed code only (no secret, header or body)", async () => {
    const errorSpy = vi.mocked(console.error);
    const body = payload("acct_studio_1");
    await post(body, PLATFORM_SECRET);
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("webhook_scope_mismatch");
    expect(logged).not.toContain(PLATFORM_SECRET);
    expect(logged).not.toContain(CONNECT_SECRET);
    expect(logged).not.toContain("evt_paydc2b_post");
  });

  it("valid platform and Connect events reach the dedupe step", async () => {
    expect((await post(payload(), PLATFORM_SECRET)).status).toBe(200);
    expect(supabaseTables).toEqual(["payment_provider_events"]);

    supabaseTables.length = 0;
    expect((await post(payload("acct_studio_1"), CONNECT_SECRET)).status).toBe(200);
    expect(supabaseTables).toEqual(["payment_provider_events"]);
  });

  it("invalid signature and missing configuration keep their existing responses", async () => {
    expect(await post(payload(), "whsec_wrong")).toEqual({ status: 400, text: "Invalid webhook signature." });

    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    expect((await post(payload(), PLATFORM_SECRET)).status).toBe(503);
    expect(supabaseTables).toEqual([]);
  });
});
