import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ORGANIZER_SUITE_EXPIRY_ROUTE,
  ORGANIZER_SUITE_EXPIRY_SUGGESTED_SCHEDULE,
  countDueOrganizerSuiteGrants,
  isMissingFunctionError,
  isOrganizerSuiteExpiryDryRun,
  isOrganizerSuiteExpiryEnabled,
  runOrganizerSuiteExpiry,
  validateOrganizerSuiteExpirySchedule,
} from "@/lib/billing/organizerSuiteExpiryJob";

type Rows = Record<string, unknown[]>;

function fakeClient(rows: Rows, rpcResult: { data: unknown; error: unknown } = { data: [], error: null }) {
  const filters: Array<[string, string, unknown]> = [];
  const rpcCalls: unknown[] = [];
  const client = {
    rpc: async (...args: unknown[]) => { rpcCalls.push(args); return rpcResult; },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "order", "in"]) b[m] = () => b;
      for (const m of ["eq", "not", "lte"]) b[m] = (col: string, ...rest: unknown[]) => { filters.push([table, `${m}:${col}`, rest.at(-1)]); return b; };
      b.range = async (from: number, to: number) => ({ data: (rows[table] ?? []).slice(from, to + 1), error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res);
      return b;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, filters, rpcCalls };
}

const NY = "s-ny";

describe("switches", () => {
  it("enabled only for the exact string true", () => {
    expect(isOrganizerSuiteExpiryEnabled({})).toBe(false);
    for (const v of ["", "on", "TRUE", "1", " true", "yes"]) expect(isOrganizerSuiteExpiryEnabled({ ORGANIZER_SUITE_EXPIRY_ENABLED: v })).toBe(false);
    expect(isOrganizerSuiteExpiryEnabled({ ORGANIZER_SUITE_EXPIRY_ENABLED: "true" })).toBe(true);
  });
  it("dry-run from query or env; env wins", () => {
    expect(isOrganizerSuiteExpiryDryRun("https://x.test/a", {})).toBe(false);
    expect(isOrganizerSuiteExpiryDryRun("https://x.test/a?dry_run=1", {})).toBe(true);
    expect(isOrganizerSuiteExpiryDryRun("https://x.test/a?dry_run=yes", {})).toBe(false);
    expect(isOrganizerSuiteExpiryDryRun("https://x.test/a?dry_run=0", { ORGANIZER_SUITE_EXPIRY_DRY_RUN: "true" })).toBe(true);
    expect(isOrganizerSuiteExpiryDryRun("not a url", {})).toBe(true);
  });
});

describe("schedule validation", () => {
  it("accepts the suggested hourly schedule and a daily one", () => {
    expect(validateOrganizerSuiteExpirySchedule(ORGANIZER_SUITE_EXPIRY_SUGGESTED_SCHEDULE)).toEqual({ ok: true });
    expect(validateOrganizerSuiteExpirySchedule("15 */2 * * *")).toEqual({ ok: true });
    expect(validateOrganizerSuiteExpirySchedule("0 5 * * *")).toEqual({ ok: true });
  });
  it.each([
    [""], [null], ["@hourly"], ["* * * * *"], ["*/5 * * * *"], ["7 * * *"], ["7 * * * * *"], ["60 * * * *"],
    ["7 24 * * *"], ["7 * 1 * *"], ["7 * * 1 *"], ["7 * * * MON"], ["7 5-3 * * *"], ["7 */0 * * *"],
  ])("rejects %p", (value) => {
    expect(validateOrganizerSuiteExpirySchedule(value as string | null).ok).toBe(false);
  });
  it("the route stays unregistered in vercel.json", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).some((c) => c.path === ORGANIZER_SUITE_EXPIRY_ROUTE)).toBe(false);
  });
});

describe("missing-function detection", () => {
  it("recognises PostgREST and Postgres codes, not other errors", () => {
    expect(isMissingFunctionError({ code: "PGRST202" })).toBe(true);
    expect(isMissingFunctionError({ code: "42883" })).toBe(true);
    expect(isMissingFunctionError({ code: "42501", message: "permission denied for function expire_due_usage_addon_entitlements" })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });
});

describe("runOrganizerSuiteExpiry", () => {
  it("counts returned rows; null data is zero", async () => {
    const { client, rpcCalls } = fakeClient({}, { data: [{}, {}], error: null });
    expect(await runOrganizerSuiteExpiry(client, new Date("2027-07-09T04:00:00Z"))).toEqual({
      ok: true, dryRun: false, asOf: "2027-07-09T04:00:00.000Z", expiredCount: 2,
    });
    expect(rpcCalls).toEqual([["expire_due_usage_addon_entitlements", { p_as_of: "2027-07-09T04:00:00.000Z", p_feature_key: "organizer_suite" }]]);
    const empty = fakeClient({}, { data: null, error: null });
    expect(await runOrganizerSuiteExpiry(empty.client, new Date(0))).toMatchObject({ ok: true, expiredCount: 0 });
  });
});

describe("countDueOrganizerSuiteGrants (dry-run boundary = SQL boundary)", () => {
  const rows: Rows = {
    usage_addon_entitlements: [
      { id: "g1", studio_id: NY, organizer_id: null, period_end: "2027-07-09" },
      { id: "g2", studio_id: "s-utc", organizer_id: null, period_end: "2027-07-09" },
      { id: "g3", studio_id: null, organizer_id: "o-ny", period_end: "2027-07-09" },
      { id: "g4", studio_id: "s-bad", organizer_id: null, period_end: "2027-07-09" },
    ],
    organizers: [{ id: "o-ny", studio_id: NY }],
    studios: [{ id: NY, timezone: "America/New_York" }, { id: "s-utc", timezone: null }, { id: "s-bad", timezone: "Not/AZone" }],
  };

  it("filters to active manual grants of organizer_suite with a period_end and never calls the RPC", async () => {
    const { client, filters, rpcCalls } = fakeClient(rows);
    await countDueOrganizerSuiteGrants(client, new Date("2027-07-09T03:59:59Z"));
    expect(filters).toEqual(expect.arrayContaining([
      ["usage_addon_entitlements", "eq:source", "manual_grant"],
      ["usage_addon_entitlements", "eq:status", "active"],
      ["usage_addon_entitlements", "eq:feature_key", "organizer_suite"],
      ["usage_addon_entitlements", "not:period_end", null],
      ["usage_addon_entitlements", "lte:period_end", "2027-07-11"],
    ]));
    expect(rpcCalls).toEqual([]);
  });

  it("UTC and invalid-timezone rows are due at 00:00Z; New York rows at 04:00Z (EDT), inclusive", async () => {
    const at = async (iso: string) => {
      const r = await countDueOrganizerSuiteGrants(fakeClient(rows).client, new Date(iso));
      return r.ok && r.dryRun ? r.wouldExpireCount : -1;
    };
    expect(await at("2027-07-08T23:59:59Z")).toBe(0);
    expect(await at("2027-07-09T00:00:00Z")).toBe(2);
    expect(await at("2027-07-09T03:59:59Z")).toBe(2);
    expect(await at("2027-07-09T04:00:00Z")).toBe(4);
  });

  it("pages through more than one page of candidates", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}`, studio_id: "s-utc", organizer_id: null, period_end: "2020-01-01" }));
    const r = await countDueOrganizerSuiteGrants(fakeClient({ ...rows, usage_addon_entitlements: many }).client, new Date("2027-01-01T00:00:00Z"));
    expect(r).toMatchObject({ ok: true, wouldExpireCount: 2500 });
  });
});
