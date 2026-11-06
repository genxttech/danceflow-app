import { describe, expect, it, vi } from "vitest";
import { evaluateRequest } from "../allowlist";
import { STRIPE_API_VERSION } from "../config";
import { createFakeTransport } from "../fakeTransport";
import { createGuardedClient, pinned } from "../guarded";
import { runIdentityGate } from "../identity";
import { runScenarios } from "../scenarios";
import { createFetchTransport } from "../transport";
import type { ProofRequest, Transport } from "../types";
import { manifest } from "../manifest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const read: ProofRequest = { method: "GET", path: "/v1/invoices/in_ABC123", stripeAccount: CONNECTED };

describe("Stripe-Version is pinned on every request", () => {
  it("the pin is a dated API version string", () => {
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  });
  it("the allow-list refuses a missing, empty or different version for every rule, and accepts only the pin", () => {
    const ev = (v: string | undefined) => evaluateRequest({ ...read, stripeVersion: v }, { connectedAcct: CONNECTED });
    expect(ev(STRIPE_API_VERSION).ok).toBe(true);
    for (const v of [undefined, "", "2020-08-27", "2026-03-25", "2026-03-25.dahlia ", "2026-03-25.DAHLIA", "latest", "2026-03-25.dahlia; x"]) {
      const r = ev(v);
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Stripe-Version/);
    }
    for (const r of [{ method: "GET", path: "/v1/account" }, { method: "GET", path: `/v1/accounts/${CONNECTED}` }] as ProofRequest[]) {
      expect(evaluateRequest(r, { connectedAcct: CONNECTED }).ok, r.path).toBe(false);
      expect(evaluateRequest({ ...r, stripeVersion: STRIPE_API_VERSION }, { connectedAcct: CONNECTED }).ok, r.path).toBe(true);
    }
  });
  it("the guard refuses a request without or with another version before any network I/O", async () => {
    for (const v of [undefined, "2020-08-27"]) {
      const spy = vi.fn<Transport>();
      const client = createGuardedClient({ transport: spy, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
      await expect(client.call({ method: "GET", path: "/v1/account", stripeVersion: v })).rejects.toMatchObject({ code: "blocked_request" });
      expect(spy).not.toHaveBeenCalled();
    }
  });
  it("a response that reports another version aborts the run and no cleanup call follows", async () => {
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED, reportVersion: "2020-08-27" });
    const spy = vi.fn<Transport>(f.transport);
    const client = createGuardedClient({ transport: spy, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await expect(runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED })).rejects.toMatchObject({ code: "version_mismatch" });
    const n = spy.mock.calls.length;
    await expect(pinned(client, read, { phase: "cleanup" })).rejects.toMatchObject({ code: "version_mismatch" });
    expect(spy.mock.calls.length).toBe(n);
  });
  it("the real transport sends the header, and every request of a full scenario run carries the pin", async () => {
    const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: PLATFORM }), { status: 200, headers: { "stripe-version": STRIPE_API_VERSION } }));
    const client0 = createGuardedClient({ transport: createFetchTransport(fetchSpy as unknown as typeof fetch), apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await pinned(client0, { method: "GET", path: "/v1/account" });
    expect((fetchSpy.mock.calls[0][1].headers as Record<string, string>)["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    const f = createFakeTransport({ platformId: PLATFORM, connectedId: CONNECTED });
    const client = createGuardedClient({ transport: f.transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
    await runIdentityGate(client, { platformAcct: PLATFORM, connectedAcct: CONNECTED });
    await runScenarios({ client, expect: { platformAcct: PLATFORM, connectedAcct: CONNECTED }, runId: "vp000001", sleep: async () => undefined, replayWaitMs: 0 });
    expect(f.calls.length).toBeGreaterThan(20);
    expect(f.calls.every((c) => c.stripeVersion === STRIPE_API_VERSION)).toBe(true);
    expect([...client.versionsSeen]).toEqual([STRIPE_API_VERSION]);
  });
  it("the pin lives in config.ts, which is part of the manifest hash", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
    expect(manifest(dir).files.map((x) => x.path)).toContain("config.ts");
  });
});
