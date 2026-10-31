import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * D24 M1: route wiring. Signatures are real Stripe test headers made with SYNTHETIC secrets; the database is a stateful
 * fake that mirrors claim_payment_provider_event / complete_payment_provider_event and records d24_apply_event calls
 * (the SQL itself is covered by scripts/qa/d24-m1-sql.sh). No network is allowed.
 */

const PLATFORM_SECRET = "whsec_d24_platform_synthetic";
const CONNECT_SECRET = "whsec_d24_connect_synthetic";
const realStripe = new Stripe("sk_test_d24_not_a_real_key");

let signatureHeader: string | null = null;
type EventRow = { status: string; owner: string | null; attempts: number; outcome: string | null };
const store = new Map<string, EventRow>();
const rpcLog: Array<{ fn: string; args: Record<string, unknown> }> = [];
const tableLog: string[] = [];
let applyError: { code: string } | null = null;
let applyResult: Record<string, unknown> = { outcome: "applied", matched: false };

function claim(args: Record<string, unknown>) {
  const id = String(args.p_provider_event_id);
  const owner = String(args.p_owner);
  let row = store.get(id);
  if (!row) store.set(id, (row = { status: "received", owner: null, attempts: 0, outcome: null }));
  if (row.status === "processed") return { outcome: "already_processed" };
  if (row.status === "processing" && row.owner !== owner) return { outcome: "in_progress" };
  row.status = "processing";
  row.owner = owner;
  row.attempts += 1;
  return { outcome: "claimed" };
}

function complete(args: Record<string, unknown>) {
  const row = store.get(String(args.p_provider_event_id));
  if (!row || row.status !== "processing" || row.owner !== String(args.p_owner)) return false;
  row.status = String(args.p_status);
  row.outcome = (args.p_outcome as string | null) ?? null;
  row.owner = null;
  return true;
}

vi.mock("next/headers", () => ({ headers: async () => ({ get: (n: string) => (n === "stripe-signature" ? signatureHeader : null) }) }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ webhooks: realStripe.webhooks }) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcLog.push({ fn, args });
      if (fn === "claim_payment_provider_event") return { data: claim(args), error: null };
      if (fn === "complete_payment_provider_event") return { data: complete(args), error: null };
      if (fn === "d24_apply_event") return applyError ? { data: null, error: applyError } : { data: applyResult, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      tableLog.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "neq", "order", "limit", "gte", "lte", "not", "or", "ilike"]) chain[m] = () => chain;
      chain.maybeSingle = chain.single = async () => ({ data: null, error: null });
      chain.insert = chain.update = chain.upsert = chain.delete = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");
type HeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

const invoiceObject = { id: "in_d24", object: "invoice", status: "void", total: 5000, amount_due: 5000, amount_paid: 0, amount_remaining: 5000, currency: "usd", customer_email: "pii@example.com" };
const paymentObject = { id: "inpay_d24", object: "invoice_payment", invoice: "in_d24", status: "paid", amount_requested: 5000, amount_paid: 5000, currency: "usd" };
const noteObject = { id: "cn_d24", object: "credit_note", invoice: "in_d24", status: "issued", total: 700, currency: "usd", type: "post_payment" };

const envelope = (id: string, type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, object: "event", type, api_version: "2026-03-25.dahlia", created: 1793403552, data: { object },
  livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, ...extra,
});
const header = (body: string, secret = PLATFORM_SECRET) => realStripe.webhooks.generateTestHeaderString({ payload: body, secret } as HeaderOptions);

async function send(body: string, secret = PLATFORM_SECRET, sig: string | null = header(body, secret)) {
  signatureHeader = sig;
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const applyCalls = () => rpcLog.filter((c) => c.fn === "d24_apply_event");

beforeEach(() => {
  store.clear();
  rpcLog.length = 0;
  tableLog.length = 0;
  applyError = null;
  applyResult = { outcome: "applied", matched: false };
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  process.env.STRIPE_SECRET_KEY = "sk_test_d24_not_a_real_key";
  delete process.env.D24_HOSTED_INVOICE_EVENTS;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is not allowed in D24 tests"); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.D24_HOSTED_INVOICE_EVENTS;
});

const CASES: Array<[string, Record<string, unknown>]> = [
  ["invoice.voided", invoiceObject],
  ["invoice.marked_uncollectible", { ...invoiceObject, status: "uncollectible" }],
  ["invoice_payment.paid", paymentObject],
  ["credit_note.created", noteObject],
  ["credit_note.updated", noteObject],
  ["credit_note.voided", { ...noteObject, status: "void" }],
];

describe("dark by default", () => {
  it.each(CASES)("%s is acknowledged with no D24 database call and no table access", async (type, object) => {
    const body = JSON.stringify(envelope(`evt_dark_${type}`, type, object));
    expect((await send(body)).status).toBe(200);
    expect(applyCalls()).toHaveLength(0);
    expect(tableLog).toHaveLength(0);
    expect(store.get(`evt_dark_${type}`)?.outcome).toBe("d24_disabled");
  });
});

describe("enabled", () => {
  beforeEach(() => { process.env.D24_HOSTED_INVOICE_EVENTS = "on"; });

  it.each(CASES)("%s calls d24_apply_event once with the claim owner and finalizes processed", async (type, object) => {
    const id = `evt_on_${type}`;
    expect((await send(JSON.stringify(envelope(id, type, object)))).status).toBe(200);
    expect(applyCalls()).toHaveLength(1);
    const call = applyCalls()[0].args;
    expect(call).toMatchObject({ p_provider_event_id: id, p_event_type: type, p_account: null, p_livemode: false });
    const claimCall = rpcLog.find((c) => c.fn === "claim_payment_provider_event")!;
    expect(call.p_owner).toBe(claimCall.args.p_owner);
    expect(store.get(id)?.status).toBe("processed");
    expect(store.get(id)?.outcome).toBe("d24_applied_unmatched");
    expect(JSON.stringify(call)).not.toContain("pii@example.com");
    expect(tableLog).toHaveLength(0);
  });

  it("a Connect-scope event passes its account and requires the Connect secret", async () => {
    const body = JSON.stringify(envelope("evt_connect", "invoice.voided", invoiceObject, { account: "acct_1Connect" }));
    expect((await send(body, CONNECT_SECRET)).status).toBe(200);
    expect(applyCalls()[0].args.p_account).toBe("acct_1Connect");
    const wrong = JSON.stringify(envelope("evt_connect2", "invoice.voided", invoiceObject, { account: "acct_1Connect" }));
    expect((await send(wrong, PLATFORM_SECRET)).status).toBe(400);
    expect(applyCalls()).toHaveLength(1);
  });

  it("a replay of a processed event is acknowledged without another apply", async () => {
    const body = JSON.stringify(envelope("evt_replay", "invoice_payment.paid", paymentObject));
    expect((await send(body)).status).toBe(200);
    expect((await send(body)).status).toBe(200);
    expect(applyCalls()).toHaveLength(1);
  });

  it("a different event id for the same invoice payment is handed to the database, which dedupes on the payment id", async () => {
    expect((await send(JSON.stringify(envelope("evt_pay_a", "invoice_payment.paid", paymentObject)))).status).toBe(200);
    expect((await send(JSON.stringify(envelope("evt_pay_b", "invoice_payment.paid", paymentObject)))).status).toBe(200);
    expect(applyCalls().map((c) => c.args.p_provider_event_id)).toEqual(["evt_pay_a", "evt_pay_b"]);
  });

  it("ten simultaneous deliveries of one event apply it exactly once", async () => {
    const body = JSON.stringify(envelope("evt_race", "invoice.voided", invoiceObject));
    const sig = header(body);
    const results = await Promise.all(Array.from({ length: 10 }, () => send(body, PLATFORM_SECRET, sig)));
    expect(results.filter((r) => r.status === 200).length + results.filter((r) => r.status === 409).length).toBe(10);
    expect(applyCalls()).toHaveLength(1);
  });

  it("a database failure finalizes the event as failed (500) and the retry re-applies it", async () => {
    const body = JSON.stringify(envelope("evt_retry", "invoice.voided", invoiceObject));
    applyError = { code: "55000" };
    expect((await send(body)).status).toBe(500);
    expect(store.get("evt_retry")?.status).toBe("failed");
    applyError = null;
    expect((await send(body)).status).toBe(200);
    expect(store.get("evt_retry")?.status).toBe("processed");
    expect(applyCalls()).toHaveLength(2);
  });

  it("a malformed object is acknowledged without a database call", async () => {
    const body = JSON.stringify(envelope("evt_bad", "invoice.voided", { id: "in_d24", status: "paid" }));
    expect((await send(body)).status).toBe(200);
    expect(applyCalls()).toHaveLength(0);
    expect(store.get("evt_bad")?.outcome).toBe("d24_malformed_ignored");
  });

  it("verification still comes first: tampered body, missing signature and live events on a test key never reach D24", async () => {
    const body = JSON.stringify(envelope("evt_sec", "invoice.voided", invoiceObject));
    expect((await send(body + " ", PLATFORM_SECRET, header(body))).status).toBe(400);
    expect((await send(body, PLATFORM_SECRET, null)).status).toBe(400);
    const live = JSON.stringify(envelope("evt_live", "invoice.voided", invoiceObject, { livemode: true }));
    expect((await send(live)).status).toBe(400);
    expect(applyCalls()).toHaveLength(0);
    expect(rpcLog.filter((c) => c.fn === "claim_payment_provider_event")).toHaveLength(0);
  });

  it("existing invoice.paid / invoice.payment_failed routing is untouched by the D24 cases", async () => {
    const body = JSON.stringify(envelope("evt_paid", "invoice.paid", { id: "in_other", object: "invoice", customer: "cus_x", status: "paid" }));
    await send(body);
    expect(applyCalls()).toHaveLength(0);
  });
});
