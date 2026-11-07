import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EVIDENCE_ENV } from "../evidence";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient } from "../guarded";
import { AUTHORIZATION_PHRASE, ENV, runIdentityGate, type ConnectedObserved } from "../identity";
import { manifest } from "../manifest";
import { runProof } from "../run";

// Round 8: a REJECTED connected-account gate records what the account actually said (bounded enum tokens only) in the evidence and transcript.
// Everything here goes through runIdentityGate / runProof, so these tests also run (and fail) against the pre-round-8 code.

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

async function observe(accountType: string, controller?: unknown, withController = true): Promise<{ observed: ConnectedObserved | null; err: unknown }> {
  const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, accountType, ...(withController ? { accountController: controller } : {}) });
  const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
  let observed: ConnectedObserved | null = null;
  let err: unknown = null;
  try {
    await runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED }, (o) => { observed = o; });
  } catch (e) {
    err = e;
  }
  return { observed, err };
}

describe("observed values are bounded enum tokens, taken from the actual response", () => {
  it("a rejected controller-model account: every observed value is recorded as returned", async () => {
    const { observed, err } = await observe("none", full({ losses: { payments: "stripe" }, fees: { payer: "account" } }));
    expect(err).toMatchObject({ code: "identity_mismatch" });
    expect(observed).toEqual({
      type: "none",
      controller_type: "application",
      controller_is_controller: true,
      controller_stripe_dashboard_type: "express",
      controller_requirement_collection: "stripe",
      controller_losses_payments: "stripe",
      controller_fees_payer: "account",
    });
  });
  it("the success path records the same observation", async () => {
    const { observed, err } = await observe("none", full());
    expect(err).toBeNull();
    expect(observed).toMatchObject({ type: "none", controller_losses_payments: "application", controller_fees_payer: "application" });
  });
  it("legacy express without a controller: the controller fields are 'absent'", async () => {
    const { observed } = await observe("express", undefined, false);
    expect(observed).toEqual({
      type: "express",
      controller_type: "absent",
      controller_is_controller: "absent",
      controller_stripe_dashboard_type: "absent",
      controller_requirement_collection: "absent",
      controller_losses_payments: "absent",
      controller_fees_payer: "absent",
    });
  });
  it("null, wrong JSON types and nested absences are described, never copied", async () => {
    expect((await observe("none", null)).observed).toMatchObject({ controller_type: "null", controller_is_controller: "null", controller_fees_payer: "null" });
    expect((await observe("none", "SECRET free text")).observed).toMatchObject({ controller_type: "unexpected_type:string", controller_fees_payer: "unexpected_type:string", controller_is_controller: "unexpected_type:string" });
    expect((await observe("none", [1, 2])).observed).toMatchObject({ controller_type: "unexpected_type:array", controller_losses_payments: "unexpected_type:array" });
    expect((await observe("none", 7)).observed).toMatchObject({ controller_type: "unexpected_type:number" });
    const o = (await observe("none", full({ losses: null, fees: "x", stripe_dashboard: [] }))).observed;
    expect(o).toMatchObject({ controller_losses_payments: "null", controller_fees_payer: "unexpected_type:string", controller_stripe_dashboard_type: "unexpected_type:array" });
    expect((await observe("none", full({ losses: {}, fees: {} }))).observed).toMatchObject({ controller_losses_payments: "absent", controller_fees_payer: "absent" });
    expect((await observe("none", full({ type: 5, requirement_collection: { a: 1 } }))).observed).toMatchObject({ controller_type: "unexpected_type:number", controller_requirement_collection: "unexpected_type:object" });
  });
  it("is_controller: a boolean as is, anything else a token (even the string 'true')", async () => {
    expect((await observe("none", full({ is_controller: false }))).observed?.controller_is_controller).toBe(false);
    expect((await observe("none", full({ is_controller: "true" }))).observed?.controller_is_controller).toBe("unexpected_type:string");
    expect((await observe("none", full({ is_controller: 1 }))).observed?.controller_is_controller).toBe("unexpected_type:number");
    expect((await observe("none", full({ is_controller: null }))).observed?.controller_is_controller).toBe("null");
  });
  it("free text, over-long and odd strings are 'unrecognised' (no personal data or ids can leak through a value)", async () => {
    const bad = ["jane@example.com", "Application", "acct_1234567890", "x".repeat(33), "has space", "", "with-dash", "digits12"];
    for (const s of bad) {
      const { observed } = await observe("none", full({ fees: { payer: s }, requirement_collection: s }));
      expect(observed?.controller_fees_payer, JSON.stringify(s)).toBe("unrecognised");
      expect(observed?.controller_requirement_collection, JSON.stringify(s)).toBe("unrecognised");
    }
    expect((await observe("jane@example.com", full())).observed?.type).toBe("unrecognised");
    expect((await observe("x".repeat(40), full())).observed?.type).toBe("unrecognised");
    expect((await observe("a".repeat(32), full())).observed?.type).toBe("a".repeat(32)); // the bound itself is accepted
  });
  it("extra fields are never copied", async () => {
    const { observed } = await observe("none", full({ email: "jane@example.com", business_profile: { name: "ACME" }, capabilities: { card_payments: "active" }, fees: { payer: "application", note: "LEAK" } }));
    expect(Object.keys(observed ?? {}).sort()).toEqual(["controller_fees_payer", "controller_is_controller", "controller_losses_payments", "controller_requirement_collection", "controller_stripe_dashboard_type", "controller_type", "type"]);
    expect(JSON.stringify(observed)).not.toMatch(/jane|ACME|active|LEAK/);
  });
  it("livemode:true on the connected account is still the abort (the guard stops at the response, so nothing from it is recorded)", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, accountType: "none", accountController: full(), accountLivemode: true });
    const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    let seen: ConnectedObserved | null = null;
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED }, (o) => { seen = o; })).rejects.toMatchObject({ code: "livemode_true" });
    expect(seen).toBeNull();
  });
  it("a wrong connected id records nothing (the answer is not the pinned account)", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const wrong = async (req: Parameters<typeof f.transport>[0], key: string) => {
      const r = await f.transport(req, key);
      return req.path.startsWith("/v1/accounts/") ? { ...r, json: { ...(r.json as object), id: "acct_SOMEONEELSE1" } } : r;
    };
    const client = createGuardedClient({ transport: wrong, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    let seen: ConnectedObserved | null = null;
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED }, (o) => { seen = o; })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(seen).toBeNull();
  });
});

describe("the refusal reason never echoes free text", () => {
  const reasonFor = async (accountType: string) => String(((await observe(accountType, full())).err as Error).message);
  it("standard / custom are named; anything else is 'unrecognised'", async () => {
    expect(await reasonFor("standard")).toContain('"standard"');
    expect(await reasonFor("custom")).toContain('"custom"');
    const r = await reasonFor("jane@example.com SECRET-TEXT");
    expect(r).toContain("unrecognised");
    expect(r).not.toMatch(/jane|SECRET/);
    expect(await reasonFor("")).toContain("unrecognised");
  });
  it("a non-string type is described as such", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, accountType: 5 as unknown as string });
    const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED })).rejects.toThrow(/not a string/);
  });
});

describe("runProof with a rejected controller-model gate", () => {
  const tmps: string[] = [];
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const KEY = ["rk", "test", "ROUND8KEY0123456789"].join("_");
  it("exit 1, outcome FAILED, cleanup skipped, 2 calls, observed values present, no secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d24proof-r8-"));
    tmps.push(dir);
    const env = { [ENV.key]: KEY, [ENV.platform]: PLATFORM, [ENV.connected]: CONNECTED, [ENV.pinnedSha]: manifest(DIR).sha256, [ENV.phrase]: AUTHORIZATION_PHRASE, [EVIDENCE_ENV]: dir };
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, accountType: "none", accountController: full({ losses: { payments: "stripe" }, fees: { payer: "account" }, email: "jane@example.com" }) });
    const lines: string[] = [];
    const code = await runProof(["--live"], { env, io: { out: (s: string) => void lines.push(s), sleep: async () => undefined }, liveTransport: f.transport, docker: async () => ({ available: true, rows: [] }), runId: "r8000001", now: () => new Date("2026-11-07T12:00:00Z") });
    expect(code).toBe(1);
    expect(f.calls).toHaveLength(2); // the two identity reads; no create, no cleanup call
    const text = readFileSync(join(dir, "evidence-r8000001.json"), "utf8");
    const ev = JSON.parse(text);
    expect(ev.outcome).toBe("FAILED");
    expect(ev.abort.code).toBe("identity_mismatch");
    expect(ev.connectedAccountVerified).toBeNull();
    expect(ev.connectedAccountObserved).toEqual({
      type: "none",
      controller_type: "application",
      controller_is_controller: true,
      controller_stripe_dashboard_type: "express",
      controller_requirement_collection: "stripe",
      controller_losses_payments: "stripe",
      controller_fees_payer: "account",
    });
    expect(ev.cleanup.skipped).toEqual(expect.any(String));
    const transcript = readFileSync(join(dir, "transcript-r8000001.txt"), "utf8");
    for (const t of [text, transcript, lines.join("\n")]) {
      expect(t.replace(/\s+/g, "")).toContain('"controller_fees_payer":"account"');
      for (const forbidden of [KEY, "ROUND8KEY", "Authorization", "Bearer", PLATFORM, CONNECTED, "jane@example.com"]) expect(t).not.toContain(forbidden);
    }
  });
});
