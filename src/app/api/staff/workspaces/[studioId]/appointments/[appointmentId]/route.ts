import { canViewStudioSchedule } from "@/lib/auth/permissions";
import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import {
  requireStaffApi,
  staffApiError,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { loadAppointmentDetail } from "@/lib/staff/instructorToday";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ studioId: string; appointmentId: string }> },
) {
  const { studioId, appointmentId } = await params;
  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return guard.response;

  if (!canViewStudioSchedule(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot view this appointment.", 403);
  }

  const normalizedAppointmentId = normalizeStudentApiUuid(appointmentId);
  if (!normalizedAppointmentId) {
    return staffApiError("invalid_request", "A valid appointment id is required.", 400);
  }

  try {
    const appointment = await loadAppointmentDetail({
      supabase: guard.supabase,
      studioId: guard.studioId,
      studioRole: guard.studioRole,
      userId: guard.user.id,
      appointmentId: normalizedAppointmentId,
    });

    if (!appointment) {
      return staffApiError("not_found", "Appointment not found.", 404);
    }

    return staffApiJson(appointment);
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
