import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/integrations/google-calendar/client", () => ({}));

import { eventPayload, type EventSyncRow } from "../sync";
import { resolveStudioTimeZone } from "@/lib/staff/instructorToday";

const base: EventSyncRow = {
  id: "e1", name: "Spring Social", event_type: "social", status: "published",
  start_date: "2026-11-01", end_date: null, start_time: "19:00:00", end_time: "22:00:00",
  venue_name: null, city: null, state: null,
};

describe("S0-c studio event timeZone", () => {
  it("sends timed events with the studio IANA zone and no offset guessing", () => {
    const p = eventPayload(base, "America/Chicago");
    expect(p.start).toEqual({ dateTime: "2026-11-01T19:00:00", timeZone: "America/Chicago" });
    expect(p.end).toEqual({ dateTime: "2026-11-01T22:00:00", timeZone: "America/Chicago" });
  });

  it("keeps the wall-clock value across a DST change day (Google resolves it in the zone)", () => {
    const p = eventPayload({ ...base, start_date: "2026-11-01", start_time: "01:30:00", end_time: "03:00:00" }, "America/New_York");
    expect(p.start.dateTime).toBe("2026-11-01T01:30:00");
    expect(p.start.timeZone).toBe("America/New_York");
  });

  it("uses the end date for a multi-day timed event", () => {
    const p = eventPayload({ ...base, end_date: "2026-11-03" }, "America/Denver");
    expect(p.end).toEqual({ dateTime: "2026-11-03T22:00:00", timeZone: "America/Denver" });
  });

  it("leaves all-day events as dates with no timeZone", () => {
    const p = eventPayload({ ...base, start_time: null, end_time: null, end_date: "2026-11-03" }, "America/Chicago");
    expect(p.start).toEqual({ date: "2026-11-01" });
    expect(p.end).toEqual({ date: "2026-11-03" });
  });

  it("resolves missing or invalid studio timezones to the repo fallback instead of sending a bad zone", () => {
    expect(resolveStudioTimeZone(null)).toBe("America/New_York");
    expect(resolveStudioTimeZone("Mars/Olympus")).toBe("America/New_York");
    expect(resolveStudioTimeZone(" America/Los_Angeles ")).toBe("America/Los_Angeles");
  });
});
