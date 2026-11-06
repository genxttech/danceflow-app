import { describe, expect, it, vi } from "vitest";
import { cleanup } from "../cleanup";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient } from "../guarded";
import { redactText } from "../redact";
import { createFetchTransport } from "../transport";
import type { ProofRequest, Transport } from "../types";

const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const KEY = "d24proof-t1-";
const mk = (opts: Partial<Parameters<typeof createGuardedClient>[0]> = {}, fake: Parameters<typeof createFakeTransport>[0] = { platformId: PLATFORM, connectedId: CONNECTED }) => {
  const f = createFakeTransport(fake);
  const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0, ...opts });
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
      await expect(client.call({ method: "POST", path: `/v1/invoices/in_ABC123/${verb}`, stripeAccount: CONNECTED, idempotencyKey: `${KEY}x`, body: {} })).rejects.toMatchObject({ code: "blocked_request" });
      expect(spy).not.toHaveBeenCalled();
      expect(client.stats()).toMatchObject({ used: 0, blocked: 1 });
      expect(client.transcript[0].status).toBe("BLOCKED");
    }
  });
  it("after a blocked request every further call is refused too (no half-continuing run)", async () => {
    const { f, client } = mk();
    await expect(client.call({ method: "GET", path: "/v1/balance", stripeAccount: CONNECTED })).rejects.toMatchObject({ code: "blocked_request" });
    await expect(client.call({ method: "GET", path: "/v1/account" })).rejects.toMatchObject({ code: "blocked_request" });
    expect(f.calls).toHaveLength(0);
  });
  it("the real fetch transport is never reached by a blocked request (fetch spy)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const client = createGuardedClient({ transport: createFetchTransport(fetchSpy as unknown as typeof fetch), apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(client.call({ method: "POST", path: "/v1/invoices/in_ABC123/finalize", stripeAccount: CONNECTED, idempotencyKey: `${KEY}y`, body: {} })).rejects.toBeTruthy();
    await expect(createGuardedClient({ transport: createFetchTransport(fetchSpy as unknown as typeof fetch), apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 }).call({ method: "POST", path: "/v1/refunds", stripeAccount: CONNECTED, idempotencyKey: `${KEY}z`, body: { charge: "ch_1" } })).rejects.toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("an allowed request does reach the fetch transport, to api.stripe.com only, with the pinned headers", async () => {
    const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: PLATFORM, object: "account" }), { status: 200 }));
    const client = createGuardedClient({ transport: createFetchTransport(fetchSpy as unknown as typeof fetch), apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await client.call({ method: "GET", path: "/v1/account" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/account");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer rk_test_FAKEFAKE");
    expect(init.redirect).toBe("error");
  });
  it("DELETE of an invoice is refused unless it was observed as a draft", async () => {
    const { f, client } = mk();
    await expect(client.call({ method: "DELETE", path: "/v1/invoices/in_NEVERSEEN1", stripeAccount: CONNECTED }, { phase: "cleanup" })).rejects.toMatchObject({ code: "blocked_request" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("guarded client: hard cap of 40 calls", () => {
  it("never sends more than 40 requests and holds 8 back for cleanup", async () => {
    const { f, client } = mk();
    let sent = 0;
    for (let i = 0; i < 60; i++) {
      try {
        await client.call({ method: "GET", path: "/v1/account" });
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
        await client.call({ method: "GET", path: "/v1/account" }, { phase: "cleanup", expectStatus: [200] });
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
    const r = await Promise.allSettled(Array.from({ length: 50 }, () => client.call({ method: "GET", path: "/v1/account" })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(32);
    expect(f.calls.length).toBeLessThanOrEqual(32);
  });
});

describe("guarded client: response guards", () => {
  it("aborts on livemode:true from a create", async () => {
    const { client } = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, livemodeOnInvoices: true });
    const c = await client.call(cust("a"));
    await expect(client.call(draft(String(c.json?.id), "b"))).rejects.toMatchObject({ code: "livemode_true" });
  });
  it("aborts on a non-draft invoice and cleanup then stops without deleting", async () => {
    const { f, client } = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, invoiceStatusAfterCreate: "open" });
    const c = await client.call(cust("a"));
    await expect(client.call(draft(String(c.json?.id), "b"))).rejects.toMatchObject({ code: "non_draft_invoice" });
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.stoppedBecause).toMatch(/non-draft/);
    expect(f.calls.some((x) => x.method === "DELETE")).toBe(false);
  });
  it("aborts on any 429, on a 5xx streak of three, and on two consecutive unexpected 4xx", async () => {
    const t429 = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, failWith: { status: 429, times: 1 } });
    await expect(t429.client.call({ method: "GET", path: "/v1/account" })).rejects.toMatchObject({ code: "rate_limited" });
    const t5 = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, failWith: { status: 503, times: 5 } });
    await t5.client.call({ method: "GET", path: "/v1/account" }, { expectStatus: [200, 503] });
    await t5.client.call({ method: "GET", path: "/v1/account" }, { expectStatus: [200, 503] });
    await expect(t5.client.call({ method: "GET", path: "/v1/account" }, { expectStatus: [200, 503] })).rejects.toMatchObject({ code: "server_error_streak" });
    const t4 = mk({}, { platformId: PLATFORM, connectedId: CONNECTED });
    await t4.client.call({ method: "GET", path: "/v1/transfers", stripeAccount: CONNECTED, query: { limit: "1" } }).catch(() => undefined);
    await expect(t4.client.call({ method: "GET", path: "/v1/webhook_endpoints", stripeAccount: CONNECTED })).rejects.toMatchObject({ code: "unexpected_4xx_streak" });
  });
  it("expected 403s (S10) do not abort", async () => {
    const { client } = mk();
    const r = await client.call({ method: "GET", path: "/v1/transfers", stripeAccount: CONNECTED, query: { limit: "1" } }, { expectStatus: [403] });
    expect(r.status).toBe(403);
    expect(client.aborted()).toBeNull();
  });
});

describe("cleanup", () => {
  it("deletes drafts then customers, verifies empty lists, and leaves nothing", async () => {
    const { f, client } = mk();
    const c = await client.call(cust("a"));
    const cus = String(c.json?.id);
    await client.call(draft(cus, "b"));
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep).toMatchObject({ verifiedEmpty: true, skipped: null, stoppedBecause: null });
    expect(rep.deletedInvoices).toHaveLength(1);
    expect(rep.deletedCustomers).toEqual([cus]);
    expect(f.state.invoices.size + f.state.customers.size).toBe(0);
  });
  it("makes NO call after a livemode abort and prints ids for manual cleanup", async () => {
    const { f, client } = mk({}, { platformId: PLATFORM, connectedId: CONNECTED, livemodeOnInvoices: true });
    const c = await client.call(cust("a"));
    await client.call(draft(String(c.json?.id), "b")).catch(() => undefined);
    const before = f.calls.length;
    const rep = await cleanup(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(rep.skipped).toMatch(/NOT run/);
    expect(f.calls.length).toBe(before);
    expect(rep.remainingCustomers).toEqual([String(c.json?.id)]);
  });
});

describe("redaction", () => {
  it("removes keys, webhook secrets, bearer tokens and emails", () => {
    const s = redactText("key rk_test_ABC123 sk_live_ZZZ whsec_QQQ Bearer abc.def-ghi mail jo@example.com Authorization: Bearer tok");
    for (const secret of ["rk_test_ABC123", "sk_live_ZZZ", "whsec_QQQ", "abc.def-ghi", "jo@example.com", "tok"]) expect(s).not.toContain(secret);
  });
  it("the transcript never holds the key, the full idempotency key or a response body", async () => {
    const { client } = mk();
    await client.call(cust("long-idempotency-key-for-redaction-check"));
    const t = JSON.stringify(client.transcript);
    expect(t).not.toContain("rk_test_FAKEFAKE");
    expect(t).not.toContain("long-idempotency-key-for-redaction-check");
    expect(client.transcript[0].summary).not.toHaveProperty("name");
  });
});
