/**
 * GC-S1B B3: pure state model for the "Class series" creation form. No React,
 * no server imports: the component wires this to useReducer / useActionState,
 * and the tests drive it directly.
 *
 * Key rules encoded here:
 * - The request id is created ONCE in initSeriesFormState and no reducer action
 *   ever changes it (not edits, not skips, not a failed preview or create).
 * - Anything that defines the series changes definitionKey(); a preview is only
 *   "current" for the exact definition it was generated from, and skip choices
 *   (original occurrence indices) only apply to the definition they were made for.
 * - Creation is only available from a current preview with no unresolved
 *   conflicts. The server (B2) still regenerates and re-checks on create; this
 *   model never makes a stale preview look safe.
 */

import {
  SERIES_ERROR_MESSAGES,
  parseSeriesInput,
  type SeriesConflict,
  type SeriesDstNote,
  type SeriesErrorCode,
} from "@/lib/schedule/groupClassSeries";

// ----------------------------------------------------------------------------
// Form values
// ----------------------------------------------------------------------------

export type SeriesEndMode = "count" | "date";

export type SeriesFormValues = {
  title: string;
  description: string;
  startsOn: string;
  weekdays: number[]; // ISO 1 (Mon) .. 7 (Sun)
  startTime: string;
  durationMinutes: string;
  intervalWeeks: string;
  endMode: SeriesEndMode;
  occurrenceCount: string;
  endsOn: string;
  instructorId: string;
  roomId: string;
  locationName: string;
  rosterCapacity: string;
  // Enrollment options (progressively disclosed): packages, memberships and
  // (GC-3.5-1) direct payment with its USD price.
  allowSelfEnrollment: boolean;
  showToLinkedStudents: boolean;
  packageEnabled: boolean;
  membershipEnabled: boolean;
  directPaymentEnabled: boolean;
  directPaymentAmount: string;
};

export const SERIES_FORM_DEFAULTS: SeriesFormValues = {
  title: "",
  description: "",
  startsOn: "",
  weekdays: [],
  startTime: "18:00",
  durationMinutes: "60",
  intervalWeeks: "1",
  endMode: "count",
  occurrenceCount: "6",
  endsOn: "",
  instructorId: "",
  roomId: "",
  locationName: "",
  rosterCapacity: "",
  allowSelfEnrollment: false,
  showToLinkedStudents: false,
  packageEnabled: false,
  membershipEnabled: false,
  directPaymentEnabled: false,
  directPaymentAmount: "",
};

export const WEEKDAY_OPTIONS: { value: number; short: string; long: string }[] = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 7, short: "Sun", long: "Sunday" },
];

// ----------------------------------------------------------------------------
// State + reducer
// ----------------------------------------------------------------------------

export type SeriesFormState = {
  /** Created once for this form instance. Never changed by any action. */
  readonly requestId: string;
  values: SeriesFormValues;
  /** Skip choices are bound to the definition they were made for. */
  skip: { key: string; indices: number[] };
};

export type SeriesFormAction =
  | { type: "edit"; patch: Partial<SeriesFormValues> }
  | { type: "toggleWeekday"; day: number }
  | { type: "skip"; index: number }
  | { type: "restore"; index: number };

export function initSeriesFormState(
  newRequestId: () => string,
  initial: Partial<SeriesFormValues> = {},
): SeriesFormState {
  const values = { ...SERIES_FORM_DEFAULTS, ...initial };
  return { requestId: newRequestId(), values, skip: { key: definitionKey(values), indices: [] } };
}

/** Everything that defines the series (never the request id or the skip list). */
export function definitionKey(values: SeriesFormValues): string {
  return JSON.stringify({
    t: values.title.trim(),
    d: values.description.trim(),
    s: values.startsOn,
    w: [...values.weekdays].sort((a, b) => a - b),
    st: values.startTime,
    du: values.durationMinutes.trim(),
    i: values.intervalWeeks.trim(),
    m: values.endMode,
    n: values.endMode === "count" ? values.occurrenceCount.trim() : "",
    e: values.endMode === "date" ? values.endsOn : "",
    in: values.instructorId,
    r: values.roomId,
    l: values.locationName.trim(),
    c: values.rosterCapacity.trim(),
    se: values.allowSelfEnrollment,
    sh: values.showToLinkedStudents,
    p: values.packageEnabled,
    me: values.membershipEnabled,
    dp: values.directPaymentEnabled,
    da: values.directPaymentEnabled ? values.directPaymentAmount.trim() : "",
  });
}

export function effectiveSkipped(state: SeriesFormState): number[] {
  return state.skip.key === definitionKey(state.values) ? state.skip.indices : [];
}

export function seriesFormReducer(state: SeriesFormState, action: SeriesFormAction): SeriesFormState {
  switch (action.type) {
    case "edit":
      return { ...state, values: { ...state.values, ...action.patch } };
    case "toggleWeekday": {
      const has = state.values.weekdays.includes(action.day);
      const weekdays = has
        ? state.values.weekdays.filter((d) => d !== action.day)
        : [...state.values.weekdays, action.day].sort((a, b) => a - b);
      return { ...state, values: { ...state.values, weekdays } };
    }
    case "skip": {
      const current = effectiveSkipped(state);
      if (current.includes(action.index)) return state;
      return {
        ...state,
        skip: { key: definitionKey(state.values), indices: [...current, action.index].sort((a, b) => a - b) },
      };
    }
    case "restore": {
      const current = effectiveSkipped(state);
      return {
        ...state,
        skip: { key: definitionKey(state.values), indices: current.filter((i) => i !== action.index) },
      };
    }
    default:
      return state;
  }
}

// ----------------------------------------------------------------------------
// FormData for the B2 server actions (field names match parseSeriesInput)
// ----------------------------------------------------------------------------

/**
 * Builds the submission for the B2 preview/create actions. The studio is never
 * included (the server derives it), nor any payment field. The request id is the
 * form instance's single id.
 */
export function buildSeriesFormData(state: SeriesFormState): FormData {
  const { values } = state;
  const fd = new FormData();
  fd.set("clientRequestId", state.requestId);
  fd.set("title", values.title);
  fd.set("description", values.description);
  fd.set("instructorId", values.instructorId);
  fd.set("roomId", values.roomId);
  fd.set("locationName", values.locationName);
  fd.set("rosterCapacity", values.rosterCapacity);
  for (const day of values.weekdays) fd.append("weekdays", String(day));
  fd.set("intervalWeeks", values.intervalWeeks);
  fd.set("startsOn", values.startsOn);
  fd.set("startTime", values.startTime);
  fd.set("durationMinutes", values.durationMinutes);
  fd.set("endMode", values.endMode);
  if (values.endMode === "count") fd.set("occurrenceCount", values.occurrenceCount);
  else fd.set("endsOn", values.endsOn);
  for (const index of effectiveSkipped(state)) fd.append("skipIndices", String(index));

  const funding: string[] = [];
  if (values.packageEnabled) funding.push("package");
  if (values.membershipEnabled) funding.push("membership");
  if (values.directPaymentEnabled) funding.push("direct_payment");
  for (const type of funding) fd.append("acceptedFundingTypes", type);
  if (values.directPaymentEnabled) fd.set("directPaymentAmount", values.directPaymentAmount);
  if (values.showToLinkedStudents) fd.set("publiclyDiscoverable", "on");
  if (values.allowSelfEnrollment) fd.set("selfEnrollmentAllowed", "on");
  return fd;
}

export type DefinitionCheck = { ok: true } | { ok: false; code: SeriesErrorCode; message: string };

/** Client-side readiness, reusing the server's own parser (never a second rule set). */
export function checkDefinition(state: SeriesFormState): DefinitionCheck {
  const parsed = parseSeriesInput(buildSeriesFormData(state));
  if (parsed.ok) return { ok: true };
  return { ok: false, code: parsed.code, message: SERIES_ERROR_MESSAGES[parsed.code] };
}

// ----------------------------------------------------------------------------
// View model
// ----------------------------------------------------------------------------

export type PreviewOccurrenceInput = {
  index: number;
  localDate: string;
  startsAt: string;
  endsAt: string;
  dstNote: SeriesDstNote | null;
  conflict: SeriesConflict | null;
};

export type PreviewStateInput =
  | { status: "idle" }
  | { status: "preview"; occurrences: PreviewOccurrenceInput[] }
  | { status: "error"; code: string; error: string };

export type CreateStateInput =
  | { status: "idle" }
  | { status: "error"; code: string; error: string }
  | { status: "conflict"; error?: string; conflicts: { index: number; conflict: SeriesConflict }[] };

export type SeriesRow = {
  index: number;
  dateLabel: string;
  timeLabel: string;
  dstGuidance: string | null;
  conflict: SeriesConflict | null;
  skipped: boolean;
};

export type SeriesView = {
  previewCurrent: boolean;
  rows: SeriesRow[];
  unresolvedConflicts: number;
  createCount: number;
  canPreview: boolean;
  canCreate: boolean;
};

export function deriveSeriesView(params: {
  state: SeriesFormState;
  /** The latest preview result, tagged with the definition key it was SUBMITTED for. */
  previewResult: { key: string | null; state: PreviewStateInput };
  /** The latest create result, tagged with the definition key it was SUBMITTED for. */
  createResult: { key: string | null; state: CreateStateInput };
  pending: { preview: boolean; create: boolean };
  timeZone: string;
}): SeriesView {
  const { state, previewResult, createResult, pending, timeZone } = params;
  const previewState = previewResult.state;
  const createState = createResult.state;
  const key = definitionKey(state.values);
  // A result applies only to the exact definition it was submitted for (never inferred from current form state).
  const previewCurrent = previewState.status === "preview" && previewResult.key === key;
  const skipped = new Set(effectiveSkipped(state));

  // Conflicts reported by a create attempt for THIS definition take precedence: they are newer than the preview.
  const createConflicts = new Map<number, SeriesConflict>();
  if (createState.status === "conflict" && createResult.key === key) {
    for (const c of createState.conflicts) createConflicts.set(c.index, c.conflict);
  }

  const rows: SeriesRow[] = previewCurrent
    ? (previewState as { occurrences: PreviewOccurrenceInput[] }).occurrences.map((o) => ({
        index: o.index,
        dateLabel: formatOccurrenceDate(o.localDate),
        timeLabel: formatTimeRange(o.startsAt, o.endsAt, timeZone),
        dstGuidance: dstGuidance(o.dstNote),
        conflict: createConflicts.get(o.index) ?? o.conflict,
        skipped: skipped.has(o.index),
      }))
    : [];

  const unresolvedConflicts = rows.filter((r) => !r.skipped && r.conflict).length;
  const createCount = rows.filter((r) => !r.skipped).length;
  const idle = !pending.preview && !pending.create;

  return {
    previewCurrent,
    rows,
    unresolvedConflicts,
    createCount,
    canPreview: idle && checkDefinition(state).ok,
    canCreate: idle && previewCurrent && unresolvedConflicts === 0 && createCount > 0,
  };
}

// ----------------------------------------------------------------------------
// Presentation helpers (studio-local; never raw UTC)
// ----------------------------------------------------------------------------

/** "2027-01-12" -> "Tue, Jan 12" (calendar date only: no time zone math). */
export function formatOccurrenceDate(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return localDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

/** Start and end rendered in the studio's own time zone, e.g. "6:30 PM – 7:30 PM". */
export function formatTimeRange(startsAt: string, endsAt: string, timeZone: string): string {
  const format = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  return `${format(startsAt)} – ${format(endsAt)}`;
}

export function dstGuidance(note: SeriesDstNote | null | undefined): string | null {
  if (note === "nonexistent_adjusted") {
    return "Clocks move forward on this date, so your usual start time doesn't exist. The class starts at the adjusted time shown.";
  }
  if (note === "ambiguous_later_selected") {
    return "Clocks move back on this date, so your usual start time happens twice. The later one is used.";
  }
  return null;
}

export const CONFLICT_LABELS: Record<string, string> = {
  instructor_overlap: "Instructor conflict",
  instructor_block: "Instructor unavailable",
  room_unavailable: "Room unavailable",
  room_booked: "Room conflict",
  other: "Schedule conflict",
};
