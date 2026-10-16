import { beforeEach, describe, expect, it, vi } from "vitest";

let authFailure: Response | null = null;
const rpcCalls: string[] = [];
let rpcResult: { data: unknown; error: { code: string } | null } = { data: 0, error: null };

vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => authFailure }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async (fn: string) => { rpcCalls.push(fn); return rpcResult; } }),
}));

import { GET, POST } from "../route";

beforeEach(() => {
  authFailure = null;
  rpcCalls.length = 0;
  rpcResult = { data: 0, error: null };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("EIN purge cron", () => {
  it("refuses callers without the cron secret and does nothing", async () => {
    authFailure = new Response("Unauthorized", { status: 401 });
    const response = await POST(new Request("https://x.test", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });
  it("runs the 30-day sweep and reports a count only", async () => {
    rpcResult = { data: 2, error: null };
    const response = await POST(new Request("https://x.test", { method: "POST" }));
    expect(await response.json()).toEqual({ ok: true, purged: 2 });
    expect(rpcCalls).toEqual(["purge_due_sms_onboarding_eins"]);
  });
  it("a database failure is a generic 500 with no detail", async () => {
    rpcResult = { data: null, error: { code: "XX000" } };
    const response = await POST(new Request("https://x.test", { method: "POST" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false });
  });
  it("Vercel Cron calls with GET: same secret check, same sweep, same count-only reply, never cached", async () => {
    authFailure = new Response("Unauthorized", { status: 401 });
    expect((await GET(new Request("https://x.test"))).status).toBe(401);
    expect(rpcCalls).toEqual([]);
    authFailure = null;
    rpcResult = { data: 4, error: null };
    const response = await GET(new Request("https://x.test"));
    expect(await response.json()).toEqual({ ok: true, purged: 4 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpcCalls).toEqual(["purge_due_sms_onboarding_eins"]);
  });
  it("is registered in vercel.json as a daily schedule on the GET route", async () => {
    const config = JSON.parse((await import("node:fs")).readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(config.crons).toContainEqual({ path: "/api/cron/sms-onboarding-purge", schedule: "17 3 * * *" });
  });
});
