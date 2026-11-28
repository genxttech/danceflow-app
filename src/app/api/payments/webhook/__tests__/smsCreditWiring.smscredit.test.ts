import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * The payments webhook hands prepaid SMS credit events to their own handler, after the event claim, and runs no other handler for them. Every
 * other event takes the same path as before. Signatures are real (Stripe test header); the database is a fake that records the RPC calls.
 */

const CONNECT_SECRET = "whsec_smscredit_connect_test";
const PLATFORM_SECRET = "whsec_smscredit_platform_test";
const realStripe = new Stripe("sk_test_smscredit_not_a_real_key");

let signatureHeader: string | null = null;
type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
let rpcResults: Record<string, unknown> = {};
let rpcErrors: Record<string, { code: string; message: string }> = {};

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({ webhooks: realStripe.webhooks, checkout: { sessions: { list: async () => ({ data: [] }) } } }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcErrors[fn] ? { data: null, error: rpcErrors[fn] } : { data: rpcResults[fn] ?? null, error: null };
    },
    from: (table: string) => {
      throw new Error(`unexpected table access in credit wiring test: ${table}`);
    },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");

type TestHeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

const ENTITY = "e9000000-0000-4000-8000-0000000000c1";
const STUDIO = "a9000000-0000-4000-8000-0000000000c2";

function event(type: string, object: Record<string, unknown>, account?: string) {
  return JSON.stringify({
    id: "evt_smscredit_wiring",
    object: "event",
    type,
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...(account ? { account } : {}),
  });
}

async function post(body: string, secret = PLATFORM_SECRET) {
  signatureHeader = realStripe.webhooks.generateTestHeaderString({ payload: body, secret } as TestHeaderOptions);
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const paidSession = {
  id: "cs_test_smscredit", object: "checkout.session", mode: "payment", currency: "usd", payment_status: "paid", amount_total: 2500,
  payment_intent: "pi_smscredit",
  metadata: { df_purpose: "sms_credit_topup", legal_entity_id: ENTITY, studio_id: STUDIO, pack_cents: "2500" },
};
const names = () => rpcCalls.map((call) => call.fn);

beforeEach(() => {
  rpcCalls.length = 0;
  rpcErrors = {};
  rpcResults = {
    claim_payment_provider_event: { outcome: "claimed" },
    complete_payment_provider_event: true,
    tw4_credit_topup_lookup: { legal_entity_id: ENTITY, paid_by_studio_id: STUDIO, amount_cents: 2500 },
  };
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("payments webhook: prepaid SMS credit events", () => {
  it("settles a paid credit purchase, runs no other handler and finalizes the claim as processed", async () => {
    expect((await post(event("checkout.session.completed", paidSession))).status).toBe(200);
    expect(names()).toEqual(["claim_payment_provider_event", "tw4_credit_topup_lookup", "tw4_credit_settle_topup", "complete_payment_provider_event"]);
    expect(rpcCalls[2].args).toMatchObject({ p_entity_id: ENTITY, p_paid_by_studio_id: STUDIO, p_amount_cents: 2500, p_payment_intent: "pi_smscredit" });
    expect(rpcCalls[3].args).toMatchObject({ p_status: "processed" });
  });

  it("a settlement failure answers 500 and finalizes the claim as failed, so the delivery is retried", async () => {
    rpcErrors = { tw4_credit_settle_topup: { code: "XX000", message: "synthetic failure" } };
    expect((await post(event("checkout.session.completed", paidSession))).status).toBe(500);
    expect(rpcCalls.at(-1)).toMatchObject({ fn: "complete_payment_provider_event", args: { p_status: "failed" } });
  });

  it("runs nothing before the claim is won", async () => {
    rpcResults.claim_payment_provider_event = { outcome: "already_processed" };
    expect((await post(event("checkout.session.completed", paidSession))).status).toBe(200);
    expect(names()).toEqual(["claim_payment_provider_event"]);
  });

  it("never treats a connected account's event as a credit purchase", async () => {
    await post(event("checkout.session.completed", paidSession, "acct_studio_1"), CONNECT_SECRET);
    expect(names().filter((fn) => fn.startsWith("tw4_credit"))).toEqual([]);
  });

  it("leaves an unrelated event on its old path", async () => {
    expect((await post(event("customer.created", { id: "cus_1", object: "customer" }))).status).toBe(200);
    expect(names()).toEqual(["claim_payment_provider_event", "complete_payment_provider_event"]);
  });
});
