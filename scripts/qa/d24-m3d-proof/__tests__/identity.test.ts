import { describe, expect, it } from "vitest";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient } from "../guarded";
import { AUTHORIZATION_PHRASE, checkEnvironment, checkKeyShape, checkPinnedIds, ENV, runIdentityGate } from "../identity";
import { ProofAbort } from "../types";

const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const gate = (fake: Parameters<typeof createFakeTransport>[0]) => {
  const f = createFakeTransport(fake);
  const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
  return { f, client, run: () => runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED }) };
};

describe("identity gate: key shape", () => {
  it("accepts only a restricted test key", () => {
    expect(checkKeyShape("rk_test_abc123XYZ")).toEqual({ ok: true });
  });
  for (const bad of ["sk_test_abc123", "sk_live_abc123", "rk_live_abc123", "pk_test_abc123", "whsec_abc", "", undefined, "rk_test_", "rk_test_abc 123", "xrk_test_abc"]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      const r = checkKeyShape(bad as string | undefined);
      expect(r.ok).toBe(false);
    });
  }
  it("never echoes the key in a refusal", () => {
    const r = checkKeyShape("sk_live_SECRETVALUE123");
    expect(JSON.stringify(r)).not.toContain("SECRETVALUE");
  });
});

describe("identity gate: environment", () => {
  it("passes a clean or local-only environment", () => {
    expect(checkEnvironment({})).toEqual([]);
    expect(checkEnvironment({ DATABASE_URL: "postgres://postgres:pw@127.0.0.1:55432/postgres", SUPABASE_URL: "http://localhost:54321" })).toEqual([]);
  });
  it("refuses a hosted database URL, a live key anywhere, and the creation flag on", () => {
    expect(checkEnvironment({ DATABASE_URL: "postgres://u:p@db.abcdefgh.supabase.co:5432/postgres" }).join()).toMatch(/DATABASE_URL/);
    expect(checkEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }).join()).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(checkEnvironment({ SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOi" }).join()).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    const live = checkEnvironment({ STRIPE_SECRET_KEY: "sk_live_ABCDEFG123" });
    expect(live.join()).toMatch(/STRIPE_SECRET_KEY/);
    expect(live.join()).not.toContain("ABCDEFG123");
    expect(checkEnvironment({ D24_HOSTED_INVOICE_CREATION: "on" }).join()).toMatch(/D24_HOSTED_INVOICE_CREATION/);
  });
  it("a localhost-lookalike host is not local", () => {
    expect(checkEnvironment({ DATABASE_URL: "postgres://u:p@localhost.evil.example:5432/db" }).length).toBeGreaterThan(0);
  });
});

describe("identity gate: pinned ids", () => {
  it("requires two distinct acct_ ids", () => {
    expect(checkPinnedIds({ [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED })).toMatchObject({ ok: true });
    expect(checkPinnedIds({ [ENV.platform]: PLATFORM })).toMatchObject({ ok: false });
    expect(checkPinnedIds({ [ENV.platform]: PLATFORM, [ENV.connected]: PLATFORM })).toMatchObject({ ok: false });
    expect(checkPinnedIds({ [ENV.platform]: "x", [ENV.connected]: CONNECTED })).toMatchObject({ ok: false });
  });
  it("the authorization phrase is the exact plan wording", () => {
    expect(AUTHORIZATION_PHRASE).toBe("Approved: D24 M3-D Stripe TEST proof as written");
  });
});

describe("identity gate: reads against the (fake) accounts", () => {
  it("passes when both ids match and the connected account is express", async () => {
    const g = gate({ platformId: PLATFORM, connectedId: CONNECTED });
    await expect(g.run()).resolves.toEqual({ platformId: PLATFORM, connectedId: CONNECTED, connectedType: "express" });
    expect(g.f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/account", `GET /v1/accounts/${CONNECTED}`]);
    expect(g.f.calls.every((c) => c.stripeAccount === undefined)).toBe(true);
  });
  it("aborts when the key belongs to a different platform account, before the second read", async () => {
    const g = gate({ platformId: PLATFORM, connectedId: CONNECTED, platformIdOverride: "acct_NOTTHESANDBOX" });
    await expect(g.run()).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(g.f.calls).toHaveLength(1);
  });
  it("aborts when the connected account is not express", async () => {
    const g = gate({ platformId: PLATFORM, connectedId: CONNECTED, accountType: "standard" });
    await expect(g.run()).rejects.toBeInstanceOf(ProofAbort);
  });
  it("aborts on livemode:true in an identity response", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const live = async (req: Parameters<typeof f.transport>[0], key: string) => {
      const r = await f.transport(req, key);
      return req.path === "/v1/account" ? { ...r, json: { ...(r.json as object), livemode: true } } : r;
    };
    const client = createGuardedClient({ transport: live, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED })).rejects.toMatchObject({ code: "livemode_true" });
  });
});
