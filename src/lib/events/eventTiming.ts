import {
  addDaysToDateKey,
  getZonedDateKey,
  zonedDateTimeToUtcDate,
} from "@/lib/booking/selfServiceAvailability";

/*
  Cleanup PR B: the single event-timing authority.

  An event is PAST once its authoritative end moment has passed:
    end_date + end_time, in the EVENT's own time zone;
    when end_time is null, the end of end_date (midnight that ends it) in the event's time zone.
  A multi-day event therefore stays current through its final day. "Past" is derived from timing only -- it is never
  written to events.status (draft / published / cancelled / completed stay business statuses), and it never removes
  access to an event's detail, registrations, payments, check-ins, receipts, documents or exports. It only takes the
  event out of active / upcoming listings.

  Never use the server's or browser's time zone, a naive UTC date, or start_date as a proxy for "has this ended".
*/

export const DEFAULT_EVENT_TIME_ZONE = "America/New_York";

/**
 * Extra rows to fetch for a LIMITED current/upcoming list: rows inside the date prefilter that have in fact already
 * ended (at most about a day of events) are dropped after the fetch, so the list is filled from the remaining rows.
 */
export const EVENT_LIST_PAST_BUFFER = 20;

export type EventTimingFields = {
  start_date?: string | null;
  start_time?: string | null;
  end_date: string | null;
  end_time?: string | null;
  timezone?: string | null;
};

export type EventTimingState = "upcoming" | "in_progress" | "past";

/** The event's IANA time zone, falling back to the column default when missing or not a valid zone. */
export function getEventTimeZone(event: { timezone?: string | null }): string {
  const zone = event.timezone?.trim();
  if (!zone) return DEFAULT_EVENT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_EVENT_TIME_ZONE;
  }
}

function isDateKey(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTime(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{2}:\d{2}/.test(value);
}

/** The authoritative end moment (UTC instant), or null when the event has no usable end date. */
export function getEventEndUtc(event: EventTimingFields): Date | null {
  const endDate = isDateKey(event.end_date) ? event.end_date : isDateKey(event.start_date) ? event.start_date : null;
  if (!endDate) return null;
  const zone = getEventTimeZone(event);
  if (isTime(event.end_time)) return zonedDateTimeToUtcDate(endDate, event.end_time, zone);
  // No end time: the event runs through the whole of its end date in its own time zone.
  return zonedDateTimeToUtcDate(addDaysToDateKey(endDate, 1), "00:00", zone);
}

/** The start moment (UTC instant); a missing start time means the start of start_date in the event's time zone. */
export function getEventStartUtc(event: EventTimingFields): Date | null {
  if (!isDateKey(event.start_date)) return null;
  const zone = getEventTimeZone(event);
  return zonedDateTimeToUtcDate(event.start_date, isTime(event.start_time) ? event.start_time : "00:00", zone);
}

/** True once the event's end moment has passed. An event without a usable end date is never treated as past. */
export function isEventPast(event: EventTimingFields, now: Date = new Date()): boolean {
  const end = getEventEndUtc(event);
  return end !== null && now.getTime() >= end.getTime();
}

export function getEventTimingState(event: EventTimingFields, now: Date = new Date()): EventTimingState {
  if (isEventPast(event, now)) return "past";
  const start = getEventStartUtc(event);
  return start && now.getTime() >= start.getTime() ? "in_progress" : "upcoming";
}

/**
 * Operational day grouping (check-in, registrations): "past" once the event has ended; "today" while it is in progress
 * or when it starts on today's date in the event's own time zone; otherwise "upcoming".
 */
export function getEventDayBucket(event: EventTimingFields, now: Date = new Date()): "past" | "today" | "upcoming" {
  const state = getEventTimingState(event, now);
  if (state === "past") return "past";
  if (state === "in_progress") return "today";
  return event.start_date === getZonedDateKey(now, getEventTimeZone(event)) ? "today" : "upcoming";
}

/**
 * Safe database lower bound for `end_date` when listing current and upcoming events: every event that has not ended
 * has a (local) end_date on or after the UTC date one day before now -- time zones are at most a day from UTC. Use as
 * `.gte("end_date", eventEndDateLowerBound(now))` so ended history is not fetched, then apply `isEventPast` exactly.
 */
export function eventEndDateLowerBound(now: Date = new Date()): string {
  return addDaysToDateKey(getZonedDateKey(now, "UTC"), -1);
}

/**
 * Safe database upper bound for `end_date` when listing PAST events: every ended event has a (local) end_date on or
 * before the UTC date one day after now. Use as `.lte("end_date", eventPastEndDateUpperBound(now))`, then keep only
 * rows where `isEventPast` is true.
 */
export function eventPastEndDateUpperBound(now: Date = new Date()): string {
  return addDaysToDateKey(getZonedDateKey(now, "UTC"), 1);
}

/** Current and upcoming events only (order preserved). */
export function filterNotPastEvents<T extends EventTimingFields>(events: readonly T[], now: Date = new Date()): T[] {
  return events.filter((event) => !isEventPast(event, now));
}

/** Ended events only (order preserved). */
export function filterPastEvents<T extends EventTimingFields>(events: readonly T[], now: Date = new Date()): T[] {
  return events.filter((event) => isEventPast(event, now));
}
