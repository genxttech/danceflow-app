/*
  Mobile copy of src/lib/events/eventTiming.ts (the web single authority for "has this event ended"), plus the three time-zone helpers it
  uses from src/lib/booking/selfServiceAvailability.ts. The rule is identical and is pinned by a parity test
  (src/lib/__tests__/eventTimingParity.test.ts) that imports BOTH files and compares them on a matrix of inputs. Change them together.

  An event is PAST once end_date + end_time (the event's own time zone) has passed; no end_time means the end of end_date; a multi-day event
  stays current through its last day. Past is derived from timing only and never removes access to an event's detail, tickets or receipts;
  it only takes the event out of the upcoming listings.
*/

function getZonedDateTimeParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);

  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  const hour = part("hour");

  return { year: part("year"), month: part("month"), day: part("day"), hour: hour === 24 ? 0 : hour, minute: part("minute"), second: part("second") };
}

function getZonedOffsetMs(value: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  const utcLike = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return utcLike - value.getTime();
}

export function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.slice(0, 5).split(":").map(Number);
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let index = 0; index < 3; index += 1) {
    const offset = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset;
  }

  return new Date(utcMs);
}

export function getZonedDateKey(value: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return value.toISOString().slice(0, 10);
}
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
