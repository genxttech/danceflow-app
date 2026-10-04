/**
 * GC-S1C-5: pure helpers for "This and following classes" series editing.
 *
 * The authoritative rules (who may edit, which occurrences are edited, customized-value preservation, the
 * successor split, conflicts, the capacity floor, idempotency) live in the database RPCs
 * `preview_group_class_series_edit` and `edit_group_class_series_from`. This module only builds the change set
 * from the submitted form (diffed against the class being edited, so only real changes are sent), parses the RPC
 * jsonb into safe typed shapes, maps stable error codes to fixed owner-facing copy (database text never reaches
 * the UI), and builds the preview wording. Recurrence shape, the class date, notes and enrollment policy are
 * deliberately not part of this surface.
 */

export const SERIES_EDIT_FIELD_LABELS: Record<string, string> = {
  title: "Title",
  instructor: "Instructor",
  room: "Room",
  location: "Location",
  capacity: "Maximum students",
  time: "Start time or length",
};

/** Plain-language labels for the override groups reported by the preview, in a stable order. */
export function describeSeriesEditFields(fields: Record<string, number> | null | undefined): string[] {
  return Object.keys(SERIES_EDIT_FIELD_LABELS).filter((key) => (fields?.[key] ?? 0) > 0).map((key) => SERIES_EDIT_FIELD_LABELS[key]);
}

export type SeriesEditCurrent = {
  title: string;
  instructorId: string | null;
  roomId: string | null;
  locationName: string | null;
  rosterCapacity: number | null;
  /** Local start time of day in the series time zone, "HH:MM". */
  startTime: string;
  durationMinutes: number;
};

export type SeriesEditChanges = Partial<{
  title: string;
  instructor_id: string | null;
  room_id: string | null;
  location_name: string | null;
  roster_capacity: number | null;
  local_start_time: string;
  duration_minutes: number;
}>;

export type SeriesEditFormInput = {
  title: string;
  instructorId: string;
  roomId: string;
  locationName: string;
  rosterCapacity: string;
  startTime: string;
  durationMinutes: string;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Change-set keys that make up each tracked override group (the group "time" is start time and length together). */
export const SERIES_EDIT_GROUP_CHANGE_KEYS: Record<string, Array<keyof SeriesEditChanges>> = {
  title: ["title"],
  instructor: ["instructor_id"],
  room: ["room_id"],
  location: ["location_name"],
  capacity: ["roster_capacity"],
  time: ["local_start_time", "duration_minutes"],
};

/**
 * The reset selections the server will honor: known groups the selected class has actually customized (a reset can
 * only be requested for a customization that exists), de-duplicated in a stable order.
 */
export function parseSeriesEditResetGroups(requested: readonly string[], anchorOverridden: readonly string[]): string[] {
  const customized = new Set(anchorOverridden);
  return Object.keys(SERIES_EDIT_GROUP_CHANGE_KEYS).filter((group) => requested.includes(group) && customized.has(group));
}

export type BuildChangesResult =
  | { ok: true; changes: SeriesEditChanges }
  | { ok: false; reason: "invalid_title" | "invalid_capacity" | "invalid_time" | "invalid_duration" | "invalid_reference" };

/**
 * Diffs the submitted fields against the class being edited. Only fields that really differ are included, so an
 * untouched form sends nothing for them. A blank capacity means "no limit"; blank instructor / room / location
 * mean "none".
 */
export function buildSeriesEditChanges(
  input: SeriesEditFormInput,
  current: SeriesEditCurrent,
  resetGroups: readonly string[] = [],
): BuildChangesResult {
  const changes: SeriesEditChanges = {};

  const title = input.title.trim();
  if (title.length === 0) return { ok: false, reason: "invalid_title" };
  if (title !== current.title.trim()) changes.title = title;

  const instructor = input.instructorId.trim();
  if (instructor !== "" && !UUID_RE.test(instructor)) return { ok: false, reason: "invalid_reference" };
  if ((instructor || null) !== (current.instructorId ?? null)) changes.instructor_id = instructor || null;

  const room = input.roomId.trim();
  if (room !== "" && !UUID_RE.test(room)) return { ok: false, reason: "invalid_reference" };
  if ((room || null) !== (current.roomId ?? null)) changes.room_id = room || null;

  const location = input.locationName.trim();
  if ((location || null) !== ((current.locationName ?? "").trim() || null)) changes.location_name = location || null;

  const capacityText = input.rosterCapacity.trim();
  let capacity: number | null = null;
  if (capacityText !== "") {
    if (!/^\d+$/.test(capacityText)) return { ok: false, reason: "invalid_capacity" };
    capacity = Number(capacityText);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) return { ok: false, reason: "invalid_capacity" };
  }
  if (capacity !== (current.rosterCapacity ?? null)) changes.roster_capacity = capacity;

  const startTime = input.startTime.trim();
  if (!TIME_RE.test(startTime)) return { ok: false, reason: "invalid_time" };
  if (startTime !== current.startTime) changes.local_start_time = startTime;

  const durationText = input.durationMinutes.trim();
  if (!/^\d+$/.test(durationText)) return { ok: false, reason: "invalid_duration" };
  const duration = Number(durationText);
  if (duration < 5 || duration > 720) return { ok: false, reason: "invalid_duration" };
  if (duration !== current.durationMinutes) changes.duration_minutes = duration;

  // Explicit reset: the series-baseline value of every field of a selected group is INCLUDED even though it equals the
  // baseline (an untouched field is omitted; a deliberately reset one is sent). The reset wins over a typed value.
  for (const group of resetGroups) {
    for (const key of SERIES_EDIT_GROUP_CHANGE_KEYS[group] ?? []) {
      if (key === "title") changes.title = current.title.trim();
      else if (key === "instructor_id") changes.instructor_id = current.instructorId ?? null;
      else if (key === "room_id") changes.room_id = current.roomId ?? null;
      else if (key === "location_name") changes.location_name = (current.locationName ?? "").trim() || null;
      else if (key === "roster_capacity") changes.roster_capacity = current.rosterCapacity ?? null;
      else if (key === "local_start_time") changes.local_start_time = current.startTime;
      else if (key === "duration_minutes") changes.duration_minutes = current.durationMinutes;
    }
  }

  return { ok: true, changes };
}

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Preview / result parsing
// ---------------------------------------------------------------------------

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export type SeriesEditConflictReason = "instructor" | "instructor_block" | "room_unavailable" | "room_busy";

export type SeriesEditPreview = {
  willSplit: boolean;
  classCount: number;
  editableCount: number;
  changedCount: number;
  cancelledCount: number;
  historicalCount: number;
  terminalAttendanceCount: number;
  customizedCount: number;
  customizedFields: Record<string, number>;
  overwrite: boolean;
  conflictCount: number;
  firstConflict: { occurrenceIndex: number; reason: SeriesEditConflictReason } | null;
  capacityBlockedCount: number;
};

const CONFLICT_REASONS: readonly string[] = ["instructor", "instructor_block", "room_unavailable", "room_busy"];

export function parseSeriesEditPreview(raw: unknown): SeriesEditPreview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.series_id !== "string") return null;

  const fields: Record<string, number> = {};
  if (r.customized_fields && typeof r.customized_fields === "object" && !Array.isArray(r.customized_fields)) {
    for (const [key, value] of Object.entries(r.customized_fields as Record<string, unknown>)) {
      if (key in SERIES_EDIT_FIELD_LABELS) fields[key] = asCount(value);
    }
  }

  let firstConflict: SeriesEditPreview["firstConflict"] = null;
  if (r.first_conflict && typeof r.first_conflict === "object") {
    const c = r.first_conflict as Record<string, unknown>;
    if (typeof c.reason === "string" && CONFLICT_REASONS.includes(c.reason)) {
      firstConflict = { occurrenceIndex: asCount(c.occurrence_index), reason: c.reason as SeriesEditConflictReason };
    }
  }

  return {
    willSplit: r.will_split === true,
    classCount: asCount(r.class_count),
    editableCount: asCount(r.editable_count),
    changedCount: asCount(r.changed_count),
    cancelledCount: asCount(r.cancelled_count),
    historicalCount: asCount(r.historical_count),
    terminalAttendanceCount: asCount(r.terminal_attendance_count),
    customizedCount: asCount(r.customized_count),
    customizedFields: fields,
    overwrite: r.overwrite === true,
    conflictCount: asCount(r.conflict_count),
    firstConflict,
    capacityBlockedCount: asCount(r.capacity_blocked_count),
  };
}

export type SeriesEditResult = {
  seriesId: string;
  splitCreated: boolean;
  movedClassCount: number;
  editedClassCount: number;
  preservedCustomizedCount: number;
  overwrittenCustomizedCount: number;
  replay: boolean;
};

export function parseSeriesEditResult(raw: unknown): SeriesEditResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.series_id !== "string") return null;
  return {
    seriesId: r.series_id,
    splitCreated: r.split_created === true,
    movedClassCount: asCount(r.moved_class_count),
    editedClassCount: asCount(r.edited_class_count),
    preservedCustomizedCount: asCount(r.preserved_customized_count),
    overwrittenCustomizedCount: asCount(r.overwritten_customized_count),
    replay: r.replay === true,
  };
}

/**
 * What the owner confirms: the exact change set, the preserve/overwrite choice and the counts they were shown.
 * The apply step recomputes this server-side and refuses if it no longer matches.
 */
export function seriesEditFingerprint(changes: SeriesEditChanges, overwrite: boolean, preview: SeriesEditPreview): string {
  const ordered = Object.fromEntries(Object.entries(changes).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({
    changes: ordered,
    overwrite,
    classes: preview.classCount,
    changed: preview.changedCount,
    customized: preview.customizedCount,
    conflicts: preview.conflictCount,
  });
}

// ---------------------------------------------------------------------------
// Errors (fixed copy; never database text)
// ---------------------------------------------------------------------------

export type SeriesEditFailure =
  | "not_authorized"
  | "not_found"
  | "not_a_series"
  | "not_editable"
  | "invalid_changes"
  | "no_changes"
  | "instructor_unassignable"
  | "room_invalid"
  | "conflict"
  | "capacity_below_booked"
  | "idempotency"
  | "unknown";

export function classifySeriesEditError(error: { message?: string | null } | null | undefined): {
  failure: SeriesEditFailure;
  conflictReason?: SeriesEditConflictReason;
  conflictIndex?: number;
  booked?: number;
} {
  const message = String(error?.message ?? "");
  if (/GCSC5_UNAUTHORIZED/.test(message)) return { failure: "not_authorized" };
  if (/GCSC5_NOT_FOUND/.test(message)) return { failure: "not_found" };
  if (/GCSC5_NOT_A_SERIES_OCCURRENCE/.test(message)) return { failure: "not_a_series" };
  if (/GCSC5_ANCHOR_NOT_EDITABLE|GCSC5_SERIES_NOT_EDITABLE/.test(message)) return { failure: "not_editable" };
  if (/GCSC5_NO_CHANGES/.test(message)) return { failure: "no_changes" };
  if (/GCSC5_INVALID_CHANGES|GCSC5_REQUEST_ID_REQUIRED/.test(message)) return { failure: "invalid_changes" };
  if (/GCSC5_INSTRUCTOR_UNASSIGNABLE/.test(message)) return { failure: "instructor_unassignable" };
  if (/GCSC5_ROOM_INVALID/.test(message)) return { failure: "room_invalid" };
  if (/GCSC5_IDEMPOTENCY_CONFLICT/.test(message)) return { failure: "idempotency" };
  if (/GCSC3_CAPACITY_BELOW_BOOKED/.test(message)) {
    const match = /(\d+) students already booked/.exec(message);
    return { failure: "capacity_below_booked", booked: match ? Number(match[1]) : undefined };
  }
  const conflict = /GCSC5_CONFLICT: reason=(\w+) index=(\d+)/.exec(message);
  if (conflict && CONFLICT_REASONS.includes(conflict[1])) {
    return { failure: "conflict", conflictReason: conflict[1] as SeriesEditConflictReason, conflictIndex: Number(conflict[2]) };
  }
  if (/GCSC5_CONFLICT/.test(message)) return { failure: "conflict" };
  return { failure: "unknown" };
}

const CONFLICT_COPY: Record<SeriesEditConflictReason, string> = {
  instructor: "That instructor is already booked during one of these classes.",
  instructor_block: "That instructor has a schedule block during one of these classes.",
  room_unavailable: "That room is unavailable during one of these classes.",
  room_busy: "That room is already booked during one of these classes.",
};

export function seriesEditFailureMessage(
  failure: SeriesEditFailure,
  detail?: { conflictReason?: SeriesEditConflictReason; booked?: number },
): string {
  switch (failure) {
    case "not_authorized":
      return "Only studio owners, admins and front desk can edit a series of classes.";
    case "not_found":
      return "We couldn't find this class.";
    case "not_a_series":
      return "This class is not part of a series.";
    case "not_editable":
      return "This class can no longer be edited together with the classes that follow it. Open a later class that is still upcoming.";
    case "invalid_changes":
      return "One of the values is not valid. Check the fields and try again.";
    case "no_changes":
      return "Nothing would change. Edit at least one field first.";
    case "instructor_unassignable":
      return "Choose an active instructor from this studio.";
    case "room_invalid":
      return "Choose an active room from this studio.";
    case "conflict":
      return detail?.conflictReason
        ? `${CONFLICT_COPY[detail.conflictReason]} Nothing was changed.`
        : "These changes conflict with the schedule. Nothing was changed.";
    case "capacity_below_booked":
      return detail?.booked && detail.booked > 0
        ? `One of these classes already has ${detail.booked === 1 ? "1 student" : `${detail.booked} students`} booked. Maximum students cannot be set lower. Nothing was changed.`
        : "Maximum students cannot be set below the number of students already booked. Nothing was changed.";
    case "idempotency":
      return "This request was already used for a different change. Reload the page and try again.";
    default:
      return "Could not update the classes. Please try again.";
  }
}

export function seriesEditInputErrorMessage(reason: Exclude<BuildChangesResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "invalid_title":
      return "A class title is required.";
    case "invalid_capacity":
      return "Maximum students must be a whole number of 1 or more, or left blank for no limit.";
    case "invalid_time":
      return "Choose a valid start time.";
    case "invalid_duration":
      return "Class length must be between 5 and 720 minutes.";
    default:
      return "One of the values is not valid. Check the fields and try again.";
  }
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

/** Concise preview for the confirmation step. */
export function seriesEditPreviewLines(preview: SeriesEditPreview): string[] {
  const lines: string[] = [];
  const edited = preview.changedCount;
  lines.push(
    edited === 0
      ? "No class values would change, but the series definition would be updated for what follows."
      : `${edited} ${plural(edited, "class", "classes")} will be updated, starting with this one.`,
  );

  if (preview.willSplit) {
    lines.push("Earlier classes in the series stay exactly as they are.");
  }

  if (preview.cancelledCount > 0 || preview.historicalCount > 0 || preview.terminalAttendanceCount > 0) {
    const kept = preview.cancelledCount + preview.historicalCount + preview.terminalAttendanceCount;
    lines.push(
      `${kept} ${plural(kept, "class stays", "classes stay")} unchanged (cancelled, already held or with recorded attendance).`,
    );
  }

  if (preview.customizedCount > 0) {
    const fields = describeSeriesEditFields(preview.customizedFields).join(", ").toLowerCase();
    const n = preview.customizedCount;
    lines.push(
      preview.overwrite
        ? `${n} customized ${plural(n, "class", "classes")} will be changed to the new ${fields || "values"}.`
        : `${n} customized ${plural(n, "class keeps", "classes keep")} ${plural(n, "its", "their")} own ${fields || "values"}.`,
    );
  }

  lines.push("Students, attendance, credits and enrollment settings are not changed. No notifications are sent.");
  return lines;
}

/** Banner wording for the success redirect (the count is a numeric query param only). */
export function groupClassSeriesEditBannerMessage(code: string, count: number | null): string | null {
  if (code !== "series_edited") return null;
  const n = count !== null && count > 0 ? count : null;
  return n ? `${n} ${plural(n, "class", "classes")} updated.` : "Classes updated.";
}

/** Form fields that make up each tracked override group (the group "time" is start time and length together). */
export const SERIES_EDIT_GROUP_FIELDS: Record<string, Array<keyof SeriesEditFormInput>> = {
  title: ["title"],
  instructor: ["instructorId"],
  room: ["roomId"],
  location: ["locationName"],
  capacity: ["rosterCapacity"],
  time: ["startTime", "durationMinutes"],
};

/** Copies the selected class's own values into the form for the customized groups only. */
export function applyAnchorCustomizedValues(
  values: SeriesEditFormInput,
  anchorValues: SeriesEditFormInput,
  customizedGroups: readonly string[],
): SeriesEditFormInput {
  const next = { ...values };
  for (const group of customizedGroups) {
    for (const field of SERIES_EDIT_GROUP_FIELDS[group] ?? []) next[field] = anchorValues[field];
  }
  return next;
}

/**
 * Everything the owner reviewed: the field values and the preserve/overwrite choice. Any change to either invalidates
 * the review on the client (the server independently re-derives and compares its own fingerprint at apply time).
 */
export function seriesEditReviewKey(values: SeriesEditFormInput, overwrite: boolean, resetGroups: readonly string[] = []): string {
  return JSON.stringify([
    values.title, values.instructorId, values.roomId, values.locationName, values.rosterCapacity, values.startTime, values.durationMinutes,
    overwrite, [...resetGroups].sort(),
  ]);
}

export function isSeriesEditReviewStale(reviewedKey: string | null, currentKey: string): boolean {
  return reviewedKey === null || reviewedKey !== currentKey;
}

/** "HH:MM" wall-clock time of an instant in an IANA time zone (null when the inputs are not usable). */
export function localTimeOfDay(iso: string | null | undefined, timeZone: string | null | undefined): string | null {
  if (!iso || !timeZone) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    return hour && minute ? `${hour}:${minute}` : null;
  } catch {
    return null;
  }
}

export function minutesBetween(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : null;
}
