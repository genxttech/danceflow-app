import { describe, expect, it } from "vitest";
import { filterCurrentEntitlements, type StudioEntitlementRow } from "@/lib/billing/organizerSuiteEntitlement";

/**
 * D7: platform analytics / accounting count an Organizer Suite add-on as active only while it is current
 * under the shared boundary rule (exclusive local-midnight end of period_end in the studio's timezone).
 * Rows with no period bound count exactly as before (status 'active', trimmed and case-insensitive).
 */

const NY = "America/New_York";
const NY_STUDIO = "studio-ny";
const UTC_STUDIO = "studio-utc";
const NULL_TZ_STUDIO = "studio-null-tz";
const UNKNOWN_STUDIO = "studio-not-in-map";

const timezones = new Map<string, string | null>([
  [NY_STUDIO, NY],
  [UTC_STUDIO, "UTC"],
  [NULL_TZ_STUDIO, null],
]);

type Row = StudioEntitlementRow & { id: string; source: string };

const row = (fields: Partial<Row>): Row => ({
  id: "r",
  studio_id: NY_STUDIO,
  source: "manual_grant",
  status: "active",
  period_start: null,
  period_end: null,
  ...fields,
});

type Case = { name: string; row: Row; now: string; counted: boolean };

const CASES: Case[] = [
  // Open-ended rows: unchanged behavior (status only), whatever the timezone.
  { name: "open-ended manual grant", row: row({}), now: "2099-01-01T00:00:00Z", counted: true },
  { name: "open-ended Stripe item", row: row({ source: "stripe_subscription_item" }), now: "2099-01-01T00:00:00Z", counted: true },
  { name: "open-ended, status ' Active ' (normalized as before)", row: row({ status: " Active " }), now: "2027-07-09T12:00:00Z", counted: true },
  { name: "open-ended, canceled", row: row({ status: "canceled" }), now: "2027-07-09T12:00:00Z", counted: false },
  { name: "open-ended, null status", row: row({ status: null }), now: "2027-07-09T12:00:00Z", counted: false },
  { name: "open-ended, null studio_id", row: row({ studio_id: null }), now: "2027-07-09T12:00:00Z", counted: true },
  { name: "Stripe item with undefined period columns", row: row({ source: "stripe_subscription_item", period_start: undefined, period_end: undefined }), now: "2027-07-09T12:00:00Z", counted: true },

  // America/New_York: end instant of 2027-07-09 is 2027-07-09T04:00:00Z.
  { name: "NY current: 1s before end instant", row: row({ period_end: "2027-07-09" }), now: "2027-07-09T03:59:59Z", counted: true },
  { name: "NY at UTC midnight (still July 8 locally)", row: row({ period_end: "2027-07-09" }), now: "2027-07-09T00:00:00Z", counted: true },
  { name: "NY lapsed: at end instant", row: row({ period_end: "2027-07-09" }), now: "2027-07-09T04:00:00Z", counted: false },
  { name: "NY lapsed: long after", row: row({ period_end: "2027-07-09" }), now: "2028-01-01T00:00:00Z", counted: false },
  { name: "NY lapsed Stripe-sourced row with period_end", row: row({ source: "stripe_subscription_item", period_end: "2027-07-09" }), now: "2027-07-09T04:00:00Z", counted: false },
  { name: "NY lapsed but status canceled", row: row({ status: "canceled", period_end: "2099-01-01" }), now: "2027-07-09T04:00:00Z", counted: false },
  { name: "NY future period_start", row: row({ period_start: "2027-07-10" }), now: "2027-07-10T03:59:59Z", counted: false },
  { name: "NY period_start reached", row: row({ period_start: "2027-07-10" }), now: "2027-07-10T04:00:00Z", counted: true },

  // UTC studio: end instant of 2027-07-09 is 2027-07-09T00:00:00Z.
  { name: "UTC current: 1s before midnight", row: row({ studio_id: UTC_STUDIO, period_end: "2027-07-09" }), now: "2027-07-08T23:59:59Z", counted: true },
  { name: "UTC lapsed: at midnight", row: row({ studio_id: UTC_STUDIO, period_end: "2027-07-09" }), now: "2027-07-09T00:00:00Z", counted: false },

  // Missing timezone (NULL value, studio not in map, NULL studio_id) falls back to UTC.
  { name: "NULL tz: 1s before UTC midnight", row: row({ studio_id: NULL_TZ_STUDIO, period_end: "2027-07-09" }), now: "2027-07-08T23:59:59Z", counted: true },
  { name: "NULL tz: at UTC midnight", row: row({ studio_id: NULL_TZ_STUDIO, period_end: "2027-07-09" }), now: "2027-07-09T00:00:00Z", counted: false },
  { name: "studio missing from map: at UTC midnight", row: row({ studio_id: UNKNOWN_STUDIO, period_end: "2027-07-09" }), now: "2027-07-09T00:00:00Z", counted: false },
  { name: "studio missing from map: 1s before UTC midnight", row: row({ studio_id: UNKNOWN_STUDIO, period_end: "2027-07-09" }), now: "2027-07-08T23:59:59Z", counted: true },
  { name: "null studio_id with bound: UTC", row: row({ studio_id: null, period_end: "2027-07-09" }), now: "2027-07-09T00:00:00Z", counted: false },

  // Unparseable bound fails closed.
  { name: "garbage period_end", row: row({ period_end: "soon" }), now: "2020-01-01T00:00:00Z", counted: false },
];

describe("filterCurrentEntitlements (platform analytics / accounting add-on counts)", () => {
  it.each(CASES)("$name -> $counted", ({ row: entitlement, now, counted }) => {
    expect(filterCurrentEntitlements([entitlement], timezones, new Date(now))).toEqual(counted ? [entitlement] : []);
  });

  it("applies each studio's own timezone across a mixed set and preserves order and row identity", () => {
    const rows: Row[] = [
      row({ id: "ny-grant", studio_id: NY_STUDIO, period_end: "2027-07-09" }),
      row({ id: "utc-grant", studio_id: UTC_STUDIO, period_end: "2027-07-09" }),
      row({ id: "stripe", studio_id: UTC_STUDIO, source: "stripe_subscription_item" }),
      row({ id: "null-tz-grant", studio_id: NULL_TZ_STUDIO, period_end: "2027-07-09" }),
      row({ id: "canceled", studio_id: NY_STUDIO, status: "canceled" }),
    ];

    const ids = (now: string) => filterCurrentEntitlements(rows, timezones, new Date(now)).map((entitlement) => entitlement.id);

    expect(ids("2027-07-08T23:59:59Z")).toEqual(["ny-grant", "utc-grant", "stripe", "null-tz-grant"]);
    // UTC midnight: UTC and NULL-tz grants lapse; New York is still on July 8.
    expect(ids("2027-07-09T00:00:00Z")).toEqual(["ny-grant", "stripe"]);
    expect(ids("2027-07-09T03:59:59Z")).toEqual(["ny-grant", "stripe"]);
    expect(ids("2027-07-09T04:00:00Z")).toEqual(["stripe"]);

    const kept = filterCurrentEntitlements(rows, timezones, new Date("2027-07-08T00:00:00Z"));
    expect(kept[0]).toBe(rows[0]);
  });

  it("does not mutate its inputs", () => {
    const rows = [row({ period_end: "2027-07-09" })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    filterCurrentEntitlements(rows, timezones, new Date("2030-01-01T00:00:00Z"));
    expect(rows).toEqual(snapshot);
  });

  it("an empty timezone map treats every bounded row as UTC", () => {
    const rows = [row({ period_end: "2027-07-09" })];
    expect(filterCurrentEntitlements(rows, new Map(), new Date("2027-07-08T23:59:59Z"))).toHaveLength(1);
    expect(filterCurrentEntitlements(rows, new Map(), new Date("2027-07-09T00:00:00Z"))).toHaveLength(0);
  });
});
