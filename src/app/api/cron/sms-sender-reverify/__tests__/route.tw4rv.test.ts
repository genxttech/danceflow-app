import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

let authFailure: Response | null = null;
let outcome: unknown = { ran: false, reason: "busy" };
const runs: Array<{ provider: unknown; runner: string }> = [];

vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => authFailure }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/sms/twilioIsv/real", () => ({ messagingTokenProvider: () => null }));
vi.mock("@/lib/sms/senderVerification", () => ({
  senderReadProviderFromEnv: () => null,
  runScheduledSenderReverify: async (_admin: unknown, provider: unknown, options: { runner: string }) => {
    runs.push({ provider, runner: options.runner });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  },
}));

import { GET, POST } from "../route";

const summary = { due: 2, verified: 1, failed: 1, inconclusive: 0, skipped: 0, errors: 0, truncated: false, reads_available: true };

beforeEach(() => {
  authFailure = null;
  outcome = { ran: false, reason: "busy" };
  runs.length = 0;
  vi.stubEnv("SMS_SENDER_REVERIFY", "on");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("scheduled sender re-verification route", () => {
  it("is not registered on any schedule", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).some((c) => c.path.includes("sms-sender-reverify"))).toBe(false);
  });

  it("answers 404 and does nothing unless SMS_SENDER_REVERIFY=on", async () => {
    vi.stubEnv("SMS_SENDER_REVERIFY", "");
    expect((await GET(new Request("https://x.test"))).status).toBe(404);
    vi.stubEnv("SMS_SENDER_REVERIFY", "yes");
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

  it("returns counts only, never cached; a failed run is a 500; errors make ok false", async () => {
    outcome = { ran: true, runId: "r", failed: false, summary };
    const response = await GET(new Request("https://x.test"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, ran: true, ...summary });
    expect(runs[0].runner).toMatch(/^cron:[0-9a-f]{8}$/);
    outcome = { ran: true, runId: "r", failed: false, summary: { ...summary, errors: 1 } };
    expect((await (await GET(new Request("https://x.test"))).json()).ok).toBe(false);
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
