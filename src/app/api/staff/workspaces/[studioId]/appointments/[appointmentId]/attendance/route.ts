import { canMarkAttendance } from "@/lib/auth/permissions";
import { normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { staffApiError, staffApiJson, staffApiUnavailable } from "@/lib/auth/staffApiAuth";
import { requireStaffWrite } from "@/lib/staff/writeGuard";
import { readIdempotencyKey, readJsonBody, staffConflict, staffWriteError } from "@/lib/staff/writeSupport";
import { markAppointmentAttendance } from "@/lib/staff/appointmentAttendance";

const CHARGES = ["none", "package", "membership"];

// One-to-one appointment attendance (Phase 1A S1), behind the write gate (capability appointmentAttendance). Same rules as the web buttons:
// src/lib/staff/appointmentAttendance.ts. Pattern 1 (state-based idempotency); exactly-once deduction is enforced in the database; the key is validated, not stored.
// There is deliberately no reset: attended and no_show are terminal.
export async function PUT(request: Request, { params }: { params: Promise<{ studioId: string; appointmentId: string }> }) {
  const { studioId, appointmentId } = await params;
  const guard = await requireStaffWrite(request, studioId, "appointmentAttendance");
  if (!guard.ok) return guard.response;

  if (!canMarkAttendance(guard.studioRole)) {
    return staffApiError("role_not_permitted", "Your role cannot record attendance.", 403);
  }

  const normalizedAppointmentId = normalizeStudentApiUuid(appointmentId);
  if (!normalizedAppointmentId) return staffApiError("invalid_request", "A valid appointment id is required.", 400);

  const key = readIdempotencyKey(request);
  if (!key.ok) return key.response;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const { status, missedAppointmentCharge: charge } = parsed.body;
  if (status !== "attended" && status !== "no_show") {
    return staffApiError("invalid_request", "status must be attended or no_show.", 400);
  }
  if (charge !== undefined && charge !== null && (typeof charge !== "string" || !CHARGES.includes(charge))) {
    return staffApiError("invalid_request", "missedAppointmentCharge must be none, package or membership.", 400);
  }

  try {
    const result = await markAppointmentAttendance({
      supabase: guard.supabase,
      studioId: guard.studioId,
      appointmentId: normalizedAppointmentId.toLowerCase(),
      status,
      missedAppointmentCharge: status === "no_show" && typeof charge === "string" ? charge : undefined,
      actor: { userId: guard.user.id, studioRole: guard.studioRole, isPlatformAdmin: false },
      restrictToPrivateLessons: true,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return staffApiError("not_found", "Appointment not found.", 404);
        case "not_markable":
          return staffApiError("not_markable", "Attendance can't be recorded for this appointment.", 409);
        case "attended_cannot_be_marked_no_show":
          return staffConflict("outcome_conflict", "This lesson is already marked attended and can't be changed.", { status: "attended" });
        case "no_show_cannot_be_marked_attended":
          return staffConflict("outcome_conflict", "This lesson is already marked no-show and can't be changed.", { status: "no_show" });
        case "charge_changed":
          return staffConflict("outcome_conflict", "This charge can't be applied to the recorded no-show: another decision, or none, is on record. Use the package balance tools on the web.", { status: "no_show" });
        case "package_changed":
          return staffConflict("outcome_conflict", "This lesson was charged to a different package; change it on the web.", { status });
        case "payment_required":
          return staffWriteError("payment_required", "This lesson isn't paid or covered yet. Record payment on the web first.", 409);
        case "charge_failed":
          return staffWriteError("charge_failed", result.message ?? "The missed-lesson charge could not be applied.", 409);
        default:
          throw new Error(`Attendance write failed: ${result.reason}`);
      }
    }

    if (result.usageSyncPending && result.packageExhausted) {
      return staffWriteError(
        "package_exhausted",
        "Attendance is recorded but the package has no credit left. Resolve the package in the web app; repeating this request will not help.",
        409,
      );
    }

    if (result.usageSyncPending) {
      return staffWriteError(
        "usage_sync_pending",
        "Attendance is recorded but the package or membership deduction did not complete. Repeat the request to finish it.",
        409,
      );
    }

    return staffApiJson({ appointment: { id: result.appointmentId, status: result.status, alreadyApplied: result.alreadyApplied } });
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
