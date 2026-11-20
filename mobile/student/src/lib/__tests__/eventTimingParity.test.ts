// The mobile event-timing rule must equal the web one (src/lib/events/eventTiming.ts), input for input. The web file and the helpers it imports
// (src/lib/booking/selfServiceAvailability.ts, which has no imports) are transpiled from their source text and evaluated here, so this test fails
// the moment either copy changes without the other. (A direct import is not possible: the jest alias "@/" points at the mobile app.)
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as mobile from "@/lib/eventTiming";

type Timing = typeof mobile;

const repoRoot = path.resolve(__dirname, "../../../../..");

function loadWebModule(relative: string, requires: Record<string, unknown> = {}) {
  const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", "require", js)(mod, mod.exports, (id: string) => {
    if (id in requires) return requires[id];
    throw new Error(`unexpected import in ${relative}: ${id}`);
  });
  return mod.exports;
}

const webSelfService = loadWebModule("src/lib/booking/selfServiceAvailability.ts");
const web = loadWebModule("src/lib/events/eventTiming.ts", { "@/lib/booking/selfServiceAvailability": webSelfService }) as unknown as Timing;

type E = { id: string } & Parameters<Timing["isEventPast"]>[0];
const events: E[] = [
  { id: "single-day-with-times", start_date: "2026-11-20", start_time: "19:00", end_date: "2026-11-20", end_time: "22:00", timezone: "America/New_York" },
  { id: "multi-day", start_date: "2026-11-18", start_time: "09:00", end_date: "2026-11-20", end_time: "17:00", timezone: "America/New_York" },
  { id: "multi-day-no-end-time", start_date: "2026-11-18", start_time: "09:00", end_date: "2026-11-20", end_time: null, timezone: "America/New_York" },
  { id: "no-end-time", start_date: "2026-11-20", start_time: "19:00", end_date: "2026-11-20", end_time: null, timezone: "America/Chicago" },
  { id: "null-end-date-falls-back-to-start", start_date: "2026-11-20", start_time: "19:00", end_date: null, end_time: "22:00", timezone: "America/New_York" },
  { id: "no-usable-dates", start_date: null, start_time: null, end_date: null, end_time: null, timezone: "America/New_York" },
  { id: "bad-date-text", start_date: "soon", end_date: "later", timezone: "America/New_York" },
  { id: "no-timezone-uses-default", start_date: "2026-11-20", end_date: "2026-11-20", end_time: "21:00", timezone: null },
  { id: "invalid-timezone-uses-default", start_date: "2026-11-20", end_date: "2026-11-20", end_time: "21:00", timezone: "Mars/Olympus" },
  { id: "west-coast-late-evening", start_date: "2026-11-20", start_time: "20:00", end_date: "2026-11-20", end_time: "23:00", timezone: "America/Los_Angeles" },
  { id: "pacific-honolulu", start_date: "2026-11-20", end_date: "2026-11-20", end_time: "23:30", timezone: "Pacific/Honolulu" },
  { id: "far-east-auckland", start_date: "2026-11-20", end_date: "2026-11-20", end_time: "01:00", timezone: "Pacific/Auckland" },
  { id: "midnight-end", start_date: "2026-11-20", start_time: "22:00", end_date: "2026-11-21", end_time: "00:00", timezone: "America/New_York" },
  { id: "seconds-in-time", start_date: "2026-11-20", end_date: "2026-11-20", end_time: "21:30:00", timezone: "America/New_York" },
  // DST edges (America/New_York): spring forward 2026-03-08 02:00 -> 03:00, fall back 2026-11-01 02:00 -> 01:00
  { id: "dst-spring-nonexistent-0230", start_date: "2026-03-08", end_date: "2026-03-08", end_time: "02:30", timezone: "America/New_York" },
  { id: "dst-spring-after-0330", start_date: "2026-03-08", end_date: "2026-03-08", end_time: "03:30", timezone: "America/New_York" },
  { id: "dst-fall-ambiguous-0130", start_date: "2026-11-01", end_date: "2026-11-01", end_time: "01:30", timezone: "America/New_York" },
  { id: "dst-fall-no-end-time", start_date: "2026-11-01", end_date: "2026-11-01", end_time: null, timezone: "America/New_York" },
  { id: "dst-spring-no-end-time", start_date: "2026-03-08", end_date: "2026-03-08", end_time: null, timezone: "America/New_York" },
  { id: "year-boundary", start_date: "2026-12-31", end_date: "2026-12-31", end_time: null, timezone: "America/New_York" },
  { id: "leap-day", start_date: "2028-02-29", end_date: "2028-02-29", end_time: null, timezone: "America/New_York" },
];

const instants = [
  "2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", "2026-03-08T07:30:00Z", "2026-03-08T08:30:00Z", "2026-03-08T12:00:00Z", "2026-03-09T03:59:59Z", "2026-03-09T04:00:00Z",
  "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-01T07:00:00Z", "2026-11-02T04:59:59Z", "2026-11-02T05:00:00Z",
  "2026-11-18T12:00:00Z", "2026-11-20T02:59:59Z", "2026-11-20T03:00:00Z", "2026-11-21T01:00:00Z", "2026-11-21T02:59:59Z", "2026-11-21T03:00:00Z", "2026-11-21T04:59:59Z",
  "2026-11-21T05:00:00Z", "2026-11-21T06:59:59Z", "2026-11-21T07:00:00Z", "2026-11-21T09:30:00Z", "2026-11-21T10:00:00Z", "2026-11-21T12:00:00Z", "2026-11-22T00:00:00Z",
  "2026-12-31T23:59:59Z", "2027-01-01T04:59:59Z", "2027-01-01T05:00:00Z", "2028-03-01T04:59:59Z", "2028-03-01T05:00:00Z",
].map((value) => new Date(value));

describe("mobile eventTiming equals the web eventTiming", () => {
  it("the web module loaded (the comparison is against the real file, not an empty stub)", () => {
    expect(typeof web.isEventPast).toBe("function");
    expect(web.DEFAULT_EVENT_TIME_ZONE).toBe("America/New_York");
  });

  it("exports the same surface", () => {
    expect(Object.keys(mobile).filter((key) => !["zonedDateTimeToUtcDate", "getZonedDateKey", "addDaysToDateKey"].includes(key)).sort()).toEqual(Object.keys(web).sort());
  });

  it("constants and the time-zone resolver agree", () => {
    expect(mobile.DEFAULT_EVENT_TIME_ZONE).toBe(web.DEFAULT_EVENT_TIME_ZONE);
    expect(mobile.EVENT_LIST_PAST_BUFFER).toBe(web.EVENT_LIST_PAST_BUFFER);
    for (const e of events) expect(mobile.getEventTimeZone(e)).toBe(web.getEventTimeZone(e));
  });

  it("end and start instants agree for every event", () => {
    for (const e of events) {
      expect(mobile.getEventEndUtc(e)?.toISOString() ?? null).toBe(web.getEventEndUtc(e)?.toISOString() ?? null);
      expect(mobile.getEventStartUtc(e)?.toISOString() ?? null).toBe(web.getEventStartUtc(e)?.toISOString() ?? null);
    }
  });

  it("isEventPast, timing state and day bucket agree for every event at every instant", () => {
    let compared = 0;
    for (const e of events) {
      for (const now of instants) {
        expect([e.id, now.toISOString(), mobile.isEventPast(e, now)]).toEqual([e.id, now.toISOString(), web.isEventPast(e, now)]);
        expect([e.id, now.toISOString(), mobile.getEventTimingState(e, now)]).toEqual([e.id, now.toISOString(), web.getEventTimingState(e, now)]);
        expect([e.id, now.toISOString(), mobile.getEventDayBucket(e, now)]).toEqual([e.id, now.toISOString(), web.getEventDayBucket(e, now)]);
        compared += 3;
      }
    }
    expect(compared).toBe(events.length * instants.length * 3);
  });

  it("the database prefilter bounds and the list filters agree", () => {
    for (const now of instants) {
      expect(mobile.eventEndDateLowerBound(now)).toBe(web.eventEndDateLowerBound(now));
      expect(mobile.eventPastEndDateUpperBound(now)).toBe(web.eventPastEndDateUpperBound(now));
      expect(mobile.filterNotPastEvents(events, now).map((e) => e.id)).toEqual(web.filterNotPastEvents(events, now).map((e) => e.id));
      expect(mobile.filterPastEvents(events, now).map((e) => e.id)).toEqual(web.filterPastEvents(events, now).map((e) => e.id));
    }
  });
});

describe("the rule itself (anchors, so a wrong rule cannot pass by being wrong in both files)", () => {
  const at = (iso: string) => new Date(iso);
  const nyEvening = { start_date: "2026-11-20", start_time: "19:00", end_date: "2026-11-20", end_time: "22:00", timezone: "America/New_York" };

  it("an event ending exactly now is past; one second earlier it is not", () => {
    expect(mobile.isEventPast(nyEvening, at("2026-11-21T02:59:59Z"))).toBe(false); // 21:59:59 EST
    expect(mobile.isEventPast(nyEvening, at("2026-11-21T03:00:00Z"))).toBe(true); // 22:00:00 EST
  });
  it("uses the event's own zone, not the UTC date: 23:00 Pacific on the 20th is the 21st in UTC but still the 20th for the event", () => {
    const la = { start_date: "2026-11-20", end_date: "2026-11-20", end_time: "23:00", timezone: "America/Los_Angeles" };
    expect(mobile.isEventPast(la, at("2026-11-21T06:59:59Z"))).toBe(false);
    expect(mobile.isEventPast(la, at("2026-11-21T07:00:00Z"))).toBe(true);
  });
  it("no end time runs through the whole end date, in the event's zone", () => {
    const e = { start_date: "2026-11-20", end_date: "2026-11-20", end_time: null, timezone: "America/Chicago" };
    expect(mobile.isEventPast(e, at("2026-11-21T05:59:59Z"))).toBe(false); // 23:59:59 CST on the 20th
    expect(mobile.isEventPast(e, at("2026-11-21T06:00:00Z"))).toBe(true);
  });
  it("a multi-day event stays current through its last day", () => {
    const e = { start_date: "2026-11-18", end_date: "2026-11-20", end_time: "17:00", timezone: "America/New_York" };
    expect(mobile.isEventPast(e, at("2026-11-19T20:00:00Z"))).toBe(false);
    expect(mobile.isEventPast(e, at("2026-11-20T22:00:00Z"))).toBe(true);
  });
  it("an event with no usable date is never past (it stays listed rather than vanishing)", () => {
    expect(mobile.isEventPast({ end_date: null }, at("2030-01-01T00:00:00Z"))).toBe(false);
  });
  it("a null end_date uses start_date", () => {
    expect(mobile.isEventPast({ start_date: "2026-11-20", end_date: null, end_time: "22:00", timezone: "America/New_York" }, at("2026-11-21T03:00:00Z"))).toBe(true);
  });
  it("DST: 02:30 on the spring-forward day is resolved the same way the web resolves it, and the fall-back day has 25 hours", () => {
    const fall = { start_date: "2026-11-01", end_date: "2026-11-01", end_time: null, timezone: "America/New_York" };
    expect(mobile.isEventPast(fall, at("2026-11-02T04:59:59Z"))).toBe(false); // 23:59:59 EST on Nov 1
    expect(mobile.isEventPast(fall, at("2026-11-02T05:00:00Z"))).toBe(true);
  });
  it("the prefilter bound keeps every not-yet-ended event: the day before the UTC date", () => {
    expect(mobile.eventEndDateLowerBound(at("2026-11-20T14:14:00Z"))).toBe("2026-11-19");
    expect(mobile.eventPastEndDateUpperBound(at("2026-11-20T14:14:00Z"))).toBe("2026-11-21");
  });
});
