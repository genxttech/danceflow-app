import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  availabilityCopy,
  fetchPublicGroupClass,
  fetchPublicGroupClasses,
  fetchPublicGroupClassSeries,
  formatClassDay,
  formatClassTimeRange,
  formatClassWhen,
  isUuid,
  parsePublicGroupClass,
  parsePublicGroupClassSeries,
  sameStudioSlug,
  publicClassPath,
  publicSeriesPath,
  publicStudioClassesPath,
  unavailableMessage,
} from "../groupClasses";

const ID = "11111111-1111-4111-8111-111111111111";
const SERIES = "22222222-2222-4222-8222-222222222222";

const row = (over: Record<string, unknown> = {}) => ({
  appointment_id: ID,
  series_id: SERIES,
  series_root_id: SERIES,
  studio_slug: "salsa-house",
  studio_name: "Salsa House",
  studio_logo_url: null,
  studio_city: "Austin",
  studio_state: "TX",
  time_zone: "America/New_York",
  title: "Salsa Level 1",
  starts_at: "2030-11-02T22:00:00+00:00",
  ends_at: "2030-11-02T23:00:00+00:00",
  instructor_name: "Pat Public",
  location_label: "Main Floor",
  capacity: 10,
  spots_remaining: 4,
  availability: "available",
  enrollment_state: "open",
  public_state: "upcoming",
  ...over,
});

describe("GC-3.4A public class parsing", () => {
  it("maps a database row to the safe public shape and nothing else", () => {
    const c = parsePublicGroupClass({ ...row(), notes: "SECRET", client_id: "x", roster: ["Zelda"] });
    expect(c).not.toBeNull();
    expect(Object.keys(c!).sort()).toEqual(
      [
        "appointmentId", "availability", "capacity", "endsAt", "enrollmentState", "instructorName", "locationLabel", "publicState", "seriesId",
        "seriesRootId", "spotsRemaining", "startsAt", "studioCity", "studioLogoUrl", "studioName", "studioSlug", "studioState", "timeZone", "title",
      ].sort(),
    );
    expect(JSON.stringify(c)).not.toMatch(/SECRET|Zelda|client_id|roster/);
  });

  it("rejects malformed rows and unknown states instead of guessing", () => {
    expect(parsePublicGroupClass(null)).toBeNull();
    expect(parsePublicGroupClass(row({ appointment_id: "nope" }))).toBeNull();
    expect(parsePublicGroupClass(row({ public_state: "hidden" }))).toBeNull();
    expect(parsePublicGroupClass(row({ availability: "plenty" }))).toBeNull();
    expect(parsePublicGroupClass(row({ enrollment_state: "paid" }))).toBeNull();
  });

  it("keeps blank optional values as null and defaults the time zone", () => {
    const c = parsePublicGroupClass(row({ instructor_name: "  ", location_label: null, time_zone: null, series_id: null, series_root_id: null }))!;
    expect(c.instructorName).toBeNull();
    expect(c.locationLabel).toBeNull();
    expect(c.timeZone).toBe("America/New_York");
    expect(c.seriesRootId).toBeNull();
  });

  it("parses a series summary", () => {
    const s = parsePublicGroupClassSeries({ series_root_id: SERIES, studio_slug: "salsa-house", studio_name: "Salsa House", title: "Salsa", upcoming_count: 3 });
    expect(s).toMatchObject({ seriesRootId: SERIES, title: "Salsa", upcomingCount: 3 });
    expect(parsePublicGroupClassSeries({ studio_slug: "x" })).toBeNull();
  });
});

describe("GC-3.4A URLs: appointment id is identity, slug is routing context", () => {
  it("builds stable paths from ids", () => {
    expect(publicStudioClassesPath("salsa-house")).toBe("/studios/salsa-house/classes");
    expect(publicClassPath("salsa-house", ID)).toBe(`/studios/salsa-house/classes/${ID}`);
    expect(publicSeriesPath("salsa-house", SERIES)).toBe(`/studios/salsa-house/classes/series/${SERIES}`);
  });
  it("does not depend on any mutable field: the same class keeps its path after a title, time or room change", () => {
    const before = parsePublicGroupClass(row())!;
    const after = parsePublicGroupClass(row({ title: "Renamed", starts_at: "2030-11-09T22:00:00+00:00", location_label: "Back Room" }))!;
    expect(publicClassPath(before.studioSlug, before.appointmentId)).toBe(publicClassPath(after.studioSlug, after.appointmentId));
  });
  it("encodes the slug segment", () => {
    expect(publicStudioClassesPath("a b/c")).toBe("/studios/a%20b%2Fc/classes");
  });
  it("validates ids", () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid("../etc/passwd")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe("GC-3.4A slug comparison never loops on an encoded param", () => {
  it("matches raw, percent-encoded and unicode slugs; rejects different or malformed ones", () => {
    expect(sameStudioSlug("salsa-house", "salsa-house")).toBe(true);
    expect(sameStudioSlug("salsa%20house", "salsa house")).toBe(true);
    expect(sameStudioSlug("caf%C3%A9", "café")).toBe(true);
    expect(sameStudioSlug("other", "salsa-house")).toBe(false);
    expect(sameStudioSlug("%E0%A4%A", "x")).toBe(false);
  });
});

describe("GC-3.4A reads go through the public functions only", () => {
  const client = (data: unknown) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const from = vi.fn(() => {
      throw new Error("tables must not be read directly");
    });
    return { rpc, from } as unknown as { rpc: typeof rpc; from: typeof from } & import("@supabase/supabase-js").SupabaseClient;
  };

  it("lists via public_group_class_occurrences with only studio / series filters", async () => {
    const c = client([row()]);
    const out = await fetchPublicGroupClasses(c, { studioSlug: "salsa-house", limit: 5 });
    expect(out).toHaveLength(1);
    expect(c.rpc).toHaveBeenCalledWith("public_group_class_occurrences", { p_studio_slug: "salsa-house", p_series_id: null, p_appointment_id: null, p_limit: 5 });
    expect(c.from).not.toHaveBeenCalled();
  });
  it("drops rows it cannot parse", async () => {
    const out = await fetchPublicGroupClasses(client([row(), row({ public_state: "weird" })]));
    expect(out).toHaveLength(1);
  });
  it("loads one occurrence by id and never calls the database for an invalid id", async () => {
    const c = client([row()]);
    expect((await fetchPublicGroupClass(c, ID))?.appointmentId).toBe(ID);
    expect(c.rpc).toHaveBeenCalledWith("public_group_class_occurrences", { p_studio_slug: null, p_series_id: null, p_appointment_id: ID, p_limit: 1 });
    c.rpc.mockClear();
    expect(await fetchPublicGroupClass(c, "not-a-uuid")).toBeNull();
    expect(await fetchPublicGroupClassSeries(c, "not-a-uuid")).toBeNull();
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("returns null when the database returns nothing (hidden, private or unknown)", async () => {
    expect(await fetchPublicGroupClass(client([]), ID)).toBeNull();
    expect(await fetchPublicGroupClassSeries(client([]), SERIES)).toBeNull();
  });
  it("surfaces a database error", async () => {
    const c = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) } as unknown as import("@supabase/supabase-js").SupabaseClient;
    await expect(fetchPublicGroupClasses(c)).rejects.toThrow(/boom/);
  });
  it("source reads no table and never uses the admin client", () => {
    const src = readFileSync("src/lib/public/groupClasses.ts", "utf8");
    expect(src).not.toMatch(/\.from\(|createAdminClient|service_role/);
    expect(src).not.toMatch(/event_type|from\("events"\)/);
  });
});

describe("GC-3.4A copy", () => {
  it("availability wording", () => {
    expect(availabilityCopy({ publicState: "upcoming", availability: "available", spotsRemaining: 7 })).toEqual({ label: "7 spots left", tone: "good" });
    expect(availabilityCopy({ publicState: "upcoming", availability: "available", spotsRemaining: 3 }).tone).toBe("limited");
    expect(availabilityCopy({ publicState: "upcoming", availability: "available", spotsRemaining: 1 }).label).toBe("1 spot left");
    expect(availabilityCopy({ publicState: "upcoming", availability: "full", spotsRemaining: 0 })).toEqual({ label: "Class full", tone: "full" });
    expect(availabilityCopy({ publicState: "upcoming", availability: "unlimited", spotsRemaining: null }).label).toBe("Spots available");
    expect(availabilityCopy({ publicState: "cancelled", availability: "available", spotsRemaining: 5 }).label).toBe("Cancelled");
    expect(availabilityCopy({ publicState: "past", availability: "available", spotsRemaining: 5 }).label).toBe("Already held");
    for (const label of ["Class full", "Cancelled"]) expect(label).not.toMatch(/pay|price|\$|purchase/i);
  });
  it("unavailable messages", () => {
    expect(unavailableMessage("upcoming")).toBeNull();
    expect(unavailableMessage("cancelled")).toMatch(/cancelled/);
    expect(unavailableMessage("past")).toMatch(/already taken place/);
  });
  it("formats instants in the studio time zone across the DST end: 6 PM local stays 6 PM", () => {
    // 2030-11-02 18:00 EDT = 22:00Z ; 2030-11-09 18:00 EST = 23:00Z
    expect(formatClassTimeRange("2030-11-02T22:00:00+00:00", "2030-11-02T23:00:00+00:00", "America/New_York")).toBe("6:00 PM – 7:00 PM");
    expect(formatClassTimeRange("2030-11-09T23:00:00+00:00", "2030-11-10T00:00:00+00:00", "America/New_York")).toBe("6:00 PM – 7:00 PM");
    expect(formatClassDay("2030-11-02T22:00:00+00:00", "America/New_York")).toBe("Sat, Nov 2");
    expect(formatClassWhen("2030-11-02T22:00:00+00:00", "2030-11-02T23:00:00+00:00", "America/Chicago")).toBe("Sat, Nov 2, 5:00 PM – 6:00 PM");
  });
  it("falls back to a valid time zone for a bad value", () => {
    expect(formatClassTimeRange("2030-11-02T22:00:00+00:00", "2030-11-02T23:00:00+00:00", "Not/AZone")).toBe("6:00 PM – 7:00 PM");
  });
});
