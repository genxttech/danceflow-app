import { describe, expect, it } from "vitest";
import { clientLookupScope, decodeCursor, encodeCursor } from "@/lib/staff/clients";
import { MARKABLE_ATTENDANCE_STATUSES } from "@/lib/staff/classAttendance";
import { toIsoUtc } from "@/lib/staff/instructorToday";

// Pure slice-2 rules that run in CI. The behaviour against real RLS is in localStack.staffApiSlice2.test.ts and scripts/qa/staff-api/http-qa-slice2.mjs.

describe("client lookup scope", () => {
  it.each([
    ["studio_owner", "broad"],
    ["studio_admin", "broad"],
    ["front_desk", "broad"],
    ["instructor", "teaching"],
  ])("%s gets the %s scope", (role, scope) => {
    expect(clientLookupScope(role)).toBe(scope);
  });

  it.each(["independent_instructor", "organizer_owner", "organizer_admin", "organizer_staff", "", "future_role"])("%j gets no client lookup", (role) => {
    expect(clientLookupScope(role)).toBeNull();
  });

  it("would map platform_admin to broad, which is why requireStaffApi refuses platform admins before any route runs", () => {
    // canViewClients includes platform_admin; the staff API boundary (not this mapping) is what keeps them out in v1.
    expect(clientLookupScope("platform_admin")).toBe("broad");
  });
});

describe("client search cursor", () => {
  it("round-trips the sort key", () => {
    const cursor = encodeCursor({ lastName: "O'Neil, Jr.", firstName: "Ana \"Q\"", id: "aaaaaaaa-0000-4000-8000-000000000001" });
    expect(decodeCursor(cursor)).toEqual({ l: "O'Neil, Jr.", f: 'Ana "Q"', i: "aaaaaaaa-0000-4000-8000-000000000001" });
  });

  it("treats no cursor as the first page and rejects anything that does not decode", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-json")).toBe("invalid");
    expect(decodeCursor(Buffer.from(JSON.stringify({ l: 1, f: "x", i: "y" })).toString("base64url"))).toBe("invalid");
    expect(decodeCursor(Buffer.from(JSON.stringify({ l: "a", f: "b", i: "x".repeat(65) })).toString("base64url"))).toBe("invalid");
  });
});

describe("attendance values and timestamps", () => {
  it("lets the app set only attended and no_show", () => {
    expect([...MARKABLE_ATTENDANCE_STATUSES]).toEqual(["attended", "no_show"]);
  });

  it("normalizes database timestamps to UTC with milliseconds", () => {
    expect(toIsoUtc("2026-11-09T15:00:00+00:00")).toBe("2026-11-09T15:00:00.000Z");
    expect(toIsoUtc("2026-11-09 10:00:00-05")).toBe("2026-11-09T15:00:00.000Z");
    expect(toIsoUtc("2026-11-09T15:00:00.123456+00:00")).toBe("2026-11-09T15:00:00.123Z");
    expect(toIsoUtc(null)).toBeNull();
  });
});
