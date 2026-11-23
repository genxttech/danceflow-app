/* eslint-disable @typescript-eslint/no-explicit-any -- loose PostgREST client shape; rows are validated field by field below */
import { sequenceFromUpdatedAt, type FeedEvent } from "./ics";

/**
 * Builds the event list for one feed subject. Privacy rules (docs/integrations/Calendar_Feeds_Design.md sections 7-8):
 *  - event types come from an ALLOWLIST; anything else (competition-governed classes, events, unavailable blocks) is never emitted;
 *  - appointment notes, contact data, payments and other participants are never emitted;
 *  - every query is filtered by the token's studio, and visibility is re-evaluated on every request.
 */

export type FeedSubject = {
  studioId: string;
  subjectKind: "dancer_account" | "staff";
  subjectUserId: string;
  detailLevel: "minimal" | "standard";
  includeClientIds: string[] | null;
};

export type SupabaseLike = { from(table: string): any; rpc?(fn: string, args?: Record<string, unknown>): any };

const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOW_PAST_DAYS = 7;
export const WINDOW_FUTURE_DAYS = 120;
export const CANCELLED_RETENTION_DAYS = 30;
export const MAX_EVENTS = 1000;

const STAFF_TYPES = ["private_lesson", "group_class", "intro_lesson", "coaching", "practice_party", "floor_space_rental"] as const;
const DANCER_TYPES = ["private_lesson", "group_class", "intro_lesson", "coaching", "practice_party"] as const;
const LIVE_STATUSES = ["scheduled", "confirmed", "rescheduled", "attended"];
const FEED_STATUSES = [...LIVE_STATUSES, "cancelled"];

const TYPE_LABELS: Record<string, string> = {
  private_lesson: "Private lesson",
  group_class: "Group class",
  intro_lesson: "Intro lesson",
  coaching: "Coaching",
  practice_party: "Practice party",
  floor_space_rental: "Floor rental",
};

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  location_name: string | null;
  client_id: string | null;
  partner_client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  updated_at: string | null;
  cancelled_at: string | null;
};

const APPOINTMENT_COLUMNS =
  "id, title, appointment_type, status, starts_at, ends_at, location_name, client_id, partner_client_id, instructor_id, room_id, updated_at, cancelled_at";

function clean(value: string | null | undefined, max: number): string {
  return (value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(new RegExp("[\\u2028\\u2029]", "g"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isMinorOrUnknown(dateOfBirth: string | null | undefined, now: Date): boolean {
  const ms = Date.parse(String(dateOfBirth ?? ""));
  if (!Number.isFinite(ms)) return true; // unknown age is treated as a possible minor
  const dob = new Date(ms);
  const eighteen = new Date(Date.UTC(dob.getUTCFullYear() + 18, dob.getUTCMonth(), dob.getUTCDate()));
  return now.getTime() < eighteen.getTime();
}

async function must<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label} failed`); // never surface DB text to the HTTP layer
  return (data ?? ([] as unknown)) as T;
}

type Names = { clients: Map<string, { first: string; last: string; dob: string | null }>; instructors: Map<string, string>; rooms: Map<string, string> };

async function loadNames(admin: SupabaseLike, studioId: string, clientIds: string[], instructorIds: string[], roomIds: string[]): Promise<Names> {
  const names: Names = { clients: new Map(), instructors: new Map(), rooms: new Map() };
  if (clientIds.length) {
    const rows = await must<any[]>("clients", admin.from("clients").select("id, first_name, last_name, date_of_birth").eq("studio_id", studioId).in("id", clientIds));
    for (const r of rows) names.clients.set(r.id, { first: clean(r.first_name, 40), last: clean(r.last_name, 40), dob: r.date_of_birth ?? null });
  }
  if (instructorIds.length) {
    const rows = await must<any[]>("instructors", admin.from("instructors").select("id, first_name").eq("studio_id", studioId).in("id", instructorIds));
    for (const r of rows) names.instructors.set(r.id, clean(r.first_name, 40));
  }
  if (roomIds.length) {
    const rows = await must<any[]>("rooms", admin.from("rooms").select("id, name").eq("studio_id", studioId).in("id", roomIds));
    for (const r of rows) names.rooms.set(r.id, clean(r.name, 80));
  }
  return names;
}

function titleFor(row: AppointmentRow, subject: FeedSubject, names: Names, now: Date): string {
  const base = TYPE_LABELS[row.appointment_type] ?? "Appointment";
  if (row.appointment_type === "group_class") {
    const classTitle = clean(row.title, 80);
    return classTitle || base; // class names are studio-published; private-lesson titles are free text and are never used
  }
  if (subject.detailLevel !== "standard") return base;
  if (subject.subjectKind === "dancer_account") {
    const instructor = row.instructor_id ? names.instructors.get(row.instructor_id) : "";
    return instructor ? `${base} with ${instructor}` : base;
  }
  // staff standard: client first name + last initial; first name only when the client is, or may be, under 18
  const client = row.client_id ? names.clients.get(row.client_id) : undefined;
  if (!client || !client.first) return base;
  const initial = client.last && !isMinorOrUnknown(client.dob, now) ? ` ${client.last.charAt(0)}.` : "";
  return `${base}: ${client.first}${initial}`;
}

function toEvent(row: AppointmentRow, subject: FeedSubject, names: Names, now: Date, cancelledAt: string | null, changedAt: string | null): FeedEvent {
  const cancelled = row.status === "cancelled" || Boolean(cancelledAt);
  const base = sequenceFromUpdatedAt(changedAt ?? row.updated_at);
  const room = row.room_id ? names.rooms.get(row.room_id) : "";
  const location = clean(row.location_name, 120) || room || undefined;
  return {
    uid: `${row.id}@danceflow`,
    summary: titleFor(row, subject, names, now),
    description: "Open DanceFlow for details.",
    location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: cancelled ? "CANCELLED" : "CONFIRMED",
    sequence: cancelled ? base + 1 : base,
    lastModified: changedAt ?? row.updated_at ?? row.starts_at,
  };
}

function inWindow(row: AppointmentRow, cancelled: boolean, now: Date): boolean {
  const end = Date.parse(row.ends_at);
  const start = Date.parse(row.starts_at);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return false;
  if (start > now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS) return false;
  const horizon = cancelled ? CANCELLED_RETENTION_DAYS : WINDOW_PAST_DAYS;
  return end >= now.getTime() - horizon * DAY_MS;
}

export async function loadFeedEvents(admin: SupabaseLike, subject: FeedSubject, now: Date): Promise<{ calendarName: string; events: FeedEvent[] }> {
  const studioId = subject.studioId;
  const studio = await must<any>("studio", admin.from("studios").select("name, public_name").eq("id", studioId).maybeSingle());
  const studioName = clean(studio?.public_name || studio?.name || "Studio", 80);
  const calendarName = `${studioName} Schedule`;

  const windowStart = new Date(now.getTime() - CANCELLED_RETENTION_DAYS * DAY_MS).toISOString();
  const windowEnd = new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS).toISOString();
  const allowedTypes = subject.subjectKind === "staff" ? [...STAFF_TYPES] : [...DANCER_TYPES];

  const rows = new Map<string, { row: AppointmentRow; attendeeCancelledAt: string | null; attendeeChangedAt: string | null }>();
  const addRows = (list: AppointmentRow[]) => {
    for (const row of list) if (!rows.has(row.id)) rows.set(row.id, { row, attendeeCancelledAt: null, attendeeChangedAt: null });
  };
  const baseQuery = () =>
    admin
      .from("appointments")
      .select(APPOINTMENT_COLUMNS)
      .eq("studio_id", studioId)
      .in("appointment_type", allowedTypes)
      .in("status", FEED_STATUSES)
      .gte("starts_at", windowStart)
      .lte("starts_at", windowEnd);

  if (subject.subjectKind === "staff") {
    const instructors = await must<any[]>(
      "instructors",
      admin.from("instructors").select("id").eq("studio_id", studioId).eq("user_id", subject.subjectUserId).eq("active", true),
    );
    const instructorIds = instructors.map((r) => r.id).filter(Boolean);
    if (!instructorIds.length) return { calendarName, events: [] };
    addRows(await must<AppointmentRow[]>("appointments", baseQuery().in("instructor_id", instructorIds).order("starts_at", { ascending: true }).limit(MAX_EVENTS)));
  } else {
    const links = await must<any[]>(
      "links",
      admin
        .from("client_account_links")
        .select("client_id")
        .eq("studio_id", studioId)
        .eq("user_id", subject.subjectUserId)
        .eq("status", "linked")
        .eq("can_view_schedule", true),
    );
    let clientIds = links.map((r) => r.client_id).filter(Boolean) as string[];
    if (subject.includeClientIds && subject.includeClientIds.length) {
      const allowed = new Set(subject.includeClientIds);
      clientIds = clientIds.filter((id) => allowed.has(id));
    }
    if (!clientIds.length) return { calendarName, events: [] };

    addRows(await must<AppointmentRow[]>("appointments", baseQuery().in("client_id", clientIds).order("starts_at", { ascending: true }).limit(MAX_EVENTS)));
    addRows(await must<AppointmentRow[]>("appointments", baseQuery().in("partner_client_id", clientIds).order("starts_at", { ascending: true }).limit(MAX_EVENTS)));

    const attendees = await must<any[]>(
      "attendees",
      admin
        .from("appointment_attendees")
        .select("appointment_id, status, cancelled_at, updated_at")
        .eq("studio_id", studioId)
        .in("client_id", clientIds)
        .in("status", ["booked", "cancelled"]),
    );
    const attendeeByAppointment = new Map<string, any>();
    for (const a of attendees) {
      const prev = attendeeByAppointment.get(a.appointment_id);
      if (!prev || a.status === "booked") attendeeByAppointment.set(a.appointment_id, a);
    }
    const attendeeAppointmentIds = [...attendeeByAppointment.keys()].filter((id) => !rows.has(id));
    for (let i = 0; i < attendeeAppointmentIds.length; i += 100) {
      const chunk = attendeeAppointmentIds.slice(i, i + 100);
      addRows(await must<AppointmentRow[]>("attendee appointments", baseQuery().in("id", chunk)));
    }
    for (const [appointmentId, a] of attendeeByAppointment) {
      const entry = rows.get(appointmentId);
      if (!entry) continue;
      // this dancer's own booking state, not the class's
      if (a.status === "cancelled") entry.attendeeCancelledAt = a.cancelled_at ?? a.updated_at ?? entry.row.updated_at;
      entry.attendeeChangedAt = a.updated_at ?? null;
    }
  }

  const entries = [...rows.values()].filter(({ row, attendeeCancelledAt }) => {
    if (!(allowedTypes as string[]).includes(row.appointment_type)) return false; // defence in depth over the query filter
    if (row.status === "no_show") return false;
    const cancelled = row.status === "cancelled" || Boolean(attendeeCancelledAt);
    return inWindow(row, cancelled, now);
  });

  const clientIds = new Set<string>();
  const instructorIds = new Set<string>();
  const roomIds = new Set<string>();
  if (subject.detailLevel === "standard") {
    for (const { row } of entries) {
      if (subject.subjectKind === "staff" && row.client_id) clientIds.add(row.client_id);
      if (subject.subjectKind === "dancer_account" && row.instructor_id) instructorIds.add(row.instructor_id);
    }
  }
  for (const { row } of entries) if (row.room_id) roomIds.add(row.room_id);
  const names = await loadNames(admin, studioId, [...clientIds], [...instructorIds], [...roomIds]);

  const events = entries
    .map(({ row, attendeeCancelledAt, attendeeChangedAt }) => {
      const changedAt = [row.updated_at, attendeeChangedAt].filter(Boolean).sort().pop() ?? null;
      return toEvent(row, subject, names, now, attendeeCancelledAt, changedAt);
    })
    .slice(0, MAX_EVENTS);
  return { calendarName, events };
}
