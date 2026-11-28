/**
 * Website Embeds: a studio's public events in the calendar. Same public rule as the studio events embed API and the public studio
 * page: visibility "public", listed in the public directory, status published or open, studio-owned (not an organizer's), and not over.
 * Only the columns below are selected, so no registration, payment or attendee data can reach an embed. Registration stays on DanceFlow:
 * every event links to its public page (/events/<slug>) in a new tab.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { EVENT_LIST_PAST_BUFFER, eventEndDateLowerBound, filterNotPastEvents } from "@/lib/events/eventTiming";
import { addDays, type DayKey } from "@/lib/public/embedCalendar";

export type PublicEmbedEvent = {
  id: string;
  name: string;
  slug: string;
  typeLabel: string;
  startDate: DayKey;
  endDate: DayKey;
  startTime: string | null;
  endTime: string | null;
  timeZone: string | null;
  location: string;
  registrationRequired: boolean;
  beginnerFriendly: boolean;
};

const EVENT_COLUMNS =
  "id, name, slug, event_type, venue_name, city, state, timezone, start_date, end_date, start_time, end_time, registration_required, beginner_friendly";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 62;

const TYPE_LABELS: Record<string, string> = {
  group_class: "Group class",
  practice_party: "Practice party",
  workshop: "Workshop",
  social_dance: "Social dance",
  competition: "Competition",
  showcase: "Showcase",
  festival: "Festival",
  special_event: "Special event",
};

export function eventTypeLabel(value: unknown): string {
  return typeof value === "string" && TYPE_LABELS[value] ? TYPE_LABELS[value] : "Event";
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");

/** A database row to the safe public shape. An event with no usable slug or no valid start date cannot be linked or placed, so it is dropped. */
export function parsePublicEmbedEvent(row: unknown): PublicEmbedEvent | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const name = text(r.name, 200);
  const slug = typeof r.slug === "string" ? r.slug.trim() : "";
  const startDate = typeof r.start_date === "string" ? r.start_date : "";
  if (!name || !SLUG.test(slug) || !DAY.test(startDate) || typeof r.id !== "string") return null;
  const endRaw = typeof r.end_date === "string" && DAY.test(r.end_date) ? r.end_date : startDate;
  const endDate = endRaw < startDate ? startDate : endRaw;
  const time = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null);
  return {
    id: r.id,
    name,
    slug,
    typeLabel: eventTypeLabel(r.event_type),
    startDate,
    endDate,
    startTime: time(r.start_time),
    endTime: time(r.end_time),
    timeZone: text(r.timezone, 64) || null,
    location: [text(r.venue_name, 120), text(r.city, 80), text(r.state, 40)].filter(Boolean).join(", "),
    registrationRequired: r.registration_required === true,
    beginnerFriendly: r.beginner_friendly === true,
  };
}

/** Every calendar day an event covers (capped, so a mistyped far-future end date cannot flood the grid). */
export function eventDays(event: Pick<PublicEmbedEvent, "startDate" | "endDate">): DayKey[] {
  const days: DayKey[] = [];
  for (let d = event.startDate; d <= event.endDate && days.length < MAX_SPAN_DAYS; d = addDays(d, 1)) days.push(d);
  return days;
}

export function groupEventsByDay(events: PublicEmbedEvent[]): Map<DayKey, PublicEmbedEvent[]> {
  const map = new Map<DayKey, PublicEmbedEvent[]>();
  for (const e of [...events].sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.startTime ?? "").localeCompare(b.startTime ?? ""))) {
    for (const day of eventDays(e)) {
      const list = map.get(day);
      if (list) list.push(e);
      else map.set(day, [e]);
    }
  }
  return map;
}

export const eventPublicPath = (slug: string) => `/events/${encodeURIComponent(slug)}`;

function clock(value: string): string {
  const [h, m] = value.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "7:00 PM – 10:00 PM", "7:00 PM", or "" when the event has no times. Times are the event's own local times, never the viewer's. */
export function formatEventTimes(event: Pick<PublicEmbedEvent, "startTime" | "endTime">): string {
  if (event.startTime && event.endTime) return `${clock(event.startTime)} – ${clock(event.endTime)}`;
  return event.startTime ? clock(event.startTime) : event.endTime ? clock(event.endTime) : "";
}

export async function fetchPublicEmbedEvents(
  supabase: SupabaseClient,
  studioId: string,
  now: Date = new Date(),
  limit = 40,
): Promise<PublicEmbedEvent[]> {
  try {
    const { data, error } = await supabase
      .from("events")
      .select(EVENT_COLUMNS)
      .eq("studio_id", studioId)
      .eq("visibility", "public")
      .eq("public_directory_enabled", true)
      .in("status", ["published", "open"])
      .not("start_date", "is", null)
      .gte("end_date", eventEndDateLowerBound(now))
      .order("start_date", { ascending: true })
      .limit(limit + EVENT_LIST_PAST_BUFFER);
    if (error || !Array.isArray(data)) return [];
    const parsed = data.map(parsePublicEmbedEvent).filter((e): e is PublicEmbedEvent => e !== null);
    const live = filterNotPastEvents(
      parsed.map((e) => ({ e, start_date: e.startDate, end_date: e.endDate, start_time: e.startTime, end_time: e.endTime, timezone: e.timeZone })),
      now,
    ).map((x) => x.e);
    return live.slice(0, limit);
  } catch {
    return [];
  }
}
