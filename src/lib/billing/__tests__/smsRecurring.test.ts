import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
let signedIn: { id: string } | null = { id: "u1" };
let studioContext: { studioId: string; userId: string } | null = { studioId: "s1", userId: "u1" };
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcResult: { data: unknown; error: { code?: string } | null } = { data: { authorization_id: "a1" }, error: null };
const userClientCalls: string[] = [];
// the user's own session is only used to learn who they are; every database call goes through the service-role client built by the route
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

import SmsRecurringPanel from "@/app/app/settings/sms/SmsRecurringPanel";
import SmsCreditAdmin from "@/app/platform/sms/SmsCreditAdmin";
import { authorizeRecurringCall, revokeRecurringCall } from "../smsRecurringClient";
import {
  authorizeRecurring,
  buildAuthorizationStatement,
  getRecurringAdminOverview,
  getRecurringOverview,
  parseRecurringAdminOverview,
  parseRecurringOverview,
  periodKeyFor,
  revokeRecurring,
  runDueRecurringCharges,
  smsRecurringAuthorizationEnabled,
  type RecurringOverview,
} from "../smsRecurring";

const raw = (over: Record<string, unknown> = {}) => ({
  legal_business: true, expected_monthly_cents: 2000, available_cents: 5000, months_covered: 2, low_for_recurring: false, on_hold: false, service_state: "active",
  authorizations: [
    { id: "a1", kind: "monthly", price_cents: 1500, term_months: 3, total_limit_cents: 4500, spent_cents: 1500, expires_at: "2027-01-19T00:00:00Z", status: "active", this_location: true, last_status: "charged", last_period: "2026-10" },
    { id: "a2", kind: "number", price_cents: 500, term_months: 12, total_limit_cents: 6000, spent_cents: 0, expires_at: "2027-10-19T00:00:00Z", status: "active", this_location: false, last_status: "unfunded", last_period: "2026-10" },
    { id: "a3", kind: "number", price_cents: 500, term_months: 1, total_limit_cents: 500, spent_cents: 0, expires_at: "2026-11-19T00:00:00Z", status: "revoked", this_location: true, last_status: null, last_period: null },
  ],
  ...over,
});
const prices = [
  { kind: "number", customerPriceCents: 500, description: "Texting phone number" },
  { kind: "monthly", customerPriceCents: 1500, description: "Monthly texting service" },
];
const html = (over: Record<string, unknown> = {}, props: Partial<Parameters<typeof SmsRecurringPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(SmsRecurringPanel, { overview: parseRecurringOverview(raw(over)), prices, isOwner: true, enabled: true, ...props }));

beforeEach(() => {
  signedIn = { id: "u1" };
  studioContext = { studioId: "s1", userId: "u1" };
  rpcCalls.length = 0;
  userClientCalls.length = 0;
  rpcResult = { data: { authorization_id: "a1" }, error: null };
  delete process.env.SMS_RECURRING_AUTHORIZATION;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
});

describe("acknowledgement text and flag", () => {
  it("states price, frequency, term, total limit, funding source, no card, no auto top-up, revocability and pending terms", () => {
    const text = buildAuthorizationStatement({ kind: "number", priceCents: 500, termMonths: 1, totalLimitCents: 500 });
    expect(text).toContain("$5.00 per month for texting phone number rent");
    expect(text).toContain("up to 1 month and no more than $5.00 in total");
    expect(text).toContain("prepaid texting credit");
    expect(text).toContain("No card is charged, no credit is added automatically, and I can revoke this at any time.");
    expect(text).toContain("pending approval");
    expect(buildAuthorizationStatement({ kind: "monthly", priceCents: 1500, termMonths: 12, totalLimitCents: 18000 })).toContain("12 months and no more than $180.00");
  });
  it("the feature is off unless explicitly on", () => {
    expect(smsRecurringAuthorizationEnabled({})).toBe(false);
    expect(smsRecurringAuthorizationEnabled({ SMS_RECURRING_AUTHORIZATION: "1" })).toBe(false);
    expect(smsRecurringAuthorizationEnabled({ SMS_RECURRING_AUTHORIZATION: " ON " })).toBe(true);
  });
  it("the service period is the UTC month", () => {
    expect(periodKeyFor(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(periodKeyFor(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
  });
});

describe("parsers", () => {
  it("never trust the shape: garbage becomes a safe empty overview", () => {
    expect(parseRecurringOverview(null)).toMatchObject({ legalBusiness: false, expectedMonthlyCents: 0, serviceState: "none", authorizations: [] });
    expect(parseRecurringOverview(raw({ service_state: "weird" })).serviceState).toBe("none");
    expect(parseRecurringOverview(raw({ service_issue: "limit" })).serviceIssue).toBe("limit");
    expect(parseRecurringOverview(raw({ service_issue: "nonsense" })).serviceIssue).toBeNull();
    const parsed = parseRecurringOverview(raw({ authorizations: [{ id: "x", kind: "sms_usage", status: "active" }, { id: "y", kind: "number", status: "pending" }, { kind: "number", status: "active" }, ...raw().authorizations] }));
    expect(parsed.authorizations.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(parseRecurringAdminOverview(undefined)).toEqual({ activeAuthorizations: 0, needsAttention: [] });
  });
  it("a refused or missing read is null, so the screen shows nothing", async () => {
    const fake = (error: { code: string } | null) => ({ rpc: async () => ({ data: raw(), error }) }) as never;
    expect(await getRecurringOverview(fake({ code: "42501" }), "s1")).toBeNull();
    expect(await getRecurringOverview(fake({ code: "PGRST202" }), "s1")).toBeNull(); // not installed in this environment
    expect(await getRecurringAdminOverview(fake({ code: "42501" }))).toBeNull();
  });
});

describe("authorizeRecurring / revokeRecurring", () => {
  const client = (result: { data?: unknown; error?: { code: string } | null }) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return { calls, client: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: result.data ?? null, error: result.error ?? null }; } } as never };
  };
  const input = { studioId: "s1", userId: "u1", kind: "monthly" as const, acknowledgedPriceCents: 1500, termMonths: 3, totalLimitCents: 4500 };
  it("calls only the service-role owner function with the user id, and sends NO acknowledgement text (the database writes it)", async () => {
    const { calls, client: c } = client({ data: { authorization_id: "auth-9" } });
    expect(await authorizeRecurring(c, input)).toEqual({ authorizationId: "auth-9" });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("tw4_recurring_authorize");
    expect(calls[0].args).toEqual({ p_studio_id: "s1", p_user_id: "u1", p_kind: "monthly", p_acknowledged_price_cents: 1500, p_term_months: 3, p_total_limit_cents: 4500 });
  });
  it("maps database refusals to plain codes and rejects bad input before any call", async () => {
    for (const [code, expected] of [["42501", "not_authorized"], ["TW010", "no_legal_business"], ["TW008", "price_changed"], ["23505", "already_authorized"], ["22023", "invalid"], ["57014", "unavailable"]] as const) {
      const { client: c } = client({ error: { code } });
      await expect(authorizeRecurring(c, input)).rejects.toMatchObject({ code: expected });
      await expect(revokeRecurring(c, "a1", "u1")).rejects.toMatchObject({ code: expected });
    }
    const { calls, client: c } = client({ data: {} });
    await expect(authorizeRecurring(c, { ...input, termMonths: 5 })).rejects.toMatchObject({ code: "invalid" });
    await expect(authorizeRecurring(c, { ...input, acknowledgedPriceCents: 0 })).rejects.toMatchObject({ code: "invalid" });
    await expect(authorizeRecurring(c, input)).rejects.toMatchObject({ code: "unavailable" }); // an answer without an id is not success
    expect(calls).toHaveLength(1);
  });
});

describe("runDueRecurringCharges", () => {
  const fake = (due: unknown, outcomes: Record<string, { data?: unknown; error?: { code: string } }>) => {
    const calls: string[] = [];
    return {
      calls,
      client: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push(fn === "tw4_recurring_charge" ? `${fn}:${String(args.p_authorization_id)}:${String(args.p_period_key)}` : fn);
          if (fn === "tw4_recurring_due") return due as { data: unknown; error: null };
          const o = outcomes[String(args.p_authorization_id)] ?? { data: { outcome: "charged", replayed: false } };
          return { data: o.data ?? null, error: o.error ?? null };
        },
      } as never,
    };
  };
  it("charges each due authorization once for the current UTC month, counts every outcome, and one failure never stops the rest", async () => {
    const { calls, client } = fake({ data: ["a", "b", "c", "d", "e", 7], error: null }, {
      b: { data: { outcome: "unfunded" } }, c: { data: { outcome: "held" } }, d: { data: { outcome: "refused" } }, e: { error: { code: "40001" } },
    });
    const summary = await runDueRecurringCharges(client, new Date("2026-10-19T10:00:00Z"));
    // the previous month is asked first (an unpaid one is retried once credit arrives), then the current one; the fake answers the same for both
    expect(summary).toEqual({ period: "2026-10", periods: ["2026-09", "2026-10"], due: 10, charged: 2, unfunded: 2, held: 2, refused: 2, replayed: 0, errors: 2 });
    expect(calls.slice(0, 7)).toEqual(["tw4_recurring_due", "tw4_recurring_charge:a:2026-09", "tw4_recurring_charge:b:2026-09", "tw4_recurring_charge:c:2026-09", "tw4_recurring_charge:d:2026-09", "tw4_recurring_charge:e:2026-09", "tw4_recurring_due"]);
    expect(calls[7]).toBe("tw4_recurring_charge:a:2026-10");
  });
  it("a replayed charge is not counted as a new one; a failed due-query stops the run loudly", async () => {
    const { client } = fake({ data: ["a"], error: null }, { a: { data: { outcome: "charged", replayed: true } } });
    expect(await runDueRecurringCharges(client, new Date("2026-10-19T10:00:00Z"))).toMatchObject({ charged: 0, replayed: 2 });
    expect(await runDueRecurringCharges(client, new Date("2026-01-05T10:00:00Z"))).toMatchObject({ periods: ["2025-12", "2026-01"] }); // across a year boundary
    const { client: broken } = fake({ data: null, error: { code: "XX000" } }, {});
    await expect(runDueRecurringCharges(broken, new Date())).rejects.toThrow("recurring due query failed");
  });
});

describe("client calls", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("authorize and revoke post to the right routes; failures say nothing was charged and never throw", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const spy = (async (url: string, init?: RequestInit) => { sent = { url, body: JSON.parse(String(init?.body)) }; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    expect(await authorizeRecurringCall({ kind: "monthly", acknowledgedPriceCents: 1500, termMonths: 3, totalLimitCents: 4500 }, spy)).toEqual({ ok: true });
    expect(sent).toEqual({ url: "/api/billing/sms-recurring/authorize", body: { kind: "monthly", acknowledgedPriceCents: 1500, termMonths: 3, totalLimitCents: 4500 } });
    await revokeRecurringCall("a1", spy);
    expect(sent).toEqual({ url: "/api/billing/sms-recurring/revoke", body: { authorizationId: "a1" } });
    expect(await revokeRecurringCall("a1", respond(404, {}))).toEqual({ ok: false, message: "Recurring charges are not open yet." });
    expect(await revokeRecurringCall("a1", respond(409, { error: "The price changed." }))).toEqual({ ok: false, message: "The price changed." });
    const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await authorizeRecurringCall({ kind: "number", acknowledgedPriceCents: 500, termMonths: 1, totalLimitCents: 500 }, boom)).toMatchObject({ ok: false, message: expect.stringContaining("Nothing was charged") });
  });
});

describe("routes", () => {
  const post = async (path: "authorize" | "revoke", body: unknown) => {
    const { NextRequest } = await import("next/server");
    const route = await import(`@/app/api/billing/sms-recurring/${path}/route`);
    const response = await route.POST(new NextRequest(`https://example.test/api/billing/sms-recurring/${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } }));
    return { status: response.status, json: await response.json().catch(() => ({})) };
  };
  const good = { kind: "monthly", acknowledgedPriceCents: 1500, termMonths: 3, totalLimitCents: 4500 };
  it("dark by default: 404 and no database call for both routes", async () => {
    expect((await post("authorize", good)).status).toBe(404);
    expect((await post("revoke", { authorizationId: "6f1d5b2e-3b1a-4f0e-9d3a-0c2b8f7a1e11" })).status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });
  it("authorize: signed in, a studio, a valid body; the studio comes from the session, never the body; the user's own client makes the call", async () => {
    process.env.SMS_RECURRING_AUTHORIZATION = "on";
    signedIn = null;
    expect((await post("authorize", good)).status).toBe(401);
    signedIn = { id: "u1" };
    studioContext = null;
    expect((await post("authorize", good)).status).toBe(400);
    studioContext = { studioId: "s1", userId: "u1" };
    for (const bad of ["not json", { ...good, kind: "sms_usage" }, { ...good, kind: "brand" }, { ...good, termMonths: 5 }, { ...good, acknowledgedPriceCents: 0 }, { ...good, acknowledgedPriceCents: 1.5 }, { ...good, totalLimitCents: 1499 }, { ...good, totalLimitCents: 4501 }, { ...good, totalLimitCents: 3000 }, {}, { ...good, kind: undefined }]) {
      expect((await post("authorize", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
    const ok = await post("authorize", { ...good, studioId: "someone-elses-studio", legalEntityId: "e9", userId: "someone-else", statement: "I agree to anything" });
    expect(ok).toEqual({ status: 200, json: { authorizationId: "a1" } });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("tw4_recurring_authorize");
    expect(rpcCalls[0].args).toMatchObject({ p_studio_id: "s1", p_user_id: "u1" }); // the studio and the user come from the session, never from the body
    const sent = JSON.stringify(rpcCalls[0].args);
    expect(sent).not.toContain("someone-elses-studio");
    expect(sent).not.toContain("someone-else");
    expect(sent).not.toContain("I agree to anything"); // the acknowledgement text is not accepted from the browser
    expect(userClientCalls).toEqual([]); // the user's own client makes no database call at all
  });
  it("authorize maps database refusals to statuses without leaking details", async () => {
    process.env.SMS_RECURRING_AUTHORIZATION = "on";
    for (const [code, status] of [["42501", 403], ["TW010", 409], ["TW008", 409], ["23505", 409], ["22023", 400], ["57014", 503]] as const) {
      rpcResult = { data: null, error: { code } };
      expect((await post("authorize", good)).status, code).toBe(status);
    }
  });
  it("revoke: a signed-in caller and a well-formed id only; the database decides ownership", async () => {
    process.env.SMS_RECURRING_AUTHORIZATION = "on";
    signedIn = null;
    expect((await post("revoke", { authorizationId: "6f1d5b2e-3b1a-4f0e-9d3a-0c2b8f7a1e11" })).status).toBe(401);
    signedIn = { id: "u1" };
    for (const bad of ["nope", {}, { authorizationId: "1; drop table" }, { authorizationId: 5 }]) expect((await post("revoke", bad)).status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
    rpcResult = { data: { status: "revoked" }, error: null };
    expect((await post("revoke", { authorizationId: "6f1d5b2e-3b1a-4f0e-9d3a-0c2b8f7a1e11" })).status).toBe(200);
    expect(rpcCalls.at(-1)).toEqual({ fn: "tw4_recurring_revoke", args: { p_authorization_id: "6f1d5b2e-3b1a-4f0e-9d3a-0c2b8f7a1e11", p_user_id: "u1" } });
    rpcResult = { data: null, error: { code: "42501" } };
    expect((await post("revoke", { authorizationId: "6f1d5b2e-3b1a-4f0e-9d3a-0c2b8f7a1e11" })).status).toBe(403);
  });
});

describe("recurring panel", () => {
  it("states what is authorized, what it costs a month and how many months the credit covers; revoked ones are labelled", () => {
    const out = html({}, { initialOpen: true });
    expect(out).toContain("$20.00 a month from your credit");
    expect(out).toContain("covers 2 months");
    expect(out).toContain("monthly texting service");
    expect(out).toContain("$15.00 a month · up to $45.00");
    expect(out).toContain("revoked");
    expect(out).toContain("last attempt: not enough credit");
    expect(out).not.toMatch(/provider/i);
  });
  it("owners get Revoke (only for this location's active ones) and the authorize form; others only see", () => {
    const owner = html({}, { initialOpen: true });
    expect(owner).toContain("Revoke");
    expect(owner.match(/>Revoke</g)).toHaveLength(1); // a1 is this location and active; a2 is another location; a3 is revoked
    expect(owner).toContain("Authorize a monthly charge for this location");
    const admin = html({}, { initialOpen: true, isOwner: false });
    expect(admin).not.toContain(">Revoke<");
    expect(admin).not.toContain("Authorize a monthly charge");
    expect(admin).toContain("Only the studio owner can authorize or revoke");
    expect(html({}, { isOwner: false })).toContain("View");
  });
  it("the form shows price, term, total limit and the plain promises, requires the checkbox, and is disabled while the flag is off or nothing is chosen", () => {
    const filled = html({ authorizations: [] }, { initialOpen: true, initialKind: "monthly", initialTerm: 6 });
    // the owner reads, word for word, the statement the database will store
    expect(filled).toContain(buildAuthorizationStatement({ kind: "monthly", priceCents: 1500, termMonths: 6, totalLimitCents: 9000 }).replace("legal business's", "legal business&#x27;s"));
    expect(filled).toContain("up to 6 months and no more than $90.00 in total");
    expect(filled).toContain("No card is charged, no credit is added automatically");
    expect(filled).toContain("Final prices and terms are pending approval");
    expect(filled).toContain("I agree to the statement above.");
    expect(filled).toMatch(/<button[^>]*disabled=""[^>]*>Authorize</); // not agreed yet
    expect(html({}, { initialOpen: true, enabled: false })).toContain("Recurring charges are not open yet.");
    expect(html({ authorizations: [] }, { initialOpen: true, prices: [] })).toContain("Price not published");
  });
  it("a fee that is already authorized for this location cannot be authorized twice from the form", () => {
    const out = html({}, { initialOpen: true });
    expect(out).toContain("authorized");
    expect(out).toMatch(/<input[^>]*disabled=""[^>]*value="monthly"|<input[^>]*value="monthly"[^>]*disabled=""/);
  });
  it("warnings: credit below what is coming, a payment not covered, suspension, and hold; numbers are always said to be kept", () => {
    expect(html({ low_for_recurring: true, available_cents: 900 })).toContain("below the next monthly charges ($20.00)");
    const past = html({ service_state: "past_due", service_issue: "unfunded" });
    expect(past).toContain("A monthly charge is due.");
    expect(past).toContain("not enough credit");
    const suspended = html({ service_state: "suspended", service_issue: "unfunded" });
    expect(suspended).toContain("marked as paused");
    expect(suspended).toContain("phone numbers are kept");
    expect(suspended).not.toContain("Texting is paused"); // nothing consumes the state yet: the screen says what is recorded, not what the sender does
    expect(html({ on_hold: true })).toContain("on hold by DanceFlow");
    expect(html({})).not.toContain("role=\"alert\"");
    expect(html({}, { initialOpen: true })).toContain("your phone numbers are kept");
    expect(html({}, { initialOpen: true })).not.toMatch(/texting pauses/i);
    expect(html({}, { initialOpen: true })).not.toMatch(/release|cancel your number|delete your number/i);
  });
  it("the next step matches the cause: credit, a hold, a used-up limit and a changed price each say different things, and only credit is fixed by adding credit", () => {
    const text = (issue: string) => html({ service_state: "suspended", service_issue: issue });
    expect(text("unfunded")).toContain("Add credit");
    expect(text("held")).toContain("on hold by DanceFlow");
    expect(text("held")).not.toContain("Add credit");
    expect(text("limit")).toContain("Authorize again to continue");
    expect(text("limit")).not.toContain("Add credit");
    expect(text("price")).toContain("price changed since you authorized");
    expect(text("price")).not.toContain("Add credit");
  });
  it("while the feature is off the card shows only when something already exists", () => {
    expect(html({ authorizations: [] }, { enabled: false })).toBe("");
    expect(html({}, { enabled: false })).toContain("Monthly texting charges");
  });
  it("nothing is shown for a studio without a verified legal business, and nothing mentions a card on file or an automatic top-up as a feature", () => {
    expect(html({ legal_business: false })).toBe("");
    expect(html({}, { initialOpen: true })).not.toMatch(/auto-?reload|auto-?recharge|saved card/i);
  });
});

describe("platform admin recurring section", () => {
  it("lists charges that were not taken with reason and attempts; read only", () => {
    const recurring = parseRecurringAdminOverview({ active_authorizations: 4, needs_attention: [{ legal_name: "Beta LLC", kind: "number", period_key: "2026-10", amount_cents: 500, status: "unfunded", reason: "insufficient settled credit", attempts: 3 }] });
    const out = renderToStaticMarkup(createElement(SmsCreditAdmin, { overview: { prices: [], accounts: [], stalePending: [], variances: [], pilot: null }, recurring }));
    expect(out).toContain("Recurring charges (4 active, 1 not charged)");
    expect(out).toContain("Beta LLC");
    expect(out).toContain("3 attempts");
    expect(out).not.toMatch(/<form|<button|<input/);
    expect(renderToStaticMarkup(createElement(SmsCreditAdmin, { overview: { prices: [], accounts: [], stalePending: [], variances: [], pilot: null }, recurring: null }))).not.toContain("Recurring charges");
  });
});

describe("overview type guard used by the page", () => {
  it("a null overview hides the card (the page renders it only when both reads succeeded)", () => {
    const overview: RecurringOverview | null = null;
    expect(overview).toBeNull();
  });
});
