/**
 * GC-S1B B2: pure helpers for the canonical group-class series server layer
 * (input parsing, safe error mapping, safe conflict output, bounded
 * concurrency). No server-only imports: this file is shared by the server
 * actions and their tests. The database (preview_group_class_series /
 * create_group_class_series, GC-S1B B1) stays authoritative for recurrence
 * validity, authority and tenant rules; this layer only rejects obviously
 * malformed input and keeps raw database text away from users.
 */

export const SERIES_MAX_OCCURRENCES = 104;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_LOCATION_LENGTH = 200;
const MAX_CAPACITY = 10000;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type SeriesErrorCode =
  | "unauthorized"
  | "invalid_input"
  | "invalid_recurrence"
  | "invalid_timezone"
  | "invalid_definition"
  | "instructor_unassignable"
  | "room_invalid"
  | "occurrence_cap_exceeded"
  | "invalid_skip"
  | "no_occurrences"
  | "policy_invalid"
  | "idempotency_conflict"
  | "conflict"
  | "conflict_check_failed"
  | "unknown";

export type SeriesDstNote = "nonexistent_adjusted" | "ambiguous_later_selected";

export type SeriesConflictCategory =
  | "instructor_overlap"
  | "instructor_block"
  | "room_unavailable"
  | "room_booked"
  | "other";

export type SeriesFundingType = "membership" | "package" | "manual_other";

/** The authoritative, validated series definition (what both RPCs receive). */
export type SeriesDefinition = {
  title: string;
  description: string | null;
  instructorId: string | null;
  roomId: string | null;
  locationName: string | null;
  rosterCapacity: number | null;
  weekdays: number[];
  intervalWeeks: number;
  startsOn: string; // YYYY-MM-DD
  endsOn: string | null; // YYYY-MM-DD
  occurrenceCount: number | null;
  localStartTime: string; // HH:MM:SS
  durationMinutes: number;
  skipIndices: number[];
  clientRequestId: string;
  publiclyDiscoverable: boolean;
  selfEnrollmentAllowed: boolean;
  acceptedFundingTypes: SeriesFundingType[] | null;
};

export type ParsedSeriesInput =
  | { ok: true; value: SeriesDefinition }
  | { ok: false; code: SeriesErrorCode };

/** A generated occurrence as returned by preview_group_class_series. */
export type PreviewRpcRow = {
  occurrence_index: number;
  local_date: string;
  starts_at: string;
  ends_at: string;
  instructor_id: string | null;
  room_id: string | null;
  location_name: string | null;
  roster_capacity: number | null;
  dst_note: string | null;
};

export type SeriesConflict = {
  category: SeriesConflictCategory;
  message: string;
};

/** Safe, UI-facing occurrence (no internal ids, no other people's data). */
export type SeriesPreviewOccurrence = {
  index: number;
  localDate: string;
  startsAt: string;
  endsAt: string;
  dstNote: SeriesDstNote | null;
  conflict: SeriesConflict | null;
};

// ----------------------------------------------------------------------------
// Safe copy
// ----------------------------------------------------------------------------

export const SERIES_ERROR_MESSAGES: Record<SeriesErrorCode, string> = {
  unauthorized: "Only an owner, admin, or front desk can create a recurring class.",
  invalid_input: "Some of the class details are missing or invalid. Check the form and try again.",
  invalid_recurrence:
    "Check the schedule: choose at least one weekday, a valid start, and either a number of classes or an end date within two years.",
  invalid_timezone: "The studio time zone is not set up correctly. Contact support.",
  invalid_definition: "Some of the class details are not valid. Check the title and capacity.",
  instructor_unassignable: "That instructor is not available for assignment.",
  room_invalid: "That room is not available for this studio.",
  occurrence_cap_exceeded: `A series can have at most ${SERIES_MAX_OCCURRENCES} classes.`,
  invalid_skip: "One of the skipped dates is not part of this schedule.",
  no_occurrences: "Every class in this series was skipped. Keep at least one class.",
  policy_invalid: "The enrollment options are not valid.",
  idempotency_conflict: "This series was already created or changed. Refresh before trying again.",
  conflict: "Some classes conflict with existing bookings. Resolve or skip them to continue.",
  conflict_check_failed: "We couldn't check the schedule for conflicts. Please try again.",
  unknown: "Something went wrong creating the series. Please try again.",
};

export function seriesError(code: SeriesErrorCode) {
  return { code, error: SERIES_ERROR_MESSAGES[code] };
}

const RPC_CODE_MAP: Record<string, SeriesErrorCode> = {
  GCSB1_UNAUTHORIZED: "unauthorized",
  GCSB1_INVALID_RECURRENCE: "invalid_recurrence",
  GCSB1_INVALID_TIMEZONE: "invalid_timezone",
  GCSB1_INVALID_DEFINITION: "invalid_definition",
  GCSB1_INSTRUCTOR_UNASSIGNABLE: "instructor_unassignable",
  GCSB1_ROOM_INVALID: "room_invalid",
  GCSB1_OCCURRENCE_CAP_EXCEEDED: "occurrence_cap_exceeded",
  GCSB1_INVALID_SKIP: "invalid_skip",
  GCSB1_NO_OCCURRENCES: "no_occurrences",
  GCSB1_POLICY_INVALID: "policy_invalid",
  GCSB1_IDEMPOTENCY_CONFLICT: "idempotency_conflict",
};

/**
 * Maps a PostgREST/RPC error to a stable code from the GCSB1_* machine prefix
 * in the database message. The message text itself is never returned to the
 * user: anything without a recognized prefix is "unknown".
 */
export function mapSeriesRpcError(error: { message?: string | null } | null | undefined): SeriesErrorCode {
  // GC-S1E-3: the database's own conflict refusal (a conflict committed after the app's check).
  if (String(error?.message ?? "").includes("GCSE3_CONFLICT")) return "conflict";
  const match = /GCSB1_[A-Z_]+/.exec(String(error?.message ?? ""));
  return (match && RPC_CODE_MAP[match[0]]) || "unknown";
}

// ----------------------------------------------------------------------------
// Conflict mapping (existing detectAppointmentConflicts messages -> safe output)
// ----------------------------------------------------------------------------

// These literals are the exact messages src/lib/schedule/conflicts.ts returns
// today (a test asserts they still exist there, so drift is caught). Mapping
// them keeps B2 on the one canonical engine without a second conflict system.
const ENGINE_MESSAGE_CATEGORY: Record<string, SeriesConflictCategory> = {
  "That instructor is already booked during this time.": "instructor_overlap",
  "That instructor has a schedule block during this time.": "instructor_block",
  "That room is unavailable during this time.": "room_unavailable",
  "That room is already booked during this time.": "room_booked",
};

export const SERIES_CONFLICT_COPY: Record<SeriesConflictCategory, string> = {
  instructor_overlap: "The instructor is already booked at this time.",
  instructor_block: "The instructor has a schedule block at this time.",
  room_unavailable: "The room is unavailable at this time.",
  room_booked: "The room is already booked at this time.",
  other: "This time conflicts with an existing booking.",
};

export function toSafeConflict(engineMessage: string | null | undefined): SeriesConflict {
  const category = ENGINE_MESSAGE_CATEGORY[String(engineMessage ?? "")] ?? "other";
  return { category, message: SERIES_CONFLICT_COPY[category] };
}

// GC-S1E-3: reason codes of the database conflict rule (_gcse3_schedule_conflict) -> the same categories.
const DB_CONFLICT_REASON_CATEGORY: Record<string, SeriesConflictCategory> = {
  instructor: "instructor_overlap",
  instructor_block: "instructor_block",
  room_unavailable: "room_unavailable",
  room_busy: "room_booked",
};

/**
 * Maps the database's authoritative conflict refusal ("GCSE3_CONFLICT: reason=<code> ...") to safe
 * copy, or null for any other error. Only the reason code is read; no database text is shown.
 */
export function mapGroupClassConflictDbError(message: string | null | undefined): SeriesConflict | null {
  const text = String(message ?? "");
  if (!text.includes("GCSE3_CONFLICT")) return null;
  const reason = /GCSE3_CONFLICT: reason=(\w+)/.exec(text)?.[1] ?? "";
  const category = DB_CONFLICT_REASON_CATEGORY[reason] ?? "other";
  return { category, message: SERIES_CONFLICT_COPY[category] };
}

/**
 * Proposed occurrences must not overlap each other. B1's bounds (duration at
 * most 12 hours, one class per calendar date) make this impossible, but the
 * check is cheap and keeps the guarantee explicit rather than assumed.
 */
export function findInternalOverlaps(rows: { index: number; startsAt: string; endsAt: string }[]): number[] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const overlapping = new Set<number>();
  for (let i = 1; i < sorted.length; i += 1) {
    if (Date.parse(sorted[i].startsAt) < Date.parse(sorted[i - 1].endsAt)) {
      overlapping.add(sorted[i - 1].index);
      overlapping.add(sorted[i].index);
    }
  }
  return [...overlapping].sort((a, b) => a - b);
}

/** Runs async work over items with a concurrency cap, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const current = next;
      next += 1;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ----------------------------------------------------------------------------
// Input parsing
// ----------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [h, m, s] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (h > 23 || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

function toHms(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function parseInteger(value: string): number | null {
  return /^-?\d+$/.test(value) ? Number(value) : null;
}

function text(values: FormData | Record<string, string | string[] | undefined>, key: string) {
  if (values instanceof FormData) return String(values.get(key) ?? "").trim();
  const raw = values[key];
  return (Array.isArray(raw) ? raw[0] : raw ?? "").toString().trim();
}

function list(values: FormData | Record<string, string | string[] | undefined>, key: string): string[] {
  const raw = values instanceof FormData ? values.getAll(key).map(String) : [values[key] ?? []].flat();
  return raw
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function flag(values: FormData | Record<string, string | string[] | undefined>, key: string) {
  return ["on", "true", "1", "yes"].includes(text(values, key).toLowerCase());
}

const ALLOWED_FUNDING_TYPES: SeriesFundingType[] = ["membership", "package", "manual_other"];

/**
 * Parses and validates the submitted series definition. The studio is NEVER
 * read from the input: the caller supplies it from the authenticated context.
 * direct_payment (and its amount) are deliberately not accepted here (Phase 7).
 */
export function parseSeriesInput(values: FormData | Record<string, string | string[] | undefined>): ParsedSeriesInput {
  const title = text(values, "title");
  if (!title || title.length > MAX_TITLE_LENGTH) return { ok: false, code: "invalid_input" };

  const description = text(values, "description");
  if (description.length > MAX_DESCRIPTION_LENGTH) return { ok: false, code: "invalid_input" };

  const locationName = text(values, "locationName");
  if (locationName.length > MAX_LOCATION_LENGTH) return { ok: false, code: "invalid_input" };

  const instructorId = text(values, "instructorId");
  const roomId = text(values, "roomId");
  if ((instructorId && !UUID_PATTERN.test(instructorId)) || (roomId && !UUID_PATTERN.test(roomId))) {
    return { ok: false, code: "invalid_input" };
  }

  const clientRequestId = text(values, "clientRequestId");
  if (!UUID_PATTERN.test(clientRequestId)) return { ok: false, code: "invalid_input" };

  let rosterCapacity: number | null = null;
  const capacityRaw = text(values, "rosterCapacity");
  if (capacityRaw) {
    const parsed = parseInteger(capacityRaw);
    if (parsed === null || parsed < 1 || parsed > MAX_CAPACITY) return { ok: false, code: "invalid_input" };
    rosterCapacity = parsed;
  }

  const weekdays = [...new Set(list(values, "weekdays").map((w) => parseInteger(w)))];
  if (weekdays.length === 0 || weekdays.some((w) => w === null || w < 1 || w > 7)) {
    return { ok: false, code: "invalid_recurrence" };
  }

  const intervalRaw = text(values, "intervalWeeks") || "1";
  const intervalWeeks = parseInteger(intervalRaw);
  if (intervalWeeks === null || intervalWeeks < 1 || intervalWeeks > 52) {
    return { ok: false, code: "invalid_recurrence" };
  }

  const startsOn = text(values, "startsOn");
  if (!isValidDate(startsOn)) return { ok: false, code: "invalid_recurrence" };

  const endMode = text(values, "endMode");
  let endsOn: string | null = null;
  let occurrenceCount: number | null = null;
  if (endMode === "count") {
    const count = parseInteger(text(values, "occurrenceCount"));
    if (count === null || count < 1) return { ok: false, code: "invalid_recurrence" };
    if (count > SERIES_MAX_OCCURRENCES) return { ok: false, code: "occurrence_cap_exceeded" };
    occurrenceCount = count;
  } else if (endMode === "date") {
    const endsOnRaw = text(values, "endsOn");
    if (!isValidDate(endsOnRaw) || endsOnRaw < startsOn) return { ok: false, code: "invalid_recurrence" };
    endsOn = endsOnRaw;
  } else {
    return { ok: false, code: "invalid_recurrence" };
  }

  const startSeconds = parseTime(text(values, "startTime"));
  if (startSeconds === null) return { ok: false, code: "invalid_recurrence" };

  let durationMinutes: number | null = null;
  const durationRaw = text(values, "durationMinutes");
  const endTimeRaw = text(values, "endTime");
  if (durationRaw) {
    durationMinutes = parseInteger(durationRaw);
  } else if (endTimeRaw) {
    const endSeconds = parseTime(endTimeRaw);
    if (endSeconds !== null && endSeconds > startSeconds) {
      durationMinutes = Math.round((endSeconds - startSeconds) / 60);
    }
  }
  if (durationMinutes === null || durationMinutes < 5 || durationMinutes > 720) {
    return { ok: false, code: "invalid_recurrence" };
  }

  const skipValues = list(values, "skipIndices").map((s) => parseInteger(s));
  if (skipValues.some((s) => s === null || s < 1 || s > SERIES_MAX_OCCURRENCES)) {
    return { ok: false, code: "invalid_skip" };
  }
  const skipIndices = [...new Set(skipValues as number[])].sort((a, b) => a - b);

  const fundingRaw = list(values, "acceptedFundingTypes");
  if (fundingRaw.some((f) => !ALLOWED_FUNDING_TYPES.includes(f as SeriesFundingType))) {
    return { ok: false, code: "policy_invalid" };
  }
  const acceptedFundingTypes = fundingRaw.length
    ? ([...new Set(fundingRaw)] as SeriesFundingType[])
    : null;
  const publiclyDiscoverable = flag(values, "publiclyDiscoverable");
  const selfEnrollmentAllowed = flag(values, "selfEnrollmentAllowed");
  if ((publiclyDiscoverable || selfEnrollmentAllowed) && !acceptedFundingTypes) {
    return { ok: false, code: "policy_invalid" };
  }

  return {
    ok: true,
    value: {
      title,
      description: description || null,
      instructorId: instructorId || null,
      roomId: roomId || null,
      locationName: locationName || null,
      rosterCapacity,
      weekdays: (weekdays as number[]).sort((a, b) => a - b),
      intervalWeeks,
      startsOn,
      endsOn,
      occurrenceCount,
      localStartTime: toHms(startSeconds),
      durationMinutes,
      skipIndices,
      clientRequestId: clientRequestId.toLowerCase(),
      publiclyDiscoverable,
      selfEnrollmentAllowed,
      acceptedFundingTypes,
    },
  };
}

// ----------------------------------------------------------------------------
// RPC argument builders (the studio id comes from the caller's server context)
// ----------------------------------------------------------------------------

export function buildPreviewRpcArgs(studioId: string, def: SeriesDefinition) {
  return {
    p_studio_id: studioId,
    p_title: def.title,
    p_instructor_id: def.instructorId,
    p_room_id: def.roomId,
    p_location_name: def.locationName,
    p_roster_capacity: def.rosterCapacity,
    p_weekdays: def.weekdays,
    p_interval_weeks: def.intervalWeeks,
    p_starts_on: def.startsOn,
    p_ends_on: def.endsOn,
    p_occurrence_count: def.occurrenceCount,
    p_local_start_time: def.localStartTime,
    p_duration_minutes: def.durationMinutes,
  };
}

export function buildCreateRpcArgs(studioId: string, def: SeriesDefinition) {
  return {
    p_studio_id: studioId,
    p_client_request_id: def.clientRequestId,
    p_title: def.title,
    p_description: def.description,
    p_instructor_id: def.instructorId,
    p_room_id: def.roomId,
    p_location_name: def.locationName,
    p_roster_capacity: def.rosterCapacity,
    p_weekdays: def.weekdays,
    p_interval_weeks: def.intervalWeeks,
    p_starts_on: def.startsOn,
    p_ends_on: def.endsOn,
    p_occurrence_count: def.occurrenceCount,
    p_local_start_time: def.localStartTime,
    p_duration_minutes: def.durationMinutes,
    p_skip_indices: def.skipIndices,
    p_publicly_discoverable: def.publiclyDiscoverable,
    p_self_enrollment_allowed: def.selfEnrollmentAllowed,
    p_accepted_funding_types: def.acceptedFundingTypes,
    // Phase 7 owns direct payment: never accepted or sent from this layer.
    p_direct_payment_amount: null,
  };
}

export function toDstNote(value: string | null | undefined): SeriesDstNote | null {
  return value === "nonexistent_adjusted" || value === "ambiguous_later_selected" ? value : null;
}
