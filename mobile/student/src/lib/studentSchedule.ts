import { supabase } from "@/lib/supabase";
import type { LinkedStudioAccess } from "@/lib/studentAccess";

export type StudentScheduleItem = {
  id: string;
  studioId: string;
  // GC-1.4A: the linked client this schedule item belongs to -- needed so
  // class self-check-in (which has no single appointments.client_id to
  // resolve from) knows which of the caller's own linked clients it's
  // acting for. Always populated; the multi-studio loop below already
  // scopes every query by this exact id, this only exposes it on the item.
  clientId: string;
  studioName: string;
  studioSlug: string;
  title: string;
  subtitle: string;
  appointmentType: string | null;
  status: string;
  startsAt: string;
  endsAt: string | null;
  timeZone: string;
  locationName: string | null;
  instructorName: string | null;
  roomName: string | null;
  // GC-1.3B: this viewer's own class attendance state, from attendance_records
  // -- populated only for a group_class row, never a classmate's. Undefined
  // for a lesson (unchanged rendering there).
  attendanceStatus?: string | null;
};

export type StudentBookingRequest = {
  id: string;
  studioId: string;
  studioName: string;
  studioSlug: string;
  status: string;
  source: string | null;
  requestedStartsAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  timeZone: string;
};

export type StudentScheduleOverview = {
  upcoming: StudentScheduleItem[];
  recent: StudentScheduleItem[];
  bookingRequests: StudentBookingRequest[];
  nextItem: StudentScheduleItem | null;
};

type StudioSettingRow = {
  studio_id: string;
  timezone: string | null;
};

type AppointmentRow = {
  id: string;
  studio_id: string;
  client_id: string;
  appointment_type: string | null;
  title: string | null;
  status: string | null;
  location_name: string | null;
  starts_at: string;
  ends_at: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms:
    | { name: string | null }
    | { name: string | null }[]
    | null;
};

type BookingRequestRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  status: string | null;
  source: string | null;
  requested_starts_at: string | null;
  created_at: string;
  updated_at: string | null;
};

// GC-1.3B: mobile independently duplicates the web read-layer's own class
// enrollment/legacy-fallback logic (src/lib/schedule/groupClassRoster.ts) --
// mobile never imports from src/**, so this is a deliberate, small
// duplication of the identical rule, not a divergent one.
type ClassAttendeeRow = {
  appointment_id: string;
  status: string;
  cancelled_at: string | null;
  appointments:
    | {
        id: string;
        title: string | null;
        appointment_type: string;
        status: string;
        starts_at: string;
        ends_at: string | null;
        instructors:
          | { first_name: string | null; last_name: string | null }
          | { first_name: string | null; last_name: string | null }[]
          | null;
        rooms: { name: string | null } | { name: string | null }[] | null;
      }
    | {
        id: string;
        title: string | null;
        appointment_type: string;
        status: string;
        starts_at: string;
        ends_at: string | null;
        instructors:
          | { first_name: string | null; last_name: string | null }
          | { first_name: string | null; last_name: string | null }[]
          | null;
        rooms: { name: string | null } | { name: string | null }[] | null;
      }[]
    | null;
};

type LegacyClassCandidateRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string | null;
  cancelled_at: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

function firstJoin<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function personName(
  value:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null
    | undefined
) {
  const row = firstJoin(value);
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

function roomName(value: { name: string | null } | { name: string | null }[] | null | undefined) {
  const row = firstJoin(value);
  return row?.name?.trim() || null;
}

export function appointmentTypeLabel(value: string | null | undefined) {
  if (value === "private_lesson") return "Private lesson";
  if (value === "group_class") return "Group class";
  if (value === "intro_lesson") return "Intro lesson";
  if (value === "practice_party") return "Practice party";
  if (value === "coaching") return "Coaching";
  if (value === "floor_space_rental") return "Floor rental";
  if (!value) return "Appointment";

  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function statusLabel(value: string | null | undefined) {
  if (value === "scheduled") return "Scheduled";
  if (value === "confirmed") return "Confirmed";
  if (value === "rescheduled") return "Rescheduled";
  if (value === "attended") return "Attended";
  if (value === "cancelled") return "Cancelled";
  if (value === "no_show") return "No show";
  if (value === "pending") return "Pending";
  if (value === "approved") return "Approved";
  if (value === "in_review") return "In review";
  if (value === "declined") return "Declined";
  if (!value) return "Unknown";

  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatScheduleDateTime(value: string | null | undefined, timeZone?: string) {
  if (!value) return "Time pending";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time pending";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone || "America/New_York"
  }).format(date);
}

export function formatScheduleTimeRange(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  timeZone?: string
) {
  if (!startsAt) return "Time pending";

  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : null;

  if (Number.isNaN(start.getTime())) return "Time pending";

  const startText = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone || "America/New_York"
  }).format(start);

  if (!end || Number.isNaN(end.getTime())) return startText;

  const endText = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone || "America/New_York"
  }).format(end);

  return `${startText} – ${endText}`;
}

function studioDisplayName(studio: LinkedStudioAccess) {
  return studio.studioPublicName || studio.studioName || "Studio";
}

function toScheduleItem(
  row: AppointmentRow,
  studio: LinkedStudioAccess,
  timeZone: string
): StudentScheduleItem {
  const typeLabel = appointmentTypeLabel(row.appointment_type);
  const instructor = personName(row.instructors);
  const room = roomName(row.rooms);
  const location = row.location_name?.trim() || null;
  const title = row.title?.trim() || typeLabel;
  const details = [instructor, location, room].filter(Boolean).join(" • ");

  return {
    id: row.id,
    studioId: row.studio_id,
    clientId: studio.clientId,
    studioName: studioDisplayName(studio),
    studioSlug: studio.studioSlug,
    title,
    subtitle: details || typeLabel,
    appointmentType: row.appointment_type,
    status: row.status || "scheduled",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timeZone,
    locationName: location,
    instructorName: instructor,
    roomName: room
  };
}

function classRowToScheduleItem(params: {
  id: string;
  title: string | null;
  appointmentType: string;
  status: string;
  startsAt: string;
  endsAt: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
  attendanceStatus: string | null;
  studio: LinkedStudioAccess;
  timeZone: string;
}): StudentScheduleItem {
  const typeLabel = appointmentTypeLabel(params.appointmentType);
  const instructor = personName(params.instructors);
  const room = roomName(params.rooms);
  const title = params.title?.trim() || typeLabel;
  const details = [instructor, room].filter(Boolean).join(" • ");

  return {
    id: params.id,
    studioId: params.studio.studioId,
    clientId: params.studio.clientId,
    studioName: studioDisplayName(params.studio),
    studioSlug: params.studio.studioSlug,
    title,
    subtitle: details || typeLabel,
    appointmentType: params.appointmentType,
    status: params.status,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    timeZone: params.timeZone,
    locationName: null,
    instructorName: instructor,
    roomName: room,
    attendanceStatus: params.attendanceStatus
  };
}

function toBookingRequest(
  row: BookingRequestRow,
  studio: LinkedStudioAccess,
  timeZone: string
): StudentBookingRequest {
  return {
    id: row.id,
    studioId: row.studio_id,
    studioName: studioDisplayName(studio),
    studioSlug: studio.studioSlug,
    status: row.status || "pending",
    source: row.source,
    requestedStartsAt: row.requested_starts_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timeZone
  };
}

// ============================================================================
// GC-1.3B canonical lifecycle rules -- duplicated independently from
// src/lib/schedule/groupClassRoster.ts's isBookedEligible/
// isHistoricallyEligible (mobile never imports from src/**). Read directly
// from GC-1.2's class_enrollment_covers_participation:
//   status = 'booked'
//   or (status = 'cancelled' and cancelled_at is not null and cancelled_at > starts_at)
// "Upcoming" is the strict booked-only half; "recent"/history is the full
// predicate, so a post-start cancellation (GC-1.2's own definition of
// historically-eligible participation) is not lost from a student's own
// class history.
// ============================================================================
function isBookedEligible(status: string): boolean {
  return status === "booked";
}

function isHistoricallyEligible(input: {
  status: string;
  cancelledAt: string | null;
  startsAt: string;
}): boolean {
  if (input.status === "booked") return true;
  return (
    input.status === "cancelled" &&
    input.cancelledAt !== null &&
    input.cancelledAt > input.startsAt
  );
}

// GC-1.4 REMOVE LEGACY FALLBACK: legacy-shaped group_class rows (a class
// with zero appointment_attendees rows at all and a non-null legacy
// appointments.client_id) -- must be deleted once booking writes
// appointment_attendees on creation and a one-time PROD audit/backfill
// confirms zero remaining legacy-shaped rows. Under the legacy single-
// client-per-row model, the appointments row's own status/cancelled_at IS
// that one client's participation lifecycle -- there is no separate
// per-attendee cancelled_at to consult, and none is invented.
function isLegacyBookedEligible(status: string): boolean {
  return status !== "cancelled";
}

function isLegacyHistoricallyEligible(input: {
  status: string;
  cancelledAt: string | null;
  startsAt: string;
}): boolean {
  if (input.status !== "cancelled") return true;
  return input.cancelledAt !== null && input.cancelledAt > input.startsAt;
}

async function loadClassScheduleItems(params: {
  studio: LinkedStudioAccess;
  timeZone: string;
  nowIso: string;
}): Promise<{ upcoming: StudentScheduleItem[]; recent: StudentScheduleItem[] }> {
  const { studio, timeZone, nowIso } = params;

  const { data: attendeeRows, error: attendeeError } = await supabase
    .from("appointment_attendees")
    .select(
      `
      appointment_id,
      status,
      cancelled_at,
      appointments:appointment_id (
        id, title, appointment_type, status, starts_at, ends_at,
        instructors ( first_name, last_name ),
        rooms ( name )
      )
    `
    )
    .eq("studio_id", studio.studioId)
    .eq("client_id", studio.clientId);

  if (attendeeError) throw attendeeError;

  const { data: attendanceRows, error: attendanceError } = await supabase
    .from("attendance_records")
    .select("appointment_id, status")
    .eq("studio_id", studio.studioId)
    .eq("client_id", studio.clientId);

  if (attendanceError) throw attendanceError;

  const attendanceByAppointmentId = new Map(
    ((attendanceRows ?? []) as { appointment_id: string; status: string }[]).map((row) => [
      row.appointment_id,
      row.status
    ])
  );

  const rosterAppointmentIds = new Set<string>();
  const upcomingByAppointmentId = new Map<
    string,
    { entry: StudentScheduleItem; attendeeStatus: string }
  >();
  const recentByAppointmentId = new Map<
    string,
    { entry: StudentScheduleItem; attendeeStatus: string }
  >();

  function upsertPreferBooked(
    map: Map<string, { entry: StudentScheduleItem; attendeeStatus: string }>,
    id: string,
    entry: StudentScheduleItem,
    attendeeStatus: string
  ) {
    const existing = map.get(id);
    if (!existing || attendeeStatus === "booked") {
      map.set(id, { entry, attendeeStatus });
    }
  }

  for (const row of (attendeeRows ?? []) as ClassAttendeeRow[]) {
    const appt = firstJoin(row.appointments);
    if (!appt) continue;

    rosterAppointmentIds.add(appt.id);

    const attendeeStatus = row.status;
    const cancelledAt = row.cancelled_at;
    const isFuture = appt.starts_at >= nowIso;

    const entry = classRowToScheduleItem({
      id: appt.id,
      title: appt.title,
      appointmentType: appt.appointment_type,
      status: appt.status,
      startsAt: appt.starts_at,
      endsAt: appt.ends_at,
      instructors: appt.instructors,
      rooms: appt.rooms,
      attendanceStatus: attendanceByAppointmentId.get(appt.id) ?? null,
      studio,
      timeZone
    });

    if (isFuture) {
      if (isBookedEligible(attendeeStatus)) {
        upsertPreferBooked(upcomingByAppointmentId, appt.id, entry, attendeeStatus);
      }
    } else if (
      isHistoricallyEligible({ status: attendeeStatus, cancelledAt, startsAt: appt.starts_at })
    ) {
      upsertPreferBooked(recentByAppointmentId, appt.id, entry, attendeeStatus);
    }
  }

  const { data: legacyCandidates, error: legacyError } = await supabase
    .from("appointments")
    .select(
      `
      id, title, appointment_type, status, starts_at, ends_at, cancelled_at,
      instructors ( first_name, last_name ),
      rooms ( name )
    `
    )
    .eq("studio_id", studio.studioId)
    .eq("client_id", studio.clientId)
    .eq("appointment_type", "group_class");

  if (legacyError) throw legacyError;

  for (const appt of (legacyCandidates ?? []) as LegacyClassCandidateRow[]) {
    if (rosterAppointmentIds.has(appt.id)) continue;

    const { count: attendeeCount, error: countError } = await supabase
      .from("appointment_attendees")
      .select("id", { count: "exact", head: true })
      .eq("appointment_id", appt.id);

    if (countError) throw countError;
    if ((attendeeCount ?? 0) > 0) continue;

    const isFuture = appt.starts_at >= nowIso;
    const entry = classRowToScheduleItem({
      id: appt.id,
      title: appt.title,
      appointmentType: appt.appointment_type,
      status: appt.status,
      startsAt: appt.starts_at,
      endsAt: appt.ends_at,
      instructors: appt.instructors,
      rooms: appt.rooms,
      attendanceStatus: attendanceByAppointmentId.get(appt.id) ?? null,
      studio,
      timeZone
    });

    if (isFuture) {
      if (isLegacyBookedEligible(appt.status)) {
        upsertPreferBooked(upcomingByAppointmentId, appt.id, entry, "booked");
      }
    } else if (
      isLegacyHistoricallyEligible({
        status: appt.status,
        cancelledAt: appt.cancelled_at,
        startsAt: appt.starts_at
      })
    ) {
      upsertPreferBooked(recentByAppointmentId, appt.id, entry, "booked");
    }
  }

  return {
    upcoming: Array.from(upcomingByAppointmentId.values()).map((v) => v.entry),
    recent: Array.from(recentByAppointmentId.values()).map((v) => v.entry)
  };
}

export async function loadStudentScheduleOverview(
  linkedStudios: LinkedStudioAccess[]
): Promise<StudentScheduleOverview> {
  if (linkedStudios.length === 0) {
    return {
      upcoming: [],
      recent: [],
      bookingRequests: [],
      nextItem: null
    };
  }

  const studioIds = linkedStudios.map((studio) => studio.studioId);
  const studioById = new Map(linkedStudios.map((studio) => [studio.studioId, studio]));

  const { data: settingRows, error: settingsError } = await supabase
    .from("studio_settings")
    .select("studio_id, timezone")
    .in("studio_id", studioIds);

  if (settingsError) {
    throw settingsError;
  }

  const timeZoneByStudioId = new Map(
    ((settingRows ?? []) as StudioSettingRow[]).map((row) => [
      row.studio_id,
      row.timezone || "America/New_York"
    ])
  );

  const now = new Date();
  const nowIso = now.toISOString();
  const recentStartIso = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 45).toISOString();

  const upcomingQueries = linkedStudios.map((studio) =>
    supabase
      .from("appointments")
      .select(
        `
        id,
        studio_id,
        client_id,
        appointment_type,
        title,
        status,
        location_name,
        starts_at,
        ends_at,
        instructors ( first_name, last_name ),
        rooms ( name )
      `
      )
      .eq("studio_id", studio.studioId)
      .eq("client_id", studio.clientId)
      // GC-1.3B: group_class is excluded here and sourced exclusively from
      // loadClassScheduleItems below, which applies GC-1.2's own booked/
      // post-start-cancelled eligibility rule and covers the legacy
      // fallback -- excluded to avoid double-counting a legacy-shaped class
      // this query would otherwise also match (client_id populated).
      .neq("appointment_type", "group_class")
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(10)
  );

  const recentQueries = linkedStudios.map((studio) =>
    supabase
      .from("appointments")
      .select(
        `
        id,
        studio_id,
        client_id,
        appointment_type,
        title,
        status,
        location_name,
        starts_at,
        ends_at,
        instructors ( first_name, last_name ),
        rooms ( name )
      `
      )
      .eq("studio_id", studio.studioId)
      .eq("client_id", studio.clientId)
      .neq("appointment_type", "group_class")
      .gte("starts_at", recentStartIso)
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(8)
  );

  const requestQueries = linkedStudios.map((studio) =>
    supabase
      .from("booking_requests")
      .select("id, studio_id, client_id, status, source, requested_starts_at, created_at, updated_at")
      .eq("studio_id", studio.studioId)
      .eq("client_id", studio.clientId)
      .in("status", ["pending", "approved", "in_review"])
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(5)
  );

  const classQueries = linkedStudios.map((studio) =>
    loadClassScheduleItems({
      studio,
      timeZone: timeZoneByStudioId.get(studio.studioId) || "America/New_York",
      nowIso
    })
  );

  const [upcomingResults, recentResults, requestResults, classResults] = await Promise.all([
    Promise.all(upcomingQueries),
    Promise.all(recentQueries),
    Promise.all(requestQueries),
    Promise.all(classQueries)
  ]);

  const upcoming: StudentScheduleItem[] = [];
  const recent: StudentScheduleItem[] = [];
  const bookingRequests: StudentBookingRequest[] = [];

  upcomingResults.forEach((result) => {
    if (result.error) throw result.error;

    ((result.data ?? []) as AppointmentRow[]).forEach((row) => {
      const studio = studioById.get(row.studio_id);
      if (!studio) return;
      upcoming.push(
        toScheduleItem(row, studio, timeZoneByStudioId.get(row.studio_id) || "America/New_York")
      );
    });
  });

  recentResults.forEach((result) => {
    if (result.error) throw result.error;

    ((result.data ?? []) as AppointmentRow[]).forEach((row) => {
      const studio = studioById.get(row.studio_id);
      if (!studio) return;
      recent.push(
        toScheduleItem(row, studio, timeZoneByStudioId.get(row.studio_id) || "America/New_York")
      );
    });
  });

  requestResults.forEach((result) => {
    if (result.error) throw result.error;

    ((result.data ?? []) as BookingRequestRow[]).forEach((row) => {
      const studio = studioById.get(row.studio_id);
      if (!studio) return;
      bookingRequests.push(
        toBookingRequest(row, studio, timeZoneByStudioId.get(row.studio_id) || "America/New_York")
      );
    });
  });

  classResults.forEach((result) => {
    upcoming.push(...result.upcoming);
    recent.push(...result.recent);
  });

  upcoming.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  recent.sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());
  bookingRequests.sort(
    (a, b) =>
      new Date(b.updatedAt || b.createdAt).getTime() -
      new Date(a.updatedAt || a.createdAt).getTime()
  );

  return {
    upcoming: upcoming.slice(0, 20),
    recent: recent.slice(0, 12),
    bookingRequests: bookingRequests.slice(0, 10),
    nextItem: upcoming[0] ?? null
  };
}
