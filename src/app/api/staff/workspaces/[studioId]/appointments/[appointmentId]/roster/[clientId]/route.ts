import { canEditAppointments } from "@/lib/auth/permissions";
import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { staffApiError, staffApiJson, staffApiUnavailable } from "@/lib/auth/staffApiAuth";
import { requireStaffWrite } from "@/lib/staff/writeGuard";
import { readIdempotencyKey, staffConflict } from "@/lib/staff/writeSupport";
import { cancelClassAttendeeForClient } from "@/lib/staff/classRoster";

// Remove a dancer from a class (Phase 1A S2): cancel_class_attendee through src/lib/staff/classRoster.ts. Pattern 1 (state-based): removing a dancer who is already
// removed is a no-op that answers 200 with alreadyApplied.
export async function DELETE(request: Request, { params }: { params: Promise<{ studioId: string; appointmentId: string; clientId: string }> }) {
  const { studioId, appointmentId, clientId } = await params;
  const guard = await requireStaffWrite(request, studioId, "classRoster");
  if (!guard.ok) return guard.response;

  if (!canEditAppointments(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot change a class roster.", 403);
  }

  const classId = normalizeStudentApiUuid(appointmentId);
  const dancerId = normalizeStudentApiUuid(clientId);
  if (!classId || !dancerId) return staffApiError("invalid_request", "Valid class and client ids are required.", 400);

  const key = readIdempotencyKey(request);
  if (!key.ok) return key.response;

  try {
    const result = await cancelClassAttendeeForClient({
      supabase: guard.supabase,
      studioId: guard.studioId,
      appointmentId: classId.toLowerCase(),
      clientId: dancerId.toLowerCase(),
    });

    if (result.ok) return staffApiJson({ removed: true, alreadyApplied: !result.changed });

    switch (result.reason) {
      case "class_not_found":
      case "not_found":
      case "attendee_not_authorized":
        // Missing, another studio's, not enrolled, or not the caller's class: indistinguishable.
        return staffApiError("not_found", "Class or dancer not found.", 404);
      case "attendee_attendance_recorded":
        return staffConflict("attendance_recorded", "This dancer's attendance is already recorded, so they can't be removed.", null);
      default:
        throw new Error(`Remove failed: ${result.reason}`);
    }
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
