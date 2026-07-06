import { supabase } from "@/lib/supabase";
import type { LinkedStudioAccess } from "@/lib/studentAccess";

export type StudentScheduleItem = {
  id: string;
  studioId: string;
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
      .gte("starts_at", nowIso)
      .neq("status", "cancelled")
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

  const [upcomingResults, recentResults, requestResults] = await Promise.all([
    Promise.all(upcomingQueries),
    Promise.all(recentQueries),
    Promise.all(requestQueries)
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
