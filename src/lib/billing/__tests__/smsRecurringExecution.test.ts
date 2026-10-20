import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
const adminCalls: { fn: string; args: Record<string, unknown> }[] = [];
let adminHandler: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { code: string } | null } = () => ({ data: null, error: null });
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      adminCalls.push({ fn, args });
      const out = adminHandler(fn, args);
      return { data: out.data ?? null, error: out.error ?? null };
    },
  }),
}));

import SmsRecurringPanel from "@/app/app/settings/sms/SmsRecurringPanel";
import SmsCreditAdmin from "@/app/platform/sms/SmsCreditAdmin";
import { GET, POST } from "@/app/api/cron/sms-recurring/route";
import { parseRecurringAdminOverview, parseRecurringOverview, runScheduledRecurringCharges } from "../smsRecurring";

const fakeClient = (handler: typeof adminHandler) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const out = handler(fn, args);
        return { data: out.data ?? null, error: out.error ?? null };
      },
    } as never,
  };
};

describe("runScheduledRecurringCharges", () => {
  const happy = (overrides: Record<string, ReturnType<typeof adminHandler>> = {}): typeof adminHandler => (fn, args) => {
    if (overrides[fn]) return overrides[fn];
    if (fn === "tw4_recurring_run_begin") return { data: { acquired: true, run_id: "run-1" } };
    if (fn === "tw4_recurring_release_ended") return { data: { released: 0 } };
    if (fn === "tw4_recurring_due_list") return { data: [{ id: "a", period_key: "2026-10" }, { id: "b", period_key: "2026-10" }] };
    if (fn === "tw4_recurring_charge") return { data: { outcome: "charged", replayed: false } };
    return { data: { status: "completed" } };
  };

  it("takes the lease first, charges every due authorization under the run id, then records the outcome", async () => {
    const { calls, client } = fakeClient(happy());
    const outcome = await runScheduledRecurringCharges(client, { runner: "cron:abc12345" });
    expect(outcome).toMatchObject({ ran: true, summary: { periods: ["2026-10"], runId: "run-1", due: 2, charged: 2, errors: 0 } });
    expect(calls.map((c) => c.fn)).toEqual(["tw4_recurring_run_begin", "tw4_recurring_release_ended", "tw4_recurring_due_list", "tw4_recurring_charge", "tw4_recurring_charge", "tw4_recurring_run_finish"]);
    expect(calls[0].args).toEqual({ p_runner: "cron:abc12345", p_lease_seconds: 600 });
    expect(calls.filter((c) => c.fn === "tw4_recurring_charge").every((c) => c.args.p_run_id === "run-1")).toBe(true); // every charge carries the run, so a replaced runner is fenced
    expect(calls.at(-1)?.args).toMatchObject({ p_run_id: "run-1", p_status: "completed", p_error: null });
  });

  it("does nothing, and charges nothing, while the database switch is off or another run holds the lease", async () => {
    for (const reason of ["disabled", "busy"] as const) {
      const { calls, client } = fakeClient(happy({ tw4_recurring_run_begin: { data: { acquired: false, reason } } }));
      expect(await runScheduledRecurringCharges(client, { runner: "cron:abc12345" })).toEqual({ ran: false, reason });
      expect(calls.map((c) => c.fn)).toEqual(["tw4_recurring_run_begin"]);
    }
    for (const odd of [{ acquired: true }, { acquired: "yes", run_id: "x" }, null, "x"]) {
      const { calls, client } = fakeClient(happy({ tw4_recurring_run_begin: { data: odd } }));
      expect((await runScheduledRecurringCharges(client, { runner: "cron:abc12345" })).ran).toBe(false); // an answer it does not understand is not a lease
      expect(calls).toHaveLength(1);
    }
  });

  it("a failed start is an error, not a silent skip", async () => {
    const { client } = fakeClient(happy({ tw4_recurring_run_begin: { error: { code: "57014" } } }));
    await expect(runScheduledRecurringCharges(client, { runner: "cron:abc12345" })).rejects.toThrow("could not start");
  });

  it("one failed charge call marks the run failed with the count, and the other charges still run", async () => {
    const { calls, client } = fakeClient(happy({}));
    let failFirst = true;
    const flaky = { rpc: async (fn: string, args: Record<string, unknown>) => (fn === "tw4_recurring_charge" && args.p_authorization_id === "a" && failFirst && args.p_period_key === "2026-10" ? ((failFirst = false), { data: null, error: { code: "40001" } }) : (client as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<unknown> }).rpc(fn, args)) } as never;
    const outcome = await runScheduledRecurringCharges(flaky, { runner: "cron:abc12345" });
    expect(outcome).toMatchObject({ ran: true, summary: { charged: 1, errors: 1 } });
    expect(calls.at(-1)?.args).toMatchObject({ p_status: "failed", p_error: "1 charge call(s) failed" });
  });

  it("an exception closes the run as failed (best effort) and is rethrown", async () => {
    const { calls, client } = fakeClient(happy({ tw4_recurring_due_list: { error: { code: "XX000" } } }));
    await expect(runScheduledRecurringCharges(client, { runner: "cron:abc12345" })).rejects.toThrow("recurring due query failed");
    expect(calls.at(-1)).toMatchObject({ fn: "tw4_recurring_run_finish", args: { p_run_id: "run-1", p_status: "failed", p_summary: null } });
  });

  it("the code never computes a service month: it charges exactly the periods the database lists", async () => {
    const { calls, client } = fakeClient(happy({ tw4_recurring_due_list: { data: [{ id: "a", period_key: "2026-12" }, { id: "b", period_key: "2027-01" }] } }));
    const outcome = await runScheduledRecurringCharges(client, { runner: "cron:abc12345" });
    expect(outcome).toMatchObject({ ran: true, summary: { periods: ["2026-12", "2027-01"], due: 2 } });
    expect(calls.filter((c) => c.fn === "tw4_recurring_charge").map((c) => c.args.p_period_key)).toEqual(["2026-12", "2027-01"]);
  });
});

describe("the cron route (not registered anywhere; dark twice over)", () => {
  const request = (method: "GET" | "POST", secret?: string) => new Request("https://example.test/api/cron/sms-recurring", { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  beforeEach(() => {
    adminCalls.length = 0;
    adminHandler = () => ({ data: null, error: null });
    delete process.env.SMS_RECURRING_SCHEDULER;
    process.env.CRON_SECRET = "cron-secret-for-tests";
  });

  it("404 and no database call unless the environment switch is on, for every method and even with the right secret", async () => {
    expect((await GET(request("GET", "cron-secret-for-tests"))).status).toBe(404);
    expect((await POST(request("POST", "cron-secret-for-tests"))).status).toBe(404);
    process.env.SMS_RECURRING_SCHEDULER = "true";
    expect((await GET(request("GET", "cron-secret-for-tests"))).status).toBe(404);
    expect(adminCalls).toHaveLength(0);
  });

  it("with the switch on it still needs the cron secret before touching the database", async () => {
    process.env.SMS_RECURRING_SCHEDULER = "on";
    for (const secret of [undefined, "wrong", ""]) {
      const response = await GET(request("GET", secret));
      expect([401, 403]).toContain(response.status);
    }
    delete process.env.CRON_SECRET;
    expect([401, 403, 500, 503]).toContain((await GET(request("GET", "anything"))).status); // no secret configured: nothing is authorized
    expect(adminCalls).toHaveLength(0);
  });

  it("the database kill switch is the second gate: authorized but disabled does nothing and says so", async () => {
    process.env.SMS_RECURRING_SCHEDULER = "on";
    adminHandler = (fn) => (fn === "tw4_recurring_run_begin" ? { data: { acquired: false, reason: "disabled" } } : { data: null });
    const response = await GET(request("GET", "cron-secret-for-tests"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ran: false, reason: "disabled" });
    expect(adminCalls.map((c) => c.fn)).toEqual(["tw4_recurring_run_begin"]);
    expect(String(adminCalls[0].args.p_runner)).toMatch(/^cron:[0-9a-f]{8}$/);
  });

  it("a run returns counts only (no business, no amount, no id); failures answer 500; an exception answers 500 without detail", async () => {
    process.env.SMS_RECURRING_SCHEDULER = "on";
    adminHandler = (fn, args) => {
      if (fn === "tw4_recurring_run_begin") return { data: { acquired: true, run_id: "11111111-1111-4111-8111-111111111111" } };
      if (fn === "tw4_recurring_due_list") return { data: [{ id: "22222222-2222-4222-8222-222222222222", period_key: "2026-10" }] };
      if (fn === "tw4_recurring_charge") return { data: { outcome: "charged", replayed: false, amount_cents: 1500 } };
      return { data: { status: "completed" }, error: null };
    };
    const ok = await POST(request("POST", "cron-secret-for-tests"));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(Object.keys(body).sort()).toEqual(["charged", "due", "errors", "held", "ok", "ran", "refused", "replayed", "unfunded"]);
    expect(JSON.stringify(body)).not.toMatch(/1111|2222|1500/);
    adminHandler = (fn) => (fn === "tw4_recurring_run_begin" ? { data: { acquired: true, run_id: "r" } } : fn === "tw4_recurring_due_list" ? { data: [{ id: "a", period_key: "2026-10" }] } : fn === "tw4_recurring_charge" ? { error: { code: "40001" } } : { data: {} });
    expect((await GET(request("GET", "cron-secret-for-tests"))).status).toBe(500);
    adminHandler = (fn) => (fn === "tw4_recurring_run_begin" ? { error: { code: "XX000" } } : { data: null });
    const boom = await GET(request("GET", "cron-secret-for-tests"));
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ ok: false });
  });

  it("is not registered in vercel.json: nothing calls it on a schedule", () => {
    const vercel = readFileSync(join(process.cwd(), "vercel.json"), "utf8");
    expect(vercel).not.toContain("sms-recurring");
  });
});

describe("panel: the pilot business and the spending cap", () => {
  const overview = (over: Record<string, unknown> = {}) =>
    parseRecurringOverview({ legal_business: true, expected_monthly_cents: 0, available_cents: 0, months_covered: null, low_for_recurring: false, on_hold: false, service_state: "none", authorizations: [], ...over });
  const html = (over: Record<string, unknown>, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(SmsRecurringPanel, { overview: overview(over), prices: [{ kind: "monthly", customerPriceCents: 1500, description: "m" }], isOwner: true, enabled: true, initialOpen: true, ...props } as never));

  it("a pilot business sees no authorize form: each recurring fee is approved one at a time, nothing is charged by a schedule, and the allowance is not credit", () => {
    const out = html({ pilot_business: true });
    expect(out).toContain("Your business is in the DanceFlow pilot");
    expect(out).toContain("one at a time");
    expect(out).toContain("nothing is charged by a schedule");
    expect(out).toContain("not credit and cannot pay for texting");
    expect(out).not.toContain("Authorize a monthly charge");
    expect(out).not.toMatch(/<button[^>]*>Authorize</);
    expect(html({ pilot_business: false })).toContain("Authorize a monthly charge for this location");
  });
  it("the card still shows for a pilot business while the feature flag is off, so the explanation is never hidden", () => {
    expect(html({ pilot_business: true }, { enabled: false, initialOpen: false })).toContain("Monthly texting charges");
    expect(html({ pilot_business: false }, { enabled: false, initialOpen: false })).toBe("");
  });
  it("a spending-cap hold says so and does not tell the owner to add credit", () => {
    const out = html({ service_state: "suspended", service_issue: "cap" }, { initialOpen: false });
    expect(out).toContain("spending limit has been reached");
    expect(out).not.toContain("Add credit");
  });
  it("the parsers carry the new fields", () => {
    expect(overview({ pilot_business: true }).pilotBusiness).toBe(true);
    expect(overview({ service_issue: "cap" }).serviceIssue).toBe("cap");
    expect(overview({}).pilotBusiness).toBe(false);
    const admin = parseRecurringAdminOverview({ scheduler_enabled: true, reconciliation_gaps: 2, recent_runs: [{ runner: "cron:1", status: "failed", started_at: "2026-10-19T10:00:00Z", finished_at: null, error: "x" }, 5] });
    expect(admin).toMatchObject({ schedulerEnabled: true, reconciliationGaps: 2 });
    expect(admin.recentRuns[0]).toMatchObject({ runner: "cron:1", status: "failed", error: "x" });
    expect(parseRecurringAdminOverview(undefined)).toMatchObject({ schedulerEnabled: false, reconciliationGaps: 0, recentRuns: [] });
  });
  it("the platform section shows the switch, the reconciliation count and the last run; read only", () => {
    const recurring = parseRecurringAdminOverview({ scheduler_enabled: false, reconciliation_gaps: 3, recent_runs: [{ runner: "cron:1", status: "completed", started_at: "2026-10-19T10:00:00Z" }], active_authorizations: 1, needs_attention: [] });
    const out = renderToStaticMarkup(createElement(SmsCreditAdmin, { overview: { prices: [], accounts: [], stalePending: [], variances: [], pilot: null }, recurring }));
    expect(out).toContain("Scheduler switch: <span class=\"font-semibold\">off</span>");
    expect(out).toContain("reconciliation gaps: <span class=\"font-semibold\">3</span>");
    expect(out).toContain("last run: completed");
    expect(out).not.toMatch(/<form|<button|<input/);
  });
});
