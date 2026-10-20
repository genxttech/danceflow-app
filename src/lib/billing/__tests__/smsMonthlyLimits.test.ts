import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
let signedIn: { id: string } | null = { id: "u1" };
let studioContext: { studioId: string; userId: string } | null = { studioId: "s1", userId: "u1" };
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcResult: { data: unknown; error: { code?: string } | null } = { data: { limit_cents: 700, previous_limit_cents: 0, effective_month: "2026-10", spend_cents: 0 }, error: null };
const userClientCalls: string[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: signedIn } }) },
    rpc: async (fn: string) => {
      userClientCalls.push(fn);
      return { data: null, error: { code: "42501" } };
    },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  }),
}));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => studioContext }));

import SmsLimitPanel, { dollarsToCents } from "@/app/app/settings/sms/SmsLimitPanel";
import { saveMonthlyLimitCall, saveTimezoneCall } from "../smsMonthlyLimitsClient";
import { getMonthlyLimitOverview, parseMonthlyLimitOverview, setEntityTimezone, setMonthlyLimit, smsMonthlyLimitsEnabled } from "../smsMonthlyLimits";

const raw = (over: Record<string, unknown> = {}) => ({
  legal_business: true, month: "2026-11", timezone: "America/New_York", next_month_timezone: "America/New_York", limit_cents: 5000, ceiling_cents: 50000, effective_limit_cents: 5000,
  next_month_limit_cents: 5000, on_hold: false, available_cents: 3000, pilot_business: false,
  parts: { usage_cents: 1200, recurring_cents: 1500, reserved_cents: 500, total_cents: 3200, starts_at: "2026-11-01T04:00:00Z", ends_at: "2026-12-01T05:00:00Z" },
  recent_changes: [
    { effective_month: "2026-11", limit_cents: 5000, previous_limit_cents: 0, spend_at_change_cents: 0, changed_by_role: "owner", created_at: "2026-11-02T10:00:00Z" },
    { effective_month: "2026-11", limit_cents: 1, previous_limit_cents: 0, spend_at_change_cents: 0, changed_by_role: "hacker", created_at: "2026-11-02T10:00:00Z" },
  ],
  ...over,
});
const html = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SmsLimitPanel, { overview: parseMonthlyLimitOverview(raw(over)), isOwner: true, enabled: true, initialOpen: true, ...props }));

beforeEach(() => {
  rpcCalls.length = 0;
  userClientCalls.length = 0;
  signedIn = { id: "u1" };
  studioContext = { studioId: "s1", userId: "u1" };
  rpcResult = { data: { limit_cents: 700, previous_limit_cents: 0, effective_month: "2026-10", spend_cents: 0 }, error: null };
  delete process.env.SMS_MONTHLY_LIMITS;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
});

describe("parsing and the feature switch", () => {
  it("is dark unless exactly 'on'", () => {
    expect(smsMonthlyLimitsEnabled({})).toBe(false);
    expect(smsMonthlyLimitsEnabled({ SMS_MONTHLY_LIMITS: "true" })).toBe(false);
    expect(smsMonthlyLimitsEnabled({ SMS_MONTHLY_LIMITS: " ON " })).toBe(true);
  });
  it("parses the overview defensively: junk becomes zeros, an unknown change author is dropped", () => {
    const o = parseMonthlyLimitOverview(raw());
    expect(o).toMatchObject({ legalBusiness: true, limitCents: 5000, ceilingCents: 50000, usageCents: 1200, recurringCents: 1500, setAsideCents: 500, spentCents: 3200 });
    expect(o.recentChanges).toHaveLength(1);
    expect(parseMonthlyLimitOverview(null)).toMatchObject({ legalBusiness: false, limitCents: 0, ceilingCents: 0, recentChanges: [] });
    expect(parseMonthlyLimitOverview({ limit_cents: "abc", ceiling_cents: "2500" })).toMatchObject({ limitCents: 0, ceilingCents: 2500 });
  });
  it("the overview read returns null when the database refuses or the feature is not installed", async () => {
    expect(await getMonthlyLimitOverview({ rpc: async () => ({ data: null, error: { code: "42883" } }) } as never, "s1")).toBeNull();
    expect(await getMonthlyLimitOverview({ rpc: async () => ({ data: raw(), error: null }) } as never, "s1")).toMatchObject({ limitCents: 5000 });
  });
});

describe("setMonthlyLimit / setEntityTimezone", () => {
  const client = (result: { data?: unknown; error?: { code: string } | null }) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return { calls, client: { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { data: result.data ?? null, error: result.error ?? null }) } as never };
  };
  const base = { studioId: "s1", userId: "u1", limitCents: 700, confirmed: true };
  it("sends exactly the confirmed change with the given user and returns the parsed result", async () => {
    const { calls, client: c } = client({ data: { limit_cents: 700, previous_limit_cents: 100, effective_month: "2026-11", spend_cents: 40 } });
    expect(await setMonthlyLimit(c, base)).toEqual({ limitCents: 700, previousLimitCents: 100, effectiveMonth: "2026-11", spendCents: 40 });
    expect(calls).toEqual([{ fn: "tw4_monthly_limit_set", args: { p_studio_id: "s1", p_user_id: "u1", p_limit_cents: 700, p_effective_month: null, p_confirmed: true, p_reason: null } }]);
  });
  it("rejects unconfirmed, fractional, negative and malformed input before any database call", async () => {
    const { calls, client: c } = client({ data: {} });
    for (const bad of [{ confirmed: false }, { limitCents: 1.5 }, { limitCents: -1 }, { effectiveMonth: "2026-13" }, { effectiveMonth: "next" }]) {
      await expect(setMonthlyLimit(c, { ...base, ...bad } as never)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(calls).toHaveLength(0);
  });
  it("maps database refusals to plain codes", async () => {
    for (const [code, expected] of [["42501", "not_authorized"], ["TW010", "no_legal_business"], ["22023", "invalid"], ["TW013", "above_ceiling"], ["TW007", "blocked"], ["TW014", "reauth_required"], ["57014", "unavailable"]] as const) {
      await expect(setMonthlyLimit(client({ error: { code } }).client, base)).rejects.toMatchObject({ code: expected });
      await expect(setEntityTimezone(client({ error: { code } }).client, { studioId: "s1", userId: "u1", timezone: "UTC", reason: "moved" })).rejects.toMatchObject({ code: expected });
    }
  });
  it("timezone: needs a zone and a reason before any call", async () => {
    const { calls, client: c } = client({ data: { timezone: "UTC", effective_month: "2026-12" } });
    await expect(setEntityTimezone(c, { studioId: "s1", userId: "u1", timezone: "", reason: "moved" })).rejects.toMatchObject({ code: "invalid" });
    await expect(setEntityTimezone(c, { studioId: "s1", userId: "u1", timezone: "UTC", reason: " " })).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toHaveLength(0);
    expect(await setEntityTimezone(c, { studioId: "s1", userId: "u1", timezone: "UTC", reason: "moved" })).toEqual({ timezone: "UTC", effectiveMonth: "2026-12" });
  });
});

describe("client calls", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("post to the right routes with the confirmation; failures never throw and say nothing changed", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const spy = (async (url: string, init?: RequestInit) => ((sent = { url, body: JSON.parse(String(init?.body)) }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    expect(await saveMonthlyLimitCall({ limitCents: 700 }, spy)).toEqual({ ok: true });
    expect(sent).toEqual({ url: "/api/billing/sms-limits/set", body: { limitCents: 700, confirmed: true, effectiveMonth: null, reason: null } });
    await saveTimezoneCall({ timezone: "UTC", reason: "moved" }, spy);
    expect(sent).toEqual({ url: "/api/billing/sms-limits/timezone", body: { timezone: "UTC", reason: "moved" } });
    expect(await saveMonthlyLimitCall({ limitCents: 1 }, respond(404, {}))).toEqual({ ok: false, message: "Spending limits are not open yet." });
    expect(await saveMonthlyLimitCall({ limitCents: 1 }, respond(403, { error: "Sign in again.", code: "reauth_required" }))).toEqual({ ok: false, message: "Sign in again.", code: "reauth_required" });
    const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await saveTimezoneCall({ timezone: "UTC", reason: "moved" }, boom)).toMatchObject({ ok: false, message: expect.stringContaining("Nothing was changed") });
  });
});

describe("routes", () => {
  const post = async (path: "set" | "timezone", body: unknown) => {
    const { NextRequest } = await import("next/server");
    const route = await import(`@/app/api/billing/sms-limits/${path}/route`);
    const response = await route.POST(new NextRequest(`https://example.test/api/billing/sms-limits/${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } }));
    return { status: response.status, json: await response.json().catch(() => ({})) };
  };
  it("dark by default: 404 and no database call", async () => {
    expect((await post("set", { limitCents: 100, confirmed: true })).status).toBe(404);
    expect((await post("timezone", { timezone: "UTC", reason: "moved" })).status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });
  it("set: needs a session, a studio, a valid confirmed body; studio and user come from the session, never the body", async () => {
    process.env.SMS_MONTHLY_LIMITS = "on";
    signedIn = null;
    expect((await post("set", { limitCents: 100, confirmed: true })).status).toBe(401);
    signedIn = { id: "u1" };
    studioContext = null;
    expect((await post("set", { limitCents: 100, confirmed: true })).status).toBe(400);
    studioContext = { studioId: "s1", userId: "u1" };
    for (const bad of ["not json", {}, { limitCents: 100 }, { limitCents: 100, confirmed: "yes" }, { limitCents: -5, confirmed: true }, { limitCents: 1.5, confirmed: true }, { limitCents: 2_000_000, confirmed: true }, { limitCents: 100, confirmed: true, effectiveMonth: "soon" }]) {
      expect((await post("set", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
    const ok = await post("set", { limitCents: 700, confirmed: true, studioId: "other", userId: "other-user", legalEntityId: "e9" });
    expect(ok.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({ fn: "tw4_monthly_limit_set", args: { p_studio_id: "s1", p_user_id: "u1", p_limit_cents: 700, p_confirmed: true } });
    expect(JSON.stringify(rpcCalls[0].args)).not.toMatch(/other|e9/);
    expect(userClientCalls).toEqual([]);
  });
  it("set: maps database refusals to statuses without leaking details", async () => {
    process.env.SMS_MONTHLY_LIMITS = "on";
    for (const [code, status] of [["42501", 403], ["TW010", 409], ["TW013", 409], ["TW007", 409], ["TW014", 403], ["22023", 400], ["57014", 503]] as const) {
      rpcResult = { data: null, error: { code } };
      const r = await post("set", { limitCents: 700, confirmed: true });
      expect(r.status, code).toBe(status);
      expect(JSON.stringify(r.json)).not.toContain(code === "57014" ? "57014" : "SELECT");
    }
  });
  it("timezone: session-bound, needs a zone and a reason, maps refusals", async () => {
    process.env.SMS_MONTHLY_LIMITS = "on";
    signedIn = null;
    expect((await post("timezone", { timezone: "UTC", reason: "moved" })).status).toBe(401);
    signedIn = { id: "u1" };
    for (const bad of ["nope", {}, { timezone: "UTC" }, { timezone: "", reason: "moved" }, { timezone: "UTC", reason: "" }]) expect((await post("timezone", bad)).status, JSON.stringify(bad)).toBe(400);
    expect(rpcCalls).toHaveLength(0);
    rpcResult = { data: { timezone: "UTC", effective_month: "2026-12" }, error: null };
    expect((await post("timezone", { timezone: "UTC", reason: "the studio moved", studioId: "other" })).status).toBe(200);
    expect(rpcCalls[0]).toMatchObject({ fn: "tw4_entity_timezone_set", args: { p_studio_id: "s1", p_user_id: "u1", p_timezone: "UTC" } });
    rpcResult = { data: null, error: { code: "42501" } };
    expect((await post("timezone", { timezone: "UTC", reason: "the studio moved" })).status).toBe(403);
  });
});

describe("panel", () => {
  it("amount parsing accepts plain dollars and cents only", () => {
    expect(dollarsToCents("50")).toBe(5000);
    expect(dollarsToCents("$12.5")).toBe(1250);
    expect(dollarsToCents("0.05")).toBe(5);
    for (const bad of ["", "-5", "1e3", "12.345", "abc", "1,000"]) expect(dollarsToCents(bad), bad).toBeNull();
  });
  it("shows spending, the limit, room left, the breakdown, the month window and recent changes; never provider costs", () => {
    const out = html();
    expect(out).toContain("Monthly spending limit");
    expect(out).toContain("$32.00");
    expect(out).toContain("$50.00");
    expect(out).toContain("$18.00");
    expect(out).toContain("2026-11-01");
    expect(out).toContain("by the owner");
    expect(out).not.toMatch(/provider|hacker/i);
  });
  it("warns when no limit is set, when it is used up, when capped by the ceiling, on hold, and for the pilot business", () => {
    expect(html({ limit_cents: 0, effective_limit_cents: 0 })).toContain("No monthly limit is set");
    expect(html({}, {})).not.toContain("No monthly limit is set");
    expect(html({ parts: { total_cents: 5000 } })).toContain("limit is used up");
    expect(html({ limit_cents: 90000, effective_limit_cents: 50000 })).toContain("Capped by the platform safety ceiling");
    expect(html({ on_hold: true })).toContain("on hold");
    expect(html({ pilot_business: true })).toContain("never resets");
  });
  it("owners get the form and timezone picker; others only see; a business without a legal entity renders nothing; a dark environment disables saving", () => {
    expect(html({}, { initialDollars: "70" })).toContain("Set the limit to $70.00");
    expect(html({}, { initialDollars: "70" })).toContain("Change from <span class=\"font-semibold\">$50.00</span>");
    expect(html({}, { initialDollars: "70" })).toContain("signed in within the last 15 minutes"); // an increase warns about the security check
    expect(html({}, { initialDollars: "20" })).not.toContain("signed in within the last 15 minutes");
    expect(html({}, { initialDollars: "900" })).toContain("above the platform safety ceiling");
    expect(html()).toContain("Change timezone from next month");
    const viewer = html({}, { isOwner: false });
    expect(viewer).toContain("Only the studio owner can change");
    expect(viewer).not.toContain("Set the limit to");
    expect(html({ legal_business: false })).toBe("");
    expect(html({}, { enabled: false })).toContain("not open yet");
  });
});
