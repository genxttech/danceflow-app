import { describe, expect, it, vi } from "vitest";
import { STRIPE_API_VERSION } from "../config";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient, pinned } from "../guarded";
import { AUTHORIZATION_PHRASE, ENV, runIdentityGate } from "../identity";
import { manifest } from "../manifest";
import { runProof } from "../run";
import type { ProofRequest, Transport } from "../types";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// "The proof cannot run against LIVE or an unintended connected account": each requirement from the owner's list, as a test that FAILS if the barrier is removed.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const OTHER = "acct_SOMEONEELSE99";
const spyClient = (transport?: Transport) => {
  const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
  const spy = vi.fn<Transport>(transport ?? f.transport);
  const client = createGuardedClient({ transport: spy, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
  return { f, spy, client };
};
const validEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  [ENV.key]: "rk_test_FAKEFAKE123", [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE, ...over,
});
const out = () => { const lines: string[] = []; return { lines, io: { out: (s: string) => void lines.push(s), sleep: async () => undefined } }; };
const noDocker = async () => ({ available: true, rows: [] as string[] });

describe("key shape: only rk_test_ can start a live run", () => {
  for (const [label, key] of [["sk_test", "sk_test_ABCDEF1234"], ["sk_live", "sk_live_ABCDEF1234"], ["rk_live", "rk_live_ABCDEF1234"], ["pk_test", "pk_test_ABCDEF1234"], ["empty", ""], ["whsec", "whsec_ABCDEF1234"]] as const) {
    it(`${label} is refused before any network I/O`, async () => {
      const live = vi.fn<Transport>();
      const c = out();
      expect(await runProof(["--live"], { env: validEnv({ [ENV.key]: key }), io: c.io, liveTransport: live, docker: noDocker })).toBe(2);
      expect(live).not.toHaveBeenCalled();
      expect(c.lines.join("\n")).not.toContain("ABCDEF1234");
    });
  }
});

describe("pinned platform AND connected ids must match before any other call", () => {
  it("a different platform account stops after exactly one request (GET /v1/account)", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, platformIdOverride: "acct_NOTTHESANDBOX" });
    const spy = vi.fn<Transport>(f.transport);
    const client = createGuardedClient({ transport: spy, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(spy.mock.calls.map((c) => `${c[0].method} ${c[0].path}`)).toEqual(["GET /v1/account"]);
    expect(client.identityVerified()).toBe(false);
  });
  it("a different connected account stops after exactly two requests and nothing is ever created", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: "acct_ANOTHERCONN99" });
    const spy = vi.fn<Transport>(f.transport);
    const client = createGuardedClient({ transport: spy, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    // the fake answers the pinned connected path with 404 (it only knows the other id), so the gate cannot pass
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED })).rejects.toBeTruthy();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(spy.mock.calls.some((c) => c[0].method !== "GET")).toBe(false);
    expect(client.identityVerified()).toBe(false);
  });
  it("until the gate passes, every non-identity request is refused before the transport is called", async () => {
    const reqs: ProofRequest[] = [
      { method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: "d24proof-x-1", body: { name: "n", email: "d24-proof-abc123-a@example.com" } },
      { method: "POST", path: "/v1/invoices", stripeAccount: CONNECTED, idempotencyKey: "d24proof-x-2", body: { customer: "cus_ABC123", collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false" } },
      { method: "GET", path: "/v1/invoices", stripeAccount: CONNECTED, query: { customer: "cus_ABC123", limit: "100" } },
      { method: "GET", path: "/v1/transfers", stripeAccount: CONNECTED, query: { limit: "1" } },
    ];
    for (const r of reqs) {
      const { spy, client } = spyClient();
      await expect(pinned(client, r)).rejects.toMatchObject({ code: "identity_not_verified" });
      expect(spy).not.toHaveBeenCalled();
    }
  });
  it("after the gate passes the scenarios run; the gate is the only thing that flips the switch", async () => {
    const { client } = spyClient();
    expect(client.identityVerified()).toBe(false);
    await runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    expect(client.identityVerified()).toBe(true);
  });
});

describe("every non-identity request carries Stripe-Account = the pinned connected id", () => {
  const withAcct = (acct: string | undefined): ProofRequest[] => [
    { method: "POST", path: "/v1/customers", stripeAccount: acct, idempotencyKey: "d24proof-x-1", body: { name: "n", email: "d24-proof-abc123-a@example.com" } },
    { method: "GET", path: "/v1/invoices/in_ABC123", stripeAccount: acct },
    { method: "GET", path: "/v1/invoices", stripeAccount: acct, query: { customer: "cus_ABC123", limit: "100" } },
    { method: "DELETE", path: "/v1/customers/cus_ABC123", stripeAccount: acct },
    { method: "GET", path: "/v1/webhook_endpoints", stripeAccount: acct },
  ];
  for (const [label, acct] of [["missing", undefined], ["another acct_", OTHER], ["the platform id", PLATFORM], ["empty", ""]] as const) {
    it(`${label}: refused before network I/O for every kind of request`, async () => {
      for (const r of withAcct(acct as string | undefined)) {
        const { spy, client } = spyClient();
        await runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
        const before = spy.mock.calls.length;
        await expect(pinned(client, r)).rejects.toMatchObject({ code: "blocked_request" });
        expect(spy.mock.calls.length).toBe(before);
      }
    });
  }
  it("the identity reads must NOT carry one", async () => {
    const { spy, client } = spyClient();
    await expect(pinned(client, { method: "GET", path: "/v1/account", stripeAccount: CONNECTED })).rejects.toMatchObject({ code: "blocked_request" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("livemode:true anywhere aborts", () => {
  it("top level, inside a list element, inside a nested object and inside an error body", async () => {
    const bodies: Array<Record<string, unknown>> = [
      { id: "cus_ABC123", object: "customer", livemode: true },
      { object: "list", data: [{ id: "in_1", object: "invoice", status: "draft", livemode: true }] },
      { id: "cus_ABC123", object: "customer", livemode: false, nested: { deep: { livemode: true } } },
      { error: { type: "x", livemode: true } },
    ];
    for (const json of bodies) {
      const t: Transport = async (r) => (r.method === "POST" && r.path === "/v1/customers" ? { status: 200, json: { id: "cus_ABC123", object: "customer", livemode: false }, stripeVersion: STRIPE_API_VERSION } : r.path === "/v1/account" ? { status: 200, json: { id: PLATFORM, object: "account", livemode: false }, stripeVersion: STRIPE_API_VERSION } : r.path.startsWith("/v1/accounts/") ? { status: 200, json: { id: CONNECTED, object: "account", type: "express" }, stripeVersion: STRIPE_API_VERSION } : { status: 200, json, stripeVersion: STRIPE_API_VERSION });
      const { client } = spyClient(t);
      await runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
      await pinned(client, { method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: "d24proof-x-lm", body: { name: "n", email: "d24-proof-abc123-a@example.com" } });
      await expect(pinned(client, { method: "GET", path: "/v1/invoices", stripeAccount: CONNECTED, query: { customer: "cus_ABC123", limit: "100" } }, { expectStatus: [200, 400] })).rejects.toMatchObject({ code: "livemode_true" });
    }
  });
});

describe("hosted-database environment variables are refused", () => {
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL"]) {
    it(`${name}=<hosted> refuses a live run and the preflight`, async () => {
      const env = validEnv({ [name]: "postgres://u:p@db.abcdefgh.supabase.co:5432/postgres" });
      const live = vi.fn<Transport>();
      const c = out();
      expect(await runProof(["--live"], { env, io: c.io, liveTransport: live, docker: noDocker })).toBe(2);
      expect(live).not.toHaveBeenCalled();
      const p = out();
      expect(await runProof(["--preflight"], { env, io: p.io, docker: noDocker })).toBe(2);
    });
  }
  it("a live key in ANY variable refuses a live run (without printing it)", async () => {
    const live = vi.fn<Transport>();
    const c = out();
    expect(await runProof(["--live"], { env: validEnv({ STRIPE_SECRET_KEY: "sk_live_SUPERSECRET123" }), io: c.io, liveTransport: live, docker: noDocker })).toBe(2);
    expect(live).not.toHaveBeenCalled();
    expect(c.lines.join("\n")).not.toContain("SUPERSECRET123");
  });
});

describe("the 40-call cap holds including retries", () => {
  // GET /v1/webhook_endpoints is an allow-listed, unscoped rule, so repeating it is a pure test of the counter (status 200 so no streak ever aborts the loop)
  const repeat = { method: "GET", path: "/v1/webhook_endpoints", stripeAccount: CONNECTED } as const;
  it("100 repeated identical requests (retries) reach the transport EXACTLY 40 times in total, and the scenario phase stops at 32", async () => {
    const mkc = () =>
      spyClient(async (r) =>
        r.path === "/v1/account" ? { status: 200, json: { id: PLATFORM, object: "account" }, stripeVersion: STRIPE_API_VERSION }
        : r.path.startsWith("/v1/accounts/") ? { status: 200, json: { id: CONNECTED, object: "account", type: "express" }, stripeVersion: STRIPE_API_VERSION }
        : { status: 200, json: { object: "list", data: [] }, stripeVersion: STRIPE_API_VERSION });
    const a = mkc();
    await runIdentityGate(a.client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    for (let i = 0; i < 100; i++) await pinned(a.client, repeat).catch(() => undefined);
    expect(a.spy.mock.calls.length).toBe(32); // 2 identity reads + 30 more: the scenario phase never touches the 8 reserved for cleanup
    const b = mkc();
    await runIdentityGate(b.client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    for (let i = 0; i < 100; i++) await pinned(b.client, repeat, { phase: "cleanup" }).catch(() => undefined);
    expect(b.spy.mock.calls.length).toBe(40);
  });
  it("failed attempts (network errors) count against the cap too", async () => {
    let n = 0;
    const flaky: Transport = async (r) => {
      n++;
      if (r.path === "/v1/account") return { status: 200, json: { id: PLATFORM, object: "account" }, stripeVersion: STRIPE_API_VERSION };
      if (r.path.startsWith("/v1/accounts/")) return { status: 200, json: { id: CONNECTED, object: "account", type: "express" }, stripeVersion: STRIPE_API_VERSION };
      throw new Error("socket hang up");
    };
    const { client } = spyClient(flaky);
    await runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    for (let i = 0; i < 100; i++) await pinned(client, repeat, { phase: "cleanup" }).catch(() => undefined);
    expect(n).toBe(40);
  });
  it("a whole dry run (scenarios + cleanup) stays inside the cap", async () => {
    const c = out();
    expect(await runProof(["--dry-run"], { env: {}, io: c.io })).toBe(0);
    const m = /Calls used: (\d+) of hard cap 40/.exec(c.lines.join("\n"));
    expect(Number(m?.[1])).toBeLessThanOrEqual(40);
  });
});
