import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

let authFailure: Response | null = null;
let outcome: unknown = null;
const runs: Array<{ sink: unknown }> = [];

vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => authFailure }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/sms/providerFeeLifecycle", () => ({
  ProviderFeeLifecycleStore: class {},
  runProviderFeeLifecycleScan: async (_store: unknown, sink: unknown) => {
    runs.push({ sink });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  },
}));

import { GET, POST } from "../route";

const summary = { entities: 2, opened: 1, closed: 0, alertsCreated: 3, inventoryGaps: 0, delivered: 0, failed: 0, errors: 0, deliveryEnabled: false, truncated: 0 };

beforeEach(() => {
  authFailure = null;
  outcome = summary;
  runs.length = 0;
  vi.stubEnv("SMS_FEE_LIFECYCLE_SCAN", "on");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("recurring provider-fee lifecycle scan route", () => {
  it("is not registered on any schedule (a release owner adds it deliberately)", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).some((c) => c.path.includes("sms-provider-fee-lifecycle"))).toBe(false);
  });

  it("answers 404 and does nothing unless SMS_FEE_LIFECYCLE_SCAN=on", async () => {
    vi.stubEnv("SMS_FEE_LIFECYCLE_SCAN", "");
    expect((await GET(new Request("https://x.test"))).status).toBe(404);
    vi.stubEnv("SMS_FEE_LIFECYCLE_SCAN", "yes");
    expect((await POST(new Request("https://x.test", { method: "POST" }))).status).toBe(404);
    expect(runs).toEqual([]);
  });

  it("refuses callers without the cron secret", async () => {
    authFailure = new Response("Unauthorized", { status: 401 });
    expect((await GET(new Request("https://x.test"))).status).toBe(401);
    expect(runs).toEqual([]);
  });

  it("returns counts only, never cached, and wires NO delivery sink until the owner decides the channel", async () => {
    const response = await GET(new Request("https://x.test"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, ...summary });
    expect(runs[0].sink).toBeNull();
  });

  it("a scan with errors is a 500 (counts still returned); an exception is a generic 500 with no detail", async () => {
    outcome = { ...summary, errors: 1 };
    expect((await POST(new Request("https://x.test", { method: "POST" }))).status).toBe(500);
    outcome = new Error("boom secret");
    const response = await GET(new Request("https://x.test"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false });
  });
});
