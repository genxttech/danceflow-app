import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTITLEMENT_FALLBACK_TIME_ZONE,
  entitlementEndInstant,
  entitlementStartInstant,
  isEntitlementCurrent,
  readOrganizerSuiteEntitlement,
  resolveEntitlementTimeZone,
  studioHasCurrentOrganizerSuiteEntitlement,
  type EntitlementPeriodRow,
} from "@/lib/billing/organizerSuiteEntitlement";
import { getOrganizerPlatformFeePercent, ORGANIZER_PRO_ADDON_FEE_PERCENT, ORGANIZER_STUDIO_ADDON_FEE_PERCENT } from "@/lib/events/platformFee";
import { studioIdHasFeature } from "@/lib/billing/access";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import { createEntitlementFakeDb, type Row } from "./entitlementFakeDb";

/**
 * D7: the Organizer Suite entitlement boundary rule and its shared reader.
 *
 * TRUTH TABLE: shared with the SQL twin public.usage_addon_entitlement_is_current. If the owner changes the
 * boundary (exclusive local-midnight end of period_end), change entitlementEndInstant/entitlementStartInstant,
 * this table and the SQL function together.
 */

const NY = "America/New_York";
const active = (fields: Partial<EntitlementPeriodRow> = {}): EntitlementPeriodRow => ({
  status: "active",
  period_start: null,
  period_end: null,
  ...fields,
});

type Case = { name: string; row: EntitlementPeriodRow; tz: string | null; now: string; current: boolean };

const TRUTH_TABLE: Case[] = [
  // No bounds.
  { name: "period_end null", row: active(), tz: NY, now: "2027-07-09T12:00:00Z", current: true },
  { name: "period_end null, NULL tz", row: active(), tz: null, now: "2099-01-01T00:00:00Z", current: true },

  // America/New_York in July (EDT, UTC-4): local midnight of 2027-07-09 is 2027-07-09T04:00:00Z.
  { name: "NY 1s before local midnight of period_end", row: active({ period_end: "2027-07-09" }), tz: NY, now: "2027-07-09T03:59:59Z", current: true },
  { name: "NY at local midnight of period_end", row: active({ period_end: "2027-07-09" }), tz: NY, now: "2027-07-09T04:00:00Z", current: false },
  { name: "NY 1s after local midnight of period_end", row: active({ period_end: "2027-07-09" }), tz: NY, now: "2027-07-09T04:00:01Z", current: false },
  { name: "NY at UTC midnight (still July 8 locally)", row: active({ period_end: "2027-07-09" }), tz: NY, now: "2027-07-09T00:00:00Z", current: true },

  // UTC: local midnight of 2027-07-09 is 2027-07-09T00:00:00Z.
  { name: "UTC 1s before midnight of period_end", row: active({ period_end: "2027-07-09" }), tz: "UTC", now: "2027-07-08T23:59:59Z", current: true },
  { name: "UTC at midnight of period_end", row: active({ period_end: "2027-07-09" }), tz: "UTC", now: "2027-07-09T00:00:00Z", current: false },
  { name: "UTC 1s after midnight of period_end", row: active({ period_end: "2027-07-09" }), tz: "UTC", now: "2027-07-09T00:00:01Z", current: false },

  // NULL / empty / invalid timezone fall back to UTC.
  { name: "NULL tz: 1s before UTC midnight", row: active({ period_end: "2027-07-09" }), tz: null, now: "2027-07-08T23:59:59Z", current: true },
  { name: "NULL tz: at UTC midnight", row: active({ period_end: "2027-07-09" }), tz: null, now: "2027-07-09T00:00:00Z", current: false },
  { name: "empty tz: at UTC midnight", row: active({ period_end: "2027-07-09" }), tz: "", now: "2027-07-09T00:00:00Z", current: false },
  { name: "invalid tz: 1s before UTC midnight", row: active({ period_end: "2027-07-09" }), tz: "Mars/Olympus_Mons", now: "2027-07-08T23:59:59Z", current: true },
  { name: "invalid tz: at UTC midnight", row: active({ period_end: "2027-07-09" }), tz: "Mars/Olympus_Mons", now: "2027-07-09T00:00:00Z", current: false },

  // DST edges in New York: 2027-03-14 (spring forward at 02:00, midnight still EST) and 2027-11-07 (fall back at 02:00, midnight still EDT).
  { name: "NY spring-forward day: 1s before 05:00Z", row: active({ period_end: "2027-03-14" }), tz: NY, now: "2027-03-14T04:59:59Z", current: true },
  { name: "NY spring-forward day: at 05:00Z", row: active({ period_end: "2027-03-14" }), tz: NY, now: "2027-03-14T05:00:00Z", current: false },
  { name: "NY fall-back day: 1s before 04:00Z", row: active({ period_end: "2027-11-07" }), tz: NY, now: "2027-11-07T03:59:59Z", current: true },
  { name: "NY fall-back day: at 04:00Z", row: active({ period_end: "2027-11-07" }), tz: NY, now: "2027-11-07T04:00:00Z", current: false },
  { name: "NY winter: at 05:00Z", row: active({ period_end: "2027-01-15" }), tz: NY, now: "2027-01-15T05:00:00Z", current: false },
  { name: "NY winter: 1s before 05:00Z", row: active({ period_end: "2027-01-15" }), tz: NY, now: "2027-01-15T04:59:59Z", current: true },

  // A zone ahead of UTC: Pacific/Kiritimati (UTC+14) midnight of 2027-07-09 is 2027-07-08T10:00:00Z.
  { name: "UTC+14 at local midnight", row: active({ period_end: "2027-07-09" }), tz: "Pacific/Kiritimati", now: "2027-07-08T10:00:00Z", current: false },
  { name: "UTC+14 1s before local midnight", row: active({ period_end: "2027-07-09" }), tz: "Pacific/Kiritimati", now: "2027-07-08T09:59:59Z", current: true },

  // period_start is inclusive from the start of its local day.
  { name: "period_start in the future", row: active({ period_start: "2027-07-10" }), tz: "UTC", now: "2027-07-09T12:00:00Z", current: false },
  { name: "NY period_start: 1s before local midnight", row: active({ period_start: "2027-07-09" }), tz: NY, now: "2027-07-09T03:59:59Z", current: false },
  { name: "NY period_start: at local midnight", row: active({ period_start: "2027-07-09" }), tz: NY, now: "2027-07-09T04:00:00Z", current: true },
  { name: "start and end in window", row: active({ period_start: "2027-07-01", period_end: "2027-07-09" }), tz: NY, now: "2027-07-05T12:00:00Z", current: true },
  { name: "start == end: empty window", row: active({ period_start: "2027-07-09", period_end: "2027-07-09" }), tz: NY, now: "2027-07-09T04:00:00Z", current: false },

  // Status must be active, whatever the dates say.
  { name: "status canceled, no bounds", row: active({ status: "canceled" }), tz: NY, now: "2027-07-09T12:00:00Z", current: false },
  { name: "status expired, future end", row: active({ status: "expired", period_end: "2099-01-01" }), tz: NY, now: "2027-07-09T12:00:00Z", current: false },
  { name: "status null", row: active({ status: null }), tz: NY, now: "2027-07-09T12:00:00Z", current: false },

  // Unparseable bounds fail closed.
  { name: "garbage period_end", row: active({ period_end: "not-a-date" }), tz: NY, now: "2020-01-01T00:00:00Z", current: false },
  { name: "impossible period_end date", row: active({ period_end: "2027-02-30" }), tz: NY, now: "2020-01-01T00:00:00Z", current: false },
  { name: "garbage period_start", row: active({ period_start: "soon" }), tz: NY, now: "2030-01-01T00:00:00Z", current: false },
];

describe("isEntitlementCurrent truth table (shared with SQL usage_addon_entitlement_is_current)", () => {
  it.each(TRUTH_TABLE)("$name -> $current", ({ row, tz, now, current }) => {
    expect(isEntitlementCurrent(row, tz, new Date(now))).toBe(current);
  });
});

describe("boundary instants", () => {
  it.each([
    ["2027-07-09", NY, "2027-07-09T04:00:00.000Z"],
    ["2027-07-09", "UTC", "2027-07-09T00:00:00.000Z"],
    ["2027-07-09", null, "2027-07-09T00:00:00.000Z"],
    ["2027-07-09", "Not/AZone", "2027-07-09T00:00:00.000Z"],
    ["2027-03-14", NY, "2027-03-14T05:00:00.000Z"],
    ["2027-03-15", NY, "2027-03-15T04:00:00.000Z"],
    ["2027-11-07", NY, "2027-11-07T04:00:00.000Z"],
    ["2027-11-08", NY, "2027-11-08T05:00:00.000Z"],
    ["2027-07-09", "Asia/Kolkata", "2027-07-08T18:30:00.000Z"],
    ["2027-07-09", "Pacific/Kiritimati", "2027-07-08T10:00:00.000Z"],
  ])("end of %s in %s is %s", (date, tz, iso) => {
    expect(entitlementEndInstant(date, tz)?.toISOString()).toBe(iso);
    expect(entitlementStartInstant(date, tz)?.toISOString()).toBe(iso);
  });

  it("unparseable dates have no instant", () => {
    expect(entitlementEndInstant("2027-13-01", NY)).toBeNull();
    expect(entitlementEndInstant("", NY)).toBeNull();
  });

  it("timezone resolution falls back to UTC", () => {
    expect(ENTITLEMENT_FALLBACK_TIME_ZONE).toBe("UTC");
    expect(resolveEntitlementTimeZone(null)).toBe("UTC");
    expect(resolveEntitlementTimeZone("   ")).toBe("UTC");
    expect(resolveEntitlementTimeZone("Bogus/Zone")).toBe("UTC");
    expect(resolveEntitlementTimeZone(NY)).toBe(NY);
  });
});

const STUDIO = "studio-1";
const OTHER = "studio-2";

function suiteRow(fields: Row): Row {
  return { studio_id: STUDIO, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, status: "active", period_start: null, period_end: null, stripe_subscription_item_id: null, ...fields };
}

const manualGrant = (fields: Row = {}) => suiteRow({ id: "grant-1", source: "manual_grant", ...fields });
const stripeRow = (fields: Row = {}) => suiteRow({ id: "stripe-1", source: "stripe_subscription_item", stripe_subscription_item_id: "si_suite", ...fields });

const BEFORE_END = new Date("2027-07-09T03:59:59Z");
const AFTER_END = new Date("2027-07-09T04:00:00Z");

function db(entitlements: Row[], timezone: string | null = NY, options: { failSelectOn?: string[] } = {}) {
  return createEntitlementFakeDb({ usage_addon_entitlements: entitlements, studios: [{ id: STUDIO, timezone }, { id: OTHER, timezone: "UTC" }] }, options);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reader: manual grant and Stripe add-on coexistence", () => {
  it("manual grant only (open-ended): current, and no timezone read is needed", async () => {
    const fake = db([manualGrant()]);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, AFTER_END)).toBe(true);
    expect(fake.reads).toEqual(["usage_addon_entitlements"]);
  });

  it("manual grant with a period_end: current before, denied from the studio-local end", async () => {
    const fake = db([manualGrant({ period_end: "2027-07-09" })]);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, BEFORE_END)).toBe(true);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, AFTER_END)).toBe(false);
    expect(fake.reads).toContain("studios");
  });

  it("Stripe row only: current", async () => {
    expect(await studioHasCurrentOrganizerSuiteEntitlement(db([stripeRow()]).client, STUDIO, AFTER_END)).toBe(true);
  });

  it("both active: current", async () => {
    const fake = db([manualGrant({ period_end: "2027-07-09" }), stripeRow()]);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, BEFORE_END)).toBe(true);
  });

  it("manual expired + Stripe active: access continues through the Stripe row", async () => {
    const fake = db([manualGrant({ period_end: "2027-07-09" }), stripeRow()]);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, AFTER_END)).toBe(true);
  });

  it("manual expired alone: denied", async () => {
    const fake = db([manualGrant({ period_end: "2027-07-09" })]);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, AFTER_END)).toBe(false);
  });

  it("a canceled Stripe row or an expired-status grant does not count", async () => {
    const fake = db([manualGrant({ status: "expired" }), stripeRow({ status: "canceled" })]);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, BEFORE_END)).toBe(false);
  });

  it("other sources and other studios never grant access", async () => {
    const fake = db([
      suiteRow({ id: "x", source: "manual" }),
      suiteRow({ id: "y", source: "promo" }),
      manualGrant({ id: "z", studio_id: OTHER }),
      suiteRow({ id: "w", source: "manual_grant", feature_key: "ai_credits" }),
    ]);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, BEFORE_END)).toBe(false);
  });

  it("nothing silently extends a grant: the reader writes nothing and repeat reads stay denied", async () => {
    const fake = db([manualGrant({ period_end: "2027-07-09" })]);
    const snapshot = JSON.parse(JSON.stringify(fake.rows("usage_addon_entitlements")));
    for (let i = 0; i < 3; i += 1) {
      expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, AFTER_END)).toBe(false);
    }
    expect(fake.writes).toEqual([]);
    expect(fake.rows("usage_addon_entitlements")).toEqual(snapshot);
  });

  it("NULL studio timezone falls back to UTC", async () => {
    const fake = db([manualGrant({ period_end: "2027-07-09" })], null);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, new Date("2027-07-08T23:59:59Z"))).toBe(true);
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, new Date("2027-07-09T00:00:00Z"))).toBe(false);
  });

  it("a failed timezone read falls back to UTC (logged, no ids)", async () => {
    const fake = db([manualGrant({ period_end: "2027-07-09" })], NY, { failSelectOn: ["studios"] });
    // 02:00Z is still July 8 in New York but already July 9 in UTC: the UTC fallback ends it.
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO, new Date("2027-07-09T02:00:00Z"))).toBe(false);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain(STUDIO);
  });

  it("a failed entitlement read fails closed (false, logged) and reports ok:false to throwing callers", async () => {
    const fake = db([manualGrant()], NY, { failSelectOn: ["usage_addon_entitlements"] });
    expect(await studioHasCurrentOrganizerSuiteEntitlement(fake.client, STUDIO)).toBe(false);
    expect(console.error).toHaveBeenCalledWith("Failed to read Organizer Suite add-on entitlement", expect.anything());
    const read = await readOrganizerSuiteEntitlement(fake.client, STUDIO);
    expect(read).toEqual({ ok: false, current: false, error: { message: "select on usage_addon_entitlements failed" } });
  });
});

describe("callers: what a lapsed grant changes", () => {
  function feeDb(code: string, entitlements: Row[]) {
    return createEntitlementFakeDb({
      studio_subscriptions: [{ studio_id: STUDIO, status: "active", subscription_plans: { code } }],
      usage_addon_entitlements: entitlements,
      studios: [{ id: STUDIO, timezone: NY }],
    });
  }

  it("event platform fee: discounted Suite tier while the grant is current, 0 (no DanceFlow fee) after it lapses", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BEFORE_END);
      expect(await getOrganizerPlatformFeePercent(feeDb("growth", [manualGrant({ period_end: "2027-07-09" })]).client, STUDIO)).toBe(ORGANIZER_STUDIO_ADDON_FEE_PERCENT);
      vi.setSystemTime(AFTER_END);
      expect(await getOrganizerPlatformFeePercent(feeDb("growth", [manualGrant({ period_end: "2027-07-09" })]).client, STUDIO)).toBe(0);
      expect(await getOrganizerPlatformFeePercent(feeDb("pro", [manualGrant({ period_end: "2027-07-09" }), stripeRow()]).client, STUDIO)).toBe(ORGANIZER_PRO_ADDON_FEE_PERCENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("studioIdHasFeature: an Organizer Suite feature is denied once the only grant has lapsed", async () => {
    const studios = new FakeTable();
    const subscriptions = new FakeTable();
    const addons = new FakeTable();
    studios.rows.push({ id: STUDIO, timezone: "UTC", billing_plan: "starter", subscription_status: "active", billing_override_enabled: false });
    subscriptions.rows.push({ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "starter", name: "Starter" } });
    addons.rows.push({ id: "g", studio_id: STUDIO, feature_key: "organizer_suite", source: "manual_grant", status: "active", period_start: null, period_end: "2000-01-01" });
    const client = createFakeAdminClient({ studios, studio_subscriptions: subscriptions, usage_addon_entitlements: addons }) as never;
    expect(await studioIdHasFeature(client, STUDIO, "event_waivers")).toBe(false);
    addons.rows.push({ id: "s", studio_id: STUDIO, feature_key: "organizer_suite", source: "stripe_subscription_item", status: "active", period_start: null, period_end: null });
    expect(await studioIdHasFeature(client, STUDIO, "event_waivers")).toBe(true);
  });
});
