import { canMarkAttendance } from "@/lib/auth/permissions";
import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import {
  MARKABLE_ATTENDANCE_STATUSES,
  markClassAttendance,
  type MarkableAttendanceStatus,
} from "@/lib/staff/classAttendance";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ studioId: string; appointmentId: string; clientId: string }> },
) {
  const { studioId, appointmentId, clientId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  if (!canMarkAttendance(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot record attendance.", 403);
  }

  const normalizedAppointmentId = normalizeStudentApiUuid(appointmentId);
  const normalizedClientId = normalizeStudentApiUuid(clientId);
  if (!normalizedAppointmentId || !normalizedClientId) {
    return staffApiError("invalid_request", "Valid appointment and client ids are required.", 400);
  }

  if (!IDEMPOTENCY_KEY.test(request.headers.get("idempotency-key") ?? "")) {
    return staffApiError("invalid_request", "An Idempotency-Key header (8-128 letters, digits, - _ : .) is required.", 400);
  }

  let status: unknown;
  try {
    status = ((await request.json()) as { status?: unknown } | null)?.status;
  } catch {
    return staffApiError("invalid_request", "The body must be JSON.", 400);
  }
  if (!MARKABLE_ATTENDANCE_STATUSES.includes(status as MarkableAttendanceStatus)) {
    return staffApiError("invalid_request", "status must be attended or no_show.", 400);
  }

  try {
    const result = await markClassAttendance({
      supabase: guard.supabase,
      studioId: guard.studioId,
      studioRole: guard.studioRole,
      userId: guard.user.id,
      appointmentId: normalizedAppointmentId.toLowerCase(),
      clientId: normalizedClientId.toLowerCase(),
      status: status as MarkableAttendanceStatus,
    });

    if (!result.ok) {
      return result.reason === "not_markable"
        ? staffApiError("not_markable", "Attendance can't be recorded for this appointment.", 409)
        : staffApiError("not_found", "Class or attendee not found.", 404);
    }

    return staffApiJson({ attendee: result.attendee });
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
