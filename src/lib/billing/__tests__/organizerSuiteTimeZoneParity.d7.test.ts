import { describe, expect, it } from "vitest";
import { entitlementEndInstant, resolveEntitlementTimeZone } from "@/lib/billing/organizerSuiteEntitlement";

/**
 * D7: the TypeScript boundary rule must resolve timezones the way the SQL twin does
 * (usage_addon_entitlement_safe_timezone / usage_addon_entitlement_end_instant in migration 20270203090000):
 * IANA names only, local midnight, the later instant when midnight is ambiguous, UTC for anything else.
 */
const end = (periodEnd: string, tz: string | null) => entitlementEndInstant(periodEnd, tz)?.toISOString();

describe("zones whose clocks change at local midnight", () => {
  it.each([
    ["America/Havana gap", "2027-03-14", "America/Havana", "2027-03-14T05:00:00.000Z"],
    ["America/Havana overlap (later instant)", "2027-11-07", "America/Havana", "2027-11-07T05:00:00.000Z"],
    ["America/Santiago gap", "2027-09-05", "America/Santiago", "2027-09-05T04:00:00.000Z"],
  ])("%s", (_name, periodEnd, tz, expected) => {
    expect(end(periodEnd, tz)).toBe(expected);
  });
});

describe("half-hour and 45-minute offsets", () => {
  it.each([
    ["Australia/Lord_Howe (UTC+10:30 in July)", "Australia/Lord_Howe", "2027-07-08T13:30:00.000Z"],
    ["Asia/Kathmandu (UTC+5:45)", "Asia/Kathmandu", "2027-07-08T18:15:00.000Z"],
    ["Asia/Kolkata (UTC+5:30)", "Asia/Kolkata", "2027-07-08T18:30:00.000Z"],
  ])("%s", (_name, tz, expected) => {
    expect(end("2027-07-09", tz)).toBe(expected);
  });
});

describe("timezone strings the SQL twin does not accept", () => {
  it("UTC-offset strings fall back to UTC (Intl would accept them)", () => {
    for (const tz of ["+05:00", "-0800", "+0530", "-08"]) {
      expect(resolveEntitlementTimeZone(tz)).toBe("UTC");
      expect(end("2027-07-09", tz)).toBe("2027-07-09T00:00:00.000Z");
    }
  });
  it("junk, blank and NULL fall back to UTC", () => {
    for (const tz of ["Not/AZone", "   ", "", null, undefined]) {
      expect(end("2027-07-09", tz as string | null)).toBe("2027-07-09T00:00:00.000Z");
    }
  });
  it("a posix/ prefix resolves like the plain name (pg_timezone_names lists those)", () => {
    expect(end("2027-07-09", "posix/America/New_York")).toBe(end("2027-07-09", "America/New_York"));
    expect(end("2027-07-09", "posix/America/New_York")).toBe("2027-07-09T04:00:00.000Z");
  });
  it("a real IANA name is kept as given", () => {
    expect(resolveEntitlementTimeZone("America/New_York")).toBe("America/New_York");
  });
});

describe("legacy aliases that Node resolves but PostgreSQL pg_timezone_names does not list (parity corpus finding)", () => {
  const legacy = [
    "ACT", "AET", "AGT", "ART", "AST", "BET", "BST", "CAT", "CNT", "CST", "CTT", "EAT", "ECT", "IET", "IST", "JST", "MIT",
    "NET", "NST", "PLT", "PNT", "PRT", "PST", "SST", "VST", "SystemV/EST5",
  ];
  it.each(legacy)("%s falls back to UTC, like the SQL twin (any letter case, padded)", (tz) => {
    for (const variant of [tz, tz.toLowerCase(), `  ${tz}  `]) {
      expect(resolveEntitlementTimeZone(variant)).toBe("UTC");
      expect(end("2027-07-09", variant)).toBe("2027-07-09T00:00:00.000Z");
    }
  });
  it("the real zones behind those aliases still resolve (America/Los_Angeles, EST5EDT, US/Eastern)", () => {
    expect(end("2027-07-09", "America/Los_Angeles")).toBe("2027-07-09T07:00:00.000Z");
    expect(end("2027-07-09", "EST5EDT")).toBe("2027-07-09T04:00:00.000Z");
    expect(end("2027-07-09", "US/Eastern")).toBe("2027-07-09T04:00:00.000Z");
  });
  it("the DanceAbel boundary is unchanged: America/New_York ends at 2027-07-09T04:00:00Z", () => {
    expect(end("2027-07-09", "America/New_York")).toBe("2027-07-09T04:00:00.000Z");
  });
});
