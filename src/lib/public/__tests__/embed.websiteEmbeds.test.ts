import { describe, expect, it } from "vitest";
import {
  buildEmbedCode,
  DEFAULT_ACCENT,
  embedCalendarPath,
  embedClassPath,
  normalizeAccent,
  normalizeDateParam,
  parseEmbedOptions,
  readableTextOn,
} from "@/lib/public/embedOptions";
import { addDays, addMonths, dayKeyInZone, filterByInstructor, groupByDay, monthWeeks, weekDays } from "@/lib/public/embedCalendar";
import type { PublicGroupClass } from "@/lib/public/groupClasses";

const cls = (o: Partial<PublicGroupClass>): PublicGroupClass => ({
  appointmentId: "11111111-1111-4111-8111-111111111111",
  seriesId: null,
  seriesRootId: null,
  studioSlug: "s",
  studioName: "S",
  studioLogoUrl: null,
  studioCity: null,
  studioState: null,
  timeZone: "America/Los_Angeles",
  title: "Salsa",
  startsAt: "2026-11-14T03:30:00Z",
  endsAt: "2026-11-14T04:30:00Z",
  instructorName: null,
  locationLabel: null,
  capacity: null,
  spotsRemaining: null,
  availability: "unlimited",
  enrollmentState: "open",
  publicState: "upcoming",
  ...o,
});

describe("embed option validation", () => {
  it("accepts only 6-digit hex accents and normalizes them", () => {
    expect(normalizeAccent("1E90FF")).toBe("#1e90ff");
    expect(normalizeAccent("#abc")).toBeNull();
    expect(normalizeAccent("red;background:url(x)")).toBeNull();
    expect(normalizeAccent('"><script>')).toBeNull();
  });

  it("falls back to safe defaults for hostile or unknown input", () => {
    const o = parseEmbedOptions({ accent: "javascript:1", theme: "neon", view: "../x", date: "2026-02-31", instructor: "  " });
    expect(o).toEqual({ accent: DEFAULT_ACCENT, theme: "light", view: "agenda", instructor: null, date: null });
  });

  it("parses valid options and caps/strips the instructor filter", () => {
    const o = parseEmbedOptions({ accent: "7a1f5c", theme: "dark", view: "month", instructor: "A\u0000".repeat(200), date: "2026-11-14" });
    expect(o.accent).toBe("#7a1f5c");
    expect(o.theme).toBe("dark");
    expect(o.view).toBe("month");
    expect(o.instructor).toHaveLength(80);
    expect(o.instructor).not.toMatch(/\u0000/);
    expect(o.date).toBe("2026-11-14");
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(normalizeDateParam("2026-02-31")).toBeNull();
    expect(normalizeDateParam("2026-13-01")).toBeNull();
    expect(normalizeDateParam("1999-01-01")).toBeNull();
    expect(normalizeDateParam("2028-02-29")).toBe("2028-02-29");
  });

  it("chooses readable text for light and dark accents", () => {
    expect(readableTextOn("#ffffff")).toBe("#0f172a");
    expect(readableTextOn("#1e293b")).toBe("#ffffff");
  });
});

describe("embed paths and code", () => {
  it("omits defaults and encodes slugs", () => {
    expect(embedCalendarPath("my studio")).toBe("/embed/calendar/my%20studio");
    expect(embedClassPath("abc", { accent: "#7a1f5c", theme: "dark" })).toBe("/embed/class/abc?accent=7a1f5c&theme=dark");
  });

  it("builds an iframe that only trusts its own frame and the DanceFlow origin", () => {
    const code = buildEmbedCode({ origin: "https://www.idanceflow.com", path: "/embed/calendar/x", title: 'My "studio"' });
    expect(code).toContain('src="https://www.idanceflow.com/embed/calendar/x"');
    expect(code).toContain('title="My &quot;studio&quot;"');
    expect(code).toContain("e.source!==f.contentWindow");
    expect(code).toContain('e.origin!=="https://www.idanceflow.com"');
    expect(code).toContain("d.height<20000");
    // sizing must not depend on inline styles (hosts with a strict style-src would drop them)
    expect(code).toContain('width="100%" height="480" frameborder="0"');
    expect(code).toContain('f.setAttribute("height"');
    expect(code).not.toContain("f.style.height");
  });
});

describe("calendar math", () => {
  it("assigns the day in the studio's zone, not UTC", () => {
    // 03:30Z on Nov 14 is still Nov 13 evening in Los Angeles.
    expect(dayKeyInZone("2026-11-14T03:30:00Z", "America/Los_Angeles")).toBe("2026-11-13");
    expect(dayKeyInZone("2026-11-14T03:30:00Z", "America/New_York")).toBe("2026-11-13");
    expect(dayKeyInZone("2026-11-14T03:30:00Z", "Asia/Tokyo")).toBe("2026-11-14");
  });

  it("falls back for an invalid zone rather than throwing", () => {
    expect(dayKeyInZone("2026-11-14T15:00:00Z", "Not/AZone")).toBe("2026-11-14");
  });

  it("groups and orders by day and filters by public instructor name only", () => {
    const a = cls({ appointmentId: "a", startsAt: "2026-11-14T20:00:00Z", instructorName: "Ana" });
    const b = cls({ appointmentId: "b", startsAt: "2026-11-14T18:00:00Z", instructorName: null });
    const map = groupByDay([a, b]);
    expect([...map.get("2026-11-14")!.map((c) => c.appointmentId)]).toEqual(["b", "a"]);
    expect(filterByInstructor([a, b], "Ana")).toEqual([a]);
    expect(filterByInstructor([a, b], null)).toHaveLength(2);
  });

  it("builds Sunday-first month weeks that cover the whole month", () => {
    const weeks = monthWeeks("2026-11-14"); // Nov 1 2026 is a Sunday; 30 days -> 5 weeks
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]).toBe("2026-11-01");
    expect(weeks[4][6]).toBe("2026-12-05");
    const feb = monthWeeks("2026-02-10"); // Feb 1 2026 is a Sunday, 28 days -> 4 weeks
    expect(feb).toHaveLength(4);
    expect(monthWeeks("2026-08-10")).toHaveLength(6); // Aug 1 2026 is a Saturday, 31 days
  });

  it("moves weeks and months across boundaries", () => {
    expect(weekDays("2026-11-14")[0]).toBe("2026-11-08");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
  });
});
