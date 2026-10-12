/**
 * CI-A: strict conversion between an event-local wall-clock time ("YYYY-MM-DDTHH:mm", as entered in a
 * datetime-local input) and an absolute instant, in the EVENT's IANA time zone.
 *
 * Unlike the lenient zonedDateTimeToUtcDate helper used for booking slots, this never guesses around daylight-saving
 * transitions: a wall time that does not exist (spring-forward gap) or that happens twice (fall-back overlap) is
 * reported so the organizer can choose an unambiguous time. Pure (Intl only), no server-only APIs.
 */

export type EventLocalToInstantResult =
  | { ok: true; iso: string }
  | { ok: false; reason: "invalid_format" | "invalid_date" | "invalid_time_zone" | "nonexistent_local_time" | "ambiguous_local_time" };

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function localParts(utcMs: number, format: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(format.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone's UTC offset (ms) at an instant. */
function offsetAt(utcMs: number, format: Intl.DateTimeFormat) {
  const p = localParts(utcMs, format);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Event-local "YYYY-MM-DDTHH:mm[:ss]" -> absolute instant, strictly. */
export function eventLocalToInstant(local: string, timeZone: string): EventLocalToInstantResult {
  const match = LOCAL_PATTERN.exec(local.trim());
  if (!match) return { ok: false, reason: "invalid_format" };
  const [year, month, day, hour, minute, second] = match.slice(1).map((value) => Number(value ?? 0));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return { ok: false, reason: "invalid_date" };
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return { ok: false, reason: "invalid_date" };

  let format: Intl.DateTimeFormat;
  try {
    format = formatter(timeZone);
  } catch {
    return { ok: false, reason: "invalid_time_zone" };
  }

  // Candidate instants from the offsets in force a day before and a day after the wall time; a valid candidate is
  // one whose local reading is exactly the requested wall time.
  const offsets = new Set([offsetAt(wall - 86_400_000, format), offsetAt(wall + 86_400_000, format), offsetAt(wall, format)]);
  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = wall - offset;
    const p = localParts(candidate, format);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === second) {
      matches.add(candidate);
    }
  }
  if (matches.size === 0) return { ok: false, reason: "nonexistent_local_time" };
  if (matches.size > 1) return { ok: false, reason: "ambiguous_local_time" };
  return { ok: true, iso: new Date([...matches][0]).toISOString() };
}

/** Absolute instant -> event-local "YYYY-MM-DDTHH:mm" for a datetime-local input ("" when invalid). */
export function instantToEventLocalInput(value: string | null | undefined, timeZone: string): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  let format: Intl.DateTimeFormat;
  try {
    format = formatter(timeZone);
  } catch {
    return "";
  }
  const p = localParts(ms, format);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export const EVENT_LOCAL_TIME_ERRORS: Record<Exclude<EventLocalToInstantResult, { ok: true }>["reason"], string> = {
  invalid_format: "Enter the early bird end date and time.",
  invalid_date: "The early bird end date and time is not a valid date.",
  invalid_time_zone: "This event's time zone is not valid. Fix the event time zone before setting early bird pricing.",
  nonexistent_local_time: "That early bird end time does not exist in the event's time zone (clocks skip it for daylight saving). Choose another time.",
  ambiguous_local_time: "That early bird end time happens twice in the event's time zone (clocks repeat it for daylight saving). Choose another time.",
};
