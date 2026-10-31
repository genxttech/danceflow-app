import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { livemodeMismatch } from "@/lib/payments/webhookVerification";

/**
 * Stage 3 (F-1): live-mode events are refused, before any database work, when the deployment is configured with a
 * Stripe TEST key. Everything else is unchanged.
 */

const PLATFORM_SECRET = "whsec_stage3guard_platform_synthetic";
const realStripe = new Stripe("sk_test_stage3guard_not_a_real_key");

let signatureHeader: string | null = null;
const rpcCalls: string[] = [];

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ webhooks: realStripe.webhooks }) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      if (fn === "claim_payment_provider_event") return { data: { outcome: "claimed" }, error: null };
      if (fn === "complete_payment_provider_event") return { data: true, error: null };
      return { data: null, error: null };
    },
    from: () => {
      throw new Error("unexpected table access");
    },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");

type TestHeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

function body(livemode: boolean) {
  return JSON.stringify({
    id: "evt_stage3guard", object: "event", type: "invoice_payment.paid", api_version: "2026-03-25.dahlia", created: 1793403552,
    data: { object: { id: "inpay_1", object: "invoice_payment" } }, livemode, pending_webhooks: 1, request: { id: null, idempotency_key: null },
  });
}

async function post(livemode: boolean) {
  const payload = body(livemode);
  signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload, secret: PLATFORM_SECRET } as TestHeaderOptions);
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body: payload }));
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  rpcCalls.length = 0;
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  vi.restoreAllMocks();
});

describe("livemodeMismatch", () => {
  it.each([
    [true, "sk_test_abc", true],
    [true, "rk_test_abc", true],
    [true, "  sk_test_abc  ", true],
    [true, "sk_live_abc", false],
    [true, "rk_live_abc", false],
    [true, "", false],
    [true, undefined, false],
    [true, null, false],
    [true, "pk_test_abc", false],
    [false, "sk_test_abc", false],
    [false, "sk_live_abc", false],
  ] as const)("livemode=%s key=%s -> %s", (livemode, key, expected) => {
    expect(livemodeMismatch({ livemode }, key)).toBe(expected);
  });
});

describe("POST webhook live-mode guard", () => {
  it("test key + live event: 400 before any claim, and nothing sensitive is logged", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_stage3guard_configured";
    expect(await post(true)).toEqual({ status: 400, text: "Invalid webhook environment." });
    expect(rpcCalls).toEqual([]);
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("webhook_livemode_mismatch");
    for (const secret of ["sk_test_stage3guard_configured", PLATFORM_SECRET, "evt_stage3guard"]) expect(logged).not.toContain(secret);
  });

  it("test key + test event is processed as before", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_stage3guard_configured";
    expect(await post(false)).toEqual({ status: 200, text: "Webhook processed." });
    expect(rpcCalls).toEqual(["claim_payment_provider_event", "complete_payment_provider_event"]);
  });

  it("live key + live event is processed as before", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_stage3guard_configured";
    expect((await post(true)).status).toBe(200);
  });

  it("no key configured: the guard blocks nothing", async () => {
    expect((await post(true)).status).toBe(200);
  });
});
