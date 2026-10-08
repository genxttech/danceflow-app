import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isEventPast } from "@/lib/events/eventTiming";

/**
 * Cleanup PR B: the organizer app-shell ARIA badge (src/app/app/layout.tsx, getOrganizerAriaSidebarCounts) counts
 * "Completed/past event is not settled" and closeout actions. Its "past" flag must use the same end-moment rule as the
 * /app/events ARIA queue, not "end_date is before today's UTC date", which counted still-running events west of UTC as
 * ended from UTC midnight onwards and ignored end_time.
 */

function source(path: string) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

describe("layout ARIA sidebar counts use the canonical event timing rule", () => {
  const layout = source("src/app/app/layout.tsx");

  it("selects the timing fields and decides past with isEventPast", () => {
    expect(layout).toContain('import { isEventPast } from "@/lib/events/eventTiming";');
    expect(layout).toContain('.select("id, name, status, start_date, end_date, end_time, timezone")');
    expect(layout).toMatch(
      /const isCompletedOrPast =\n\s+\(event\.status \?\? ""\)\.toLowerCase\(\) === "completed" \|\|\n\s+isEventPast\(event, now\);/,
    );
  });

  it("no longer compares against UTC midnight", () => {
    expect(layout).not.toContain("todayStartMs");
    expect(layout).not.toContain("eventEndMs");
    expect(layout).not.toMatch(/new Date\(`\$\{endDate\}T00:00:00`\)/);
  });

  it("matches the /app/events ARIA queue rule", () => {
    const eventsPage = source("src/app/app/events/page.tsx");
    expect(eventsPage).toContain("const isPastEvent = isEventPast(event, now);");
    expect(eventsPage).toContain('const isCompletedOrPast = event.status === "completed" || isPastEvent;');
  });
});

describe("cases the old UTC-midnight rule got wrong", () => {
  // the removed rule: past once the UTC date is after end_date (the server runs in UTC)
  const oldRule = (endDate: string, now: Date) => new Date(`${endDate}T00:00:00Z`).getTime() < new Date(now.toISOString().slice(0, 10)).getTime();

  it("New York event with no end_time is still active at 8 PM local on its end date (UTC is already the next day)", () => {
    const event = { start_date: "2026-10-08", end_date: "2026-10-08", end_time: null, timezone: "America/New_York" };
    const now = new Date("2026-10-09T00:30:00.000Z");
    expect(oldRule(event.end_date, now)).toBe(true);
    expect(isEventPast(event, now)).toBe(false);
    expect(isEventPast(event, new Date("2026-10-09T04:00:00.000Z"))).toBe(true);
  });

  it("Los Angeles event stays active until its 10:30 PM end_time", () => {
    const event = { start_date: "2026-10-08", end_date: "2026-10-08", end_time: "22:30:00", timezone: "America/Los_Angeles" };
    const now = new Date("2026-10-09T05:00:00.000Z"); // 10:00 PM local
    expect(oldRule(event.end_date, now)).toBe(true);
    expect(isEventPast(event, now)).toBe(false);
    expect(isEventPast(event, new Date("2026-10-09T05:30:00.000Z"))).toBe(true);
  });

  it("multi-day Oct 7 -> Oct 10 event is not past during Oct 10 in its own time zone", () => {
    const event = { start_date: "2026-10-07", end_date: "2026-10-10", end_time: null, timezone: "America/Chicago" };
    const now = new Date("2026-10-11T02:00:00.000Z"); // 9 PM Oct 10 in Chicago
    expect(oldRule(event.end_date, now)).toBe(true);
    expect(isEventPast(event, now)).toBe(false);
    expect(isEventPast(event, new Date("2026-10-11T05:00:00.000Z"))).toBe(true);
  });
});
