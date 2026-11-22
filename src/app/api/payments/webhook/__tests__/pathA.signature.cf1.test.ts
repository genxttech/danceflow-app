import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { verifyStripeWebhook } from "@/lib/payments/webhookVerification";
import { ACCOUNT_ID, checkoutEventBody } from "./helpers/pathAHarness";

/**
 * CF1 Path A, criterion 1 (offline): a delivery whose signature does not verify is rejected before ANY claim, Stripe read or
 * handler work. Signatures are produced with Stripe's own test-header generator; Stripe's API and the database are fakes
 * that fail the test if they are touched. This does NOT prove hosted Stripe Checkout payment completion.
 */

const PLATFORM_SECRET = "whsec_cf1patha_platform_test";
const CONNECT_SECRET = "whsec_cf1patha_connect_test";
const realStripe = new Stripe("sk_test_cf1patha_not_a_real_key");
type HeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

let signatureHeader: string | null = null;
const touched: string[] = [];

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    webhooks: realStripe.webhooks,
    checkout: { sessions: { retrieve: async () => { touched.push("stripe.retrieve"); throw new Error("must not be reached"); } } },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string) => { touched.push(`rpc:${fn}`); return { data: { outcome: "already_processed" }, error: null }; },
    from: (table: string) => { touched.push(`from:${table}`); throw new Error("must not be reached"); },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");

function sign(body: string, secret: string, timestampSeconds?: number) {
  return realStripe.webhooks.generateTestHeaderString({ payload: body, secret, ...(timestampSeconds ? { timestamp: timestampSeconds } : {}) } as HeaderOptions);
}

async function post(body: string, header: string | null) {
  signatureHeader = header;
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  touched.length = 0;
  signatureHeader = null;
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Path A: POST /api/payments/webhook rejects unverifiable deliveries before any work", () => {
  const body = checkoutEventBody();

  it("a missing Stripe-Signature header is rejected 400", async () => {
    expect(await post(body, null)).toEqual({ status: 400, text: "Invalid webhook request." });
    expect(touched).toEqual([]);
  });

  it("an empty Stripe-Signature header is rejected 400", async () => {
    expect(await post(body, "")).toEqual({ status: 400, text: "Invalid webhook request." });
    expect(touched).toEqual([]);
  });

  it("a malformed signature header is rejected 400", async () => {
    expect(await post(body, "not-a-stripe-signature")).toEqual({ status: 400, text: "Invalid webhook signature." });
    expect(touched).toEqual([]);
  });

  it("a signature made with the wrong secret is rejected 400", async () => {
    expect(await post(body, sign(body, "whsec_attacker_guess"))).toEqual({ status: 400, text: "Invalid webhook signature." });
    expect(touched).toEqual([]);
  });

  it("an old (expired) timestamp is rejected even though the signature is otherwise genuine", async () => {
    const stale = sign(body, CONNECT_SECRET, nowSeconds() - 60 * 60);
    expect(await post(body, stale)).toEqual({ status: 400, text: "Invalid webhook signature." });
    expect(touched).toEqual([]);
  });

  it("a timestamp inside the tolerance window is accepted (control: the old-timestamp rejection is not a blanket failure)", async () => {
    const fresh = sign(body, CONNECT_SECRET, nowSeconds() - 30);
    expect((await post(body, fresh)).status).toBe(200);
    expect(touched[0]).toBe("rpc:claim_payment_provider_event");
  });

  it("a genuine signature replayed over a different (tampered) body is rejected", async () => {
    const genuineHeader = sign(body, CONNECT_SECRET);
    const tampered = checkoutEventBody({ amount_total: 1 });
    expect(await post(tampered, genuineHeader)).toEqual({ status: 400, text: "Invalid webhook signature." });
    expect(touched).toEqual([]);
  });

  it("platform-signed payload that carries event.account is rejected as a scope mismatch before any claim", async () => {
    expect(await post(body, sign(body, PLATFORM_SECRET))).toEqual({ status: 400, text: "Invalid webhook scope." });
    expect(touched).toEqual([]);
  });

  it("Connect-signed payload without event.account is rejected as a scope mismatch before any claim", async () => {
    const noAccount = checkoutEventBody({}, { account: null });
    expect(await post(noAccount, sign(noAccount, CONNECT_SECRET))).toEqual({ status: 400, text: "Invalid webhook scope." });
    expect(touched).toEqual([]);
  });

  it("an empty-string event.account is treated as absent (Connect scope refuses it)", async () => {
    const empty = JSON.stringify({ ...JSON.parse(body), account: "" });
    expect(await post(empty, sign(empty, CONNECT_SECRET))).toEqual({ status: 400, text: "Invalid webhook scope." });
    expect(touched).toEqual([]);
  });

  it("with no secrets configured the route answers 503 and does nothing", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    expect((await post(body, sign(body, CONNECT_SECRET))).status).toBe(503);
    expect(touched).toEqual([]);
  });

  it("the correct Connect secret with event.account reaches the claim (control), and the claim is the first thing that happens", async () => {
    expect(JSON.parse(body).account).toBe(ACCOUNT_ID);
    expect((await post(body, sign(body, CONNECT_SECRET))).status).toBe(200);
    expect(touched[0]).toBe("rpc:claim_payment_provider_event");
  });
});

describe("Path A: verifyStripeWebhook timestamp tolerance", () => {
  const body = checkoutEventBody();
  const input = (signature: string) => ({ body, signature, platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET, stripe: realStripe });

  it("rejects a stale timestamp as invalid_signature", () => {
    const result = verifyStripeWebhook(input(sign(body, CONNECT_SECRET, nowSeconds() - 3600)));
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("accepts a current timestamp as connect scope", () => {
    const result = verifyStripeWebhook(input(sign(body, CONNECT_SECRET)));
    expect(result.ok && result.scope).toBe("connect");
  });
});
