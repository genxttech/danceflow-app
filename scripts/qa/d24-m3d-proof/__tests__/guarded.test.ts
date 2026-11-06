import { describe, expect, it, vi } from "vitest";
import { cleanup } from "../cleanup";
import { createFakeTransport } from "../fakeTransport";
import { STRIPE_API_VERSION } from "../config";
import { createGuardedClient, pinned } from "../guarded";
import { redactText } from "../redact";
import { createFetchTransport } from "../transport";
import type { ProofRequest, Transport } from "../types";

const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const KEY = "d24proof-t1-";
const mk = (opts: Partial<Parameters<typeof createGuardedClient>[0]> = {}, fake: Parameters<typeof createFakeTransport>[0] = { platformId: PLATFORM, connectedId: CONNECTED }) => {
  const f = createFakeTransport(fake);
  const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0, ...opts });
  client.markIdentityVerified(); // these tests exercise the other guards; the identity-first rule has its own tests (cannotRunLive.test.ts)
  return { f, client };
};
const cust = (n: string): ProofRequest => ({ method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: `${KEY}${n}`, body: { name: `proof ${n}` } });
const draft = (cus: string, n: string): ProofRequest => ({
  method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: `${KEY}${n}`,
  body: { customer: cus, collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" },
});

describe("guarded client: blocked requests never reach the transport", () => {
  it("finalize / send / pay / void / mark_uncollectible: transport is never called, the run aborts", async () => {
    for (const verb of ["finalize", "send", "pay", "void", "mark_uncollectible"]) {
      const spy = vi.fn<Transport>();
      const client = createGuardedClient({ transport: spy, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
      await expect(pinned(client, { method: "POST", path: `/v1/invoices/in_ABC123/${verb}`, stripeAccount: CONNECTED, idempotencyKey: `${KEY}x`, body: {} })).rejects.toMatchObject({ code: "blocked_request" });
      expect(spy).not.toHaveBeenCalled();
      expect(client.stats()).toMatchObject({ used: 0, blocked: 1 });
      expect(client.transcript[0].status).toBe("BLOCKED");
    }
  });
  it("after a blocked request every further call is refused too (no half-continuing run)", async () => {
    const { f, client } = mk();
    await expect(pinned(client, { method: "GET", path: "/v1/balance", stripeAccount: CONNECTED })).rejects.toMatchObject({ code: "blocked_request" });
    await expect(pinned(client, { method: "GET", path: "/v1/account" })).rejects.toMatchObject({ code: "blocked_request" });
    expect(f.calls).toHaveLength(0);
  });
  it("the real fetch transport is never reached by a blocked request (fetch spy)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const client = createGuardedClient({ transport: createFetchTransport(fetchSpy as unknown as typeof fetch), apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(pinned(client, { method: "POST", path: "/v1/invoices/in_ABC123/finalize", stripeAccount: CONNECTED, idempotencyKey: `${KEY}y`, body: {} })).rejects.toBeTruthy();
    await expect(createGuardedClient({ transport: createFetchTransport(fetchSpy as unknown as typeof fetch), apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 }).call({ method: "POST", path: "/v1/refunds", stripeAccount: CONNECTED, idempotencyKey: `${KEY}z`, body: { charge: "ch_1" } })).rejects.toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("an allowed request does reach the fetch transport, to api.stripe.com only, with the pinned headers", async () => {
    const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: PLATFORM, object: "account" }), { status: 200, headers: { "stripe-version": STRIPE_API_VERSION } }));
    const client = createGuardedClient({ transport: createFetchTransport(fetchSpy as unknown as typeof fetch), apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await pinned(client, { method: "GET", path: "/v1/account" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/account");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer rk_test_FAKEFAKE");
    expect(init.redirect).toBe("error");
  });
  it("DELETE of an invoice is refused unless it was observed as a draft", async () => {
    const { f, client } = mk();
    await expect(pinned(client, { method: "DELETE", path: "/v1/invoices/in_NEVERSEEN1", stripeAccount: CONNECTED }, { phase: "cleanup" })).rejects.toMatchObject({ code: "blocked_request" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("guarded client: hard cap of 40 calls", () => {
  it("never sends more than 40 requests and holds 8 back for cleanup", async () => {
    const { f, client } = mk();
    let sent = 0;
    for (let i = 0; i < 60; i++) {
      try {
        await pinned(client, { method: "GET", path: "/v1/account" });
        sent++;
      } catch (e) {
        expect((e as { code: string }).code).toBe("budget_exceeded");
        break;
      }
    }
    expect(sent).toBe(32);
    expect(f.calls).toHaveLength(32);
  });
  it("cleanup may use the reserve but the absolute cap is 40, even if a larger budget is requested", async () => {
    const { f, client } = mk({ budget: 500 });
    let sent = 0;
    for (let i = 0; i < 60; i++) {
      try {
        await pinned(client, { method: "GET", path: "/v1/account" }, { phase: "cleanup", expectStatus: [200] });
        sent++;
      } catch (e) {
        expect((e as { code: string }).code).toBe("budget_exceeded");
        break;
      }
    }
    expect(sent).toBe(40);
    expect(f.calls).toHaveLength(40);
  });
  it("parallel callers cannot overshoot the cap", async () => {
    const { f, client } = mk();
    const r = await Promise.allSettled(Array.from({ length: 50 }, () => pinned(client, { method: "GET", path: "/v1/account" })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(32);
    expect(f.calls.length).toBeLessThanOrEqual(32);
  });
});

describe("guarded client: response guards", () => {
  it("aborts on livemode:true from a create", async () => {
    const { client } = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, livemodeOnInvoices: true });
    const c = await pinned(client, cust("a"));
    await expect(pinned(client, draft(String(c.json?.id), "b"))).rejects.toMatchObject({ code: "livemode_true" });
  });
  it("aborts on a non-draft invoice and cleanup then stops without deleting", async () => {
    const { f, client } = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, invoiceStatusAfterCreate: "open" });
    const c = await pinned(client, cust("a"));
    await expect(pinned(client, draft(String(c.json?.id), "b"))).rejects.toMatchObject({ code: "non_draft_invoice" });
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.stoppedBecause).toMatch(/non-draft/);
    expect(f.calls.some((x) => x.method === "DELETE")).toBe(false);
  });
  it("aborts on any 429, on a 5xx streak of three, and on two consecutive unexpected 4xx", async () => {
    const t429 = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, failWith: { status: 429, times: 1 } });
    await expect(pinned(t429.client, { method: "GET", path: "/v1/account" })).rejects.toMatchObject({ code: "rate_limited" });
    const t5 = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, failWith: { status: 503, times: 5 } });
    await pinned(t5.client, { method: "GET", path: "/v1/account" }, { expectStatus: [200, 503] });
    await pinned(t5.client, { method: "GET", path: "/v1/account" }, { expectStatus: [200, 503] });
    await expect(pinned(t5.client, { method: "GET", path: "/v1/account" }, { expectStatus: [200, 503] })).rejects.toMatchObject({ code: "server_error_streak" });
    const t4 = mk({}, { platformId: PLATFORM, connectedId: CONNECTED });
    await pinned(t4.client, { method: "GET", path: "/v1/transfers", stripeAccount: CONNECTED, query: { limit: "1" } }).catch(() => undefined);
    await expect(pinned(t4.client, { method: "GET", path: "/v1/webhook_endpoints", stripeAccount: CONNECTED })).rejects.toMatchObject({ code: "unexpected_4xx_streak" });
  });
  it("expected 403s (S10) do not abort", async () => {
    const { client } = mk();
    const r = await pinned(client, { method: "GET", path: "/v1/transfers", stripeAccount: CONNECTED, query: { limit: "1" } }, { expectStatus: [403] });
    expect(r.status).toBe(403);
    expect(client.aborted()).toBeNull();
  });
});

describe("cleanup", () => {
  it("deletes drafts then customers, verifies empty lists, and leaves nothing", async () => {
    const { f, client } = mk();
    const c = await pinned(client, cust("a"));
    const cus = String(c.json?.id);
    await pinned(client, draft(cus, "b"));
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep).toMatchObject({ verifiedEmpty: true, skipped: null, stoppedBecause: null });
    expect(rep.deletedInvoices).toHaveLength(1);
    expect(rep.deletedCustomers).toEqual([cus]);
    expect(f.state.invoices.size + f.state.customers.size).toBe(0);
  });
  it("makes NO call after a livemode abort and prints ids for manual cleanup", async () => {
    const { f, client } = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, livemodeOnInvoices: true });
    const c = await pinned(client, cust("a"));
    await pinned(client, draft(String(c.json?.id), "b")).catch(() => undefined);
    const before = f.calls.length;
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.skipped).toMatch(/NOT run/);
    expect(f.calls.length).toBe(before);
    expect(rep.remainingCustomers).toEqual([String(c.json?.id)]);
  });
});

describe("review hardening", () => {
  it("nonsense budget / reserve values can never lift the cap of 40", async () => {
    for (const o of [{ cleanupReserve: -10 }, { cleanupReserve: Number.NaN }, { budget: Number.NaN }, { budget: Infinity }, { budget: 41, cleanupReserve: 0 }, { budget: -3 }]) {
      const { f, client } = mk(o);
      for (let i = 0; i < 60; i++) await pinned(client, { method: "GET", path: "/v1/account" }, { phase: "cleanup" }).catch(() => undefined);
      expect(f.calls.length, JSON.stringify(o)).toBeLessThanOrEqual(40);
    }
  });
  it("a request mutated after the caller handed it over is not what gets sent", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 5, sleep: async () => undefined });
    const req: ProofRequest = { method: "GET", path: "/v1/account", stripeVersion: STRIPE_API_VERSION };
    const p = client.call(req);
    req.path = "/v1/invoices/in_ABC123/finalize"; // mutation after the call started
    await p;
    expect(f.calls.map((c) => c.path)).toEqual(["/v1/account"]);
  });
  it("redacts keys glued to word characters and detects them in the environment scan", () => {
    expect(redactText("xrk_test_ABC123 foo_sk_live_ZZZ9")).not.toMatch(/ABC123|ZZZ9/);
  });
  it("a lost create response is remembered and cleanup never reports 'empty'", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    let n = 0;
    const lossy: Transport = async (r, k) => {
      const res = await f.transport(r, k);
      if (r.method === "POST" && ++n === 1) throw new Error("socket hang up");
      return res;
    };
    const client = createGuardedClient({ transport: lossy, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    client.markIdentityVerified();
    await expect(pinned(client, cust("lost"))).rejects.toThrow(/socket/);
    expect(client.uncertain).toHaveLength(1);
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.verifiedEmpty).toBe(false);
    expect(rep.stoppedBecause).toMatch(/lost/);
  });
  it("an operator interrupt stops further calls but cleanup still runs", async () => {
    let stop = false;
    const { f, client } = mk({ shouldStop: () => stop });
    const c = await pinned(client, cust("a"));
    await pinned(client, draft(String(c.json?.id), "b"));
    stop = true;
    await expect(pinned(client, { method: "GET", path: "/v1/account" })).rejects.toMatchObject({ code: "interrupted" });
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.verifiedEmpty).toBe(true);
    expect(f.state.invoices.size + f.state.customers.size).toBe(0);
  });
});

describe("redaction", () => {
  it("removes keys, webhook secrets, bearer tokens and emails", () => {
    const s = redactText("key rk_test_ABC123 sk_live_ZZZ whsec_QQQ Bearer abc.def-ghi mail jo@example.com Authorization: Bearer tok");
    for (const secret of ["rk_test_ABC123", "sk_live_ZZZ", "whsec_QQQ", "abc.def-ghi", "jo@example.com", "tok"]) expect(s).not.toContain(secret);
  });
  it("the transcript never holds the key, the full idempotency key or a response body", async () => {
    const { client } = mk();
    await pinned(client, cust("long-idempotency-key-for-redaction-check"));
    const t = JSON.stringify(client.transcript);
    expect(t).not.toContain("rk_test_FAKEFAKE");
    expect(t).not.toContain("long-idempotency-key-for-redaction-check");
    expect(client.transcript[0].summary).not.toHaveProperty("name");
  });
});
