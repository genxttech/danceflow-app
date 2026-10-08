import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_TIME_ZONE,
  EVENT_LIST_PAST_BUFFER,
  eventEndDateLowerBound,
  eventPastEndDateUpperBound,
  filterNotPastEvents,
  filterPastEvents,
  getEventDayBucket,
  getEventEndUtc,
  getEventTimeZone,
  getEventTimingState,
  isEventPast,
  type EventTimingFields,
} from "@/lib/events/eventTiming";

/**
 * Cleanup PR B: an event is past only after its authoritative end moment (end_date + end_time, or the end of end_date
 * when end_time is null) in the event's own time zone. Every clock here is fixed.
 */

const NOW = new Date("2026-10-08T15:00:00.000Z"); // 11:00 in New York, 08:00 in Los Angeles, 00:00 Oct 9 in Tokyo

function ms(iso: string, deltaMs = 0) {
  return new Date(new Date(iso).getTime() + deltaMs);
}

function ev(fields: Partial<EventTimingFields> & { end_date: string | null }): EventTimingFields {
  return { timezone: "America/New_York", start_time: null, end_time: null, ...fields };
}

describe("isEventPast / getEventTimingState", () => {
  it("future event later the same day is upcoming, not past", () => {
    const event = ev({ start_date: "2026-10-08", start_time: "18:00:00", end_date: "2026-10-08", end_time: "21:00:00" });
    expect(isEventPast(event, NOW)).toBe(false);
    expect(getEventTimingState(event, NOW)).toBe("upcoming");
  });

  it("currently active event is in progress, not past", () => {
    const event = ev({ start_date: "2026-10-08", start_time: "10:00:00", end_date: "2026-10-08", end_time: "13:00:00" });
    expect(isEventPast(event, NOW)).toBe(false);
    expect(getEventTimingState(event, NOW)).toBe("in_progress");
  });

  it("event that ended earlier today is past", () => {
    const event = ev({ start_date: "2026-10-08", start_time: "08:00:00", end_date: "2026-10-08", end_time: "10:00:00" });
    expect(isEventPast(event, NOW)).toBe(true);
    expect(getEventTimingState(event, NOW)).toBe("past");
  });

  it("multi-day event Oct 7 -> Oct 10 is still active on Oct 8 (start_date is not a proxy for past)", () => {
    const event = ev({ start_date: "2026-10-07", end_date: "2026-10-10" });
    expect(isEventPast(event, NOW)).toBe(false);
    expect(getEventTimingState(event, NOW)).toBe("in_progress");
    expect(getEventDayBucket(event, NOW)).toBe("today");
  });

  it("multi-day event stays current through its final day and becomes past after it", () => {
    const event = ev({ start_date: "2026-10-07", end_date: "2026-10-10" });
    // end of Oct 10 in New York = 2026-10-11T04:00Z
    expect(isEventPast(event, ms("2026-10-11T03:59:59.999Z"))).toBe(false);
    expect(isEventPast(event, ms("2026-10-11T04:00:00.000Z"))).toBe(true);
  });

  it("multi-day event that ended is past", () => {
    const event = ev({ start_date: "2026-10-03", end_date: "2026-10-05" });
    expect(isEventPast(event, NOW)).toBe(true);
  });

  it("explicit end_time is the end moment, in the event time zone", () => {
    const event = ev({ start_date: "2026-10-08", end_date: "2026-10-08", end_time: "11:30:00" });
    expect(getEventEndUtc(event)?.toISOString()).toBe("2026-10-08T15:30:00.000Z");
    expect(isEventPast(event, NOW)).toBe(false);
    expect(isEventPast(event, ms("2026-10-08T15:30:00.000Z"))).toBe(true);
  });

  it("missing end_time means active through the end of end_date in the event time zone", () => {
    const event = ev({ start_date: "2026-10-08", end_date: "2026-10-08" });
    expect(getEventEndUtc(event)?.toISOString()).toBe("2026-10-09T04:00:00.000Z");
    // UTC is already Oct 9 but it is still Oct 8 in New York
    expect(isEventPast(event, ms("2026-10-09T02:00:00.000Z"))).toBe(false);
  });

  it("time zone east of UTC (Asia/Tokyo): ends at local midnight, which is earlier in UTC", () => {
    const event = ev({ start_date: "2026-10-08", end_date: "2026-10-08", timezone: "Asia/Tokyo" });
    expect(getEventEndUtc(event)?.toISOString()).toBe("2026-10-08T15:00:00.000Z");
    expect(isEventPast(event, ms("2026-10-08T15:00:00.000Z", -1))).toBe(false);
    expect(isEventPast(event, ms("2026-10-08T15:00:00.000Z"))).toBe(true);
    // a naive UTC-date comparison would still call it "today" here
    expect(isEventPast(event, NOW)).toBe(true);
  });

  it("time zone west of UTC: America/Los_Angeles 10:30 PM end stays active after UTC has rolled to the next day", () => {
    const event = ev({
      start_date: "2026-10-08",
      start_time: "19:00:00",
      end_date: "2026-10-08",
      end_time: "22:30:00",
      timezone: "America/Los_Angeles",
    });
    expect(getEventEndUtc(event)?.toISOString()).toBe("2026-10-09T05:30:00.000Z");
    expect(isEventPast(event, ms("2026-10-09T05:00:00.000Z"))).toBe(false); // UTC Oct 9, 10:00 PM local
    expect(getEventTimingState(event, ms("2026-10-09T05:00:00.000Z"))).toBe("in_progress");
    expect(isEventPast(event, ms("2026-10-09T05:30:00.000Z"))).toBe(true);
  });

  it("boundary: immediately before the end is not past, the end instant and after are past", () => {
    const event = ev({ start_date: "2026-10-08", end_date: "2026-10-08", end_time: "21:00:00" });
    const end = getEventEndUtc(event)!;
    expect(end.toISOString()).toBe("2026-10-09T01:00:00.000Z");
    expect(isEventPast(event, new Date(end.getTime() - 1))).toBe(false);
    expect(isEventPast(event, end)).toBe(true);
    expect(isEventPast(event, new Date(end.getTime() + 1))).toBe(true);
  });

  it("uses the event time zone, never the default, when they differ", () => {
    const la = ev({ start_date: "2026-10-08", end_date: "2026-10-08", timezone: "America/Los_Angeles" });
    const ny = ev({ start_date: "2026-10-08", end_date: "2026-10-08", timezone: "America/New_York" });
    const at = ms("2026-10-09T05:00:00.000Z");
    expect(isEventPast(ny, at)).toBe(true);
    expect(isEventPast(la, at)).toBe(false);
  });

  it("invalid or missing time zone falls back to the column default", () => {
    expect(getEventTimeZone({ timezone: "Not/AZone" })).toBe(DEFAULT_EVENT_TIME_ZONE);
    expect(getEventTimeZone({ timezone: null })).toBe(DEFAULT_EVENT_TIME_ZONE);
    expect(getEventTimeZone({ timezone: " Asia/Tokyo " })).toBe("Asia/Tokyo");
  });

  it("missing end_date falls back to start_date; no usable dates is never past", () => {
    expect(isEventPast(ev({ start_date: "2026-10-01", end_date: null }), NOW)).toBe(true);
    expect(isEventPast(ev({ start_date: "2026-10-08", end_date: null }), NOW)).toBe(false);
    expect(isEventPast(ev({ start_date: null, end_date: null }), NOW)).toBe(false);
  });
});

describe("getEventDayBucket (check-in / registrations grouping)", () => {
  it("groups by the event's own time zone", () => {
    expect(getEventDayBucket(ev({ start_date: "2026-10-08", start_time: "18:00:00", end_date: "2026-10-08" }), NOW)).toBe(
      "today",
    );
    expect(getEventDayBucket(ev({ start_date: "2026-10-09", end_date: "2026-10-09" }), NOW)).toBe("upcoming");
    expect(getEventDayBucket(ev({ start_date: "2026-10-07", end_date: "2026-10-07" }), NOW)).toBe("past");
  });
});

describe("database prefilter bounds", () => {
  const zones = ["Pacific/Kiritimati", "Asia/Tokyo", "UTC", "America/New_York", "America/Los_Angeles", "Pacific/Pago_Pago", "Etc/GMT+12"];
  const instants = ["2026-10-08T00:00:00.000Z", "2026-10-08T11:59:59.999Z", "2026-10-08T23:59:59.999Z", "2026-03-08T07:30:00.000Z"];

  it("every not-yet-ended event has end_date >= eventEndDateLowerBound(now) (no current event is excluded)", () => {
    for (const iso of instants) {
      const now = new Date(iso);
      const bound = eventEndDateLowerBound(now);
      const dayBefore = new Date(`${bound}T00:00:00.000Z`);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const justBelow = dayBefore.toISOString().slice(0, 10);
      for (const timezone of zones) {
        // latest possible end for an event whose end_date is below the bound: the whole day, no end_time
        expect(isEventPast({ end_date: justBelow, end_time: null, timezone }, now)).toBe(true);
      }
    }
  });

  it("every ended event has end_date <= eventPastEndDateUpperBound(now)", () => {
    for (const iso of instants) {
      const now = new Date(iso);
      const bound = eventPastEndDateUpperBound(now);
      const dayAfter = new Date(`${bound}T00:00:00.000Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      const justAbove = dayAfter.toISOString().slice(0, 10);
      for (const timezone of zones) {
        expect(isEventPast({ end_date: justAbove, end_time: "00:00:00", timezone }, now)).toBe(false);
      }
    }
  });

  it("the lower bound is the UTC date minus one day", () => {
    expect(eventEndDateLowerBound(NOW)).toBe("2026-10-07");
    expect(eventPastEndDateUpperBound(NOW)).toBe("2026-10-09");
  });
});

describe("filterNotPastEvents / filterPastEvents", () => {
  it("partition events without reordering, and past events never consume a limited list's slots", () => {
    // what the date prefilter can return: two events that ended within the last day sorted first, then current/future
    const rows = [
      { id: "ended-1", ...ev({ start_date: "2026-10-07", end_date: "2026-10-07" }) },
      { id: "ended-2", ...ev({ start_date: "2026-10-08", end_date: "2026-10-08", end_time: "09:00:00" }) },
      { id: "active-multi", ...ev({ start_date: "2026-10-07", end_date: "2026-10-10" }) },
      { id: "today-later", ...ev({ start_date: "2026-10-08", start_time: "19:00:00", end_date: "2026-10-08" }) },
      { id: "future", ...ev({ start_date: "2026-10-20", end_date: "2026-10-20" }) },
    ];
    const current = filterNotPastEvents(rows, NOW);
    expect(current.map((row) => row.id)).toEqual(["active-multi", "today-later", "future"]);
    expect(filterPastEvents(rows, NOW).map((row) => row.id)).toEqual(["ended-1", "ended-2"]);
    // a limit of 2 is filled from current events only
    expect(filterNotPastEvents(rows, NOW).slice(0, 2).map((row) => row.id)).toEqual(["active-multi", "today-later"]);
    expect(EVENT_LIST_PAST_BUFFER).toBeGreaterThan(0);
  });
});
