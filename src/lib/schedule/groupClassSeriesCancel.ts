/**
 * GC-S1C-4: pure helpers for "This and following classes" cancellation.
 *
 * The authoritative rules (who may cancel, which occurrences are eligible, past / terminal-attendance
 * preservation, idempotent replay, stored series status) live in the database RPCs
 * `preview_group_class_series_cancellation` and `cancel_group_class_series_from`. This module only
 * validates the submitted scope, parses the RPC's jsonb into a safe typed shape (never trusting a
 * client list or count), maps stable error codes to fixed redirect codes, and builds the owner-facing
 * wording. Database text never reaches the UI.
 */

export type GroupClassCancelScope = "this_class" | "this_and_following";

/** Absent scope is the historical single-occurrence behavior; anything unrecognised is refused. */
export function parseGroupClassCancelScope(raw: string | null | undefined): GroupClassCancelScope | null {
  const value = String(raw ?? "").trim();
  if (value === "" || value === "this_class") return "this_class";
  if (value === "this_and_following") return "this_and_following";
  return null;
}

export type GroupClassSeriesCancelFailure =
  | "attendance_recorded"
  | "not_authorized"
  | "not_found"
  | "not_a_series"
  | "unknown";

export function classifyGroupClassSeriesCancelError(
  error: { message?: string | null } | null | undefined,
): GroupClassSeriesCancelFailure {
  const message = String(error?.message ?? "");
  if (/GCSC4_UNAUTHORIZED/.test(message)) return "not_authorized";
  if (/GCSC4_NOT_FOUND/.test(message)) return "not_found";
  if (/GCSC4_NOT_A_SERIES_OCCURRENCE/.test(message)) return "not_a_series";
  if (/GCSC2_ATTENDANCE_RECORDED/.test(message)) return "attendance_recorded";
  return "unknown";
}

export const GROUP_CLASS_SERIES_CANCEL_REDIRECT_CODE: Record<GroupClassSeriesCancelFailure, string> = {
  attendance_recorded: "class_cancel_attendance_recorded",
  not_authorized: "series_cancel_not_authorized",
  not_found: "appointment_not_found",
  not_a_series: "series_cancel_not_a_series",
  unknown: "series_cancel_failed",
};

export type GroupClassSeriesCancelRecipient = {
  clientId: string;
  classStarts: string[];
};

export type GroupClassSeriesCancelResult = {
  seriesId: string;
  studioId: string;
  cancelledClassCount: number;
  enrollmentsCancelled: number;
  alreadyCancelledCount: number;
  historicalCount: number;
  terminalAttendanceCount: number;
  seriesStatus: string;
  seriesCancelledByThisCall: boolean;
  recipients: GroupClassSeriesCancelRecipient[];
};

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Defensive parse of the RPC jsonb; returns null when it is not the expected object. */
export function parseGroupClassSeriesCancelResult(raw: unknown): GroupClassSeriesCancelResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.series_id !== "string" || typeof r.studio_id !== "string") return null;

  const recipients: GroupClassSeriesCancelRecipient[] = [];
  if (Array.isArray(r.recipients)) {
    for (const item of r.recipients) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.client_id !== "string" || !Array.isArray(entry.class_starts)) continue;
      const classStarts = entry.class_starts.filter((s): s is string => typeof s === "string");
      if (classStarts.length > 0) recipients.push({ clientId: entry.client_id, classStarts });
    }
  }

  return {
    seriesId: r.series_id,
    studioId: r.studio_id,
    cancelledClassCount: asCount(r.cancelled_class_count),
    enrollmentsCancelled: asCount(r.enrollments_cancelled),
    alreadyCancelledCount: asCount(r.already_cancelled_count),
    historicalCount: asCount(r.historical_count),
    terminalAttendanceCount: asCount(r.terminal_attendance_count),
    seriesStatus: typeof r.series_status === "string" ? r.series_status : "active",
    seriesCancelledByThisCall: r.series_cancelled_by_this_call === true,
    recipients,
  };
}

/** Success redirect code for a completed series cancellation. */
export function seriesCancelSuccessCode(result: GroupClassSeriesCancelResult): string {
  if (result.cancelledClassCount === 0) return "series_nothing_to_cancel";
  return result.seriesStatus === "cancelled" ? "series_cancelled" : "series_classes_cancelled";
}

export type GroupClassSeriesPreview = {
  eligibleClassCount: number;
  enrollmentsAffected: number;
  dancersAffected: number;
  alreadyCancelledCount: number;
  historicalCount: number;
  terminalAttendanceCount: number;
  seriesWouldBeCancelled: boolean;
};

export function parseGroupClassSeriesPreview(raw: unknown): GroupClassSeriesPreview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.series_id !== "string") return null;
  return {
    eligibleClassCount: asCount(r.eligible_class_count),
    enrollmentsAffected: asCount(r.enrollments_affected),
    dancersAffected: asCount(r.dancers_affected),
    alreadyCancelledCount: asCount(r.already_cancelled_count),
    historicalCount: asCount(r.historical_count),
    terminalAttendanceCount: asCount(r.terminal_attendance_count),
    seriesWouldBeCancelled: r.series_would_be_cancelled === true,
  };
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

/** Concise, truthful impact summary for the "This and following classes" choice. */
export function groupClassSeriesCancelImpactLines(preview: GroupClassSeriesPreview): string[] {
  const lines: string[] = [];
  const classes = preview.eligibleClassCount;
  if (classes === 0) {
    lines.push("There are no remaining classes from this one onward to cancel.");
  } else {
    lines.push(
      `${classes} ${plural(classes, "class", "classes")} from this one onward will be cancelled.`,
    );
    if (preview.dancersAffected > 0) {
      lines.push(
        `${preview.dancersAffected} ${plural(preview.dancersAffected, "dancer is", "dancers are")} enrolled in ${preview.enrollmentsAffected} ${plural(preview.enrollmentsAffected, "booking", "bookings")} and will be notified once.`,
      );
    } else {
      lines.push("No dancers are currently booked into these classes.");
    }
  }
  if (preview.terminalAttendanceCount > 0) {
    lines.push(
      `${preview.terminalAttendanceCount} ${plural(preview.terminalAttendanceCount, "class has", "classes have")} recorded attendance and will stay as they are.`,
    );
  }
  lines.push(
    "Earlier classes, recorded attendance and used credits are not changed.",
    preview.seriesWouldBeCancelled
      ? "No classes will remain upcoming, so the series will be marked cancelled."
      : "The series stays active for the classes that remain.",
  );
  return lines;
}

/** Banner wording for series success outcomes (the count comes from a numeric query param, never free text). */
export function groupClassSeriesCancelBannerMessage(code: string, count: number | null): string | null {
  const n = count !== null && count > 0 ? count : null;
  if (code === "series_cancelled") {
    return n
      ? `${n} ${plural(n, "class", "classes")} cancelled. The series is now cancelled.`
      : "The series is now cancelled.";
  }
  if (code === "series_classes_cancelled") {
    return n
      ? `${n} ${plural(n, "class", "classes")} cancelled. The series stays active for the remaining classes.`
      : "Classes cancelled. The series stays active for the remaining classes.";
  }
  if (code === "series_nothing_to_cancel") return "There were no remaining classes to cancel.";
  return null;
}

export const GROUP_CLASS_SERIES_ERROR_BANNERS: Record<string, string> = {
  series_cancel_not_authorized: "Only studio owners, admins and front desk can cancel a series of classes.",
  series_cancel_not_a_series: "This class is not part of a series.",
  series_cancel_invalid_scope: "Choose which classes to cancel and try again.",
  series_cancel_failed: "Could not cancel the classes. Please try again.",
};
