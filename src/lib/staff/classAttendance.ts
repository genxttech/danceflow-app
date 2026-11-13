import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAppointmentRelationshipAccess } from "@/lib/auth/appointmentAccess";
import { upsertAttendanceRecord } from "@/lib/schedule/classAttendance";
import { isCancelledClassAttendanceError } from "@/lib/schedule/groupClassCancel";
import { loadInstructorRosterNames } from "@/lib/schedule/groupClassRosterPanel";
import { toIsoUtc } from "@/lib/staff/instructorToday";

/**
 * Staff API attendance mark for one enrolled dancer on one group class. The authorization and the write are the web attendance
 * page's own: requireAppointmentRelationshipAccess (broad staff for any class in the studio, the assigned instructor for their own
 * class, never a floor-rental relationship), then upsertAttendanceRecord with the same timestamps the web actions set. Database
 * guards and triggers on attendance_records apply unchanged.
 */

export const MARKABLE_ATTENDANCE_STATUSES = ["attended", "no_show"] as const;
export type MarkableAttendanceStatus = (typeof MARKABLE_ATTENDANCE_STATUSES)[number];

export type MarkAttendanceResult =
  | { ok: true; attendee: { clientId: string; displayName: string | null; status: string; updatedAt: string | null } }
  | { ok: false; reason: "not_found" | "not_markable" };

type AttendanceRow = { status: string; updated_at: string | null };

async function readAttendance(supabase: SupabaseClient, studioId: string, appointmentId: string, clientId: string) {
  const { data, error } = await supabase
    .from("attendance_records")
    .select("status, updated_at")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId)
    .eq("client_id", clientId)
    .maybeSingle<AttendanceRow>();
  if (error) throw new Error(`Attendance lookup failed: ${error.message}`);
  return data;
}

async function displayNameFor(params: {
  supabase: SupabaseClient;
  scope: "broad" | "own-instructor";
  studioId: string;
  appointmentId: string;
  clientId: string;
}) {
  const { supabase, scope, studioId, appointmentId, clientId } = params;
  let first: string | null | undefined;
  let last: string | null | undefined;
  if (scope === "broad") {
    const { data, error } = await supabase
      .from("clients")
      .select("first_name, last_name")
      .eq("studio_id", studioId)
      .eq("id", clientId)
      .maybeSingle<{ first_name: string | null; last_name: string | null }>();
    if (error) throw new Error(`Client name lookup failed: ${error.message}`);
    first = data?.first_name;
    last = data?.last_name;
  } else {
    // clients RLS hides names from instructors; the roster function returns them for the class's assigned instructor only.
    const names = await loadInstructorRosterNames(supabase, appointmentId);
    first = names.get(clientId)?.firstName;
    last = names.get(clientId)?.lastName;
  }
  return `${first ?? ""} ${last ?? ""}`.trim() || null;
}

export async function markClassAttendance(params: {
  supabase: SupabaseClient;
  studioId: string;
  studioRole: string;
  userId: string;
  appointmentId: string;
  clientId: string;
  status: MarkableAttendanceStatus;
}): Promise<MarkAttendanceResult> {
  const { supabase, studioId, studioRole, userId, appointmentId, clientId, status } = params;

  const access = await requireAppointmentRelationshipAccess<{
    id: string;
    studio_id: string;
    client_id: string | null;
    instructor_id: string | null;
    appointment_type: string;
    status: string;
  }>({
    supabase: supabase as never,
    studioId,
    studioRole,
    isPlatformAdmin: false,
    userId,
    appointmentId,
    select: "status",
  });

  // A class that isn't the caller's, a missing one and another studio's one all answer the same; a floor-rental relationship never authorizes attendance.
  if (!access.ok || access.scope === "own-floor-rental") return { ok: false, reason: "not_found" };
  if (access.appointment.appointment_type !== "group_class" || access.appointment.status === "cancelled") {
    return { ok: false, reason: "not_markable" };
  }

  const { data: enrollment, error: enrollmentError } = await supabase
    .from("appointment_attendees")
    .select("id")
    .eq("studio_id", studioId)
    .eq("appointment_id", appointmentId)
    .eq("client_id", clientId)
    .eq("status", "booked")
    .maybeSingle();
  if (enrollmentError) throw new Error(`Enrollment lookup failed: ${enrollmentError.message}`);
  if (!enrollment) return { ok: false, reason: "not_found" };

  const scope = access.scope;
  const existing = await readAttendance(supabase, studioId, appointmentId, clientId);

  // Idempotent by state: a retry, or a second tap, that asks for the current status writes nothing.
  if (existing?.status !== status) {
    const now = new Date().toISOString();
    try {
      await upsertAttendanceRecord({
        supabase,
        studioId,
        appointmentId,
        clientId,
        createdBy: userId,
        status,
        // The same timestamps markClassAttendedAction / markClassNoShowAction set.
        checkedInAt: status === "attended" ? now : null,
        markedAttendedAt: status === "attended" ? now : null,
      });
    } catch (failure) {
      if (isCancelledClassAttendanceError(failure)) return { ok: false, reason: "not_markable" };
      throw failure;
    }
  }

  const current = existing?.status === status ? existing : await readAttendance(supabase, studioId, appointmentId, clientId);
  if (!current) throw new Error("Attendance write was not readable afterwards");

  return {
    ok: true,
    attendee: {
      clientId,
      displayName: await displayNameFor({ supabase, scope, studioId, appointmentId, clientId }),
      status: current.status,
      updatedAt: toIsoUtc(current.updated_at),
    },
  };
}
