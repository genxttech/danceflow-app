import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EVIDENCE_ENV } from "../evidence";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient, pinned } from "../guarded";
import { AUTHORIZATION_PHRASE, ENV, runIdentityGate } from "../identity";
import { manifest } from "../manifest";
import { runProof } from "../run";
import type { ProofAbort } from "../types";

// Round 7: the connected account may be a controller-model Express account (type "none" + Express-equivalent controller), never a blanket "none".
// These tests go through runIdentityGate + the fake only, so they also run (and the positive ones fail) against the pre-round-7 code.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const full = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "application",
  is_controller: true,
  losses: { payments: "application" },
  requirement_collection: "stripe",
  fees: { payer: "application" },
  stripe_dashboard: { type: "express" },
  ...over,
});
const without = (k: string): Record<string, unknown> => { const c = full(); delete c[k]; return c; };

const gate = (fake: Partial<Parameters<typeof createFakeTransport>[0]> & { accountType?: string }) => {
  const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, ...fake });
  const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
  return { f, client, run: () => runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED }) };
};
const accepted = async (fake: Parameters<typeof gate>[0]) => {
  const g = gate(fake);
  await g.run();
  expect(g.client.identityVerified()).toBe(true);
  return g;
};
const rejected = async (fake: Parameters<typeof gate>[0], code = "identity_mismatch") => {
  const g = gate(fake);
  const err = (await g.run().then(() => null, (e: unknown) => e)) as ProofAbort | null;
  expect(err).toMatchObject({ code });
  // the reason text says WHY (a type / controller reason, or the livemode abort), never an empty or generic message
  expect(err?.message).toMatch(code === "livemode_true" ? /livemode:true/ : /^connected account type is /);
  expect(g.client.identityVerified()).toBe(false);
  // exactly the two identity reads happened; no create can be sent afterwards
  expect(g.f.calls).toHaveLength(2);
  // the run is aborted: any later call is refused with that same abort (before any network I/O)
  await expect(pinned(g.client, { method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: "d24proof-r7-cus", body: { name: "n", email: "d24-proof-abc123-a@example.com" } })).rejects.toMatchObject({ code, message: err?.message });
  expect(g.f.calls).toHaveLength(2);
  return g;
};

it("a client that never ran the gate refuses a create with identity_not_verified (before any network I/O)", async () => {
  const g = gate({ accountType: "express" });
  await expect(pinned(g.client, { method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: "d24proof-r7-cus", body: { name: "n", email: "d24-proof-abc123-a@example.com" } })).rejects.toMatchObject({ code: "identity_not_verified" });
  expect(g.f.calls).toHaveLength(0);
});

describe("accepted connected accounts", () => {
  it("legacy type=express (no controller)", async () => { await accepted({ accountType: "express" }); });
  it("legacy type=express with a matching controller dashboard", async () => { await accepted({ accountType: "express", accountController: { stripe_dashboard: { type: "express" } } }); });
  it("legacy type=express with a controller that has no dashboard type", async () => { await accepted({ accountType: "express", accountController: { type: "application" } }); });
  for (const payer of ["application", "application_express"]) {
    it(`controller-model express: type none + full controller (fees.payer=${payer})`, async () => {
      const g = await accepted({ accountType: "none", accountController: full({ fees: { payer } }) });
      const r = await runIdentityGate(g.client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
      expect(r.connectedFacts).toEqual({
        accountType: "none",
        model: "controller_express",
        controller: { type: "application", is_controller: true, stripe_dashboard_type: "express", requirement_collection: "stripe", losses_payments: "application", fees_payer: payer },
      });
    });
  }
});

describe("rejected connected accounts (fail closed)", () => {
  it("standard", async () => { await rejected({ accountType: "standard" }); });
  it("custom", async () => { await rejected({ accountType: "custom" }); });
  it("custom-like none: dashboard none", async () => { await rejected({ accountType: "none", accountController: full({ stripe_dashboard: { type: "none" } }) }); });
  it("custom-like none: dashboard none and requirement_collection application", async () => { await rejected({ accountType: "none", accountController: full({ stripe_dashboard: { type: "none" }, requirement_collection: "application" }) }); });
  it("none with a full dashboard (type full)", async () => { await rejected({ accountType: "none", accountController: full({ stripe_dashboard: { type: "full" } }) }); });
  it("unknown or empty type", async () => { await rejected({ accountType: "weird" }); await rejected({ accountType: "" }); });
  it("none with no controller key", async () => { await rejected({ accountType: "none" }); });
  for (const [name, c] of [["null", null], ["array", [full()]], ["string", "application"], ["number", 7]] as const) {
    it(`none with controller = ${name}`, async () => { await rejected({ accountType: "none", accountController: c }); });
  }
  for (const k of ["type", "is_controller", "stripe_dashboard", "requirement_collection", "losses", "fees"]) {
    it(`none with controller.${k} missing`, async () => { await rejected({ accountType: "none", accountController: without(k) }); });
  }
  it("none with losses.payments / fees.payer / dashboard.type missing inside their objects", async () => {
    await rejected({ accountType: "none", accountController: full({ losses: {} }) });
    await rejected({ accountType: "none", accountController: full({ fees: {} }) });
    await rejected({ accountType: "none", accountController: full({ stripe_dashboard: {} }) });
  });
  it("none with wrong enum values", async () => {
    await rejected({ accountType: "none", accountController: full({ type: "account" }) });
    await rejected({ accountType: "none", accountController: full({ requirement_collection: "application" }) });
    await rejected({ accountType: "none", accountController: full({ losses: { payments: "stripe" } }) });
    await rejected({ accountType: "none", accountController: full({ fees: { payer: "account" } }) });
    await rejected({ accountType: "none", accountController: full({ stripe_dashboard: { type: "express_extra" } }) });
  });
  it("none with non-string / non-boolean types", async () => {
    await rejected({ accountType: "none", accountController: full({ type: 1 }) });
    await rejected({ accountType: "none", accountController: full({ is_controller: "true" }) });
    await rejected({ accountType: "none", accountController: full({ is_controller: false }) });
    await rejected({ accountType: "none", accountController: full({ requirement_collection: ["stripe"] }) });
    await rejected({ accountType: "none", accountController: full({ losses: { payments: ["application"] } }) });
    await rejected({ accountType: "none", accountController: full({ fees: { payer: { v: "application" } } }) });
    await rejected({ accountType: "none", accountController: full({ stripe_dashboard: "express" }) });
    await rejected({ accountType: "none", accountController: full({ losses: "application" }) });
    await rejected({ accountType: "none", accountController: full({ fees: null }) });
  });
  it("legacy express whose controller contradicts it", async () => {
    await rejected({ accountType: "express", accountController: { stripe_dashboard: { type: "none" } } });
    await rejected({ accountType: "express", accountController: { stripe_dashboard: { type: "full" } } });
    await rejected({ accountType: "express", accountController: { stripe_dashboard: "express" } });
    await rejected({ accountType: "express", accountController: "x" });
  });
  it("wrong connected id", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, accountType: "express" });
    const wrong = async (req: Parameters<typeof f.transport>[0], key: string) => {
      const r = await f.transport(req, key);
      return req.path.startsWith("/v1/accounts/") ? { ...r, json: { ...(r.json as object), id: "acct_SOMEONEELSE1" } } : r;
    };
    const client = createGuardedClient({ transport: wrong, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(client.identityVerified()).toBe(false);
  });
  it("wrong platform id (after one call)", async () => {
    const g = gate({ accountType: "express", platformIdOverride: "acct_NOTTHESANDBOX" });
    await expect(g.run()).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(g.f.calls).toHaveLength(1);
  });
  it("livemode:true on the connected account, even when it would otherwise pass", async () => {
    await rejected({ accountType: "none", accountController: full(), accountLivemode: true }, "livemode_true");
    await rejected({ accountType: "express", accountLivemode: true }, "livemode_true");
  });
});

describe("evidence records the verified facts", () => {
  const tmps: string[] = [];
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const env = (dir: string): Record<string, string> => ({
    [ENV.key]: ["rk", "test", "ROUND7KEY0123456789"].join("_"), [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE, [EVIDENCE_ENV]: dir,
  });
  it("a controller-model account: the pack carries the enum strings, nothing else from the account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d24proof-r7-"));
    tmps.push(dir);
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, accountType: "none", accountController: full({ fees: { payer: "application_express" }, extra_secret: "SHOULD-NOT-APPEAR" }) });
    const lines: string[] = [];
    const code = await runProof(["--live"], { env: env(dir), io: { out: (s: string) => void lines.push(s), sleep: async () => undefined }, liveTransport: f.transport, docker: async () => ({ available: true, rows: [] }), runId: "r7000001", now: () => new Date("2026-11-07T12:00:00Z") });
    expect(code).toBe(0);
    const text = readFileSync(join(dir, "evidence-r7000001.json"), "utf8");
    expect(text).not.toContain("SHOULD-NOT-APPEAR");
    expect(lines.join("\n")).not.toContain("SHOULD-NOT-APPEAR");
    expect(JSON.parse(text).connectedAccountVerified).toEqual({
      accountType: "none",
      model: "controller_express",
      controller: { type: "application", is_controller: true, stripe_dashboard_type: "express", requirement_collection: "stripe", losses_payments: "application", fees_payer: "application_express" },
    });
  });
});
