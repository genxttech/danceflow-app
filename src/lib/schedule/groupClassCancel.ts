/**
 * GC-S1C-2: pure helpers for canonical group-class cancellation.
 *
 * The authoritative rules (already-cancelled no-op, terminal attendance
 * refusal, booked-attendee-only cancellation) live in the database RPC
 * cancel_group_class_appointment. This module only translates its outcomes to
 * fixed owner-facing copy and redirect codes, so database text never reaches
 * the UI, and builds the cancellation form's consequence wording.
 */

export type GroupClassCancelFailure =
  | "attendance_recorded"
  | "not_authorized"
  | "not_found"
  | "unknown";

/** Classify an RPC error by its stable code / known message. Never returns raw text. */
export function classifyGroupClassCancelError(
  error: { message?: string | null } | null | undefined,
): GroupClassCancelFailure {
  const message = String(error?.message ?? "");
  if (/GCSC2_ATTENDANCE_RECORDED/.test(message)) return "attendance_recorded";
  if (/Not authorized to cancel this class/i.test(message)) return "not_authorized";
  if (/Group class not found/i.test(message)) return "not_found";
  return "unknown";
}

export const GROUP_CLASS_CANCEL_REDIRECT_CODE: Record<GroupClassCancelFailure, string> = {
  attendance_recorded: "class_cancel_attendance_recorded",
  not_authorized: "class_cancel_not_authorized",
  not_found: "appointment_not_found",
  unknown: "class_cancel_failed",
};

const BANNERS: Record<string, { kind: "success" | "error"; message: string }> = {
  class_cancelled: { kind: "success", message: "Class cancelled." },
  class_already_cancelled: { kind: "success", message: "This class was already cancelled." },
  class_cancel_attendance_recorded: {
    kind: "error",
    message:
      "This class already has attendance recorded. Correct the attendance record before cancelling the class.",
  },
  class_cancel_not_authorized: {
    kind: "error",
    message: "Only studio owners, admins and front desk can cancel a class.",
  },
  class_cancel_failed: {
    kind: "error",
    message: "Could not cancel the class. Please try again.",
  },
};

/** Banner for a class-cancellation redirect code (success or error), or null. */
export function groupClassCancelBanner(search: {
  success?: string | null;
  error?: string | null;
}): { kind: "success" | "error"; message: string } | null {
  const code = search.success ?? search.error ?? "";
  const banner = BANNERS[code];
  if (!banner) return null;
  if (search.success && banner.kind !== "success") return null;
  if (!search.success && search.error && banner.kind !== "error") return null;
  return banner;
}

/** Truthful consequence wording for the cancel form. */
export function groupClassCancelConsequences(params: {
  bookedCount: number | null;
  isSeriesOccurrence: boolean;
}): string[] {
  const lines: string[] = [];
  if (params.isSeriesOccurrence) {
    lines.push("This cancels only this class. Other classes in the series stay scheduled.");
  }
  const { bookedCount } = params;
  if (bookedCount === null) {
    lines.push("Any booked students will be marked cancelled.");
  } else if (bookedCount > 0) {
    lines.push(
      bookedCount === 1
        ? "1 booked student will be marked cancelled."
        : `${bookedCount} booked students will be marked cancelled.`,
    );
  }
  lines.push(
    "Students with a linked DanceFlow account may receive a cancellation notification.",
    "Recorded attendance and used credits are not changed.",
  );
  return lines;
}
