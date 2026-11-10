import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAppointmentRelationshipAccess } from "@/lib/auth/appointmentAccess";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";
import { startOfLocalDayInstant } from "@/lib/billing/organizerSuiteEntitlement";
import { loadRosterPanel } from "@/lib/schedule/groupClassRosterPanel";

/**
 * Read model for the Business app's instructor Today screen: one person's teaching day and one appointment's detail. Fields are projected explicitly and stay minimal:
 * no prices, payment state, package balances, referral source or other client PII. Client names follow the web rule: an instructor sees them only through
 * get_teaching_clients_for_instructor, which applies the teaching-relationship window, and a name outside that window is null rather than an error.
 */

// The schedule page's fallback for a studio with no usable timezone.
const FALLBACK_TIME_ZONE = "America/New_York";

export function resolveStudioTimeZone(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** Timestamps leave the API as ISO 8601 UTC with milliseconds (2026-11-09T15:00:00.000Z), whatever form the database returned. */
export function toIsoUtc(value: string): string;
export function toIsoUtc(value: string | null): string | null;
export function toIsoUtc(value: string | null) {
  if (!value) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function localDateInTimeZone(now: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The UTC bounds of one local calendar day, which is 23 or 25 hours long on a DST change. Null when `date` is not a real YYYY-MM-DD date. */
export function localDayUtcRange(date: string, timeZone: string) {
  // startOfLocalDayInstant's own pattern is unanchored at the end, so trailing junk must be refused here.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = startOfLocalDayInstant(date, timeZone);
  if (!start) return null;
  const [year, month, day] = date.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const end = startOfLocalDayInstant(nextDate, timeZone);
  return end ? { startIso: start.toISOString(), endIso: end.toISOString() } : null;
}

type ClientName = { id: string; firstName: string; lastName: string };
type ClientNameRow = { id: string; first_name: string | null; last_name: string | null };
type Embedded<T> = T | T[] | null | undefined;

function one<T>(value: Embedded<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function toClientNameMap(rows: ClientNameRow[]) {
  return new Map<string, ClientName>(
    rows.map((row) => [
      row.id,
      { id: row.id, firstName: row.first_name ?? "", lastName: row.last_name ?? "" },
    ]),
  );
}

async function loadTeachingClientNames(supabase: SupabaseClient, studioId: string) {
  const { data, error } = await supabase.rpc("get_teaching_clients_for_instructor", {
    target_studio_id: studioId,
  });
  if (error) throw new Error(`Teaching clients lookup failed: ${error.message}`);
  return toClientNameMap((data ?? []) as ClientNameRow[]);
}

async function loadStudioClientNames(supabase: SupabaseClient, studioId: string, clientIds: string[]) {
  if (clientIds.length === 0) return new Map<string, ClientName>();
  const { data, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name")
    .eq("studio_id", studioId)
    .in("id", clientIds);
  if (error) throw new Error(`Client names lookup failed: ${error.message}`);
  return toClientNameMap((data ?? []) as ClientNameRow[]);
}

type AppointmentSummaryRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  client_id: string | null;
  partner_client_id: string | null;
  location_name: string | null;
  rooms: Embedded<{ id: string; name: string | null }>;
};

function toAppointmentSummary(row: AppointmentSummaryRow, names: Map<string, ClientName>) {
  const room = one(row.rooms);
  return {
    id: row.id,
    title: row.title,
    appointmentType: row.appointment_type,
    status: row.status,
    startsAt: toIsoUtc(row.starts_at),
    endsAt: toIsoUtc(row.ends_at),
    room: room ? { id: room.id, name: room.name } : null,
    locationName: row.location_name,
    client: row.client_id ? (names.get(row.client_id) ?? null) : null,
    partner: row.partner_client_id ? (names.get(row.partner_client_id) ?? null) : null,
  };
}

const SUMMARY_FIELDS =
  "id, title, appointment_type, status, starts_at, ends_at, client_id, partner_client_id, location_name, rooms ( id, name )";

/**
 * The caller's OWN teaching appointments for one local day, whatever their role: an owner who also teaches sees their lessons, not the studio's. The explicit instructor_id
 * filter is the boundary, because RLS is wider than "mine": broad staff can read every appointment in the studio.
 */
export async function loadInstructorDay(params: {
  supabase: SupabaseClient;
  studioId: string;
  userId: string;
  date: string;
  timeZone: string;
  range: { startIso: string; endIso: string };
}) {
  const { supabase, studioId, userId, date, timeZone, range } = params;
  const instructorId = await resolveViewerInstructorId(supabase, studioId, userId);
  const base = { studioId, date, timeZone, instructorId };

  // No linked instructor means no own schedule, never everyone's.
  if (!instructorId) return { ...base, appointments: [] };

  const { data, error } = await supabase
    .from("appointments")
    .select(SUMMARY_FIELDS)
    .eq("studio_id", studioId)
    .eq("instructor_id", instructorId)
    .gte("starts_at", range.startIso)
    .lt("starts_at", range.endIso)
    .order("starts_at", { ascending: true });

  if (error) throw new Error(`Day schedule lookup failed: ${error.message}`);

  const rows = (data ?? []) as unknown as AppointmentSummaryRow[];
  const names = rows.length > 0 ? await loadTeachingClientNames(supabase, studioId) : new Map<string, ClientName>();

  return { ...base, appointments: rows.map((row) => toAppointmentSummary(row, names)) };
}

type AppointmentDetailRow = AppointmentSummaryRow & {
  studio_id: string;
  instructor_id: string | null;
  notes: string | null;
  roster_capacity: number | null;
  instructors: Embedded<{ id: string; first_name: string | null; last_name: string | null }>;
};

const DETAIL_FIELDS =
  "title, notes, status, starts_at, ends_at, partner_client_id, location_name, roster_capacity, rooms ( id, name ), instructors ( id, first_name, last_name )";

/**
 * One appointment's detail, or null when the caller may not read it. Null covers a missing row, another studio's row and a colleague's row alike, so the response cannot be
 * used to probe which appointment ids exist. An own-floor-rental match is also null: the web detail page does not show it to an instructor, and independent instructors are
 * not on this surface in v1.
 */
export async function loadAppointmentDetail(params: {
  supabase: SupabaseClient;
  studioId: string;
  studioRole: string;
  userId: string;
  appointmentId: string;
  timeZone: string;
}) {
  const { supabase, studioId, studioRole, userId, appointmentId, timeZone } = params;

  const access = await requireAppointmentRelationshipAccess<AppointmentDetailRow>({
    supabase: supabase as never,
    studioId,
    studioRole,
    isPlatformAdmin: false,
    userId,
    appointmentId,
    select: DETAIL_FIELDS,
  });

  if (!access.ok || access.scope === "own-floor-rental") return null;

  const row = access.appointment;
  const names =
    access.scope === "broad"
      ? await loadStudioClientNames(
          supabase,
          studioId,
          [row.client_id, row.partner_client_id].filter((id): id is string => Boolean(id)),
        )
      : await loadTeachingClientNames(supabase, studioId);

  const instructor = one(row.instructors);
  const isGroupClass = row.appointment_type === "group_class";

  const [roster, recap] = await Promise.all([
    isGroupClass
      ? loadRosterPanel({
          supabase,
          studioId,
          appointmentId: row.id,
          capacity: row.roster_capacity ?? null,
          includeFunding: false,
          canManage: false,
          assignedInstructorView: access.scope === "own-instructor",
        })
      : null,
    row.appointment_type === "private_lesson" ? loadLessonRecap(supabase, studioId, row.id) : null,
  ]);

  return {
    ...toAppointmentSummary(row, names),
    studioId,
    timeZone,
    accessScope: access.scope,
    notes: row.notes,
    instructor: instructor
      ? { id: instructor.id, firstName: instructor.first_name ?? "", lastName: instructor.last_name ?? "" }
      : null,
    roster: roster
      ? {
          bookedCount: roster.bookedCount,
          capacity: row.roster_capacity ?? null,
          attendees: roster.entries.map((entry) => ({
            clientId: entry.clientId,
            name: entry.nameKnown ? entry.name : null,
            attendanceStatus: entry.attendanceStatus,
          })),
        }
      : null,
    recap,
  };
}

type LessonRecapRow = {
  summary: string | null;
  homework: string | null;
  next_focus: string | null;
  visible_to_client: boolean;
  updated_at: string;
};

async function loadLessonRecap(supabase: SupabaseClient, studioId: string, appointmentId: string) {
  const { data, error } = await supabase
    .from("lesson_recaps")
    .select("summary, homework, next_focus, visible_to_client, updated_at")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId)
    .maybeSingle<LessonRecapRow>();

  if (error) throw new Error(`Lesson recap lookup failed: ${error.message}`);
  if (!data) return null;

  return {
    summary: data.summary,
    homework: data.homework,
    nextFocus: data.next_focus,
    visibleToClient: data.visible_to_client,
    updatedAt: toIsoUtc(data.updated_at),
  };
}
