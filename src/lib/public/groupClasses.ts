/**
 * GC-3.4A: public (signed-out) group-class discovery. Everything here reads through the narrow, database-authoritative
 * functions public_group_class_occurrences / public_group_class_series -- never the appointments table -- so the pages can only
 * ever see the safe columns those functions return. Appointment id is the identity of an occurrence; the studio slug in a URL is
 * routing context and is corrected by redirect when it does not match.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type PublicClassState = "upcoming" | "cancelled" | "past";
export type PublicClassAvailability = "available" | "full" | "unlimited";
export type PublicClassEnrollmentState = "open" | "full" | "closed" | "unavailable";

export type PublicGroupClass = {
  appointmentId: string;
  seriesId: string | null;
  seriesRootId: string | null;
  studioSlug: string;
  studioName: string;
  studioLogoUrl: string | null;
  studioCity: string | null;
  studioState: string | null;
  timeZone: string;
  title: string;
  startsAt: string;
  endsAt: string;
  instructorName: string | null;
  locationLabel: string | null;
  capacity: number | null;
  spotsRemaining: number | null;
  availability: PublicClassAvailability;
  enrollmentState: PublicClassEnrollmentState;
  publicState: PublicClassState;
};

export type PublicGroupClassSeries = {
  seriesRootId: string;
  studioSlug: string;
  studioName: string;
  studioLogoUrl: string | null;
  studioCity: string | null;
  studioState: string | null;
  timeZone: string;
  title: string;
  upcomingCount: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parsePublicGroupClass(raw: unknown): PublicGroupClass | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const availability = r.availability;
  const enrollment = r.enrollment_state;
  const state = r.public_state;
  if (
    !isUuid(r.appointment_id) ||
    typeof r.studio_slug !== "string" ||
    typeof r.title !== "string" ||
    typeof r.starts_at !== "string" ||
    typeof r.ends_at !== "string" ||
    (availability !== "available" && availability !== "full" && availability !== "unlimited") ||
    (enrollment !== "open" && enrollment !== "full" && enrollment !== "closed" && enrollment !== "unavailable") ||
    (state !== "upcoming" && state !== "cancelled" && state !== "past")
  ) {
    return null;
  }
  return {
    appointmentId: r.appointment_id,
    seriesId: isUuid(r.series_id) ? r.series_id : null,
    seriesRootId: isUuid(r.series_root_id) ? r.series_root_id : null,
    studioSlug: r.studio_slug,
    studioName: str(r.studio_name) ?? r.studio_slug,
    studioLogoUrl: str(r.studio_logo_url),
    studioCity: str(r.studio_city),
    studioState: str(r.studio_state),
    timeZone: str(r.time_zone) ?? "America/New_York",
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    instructorName: str(r.instructor_name),
    locationLabel: str(r.location_label),
    capacity: int(r.capacity),
    spotsRemaining: int(r.spots_remaining),
    availability,
    enrollmentState: enrollment,
    publicState: state,
  };
}

export function parsePublicGroupClassSeries(raw: unknown): PublicGroupClassSeries | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isUuid(r.series_root_id) || typeof r.studio_slug !== "string") return null;
  return {
    seriesRootId: r.series_root_id,
    studioSlug: r.studio_slug,
    studioName: str(r.studio_name) ?? r.studio_slug,
    studioLogoUrl: str(r.studio_logo_url),
    studioCity: str(r.studio_city),
    studioState: str(r.studio_state),
    timeZone: str(r.time_zone) ?? "America/New_York",
    title: str(r.title) ?? "Group class series",
    upcomingCount: int(r.upcoming_count) ?? 0,
  };
}

// --- data access (RPC only) -----------------------------------------------------------------------------------------------

export async function fetchPublicGroupClasses(
  supabase: SupabaseClient,
  args: { studioSlug?: string | null; seriesId?: string | null; limit?: number } = {},
): Promise<PublicGroupClass[]> {
  const { data, error } = await supabase.rpc("public_group_class_occurrences", {
    p_studio_slug: args.studioSlug ?? null,
    p_series_id: args.seriesId ?? null,
    p_appointment_id: null,
    p_limit: args.limit ?? 60,
  });
  if (error) throw new Error(`Failed to load classes: ${error.message}`);
  return ((data ?? []) as unknown[]).map(parsePublicGroupClass).filter((c): c is PublicGroupClass => c !== null);
}

export async function fetchPublicGroupClass(supabase: SupabaseClient, appointmentId: string): Promise<PublicGroupClass | null> {
  if (!isUuid(appointmentId)) return null;
  const { data, error } = await supabase.rpc("public_group_class_occurrences", {
    p_studio_slug: null,
    p_series_id: null,
    p_appointment_id: appointmentId,
    p_limit: 1,
  });
  if (error) throw new Error(`Failed to load class: ${error.message}`);
  const row = ((data ?? []) as unknown[])[0];
  return row ? parsePublicGroupClass(row) : null;
}

export async function fetchPublicGroupClassSeries(supabase: SupabaseClient, seriesId: string): Promise<PublicGroupClassSeries | null> {
  if (!isUuid(seriesId)) return null;
  const { data, error } = await supabase.rpc("public_group_class_series", { p_series_id: seriesId });
  if (error) throw new Error(`Failed to load series: ${error.message}`);
  const row = ((data ?? []) as unknown[])[0];
  return row ? parsePublicGroupClassSeries(row) : null;
}

/** Compares a route slug param with the authoritative slug even when the framework hands the param over percent-encoded. */
export function sameStudioSlug(param: string, authoritative: string) {
  if (param === authoritative) return true;
  try {
    return decodeURIComponent(param) === authoritative;
  } catch {
    return false;
  }
}

// --- URLs (id is identity; slug is routing context) ----------------------------------------------------------------------------

export const publicClassesPath = () => "/discover/classes";
export const publicStudioClassesPath = (studioSlug: string) => `/studios/${encodeURIComponent(studioSlug)}/classes`;
export const publicClassPath = (studioSlug: string, appointmentId: string) =>
  `/studios/${encodeURIComponent(studioSlug)}/classes/${appointmentId}`;
export const publicSeriesPath = (studioSlug: string, seriesRootId: string) =>
  `/studios/${encodeURIComponent(studioSlug)}/classes/series/${seriesRootId}`;

// --- display copy ------------------------------------------------------------------------------------------------------------------

function fmt(value: string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...options }).format(date);
  }
}

/** "Tue, Nov 10" */
export function formatClassDay(startsAt: string, timeZone: string) {
  return fmt(startsAt, timeZone, { weekday: "short", month: "short", day: "numeric" });
}

/** "6:00 PM – 7:00 PM" in the studio's time zone. */
export function formatClassTimeRange(startsAt: string, endsAt: string, timeZone: string) {
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const start = fmt(startsAt, timeZone, time);
  const end = fmt(endsAt, timeZone, time);
  return start && end ? `${start} – ${end}` : start;
}

export function formatClassWhen(startsAt: string, endsAt: string, timeZone: string) {
  return `${formatClassDay(startsAt, timeZone)}, ${formatClassTimeRange(startsAt, endsAt, timeZone)}`;
}

export function studioLocationLabel(city: string | null, state: string | null) {
  return [city, state].filter(Boolean).join(", ");
}

export type AvailabilityTone = "good" | "limited" | "full" | "closed";

/** Public availability wording; never implies that enrolling is possible from this page yet. */
export function availabilityCopy(c: Pick<PublicGroupClass, "publicState" | "availability" | "spotsRemaining">): { label: string; tone: AvailabilityTone } {
  if (c.publicState === "cancelled") return { label: "Cancelled", tone: "closed" };
  if (c.publicState === "past") return { label: "Already held", tone: "closed" };
  if (c.availability === "full") return { label: "Class full", tone: "full" };
  if (c.availability === "unlimited" || c.spotsRemaining === null) return { label: "Spots available", tone: "good" };
  const n = c.spotsRemaining;
  return { label: n === 1 ? "1 spot left" : `${n} spots left`, tone: n <= 3 ? "limited" : "good" };
}

/** The sentence shown on a class page for a class that is no longer open. */
export function unavailableMessage(state: PublicClassState) {
  if (state === "cancelled") return "This class has been cancelled.";
  if (state === "past") return "This class has already taken place.";
  return null;
}

export function seriesPartLabel(count: number | null) {
  return count && count > 1 ? `Part of a recurring class · ${count} upcoming dates` : "Part of a recurring class";
}
