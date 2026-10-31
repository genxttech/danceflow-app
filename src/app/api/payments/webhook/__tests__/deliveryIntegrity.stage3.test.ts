import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import history from "@/lib/payments/__tests__/fixtures/stage2-event-history.json";

/**
 * Stage 3 (WP1, WP2, WP3, WP6, WP7): local-only webhook delivery integrity.
 * Signatures are real Stripe test headers made with SYNTHETIC secrets. The database is a stateful fake that mirrors the
 * claim_payment_provider_event / complete_payment_provider_event semantics of migration 20261116090000 (the SQL itself
 * is exercised separately against a disposable Postgres by scripts/qa/stage3-claim-sql.sh). No network is allowed.
 */

const PLATFORM_SECRET = "whsec_stage3_platform_synthetic";
const CONNECT_SECRET = "whsec_stage3_connect_synthetic";
const realStripe = new Stripe("sk_test_stage3_not_a_real_key");

let signatureHeader: string | null = null;
let now = 1_800_000_000_000; // virtual clock for lease expiry

type EventRow = { status: "received" | "processing" | "processed" | "failed"; owner: string | null; expires: number | null; attempts: number; error: string | null };
const store = new Map<string, EventRow>();
const rpcLog: Array<{ fn: string; args: Record<string, unknown> }> = [];
const tableLog: string[] = [];
let failTables = false;
let onFrom: (() => void) | null = null;

function claim(args: Record<string, unknown>) {
  const id = String(args.p_provider_event_id);
  const owner = String(args.p_owner);
  const lease = Math.min(Math.max(Number(args.p_lease_seconds ?? 120), 15), 900);
  let row = store.get(id);
  if (!row) {
    row = { status: "received", owner: null, expires: null, attempts: 0, error: null };
    store.set(id, row);
  }
  if (row.status === "processed") return { outcome: "already_processed", attempt_count: row.attempts };
  if (row.status === "processing" && row.expires! > now && row.owner !== owner) return { outcome: "in_progress", attempt_count: row.attempts };
  row.status = "processing";
  row.owner = owner;
  row.expires = now + lease * 1000;
  row.attempts += 1;
  return { outcome: "claimed", attempt_count: row.attempts };
}

function complete(args: Record<string, unknown>) {
  const row = store.get(String(args.p_provider_event_id));
  if (!row || row.status !== "processing" || row.owner !== String(args.p_owner)) return false;
  row.status = args.p_status as EventRow["status"];
  row.error = args.p_status === "failed" ? String(args.p_error ?? "failed") : null;
  row.owner = null;
  row.expires = null;
  return true;
}

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({ webhooks: realStripe.webhooks }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcLog.push({ fn, args });
      if (fn === "claim_payment_provider_event") return { data: claim(args), error: null };
      if (fn === "complete_payment_provider_event") return { data: complete(args), error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      tableLog.push(table);
      onFrom?.();
      if (failTables) throw new Error("database unavailable");
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "neq", "order", "limit", "gte", "lte", "not", "or", "ilike"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.single = async () => ({ data: null, error: null });
      chain.insert = chain.update = chain.upsert = chain.delete = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

const { POST } = await import("@/app/api/payments/webhook/route");

type TestHeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

type Row = [string, string, number, string];
const rows = history as Row[];

function envelope(id: string, type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id, object: "event", type, api_version: "2026-03-25.dahlia", created: 1793403552, data: { object },
    livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, ...extra,
  };
}

function header(body: string, secret = PLATFORM_SECRET, timestamp?: number) {
  return realStripe.webhooks.generateTestHeaderString({ payload: body, secret, ...(timestamp ? { timestamp } : {}) } as TestHeaderOptions);
}

async function send(body: string, sig: string | null) {
  signatureHeader = sig;
  const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body }));
  return { status: response.status, text: await response.text() };
}

const sendSigned = (body: string, secret = PLATFORM_SECRET) => send(body, header(body, secret));

/** An event of a type the handler does not act on (Stage 2 invoice events other than invoice.paid / payment_failed). */
const quiet = (id: string, type = "invoice_payment.paid") =>
  JSON.stringify(envelope(id, type, { id: "inpay_stage3", object: "invoice_payment", status: "paid", amount_paid: 187575 }));

beforeEach(() => {
  store.clear();
  rpcLog.length = 0;
  tableLog.length = 0;
  failTables = false;
  onFrom = null;
  now = 1_800_000_000_000;
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is not allowed in Stage 3 local tests"); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const claimCalls = () => rpcLog.filter((c) => c.fn === "claim_payment_provider_event").length;

describe("WP1 signature verification and raw-body integrity", () => {
  it("accepts a correctly signed delivery and finalizes it as processed", async () => {
    expect(await sendSigned(quiet("evt_s3_ok"))).toEqual({ status: 200, text: "Webhook processed." });
    expect(store.get("evt_s3_ok")?.status).toBe("processed");
  });

  it("rejects a tampered body before any database work", async () => {
    const body = quiet("evt_s3_tamper");
    const sig = header(body);
    expect(await send(body.replace("187575", "100"), sig)).toEqual({ status: 400, text: "Invalid webhook signature." });
    expect(rpcLog).toEqual([]);
  });

  it("rejects a semantically identical but re-serialized body (the raw bytes must be what was signed)", async () => {
    const body = quiet("evt_s3_reserialize");
    const sig = header(body);
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(pretty).not.toBe(body);
    expect((await send(pretty, sig)).status).toBe(400);
    expect(rpcLog).toEqual([]);
  });

  it("rejects a trailing byte added after signing; a leading UTF-8 BOM is removed by Request.text() before verification (platform decoding, Stripe never sends one)", async () => {
    const body = quiet("evt_s3_bytes");
    const sig = header(body);
    expect((await send(body + "\n", sig)).status).toBe(400);
    expect((await send(" " + body, sig)).status).toBe(400);
    expect(rpcLog).toEqual([]);
    expect((await send(String.fromCharCode(0xfeff) + body, sig)).status).toBe(200);
  });

  it("rejects a stale signature timestamp (older than the 5 minute tolerance) and accepts a fresh one", async () => {
    const body = quiet("evt_s3_time");
    const t = Math.floor(Date.now() / 1000);
    expect((await send(body, header(body, PLATFORM_SECRET, t - 301 - 60))).status).toBe(400);
    expect(rpcLog).toEqual([]);
    expect((await send(body, header(body, PLATFORM_SECRET, t - 30))).status).toBe(200);
  });

  it("FINDING F-4: stripe-node only rejects OLD timestamps; a correctly signed header dated far in the future is accepted (event-id dedupe still stops replays)", async () => {
    const body = quiet("evt_s3_future");
    const t = Math.floor(Date.now() / 1000);
    expect((await send(body, header(body, PLATFORM_SECRET, t + 3600))).status).toBe(200);
    expect((await send(body, header(body, PLATFORM_SECRET, t + 3600))).text).toBe("Already processed");
  });

  it("rejects a valid signature made with the wrong secret, and accepts rotation (old + new v1 in one header)", async () => {
    const body = quiet("evt_s3_rotate");
    expect(await sendSigned(body, "whsec_someone_else")).toEqual({ status: 400, text: "Invalid webhook signature." });
    const t = Math.floor(Date.now() / 1000);
    const good = header(body, PLATFORM_SECRET, t);
    const bad = header(body, "whsec_old_rolled_secret", t);
    const merged = `t=${t},${bad.split(",").find((p) => p.startsWith("v1="))},${good.split(",").find((p) => p.startsWith("v1="))}`;
    expect((await send(body, merged)).status).toBe(200);
  });

  it.each([["empty", ""], ["garbage", "not-a-signature"], ["no v1", "t=1700000000"], ["truncated", "t=1700000000,v1=abc"], ["v0 only", "t=1700000000,v0=00"]])(
    "rejects a malformed signature header (%s)",
    async (_name, sig) => {
      expect((await send(quiet("evt_s3_hdr"), sig)).status).toBe(400);
      expect(rpcLog).toEqual([]);
    },
  );

  it("rejects a missing signature header and answers 503 when no secret is configured", async () => {
    expect((await send(quiet("evt_s3_nosig"), null)).status).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    expect((await sendSigned(quiet("evt_s3_nosecret"))).status).toBe(503);
    expect(rpcLog).toEqual([]);
  });

  it("never logs the secret, the signature header or the body when verification fails", async () => {
    const body = quiet("evt_s3_logs");
    const sig = header(body, "whsec_attacker");
    await send(body, sig);
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(" ");
    for (const secret of [PLATFORM_SECRET, CONNECT_SECRET, "whsec_attacker", sig, "evt_s3_logs", "187575"]) expect(logged).not.toContain(secret);
  });
});

describe("WP2 replay and idempotency (event id)", () => {
  it("a replay of a processed event is acknowledged without being processed again", async () => {
    const body = quiet("evt_s3_replay");
    expect((await sendSigned(body)).text).toBe("Webhook processed.");
    for (let i = 0; i < 5; i++) expect(await sendSigned(body)).toEqual({ status: 200, text: "Already processed" });
    expect(rpcLog.filter((c) => c.fn === "complete_payment_provider_event")).toHaveLength(1);
    expect(store.get("evt_s3_replay")?.attempts).toBe(1);
  });

  it("two simultaneous deliveries: one claims, the other is told to retry (409); the retry then sees it processed", async () => {
    const body = quiet("evt_s3_race");
    const [a, b] = await Promise.all([sendSigned(body), sendSigned(body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await sendSigned(body)).text).toBe("Already processed");
    expect(store.get("evt_s3_race")?.attempts).toBe(1);
  });

  it("ten simultaneous deliveries still produce exactly one claim and one completion", async () => {
    const body = quiet("evt_s3_race10");
    const results = await Promise.all(Array.from({ length: 10 }, () => sendSigned(body)));
    expect(results.filter((r) => r.status === 200 && r.text === "Webhook processed.")).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(rpcLog.filter((c) => c.fn === "complete_payment_provider_event")).toHaveLength(1);
  });

  it("an abandoned claim blocks until its lease expires, then a later delivery takes it over", async () => {
    store.set("evt_s3_lease", { status: "processing", owner: "crashed-worker", expires: now + 60_000, attempts: 1, error: null });
    expect((await sendSigned(quiet("evt_s3_lease"))).status).toBe(409);
    now += 61_000;
    expect((await sendSigned(quiet("evt_s3_lease"))).status).toBe(200);
    expect(store.get("evt_s3_lease")).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("a worker whose lease was taken over mid-processing cannot finalize, never reports success and leaves the new owner's claim intact", async () => {
    const body = JSON.stringify(envelope("evt_s3_lost", "invoice.paid", { id: "in_oneoff", object: "invoice", customer: "cus_1", subscription: null, payment_intent: "pi_1" }));
    onFrom = () => {
      onFrom = null;
      store.set("evt_s3_lost", { status: "processing", owner: "worker-b", expires: now + 120_000, attempts: 2, error: null });
    };
    expect((await sendSigned(body)).status).toBe(500);
    expect(store.get("evt_s3_lost")).toMatchObject({ status: "processing", owner: "worker-b", attempts: 2 });
  });
});

describe("WP3 duplicate invoice_payment.paid deliveries (recorded sandbox pairs)", () => {
  const pairs = Object.values(
    rows.reduce<Record<string, Row[]>>((acc, r) => {
      if (r[1] === "invoice_payment.paid") (acc[r[3]] ??= []).push(r);
      return acc;
    }, {}),
  ).filter((g) => g.length > 1);

  it("the recorded duplicates carry different event ids for the same invoice payment, so event-id dedupe alone does not collapse them", () => {
    expect(pairs).toHaveLength(2);
    for (const g of pairs) expect(new Set(g.map((r) => r[0])).size).toBe(g.length);
  });

  it("both events are acknowledged (200), each claimed exactly once, with no database table access and no side effects", async () => {
    for (const g of pairs) {
      for (const [id, , , ref] of g) {
        const inpay = ref.split(":")[1];
        const body = JSON.stringify(envelope(id, "invoice_payment.paid", { id: inpay, object: "invoice_payment", status: "paid", amount_paid: 187575 }));
        expect((await sendSigned(body)).status).toBe(200);
        expect((await sendSigned(body)).text).toBe("Already processed");
      }
    }
    expect(tableLog).toEqual([]);
    expect(claimCalls()).toBe(pairs.flat().length * 2);
    expect([...store.values()].every((r) => r.status === "processed" && r.attempts === 1)).toBe(true);
  });

  it("every Stage 2 event type the handler does not act on is acknowledged with no table access", async () => {
    const ignored = ["invoice_payment.paid", "invoice.voided", "invoice.marked_uncollectible", "invoice.finalized", "invoice.created", "invoice.updated",
      "credit_note.created", "customer.updated", "balance.available", "payment_intent.created", "charge.pending", "setup_intent.succeeded", "mandate.updated"];
    for (const type of ignored) {
      const sample = rows.find((r) => r[1] === type)!;
      const body = JSON.stringify(envelope(sample[0], type, { id: sample[3].split(":")[1] || "x", object: sample[3].split(":")[0] }));
      expect(await sendSigned(body)).toEqual({ status: 200, text: "Webhook processed." });
    }
    expect(tableLog).toEqual([]);
  });
});

describe("WP6 failure handling, replay and recovery", () => {
  const paid = () =>
    JSON.stringify(envelope("evt_s3_fail", "invoice.paid", { id: "in_oneoff", object: "invoice", customer: "cus_1", subscription: null, payment_intent: "pi_1" }));

  it("a handler failure is finalized as failed (retryable) with a bounded message, and the same event recovers on replay", async () => {
    failTables = true;
    expect((await sendSigned(paid())).status).toBe(500);
    expect(store.get("evt_s3_fail")).toMatchObject({ status: "failed", attempts: 1 });
    expect(store.get("evt_s3_fail")?.error).toBeTruthy();

    failTables = false;
    const second = await sendSigned(paid());
    expect(store.get("evt_s3_fail")?.attempts).toBe(2);
    expect([200, 500]).toContain(second.status); // recovery path reached; outcome depends on handler data, not on dedupe
    expect(second.text).not.toBe("Already processed");
  });

  it("a failed event is never reported as processed and keeps being retried (no dead-letter limit in the route: FINDING F-3)", async () => {
    failTables = true;
    for (let i = 1; i <= 6; i++) {
      expect((await sendSigned(paid())).status).toBe(500);
      expect(store.get("evt_s3_fail")).toMatchObject({ status: "failed", attempts: i });
    }
  });

  it("while a failed event waits for retry, other events are unaffected", async () => {
    failTables = true;
    await sendSigned(paid());
    failTables = false;
    expect(await sendSigned(quiet("evt_s3_other"))).toEqual({ status: 200, text: "Webhook processed." });
  });
});

describe("WP7 environment isolation", () => {
  it("uses only synthetic local secrets and never touches the network", async () => {
    expect(PLATFORM_SECRET.startsWith("whsec_stage3_")).toBe(true);
    expect(CONNECT_SECRET.startsWith("whsec_stage3_")).toBe(true);
    await sendSigned(quiet("evt_s3_iso"));
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("FINDING F-1: a validly signed livemode:true event is accepted by the route today (no livemode guard); this test pins the current behaviour so a future guard must flip it deliberately", async () => {
    const body = JSON.stringify(envelope("evt_s3_live", "invoice_payment.paid", { id: "inpay_live", object: "invoice_payment" }, { livemode: true }));
    expect(await sendSigned(body)).toEqual({ status: 200, text: "Webhook processed." });
  });

  it("scope separation still holds: platform-signed event with an account and Connect-signed event without one are rejected", async () => {
    const withAccount = JSON.stringify(envelope("evt_s3_scope1", "invoice_payment.paid", { id: "x", object: "invoice_payment" }, { account: "acct_studio" }));
    expect((await sendSigned(withAccount, PLATFORM_SECRET)).status).toBe(400);
    expect((await sendSigned(quiet("evt_s3_scope2"), CONNECT_SECRET)).status).toBe(400);
    expect(rpcLog).toEqual([]);
  });
});
