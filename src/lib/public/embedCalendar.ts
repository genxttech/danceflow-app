/**
 * Website Embeds: calendar math over the public class read model. Pure functions; every "day" is a calendar day in the
 * class's own studio time zone, never the viewer's or the server's.
 */
import type { PublicGroupClass } from "@/lib/public/groupClasses";

export type DayKey = string; // YYYY-MM-DD

export function dayKeyInZone(iso: string | number | Date, timeZone: string): DayKey {
  const d = new Date(iso);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const utc = (key: DayKey) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toKey = (d: Date): DayKey => d.toISOString().slice(0, 10);

export const addDays = (key: DayKey, n: number): DayKey => toKey(new Date(utc(key).getTime() + n * 86_400_000));

export function addMonths(key: DayKey, n: number): DayKey {
  const d = utc(key);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  return toKey(target);
}

/** Sunday-first weeks covering the month of `anchor`, each a 7-day array (includes leading/trailing days of neighbours). */
export function monthWeeks(anchor: DayKey): DayKey[][] {
  const a = utc(anchor);
  const first = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
  const last = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0));
  const start = toKey(new Date(first.getTime() - first.getUTCDay() * 86_400_000));
  const weekCount = Math.ceil((first.getUTCDay() + last.getUTCDate()) / 7);
  return Array.from({ length: weekCount }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
}

export function weekDays(anchor: DayKey): DayKey[] {
  const a = utc(anchor);
  const start = addDays(anchor, -a.getUTCDay());
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function groupByDay(items: PublicGroupClass[]): Map<DayKey, PublicGroupClass[]> {
  const map = new Map<DayKey, PublicGroupClass[]>();
  for (const item of [...items].sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt))) {
    const key = dayKeyInZone(item.startsAt, item.timeZone);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** Instructor filter: exact match on the PUBLIC instructor name (null names never match a filter). */
export function filterByInstructor(items: PublicGroupClass[], instructor: string | null): PublicGroupClass[] {
  if (!instructor) return items;
  return items.filter((i) => i.instructorName === instructor);
}

export function publicInstructorNames(items: PublicGroupClass[]): string[] {
  return [...new Set(items.map((i) => i.instructorName).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b));
}

export function dayHeading(key: DayKey, opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(utc(key));
}

/** Short zone label for the class's own time zone ("EST", "PDT"), so a viewer elsewhere can read the times correctly. */
export function zoneLabel(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
