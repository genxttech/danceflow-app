import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

let authFailure: Response | null = null;
let outcome: unknown = { ran: false, reason: "busy" };
const runs: Array<{ provider: unknown; runner: string }> = [];

vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => authFailure }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/sms/usageProvider", () => ({ usageEvidenceProviderFromEnv: () => null }));
vi.mock("@/lib/sms/usageReconciler", () => ({
  runScheduledUsageReconciliation: async (_admin: unknown, provider: unknown, options: { runner: string }) => {
    runs.push({ provider, runner: options.runner });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  },
}));

import { GET, POST } from "../route";

const summary = { released_unsent: 1, settled: 2, errors: 0, evidence_read: false };

beforeEach(() => {
  authFailure = null;
  outcome = { ran: false, reason: "busy" };
  runs.length = 0;
  vi.stubEnv("SMS_USAGE_RECONCILER", "on");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("scheduled usage reconciliation route", () => {
  it("is not registered on any schedule (a release owner adds it deliberately)", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).some((c) => c.path.includes("sms-usage-reconcile"))).toBe(false);
  });

  it("answers 404 and does nothing unless SMS_USAGE_RECONCILER=on", async () => {
    vi.stubEnv("SMS_USAGE_RECONCILER", "");
    expect((await GET(new Request("https://x.test"))).status).toBe(404);
    vi.stubEnv("SMS_USAGE_RECONCILER", "yes");
    expect((await POST(new Request("https://x.test", { method: "POST" }))).status).toBe(404);
    expect(runs).toEqual([]);
  });

  it("refuses callers without the cron secret", async () => {
    authFailure = new Response("Unauthorized", { status: 401 });
    expect((await GET(new Request("https://x.test"))).status).toBe(401);
    expect(runs).toEqual([]);
  });

  it("an overlapping call is a harmless 200 'busy'; a database that cannot start a run is 503", async () => {
    const busy = await GET(new Request("https://x.test"));
    expect(busy.status).toBe(200);
    expect(await busy.json()).toEqual({ ok: true, ran: false, reason: "busy" });
    outcome = { ran: false, reason: "unavailable" };
    expect((await GET(new Request("https://x.test"))).status).toBe(503);
  });

  it("returns counts only, never cached; a failed run is a 500", async () => {
    outcome = { ran: true, runId: "r", failed: false, summary };
    const response = await GET(new Request("https://x.test"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, ran: true, ...summary });
    expect(runs[0].runner).toMatch(/^cron:[0-9a-f]{8}$/);
    outcome = { ran: true, runId: "r", failed: true, summary };
    expect((await POST(new Request("https://x.test", { method: "POST" }))).status).toBe(500);
  });

  it("an unexpected exception is a generic 500 with no detail", async () => {
    outcome = new Error("boom secret");
    const response = await GET(new Request("https://x.test"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false });
  });
});
