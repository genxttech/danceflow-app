import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * PAY-WH-1 (M1): every delivery takes one atomic, leased claim on its Stripe event before any handler runs, and only
 * the claim owner can finalize it. A processed event is acknowledged; a delivery racing a live claim is told to retry
 * (409); a lost lease never reports success; a failure is finalized as retryable by its owner.
 * Signatures are real (Stripe test header); the database is a fake that records the RPC calls.
 */

const CONNECT_SECRET = "whsec_paywh1_connect_test";
const PLATFORM_SECRET = "whsec_paywh1_platform_test";
const realStripe = new Stripe("sk_test_paywh1_not_a_real_key");

let signatureHeader: string | null = null;
type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
let rpcResults: Record<string, unknown> = {};

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    webhooks: realStripe.webhooks,
    checkout: { sessions: { list: async () => ({ data: [] }) } },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: rpcResults[fn] ?? null, error: null };
    },
    from: (table: string) => {
      throw new Error(`unexpected table access in claim test: ${table}`);
    },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");

type TestHeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

function event(type: string, object: Record<string, unknown>) {
  return JSON.stringify({
    id: "evt_paywh1_claim",
    object: "event",
    type,
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    account: "acct_studio_1",
  });
}

async function post(body: string) {
  signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: CONNECT_SECRET } as TestHeaderOptions);
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const unrelated = () => event("customer.created", { id: "cus_1", object: "customer" });
const cartPaymentFailed = () =>
  event("payment_intent.payment_failed", {
    id: "pi_1", object: "payment_intent", status: "requires_payment_method", amount: 3000, currency: "usd",
    metadata: { source: "event_cart_order", order_id: "metadata-order" }, last_payment_error: { code: "card_declined" },
  });

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResults = {};
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook event claims", () => {
  it("claims before any handler and finalizes as the same owner", async () => {
    rpcResults = { claim_payment_provider_event: { outcome: "claimed" }, complete_payment_provider_event: true };
    expect((await post(unrelated())).status).toBe(200);
    expect(rpcCalls.map((call) => call.fn)).toEqual(["claim_payment_provider_event", "complete_payment_provider_event"]);
    const owner = rpcCalls[0].args.p_owner;
    expect(owner).toEqual(expect.any(String));
    expect(rpcCalls[1].args).toMatchObject({ p_provider_event_id: "evt_paywh1_claim", p_owner: owner, p_status: "processed" });
  });

  it("an already processed event is acknowledged without running anything", async () => {
    rpcResults = { claim_payment_provider_event: { outcome: "already_processed" } };
    expect(await post(unrelated())).toEqual({ status: 200, text: "Already processed" });
    expect(rpcCalls.map((call) => call.fn)).toEqual(["claim_payment_provider_event"]);
  });

  it("a delivery racing a live claim is told to retry later (409) and runs nothing", async () => {
    rpcResults = { claim_payment_provider_event: { outcome: "in_progress" } };
    expect((await post(cartPaymentFailed())).status).toBe(409);
    expect(rpcCalls.map((call) => call.fn)).toEqual(["claim_payment_provider_event"]);
  });

  it("a lost lease never reports success", async () => {
    rpcResults = { claim_payment_provider_event: { outcome: "claimed" }, complete_payment_provider_event: false };
    expect((await post(unrelated())).status).toBe(500);
  });

  it("a handler failure is finalized by the owner as failed (retryable) with the integrity reason", async () => {
    rpcResults = {
      claim_payment_provider_event: { outcome: "claimed" },
      fail_event_cart_payment_attempt: { outcome: "mismatch:account" },
      complete_payment_provider_event: true,
    };
    expect((await post(cartPaymentFailed())).status).toBe(500);
    const owner = rpcCalls[0].args.p_owner;
    const fail = rpcCalls.find((call) => call.fn === "fail_event_cart_payment_attempt");
    expect(fail?.args).toMatchObject({ p_claim_owner: owner, p_stripe_event_id: "evt_paywh1_claim", p_final: false, p_stripe_account: "acct_studio_1" });
    expect(rpcCalls.at(-1)).toMatchObject({ fn: "complete_payment_provider_event", args: { p_owner: owner, p_status: "failed", p_error: "event_cart_mismatch_account" } });
  });
});
