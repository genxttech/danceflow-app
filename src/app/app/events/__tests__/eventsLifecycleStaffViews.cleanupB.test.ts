import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Cleanup PR B: in the staff workspace "past" is a derived view, not an archive. /app/events defaults to current and
 * upcoming events and offers a Past view; the organizer Event Snapshot shows only current/upcoming events and links to
 * the Past view; sell-tickets offers only events that have not ended. Nothing deletes events or rewrites their status,
 * and detail / registrations / payments / reporting / exports / check-in stay reachable for ended events.
 */

function source(path: string) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const lifecycleFiles = [
  "src/lib/events/eventTiming.ts",
  "src/app/app/events/page.tsx",
  "src/app/app/page.tsx",
  "src/app/app/events/sell-tickets/page.tsx",
  "src/app/app/events/checkin/page.tsx",
  "src/app/app/events/registrations/page.tsx",
  "src/app/app/events/export/attention/route.ts",
  "src/app/app/events/export/financial-summary/route.ts",
  "src/app/app/aria/page.tsx",
  "src/app/app/aria/operations/page.tsx",
];

describe("/app/events Upcoming / Past views", () => {
  const page = source("src/app/app/events/page.tsx");

  it("defaults to Upcoming and switches to Past only for ?view=past", () => {
    expect(page).toContain('=== "past" ? "past" : "upcoming"');
    expect(page).toContain("const listView = parseEventsListView((await searchParams)?.view);");
    expect(page).toContain('const listedEvents = listView === "past" ? pastListEvents : upcomingListEvents;');
    expect(page).toContain("const upcomingListEvents = filterNotPastEvents(typedEvents, now);");
    expect(page).toContain("filterPastEvents(typedEvents, now)");
  });

  it("labels are Upcoming / Past (not Archived) and links point at the two views", () => {
    expect(page).toContain('label: "Upcoming", href: "/app/events"');
    expect(page).toContain('label: "Past", href: "/app/events?view=past"');
    expect(page).not.toMatch(/archived/i);
  });

  it("has a Past empty state and keeps the no-events onboarding state", () => {
    expect(page).toContain('"No past events yet."');
    expect(page).toContain("No events yet");
  });

  it("lists the selected view, but totals/reporting still cover every event", () => {
    expect(page).toContain("{listedEvents.map((event) => {");
    expect(page).toContain("const organizerEventRows: OrganizerEventDashboardRow[] = typedEvents.map(");
  });

  it("past detection uses the end moment (not start_date) for both the per-event flag and the upcoming count", () => {
    expect(page).toContain("const isPastEvent = isEventPast(event, now);");
    expect(page).toContain("const upcomingEventsCount = upcomingListEvents.length;");
    expect(page).not.toContain("todayStart");
  });

  it("past events keep their detail link (same href shape for every listed event)", () => {
    expect(page).toMatch(/href=\{`\/app\/events\/\$\{event\.id\}`\}/);
  });
});

describe("organizer workspace Event Snapshot", () => {
  const dashboard = source("src/app/app/page.tsx");

  it("loads current/upcoming events with a bounded prefilter and excludes past ones before slicing", () => {
    expect(dashboard).toContain('.gte("end_date", eventEndDateLowerBound(now))');
    expect(dashboard).toContain(".limit(5 + EVENT_LIST_PAST_BUFFER)");
    expect(dashboard).toContain(
      "const activeSnapshotEvents = filterNotPastEvents((snapshotEvents ?? []) as EventRow[], now).slice(0, 5);",
    );
    expect(dashboard).toContain("{activeSnapshotEvents.map((event) => (");
    expect(dashboard).not.toContain("typedEvents.slice(0, 5)");
  });

  it("links to the Past view when nothing is upcoming", () => {
    expect(dashboard).toContain('href="/app/events?view=past"');
    expect(dashboard).toContain("View past events");
  });
});

describe("operational selectors and reports", () => {
  it("sell-tickets offers only events that have not ended", () => {
    const text = source("src/app/app/events/sell-tickets/page.tsx");
    expect(text).toContain('.gte("end_date", eventEndDateLowerBound(now))');
    expect(text).toContain("const typedEvents = filterNotPastEvents((events ?? []) as EventRow[], now);");
    expect(text).toContain("end_date, end_time, timezone");
  });

  it("check-in and registrations group by the shared day bucket (event time zone + end moment)", () => {
    for (const path of ["src/app/app/events/checkin/page.tsx", "src/app/app/events/registrations/page.tsx"]) {
      const text = source(path);
      expect(text).toContain("timing: getEventDayBucket(event, now),");
      expect(text).not.toContain("function getEventTimingBucket(");
      expect(text).toMatch(/\n\s+timezone,\n/);
    }
  });

  it("exports and ARIA displays decide 'past' with isEventPast, not start_date", () => {
    for (const path of [
      "src/app/app/events/export/attention/route.ts",
      "src/app/app/events/export/financial-summary/route.ts",
      "src/app/app/aria/page.tsx",
      "src/app/app/aria/operations/page.tsx",
    ]) {
      const text = source(path);
      expect(text).toMatch(/const isPast(Event)? = isEventPast\(event, now\);/);
      expect(text).not.toMatch(/start_date\}T00:00:00`\)/);
    }
  });

  it("exports still include every event (no not-past filter on reports)", () => {
    for (const path of ["src/app/app/events/export/attention/route.ts", "src/app/app/events/export/financial-summary/route.ts"]) {
      expect(source(path)).not.toContain("filterNotPastEvents");
    }
  });
});

describe("past is derived, never written", () => {
  it("no lifecycle file deletes events or writes events.status / an archive flag", () => {
    for (const path of lifecycleFiles) {
      const text = source(path);
      expect(text).not.toMatch(/\.from\("events"\)\s*\.(delete|update|upsert)\(/);
      // no archive flag is read from or written to events (an unrelated package archived_at elsewhere is not events)
      expect(text).not.toMatch(/\.from\("events"\)[^;]*archived/);
    }
  });
});
