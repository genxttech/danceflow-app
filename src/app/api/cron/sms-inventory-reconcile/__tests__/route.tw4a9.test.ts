import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

let authFailure: Response | null = null;
let outcome: unknown = { ran: false, reason: "busy" };
const runs: Array<{ runtime: unknown; runner: string }> = [];
const RUNTIME = { ok: false, reason: "gates off" };

vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => authFailure }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/sms/inventoryReconcile/numberReadRuntime", () => ({ buildNumberReadRuntime: () => RUNTIME }));
vi.mock("@/lib/sms/inventoryReconcile/run", () => ({
  runScheduledInventoryReconcile: async (_admin: unknown, runtime: unknown, options: { runner: string }) => {
    runs.push({ runtime, runner: options.runner });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  },
}));

import { GET, POST, maxDuration } from "../route";

const summary = { checked: 2, clean: 1, findings: 1, skipped: 0, manual: 0, stopped: 0, errors: 0, reads_available: true, out_of_time: false };

beforeEach(() => {
  authFailure = null;
  outcome = { ran: false, reason: "busy" };
  runs.length = 0;
  vi.stubEnv("SMS_INVENTORY_RECONCILE", "on");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("scheduled inventory reconciliation route (A9)", () => {
  it("is not registered on any schedule", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).some((c) => c.path.includes("sms-inventory-reconcile"))).toBe(false);
  });

  it("answers 404 and does nothing unless SMS_INVENTORY_RECONCILE=on", async () => {
    vi.stubEnv("SMS_INVENTORY_RECONCILE", "");
    expect((await GET(new Request("https://x.test"))).status).toBe(404);
    vi.stubEnv("SMS_INVENTORY_RECONCILE", "yes");
    expect((await POST(new Request("https://x.test", { method: "POST" }))).status).toBe(404);
    expect(runs).toEqual([]);
  });

  it("refuses callers without the cron secret", async () => {
    authFailure = new Response("Unauthorized", { status: 401 });
    expect((await GET(new Request("https://x.test"))).status).toBe(401);
    expect(runs).toEqual([]);
  });

  it("busy is a harmless 200; an unavailable database is 503", async () => {
    const busy = await GET(new Request("https://x.test"));
    expect(busy.status).toBe(200);
    expect(await busy.json()).toEqual({ ok: true, ran: false, reason: "busy" });
    outcome = { ran: false, reason: "unavailable" };
    expect((await GET(new Request("https://x.test"))).status).toBe(503);
  });

  it("passes the number runtime from the environment and a fresh runner id; returns counts only, never cached", async () => {
    outcome = { ran: true, runId: "r", failed: false, summary };
    const response = await GET(new Request("https://x.test"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, ran: true, ...summary });
    expect(runs[0].runtime).toBe(RUNTIME);
    expect(runs[0].runner).toMatch(/^cron:[0-9a-f]{8}$/);
  });

  it("a failed run (gates off, lease lost, work list down) is a 500 with counts; skipped subaccounts make ok false", async () => {
    outcome = { ran: true, runId: "r", failed: true, summary: { ...summary, reads_available: false, checked: 0 } };
    const failed = await POST(new Request("https://x.test", { method: "POST" }));
    expect(failed.status).toBe(500);
    expect((await failed.json()).ok).toBe(false);
    outcome = { ran: true, runId: "r", failed: false, summary: { ...summary, skipped: 1, errors: 1 } };
    const partial = await GET(new Request("https://x.test"));
    expect(partial.status).toBe(200);
    expect((await partial.json()).ok).toBe(false);
  });

  it("an unexpected exception is a generic 500 with no detail", async () => {
    outcome = new Error("boom secret AC123");
    const response = await GET(new Request("https://x.test"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(JSON.stringify({ ok: false }));
    expect(console.error).toHaveBeenCalledWith("sms_inventory_reconcile_failed");
  });

  it("the run budget stays under maxDuration", async () => {
    const { INVENTORY_RECONCILE_BUDGET_MS, INVENTORY_RECONCILE_LEASE_SECONDS } = await vi.importActual<typeof import("@/lib/sms/inventoryReconcile/run")>("@/lib/sms/inventoryReconcile/run");
    expect(INVENTORY_RECONCILE_BUDGET_MS).toBeLessThan(maxDuration * 1000 - 10_000);
    expect(INVENTORY_RECONCILE_LEASE_SECONDS * 1000).toBeGreaterThan(maxDuration * 1000);
  });
});
