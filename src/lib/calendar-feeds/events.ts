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

const IN_CHUNK = 100;
function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK));
  return out;
}

async function loadNames(admin: SupabaseLike, studioId: string, clientIds: string[], instructorIds: string[], roomIds: string[]): Promise<Names> {
  const names: Names = { clients: new Map(), instructors: new Map(), rooms: new Map() };
  for (const ids of chunks(clientIds)) {
    const rows = await must<any[]>("clients", admin.from("clients").select("id, first_name, last_name, date_of_birth").eq("studio_id", studioId).in("id", ids));
    for (const r of rows) names.clients.set(r.id, { first: clean(r.first_name, 40), last: clean(r.last_name, 40), dob: r.date_of_birth ?? null });
  }
  for (const ids of chunks(instructorIds)) {
    const rows = await must<any[]>("instructors", admin.from("instructors").select("id, first_name").eq("studio_id", studioId).in("id", ids));
    for (const r of rows) names.instructors.set(r.id, clean(r.first_name, 40));
  }
  for (const ids of chunks(roomIds)) {
    const rows = await must<any[]>("rooms", admin.from("rooms").select("id, name").eq("studio_id", studioId).in("id", ids));
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
  // SEQUENCE: 2 x seconds-since-2026 (+1 when cancelled) so a later un-cancel always outranks the earlier cancellation.
  const base = sequenceFromUpdatedAt(changedAt ?? row.updated_at) * 2;
  const room = row.room_id ? names.rooms.get(row.room_id) : "";
  // Dancer feeds show the room only: staff-entered location text may be free-form (e.g. an off-site address).
  const location = subject.subjectKind === "staff" ? clean(row.location_name, 120) || room || undefined : room || undefined;
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
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) return false;
  if (start > now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS) return false;
  const horizon = cancelled ? CANCELLED_RETENTION_DAYS : WINDOW_PAST_DAYS;
  return end >= now.getTime() - horizon * DAY_MS;
}

const LIVE_FROM_DAYS = WINDOW_PAST_DAYS;

export async function loadFeedEvents(admin: SupabaseLike, subject: FeedSubject, now: Date): Promise<{ calendarName: string; events: FeedEvent[] }> {
  const studioId = subject.studioId;
  const studio = await must<any>("studio", admin.from("studios").select("name, public_name").eq("id", studioId).maybeSingle());
  const studioName = clean(studio?.public_name || studio?.name || "Studio", 80);
  const calendarName = `${studioName} Schedule`;

  const liveFrom = new Date(now.getTime() - LIVE_FROM_DAYS * DAY_MS).toISOString();
  const cancelledFrom = new Date(now.getTime() - CANCELLED_RETENTION_DAYS * DAY_MS).toISOString();
  const windowEnd = new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS).toISOString();
  const allowedTypes = subject.subjectKind === "staff" ? [...STAFF_TYPES] : [...DANCER_TYPES];

  const rows = new Map<string, { row: AppointmentRow; attendeeCancelledAt: string | null; attendeeChangedAt: string | null }>();
  const addRows = (list: AppointmentRow[]) => {
    for (const row of list) if (!rows.has(row.id)) rows.set(row.id, { row, attendeeCancelledAt: null, attendeeChangedAt: null });
  };
  // Live rows from -7d and cancelled rows from -30d, so old live rows never eat the cap before upcoming ones.
  const baseQuery = (statuses: string[], from: string) =>
    admin
      .from("appointments")
      .select(APPOINTMENT_COLUMNS)
      .eq("studio_id", studioId)
      .in("appointment_type", allowedTypes)
      .in("status", statuses)
      .gte("starts_at", from)
      .lte("starts_at", windowEnd);
  const fetchBoth = async (apply: (q: any) => any): Promise<AppointmentRow[]> => {
    const live = await must<AppointmentRow[]>("appointments", apply(baseQuery(LIVE_STATUSES, liveFrom)).order("starts_at", { ascending: true }).limit(MAX_EVENTS));
    const cancelled = await must<AppointmentRow[]>("appointments", apply(baseQuery(["cancelled"], cancelledFrom)).order("starts_at", { ascending: true }).limit(MAX_EVENTS));
    // A truncated cancellation list would leave subscribers showing cancelled lessons as confirmed: fail instead.
    if (cancelled.length >= MAX_EVENTS) throw new Error("cancelled window exceeds cap");
    return [...live, ...cancelled];
  };

  if (subject.subjectKind === "staff") {
    const instructors = await must<any[]>(
      "instructors",
      admin.from("instructors").select("id").eq("studio_id", studioId).eq("user_id", subject.subjectUserId).eq("active", true),
    );
    const instructorIds = instructors.map((r) => r.id).filter(Boolean);
    if (!instructorIds.length) return { calendarName, events: [] };
    // Defence in depth over the database revocation hooks: the staff member must still hold an active role in this studio.
    const roles = await must<any[]>("roles", admin.from("user_studio_roles").select("user_id").eq("studio_id", studioId).eq("user_id", subject.subjectUserId).eq("active", true).limit(1));
    if (!roles.length) return { calendarName, events: [] };
    addRows(await fetchBoth((q) => q.in("instructor_id", instructorIds)));
  } else {
    const links = await must<any[]>(
      "links",
      admin
        .from("client_account_links")
        .select("client_id, relationship_type")
        .eq("studio_id", studioId)
        .eq("user_id", subject.subjectUserId)
        .eq("status", "linked")
        .eq("can_view_schedule", true),
    );
    let linked = links.filter((r) => r.client_id) as Array<{ client_id: string; relationship_type: string | null }>;
    // A non-null selection is authoritative: an empty array means "include nobody", never "everybody".
    if (subject.includeClientIds) {
      const allowed = new Set(subject.includeClientIds);
      linked = linked.filter((l) => allowed.has(l.client_id));
    }
    // A person's OWN account is not served for a known minor: under-18 schedules go through the guardian link only.
    const selfIds = linked.filter((l) => (l.relationship_type ?? "self") === "self").map((l) => l.client_id);
    if (selfIds.length) {
      const dobs = new Map<string, string | null>();
      for (const ids of chunks(selfIds)) {
        const rowsDob = await must<any[]>("clients", admin.from("clients").select("id, date_of_birth").eq("studio_id", studioId).in("id", ids));
        for (const r of rowsDob) dobs.set(r.id, r.date_of_birth ?? null);
      }
      const knownMinor = (id: string) => {
        const ms = Date.parse(String(dobs.get(id) ?? ""));
        return Number.isFinite(ms) && isMinorOrUnknown(dobs.get(id), now);
      };
      linked = linked.filter((l) => (l.relationship_type ?? "self") !== "self" || !knownMinor(l.client_id));
    }
    const clientIds = linked.map((l) => l.client_id);
    if (!clientIds.length) return { calendarName, events: [] };

    addRows(await fetchBoth((q) => q.in("client_id", clientIds)));
    addRows(await fetchBoth((q) => q.in("partner_client_id", clientIds)));

    // Group-class bookings: only attendee rows whose appointment falls in the window (server-side filter, bounded, fail closed at the cap).
    const attendees = await must<any[]>(
      "attendees",
      admin
        .from("appointment_attendees")
        .select("appointment_id, status, cancelled_at, updated_at, appointments!inner(starts_at)")
        .eq("studio_id", studioId)
        .in("client_id", clientIds)
        .in("status", ["booked", "cancelled"])
        .gte("appointments.starts_at", cancelledFrom)
        .lte("appointments.starts_at", windowEnd)
        .order("updated_at", { ascending: false })
        .limit(MAX_EVENTS),
    );
    if (attendees.length >= MAX_EVENTS) throw new Error("attendee window exceeds cap"); // never silently truncate
    const attendeeByAppointment = new Map<string, { booked: boolean; cancelledAt: string | null; changedAt: string | null }>();
    for (const a of attendees) {
      const entry = attendeeByAppointment.get(a.appointment_id) ?? { booked: false, cancelledAt: null, changedAt: null };
      if (a.status === "booked") entry.booked = true;
      else entry.cancelledAt = [entry.cancelledAt, a.cancelled_at ?? a.updated_at].filter(Boolean).sort().pop() ?? null;
      // newest change across ALL rows. The cancel functions set cancelled_at without touching updated_at (no trigger on this table).
      entry.changedAt = [entry.changedAt, a.updated_at, a.cancelled_at].filter(Boolean).sort().pop() ?? null;
      attendeeByAppointment.set(a.appointment_id, entry);
    }
    const attendeeAppointmentIds = [...attendeeByAppointment.keys()].filter((id) => !rows.has(id));
    for (const ids of chunks(attendeeAppointmentIds)) {
      addRows(await must<AppointmentRow[]>("attendee appointments", baseQuery([...LIVE_STATUSES, "cancelled"], cancelledFrom).in("id", ids)));
    }
    for (const [appointmentId, a] of attendeeByAppointment) {
      const entry = rows.get(appointmentId);
      if (!entry) continue;
      // this dancer's own booking state, not the class's: cancelled only when no other included profile still holds a booking
      if (!a.booked && a.cancelledAt) entry.attendeeCancelledAt = a.cancelledAt;
      entry.attendeeChangedAt = a.changedAt;
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
    .sort((a, b) => (a.startsAt === b.startsAt ? (a.uid < b.uid ? -1 : 1) : a.startsAt < b.startsAt ? -1 : 1))
    .slice(0, MAX_EVENTS); // sort first: when capped, the furthest-future events are dropped
  return { calendarName, events };
}
