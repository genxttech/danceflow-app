import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { EMPTY_PRESENTATION, type EventPresentation } from "./draft";

type Client = Awaited<ReturnType<typeof createClient>>;

const PRESENTATION_COLUMNS =
  "name, short_description, public_summary, description, public_description, cover_image_url, public_cover_image_url, public_highlights, public_registration_info, " +
  "venue_name, address_line_1, address_line_2, city, state, postal_code, start_date, end_date, start_time, end_time, timezone";

/**
 * The event page content as the public event page shows it today (short_description, description and
 * cover_image_url, falling back to their public_* copies), plus the event's own venue, dates and time zone. It is
 * the wizard's starting point and the baseline create_competition_draft diffs against, so only fields the
 * organizer changed are ever written.
 */
export async function readEventPresentation(supabase: Client, eventId: string): Promise<EventPresentation | null> {
  const { data } = await supabase.from("events").select(PRESENTATION_COLUMNS).eq("id", eventId).maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  const textOf = (...keys: string[]) => keys.map((key) => row[key]).find((value): value is string => typeof value === "string" && value.trim() !== "") ?? "";
  // Postgres time values come back as HH:MM:SS; the wizard edits HH:MM.
  const timeOf = (key: string) => textOf(key).slice(0, 5);
  return {
    ...EMPTY_PRESENTATION,
    name: textOf("name"),
    summary: textOf("short_description", "public_summary"),
    description: textOf("description", "public_description"),
    coverImageUrl: textOf("cover_image_url", "public_cover_image_url"),
    highlights: Array.isArray(row.public_highlights) ? row.public_highlights.filter((item): item is string => typeof item === "string") : [],
    registrationInfo: textOf("public_registration_info"),
    venueName: textOf("venue_name"),
    addressLine1: textOf("address_line_1"),
    addressLine2: textOf("address_line_2"),
    city: textOf("city"),
    state: textOf("state"),
    postalCode: textOf("postal_code"),
    startDate: textOf("start_date"),
    endDate: textOf("end_date"),
    startTime: timeOf("start_time"),
    endTime: timeOf("end_time"),
    timezone: textOf("timezone"),
  };
}

export type EventOperationsLocks = {
  /** Active registrations: venue, dates, times and time zone are changed in Edit event, which notifies registrants. */
  activeRegistrations: boolean;
  /** Additional event locations (multi-location events) are managed in Edit event. */
  additionalLocations: boolean;
  /** Dated records (schedule items, sessions, competition schedule) that a date or time zone change would strand. */
  datedRecords: boolean;
};

/**
 * What the database will refuse to change in the wizard (create_competition_draft re-checks all of it), read here
 * only to explain it up front. Counts are read with the organizer's own session.
 */
export async function readEventOperationsLocks(supabase: Client, eventId: string): Promise<EventOperationsLocks> {
  // When a count cannot be read, assume the record exists: the wizard then explains instead of failing at submit.
  const total = (result: { count: number | null; error: unknown }) => (result.error ? 1 : result.count ?? 0);
  const head = { count: "exact" as const, head: true };
  const [registrations, locations, scheduleItems, locationSessions, sessions, competitionSessions] = await Promise.all([
    supabase.from("event_registrations").select("id", head).eq("event_id", eventId).in("status", ["pending", "confirmed", "waitlisted", "checked_in"]).then(total),
    supabase.from("event_locations").select("id", head).eq("event_id", eventId).eq("active", true).then(total),
    supabase.from("event_schedule_items").select("id", head).eq("event_id", eventId).then(total),
    supabase.from("event_location_sessions").select("id", head).eq("event_id", eventId).then(total),
    supabase.from("event_sessions").select("id", head).eq("event_id", eventId).then(total),
    supabase.from("event_competition_schedule_sessions").select("id", head).eq("event_id", eventId).then(total),
  ]);
  return {
    activeRegistrations: registrations > 0,
    additionalLocations: locations > 0,
    datedRecords: scheduleItems + locationSessions + sessions + competitionSessions > 0,
  };
}
