/**
 * GC-S1C-1: pure rules for editing one canonical group-class occurrence.
 *
 * Kept free of Supabase/Next so the decisions the server action makes
 * (capacity parsing and floor, whether a conflict recheck is needed, safe
 * owner-facing copy, plain-language override labels) are unit-testable.
 * Everything here is a server-side guardrail input: the action always
 * compares against the row it just loaded, never against what the client
 * claims changed.
 */

import { mapGroupClassConflictDbError } from "@/lib/schedule/groupClassSeries";

export type OccurrenceEditErrorCode =
  | "not_found"
  | "unauthorized"
  | "invalid_instructor"
  | "invalid_room"
  | "invalid_time"
  | "conflict"
  | "conflict_check_failed"
  | "capacity_invalid"
  | "capacity_below_booked"
  | "capacity_check_failed"
  | "generic";

export const OCCURRENCE_EDIT_ERROR_COPY: Record<
  Exclude<OccurrenceEditErrorCode, "conflict" | "capacity_below_booked">,
  string
> = {
  not_found: "We couldn't find this class.",
  unauthorized: "You do not have permission to edit this class.",
  invalid_instructor: "Choose an active instructor from this studio.",
  invalid_room: "Choose an active room from this studio.",
  invalid_time: "Date, start time, and end time are required, and the class must end after it starts.",
  conflict_check_failed: "We couldn't check the schedule for conflicts. Please try again.",
  capacity_invalid: "Maximum students must be a whole number of 1 or more, or left blank for no limit.",
  capacity_check_failed: "We couldn't check how many students are booked. Please try again.",
  generic: "Could not update the class. Please try again.",
};

export type CapacityParse =
  | { ok: true; present: false }
  | { ok: true; present: true; value: number | null }
  | { ok: false };

/** Upper bound is a sanity limit on the input, not a studio policy. */
const CAPACITY_MAX = 10000;

/**
 * Parse the optional capacity form value. A missing field means "leave the
 * capacity alone" (older callers); a blank field means "no limit" (null, the
 * existing canonical unlimited semantics); anything else must be a whole
 * number of at least 1.
 */
export function parseRosterCapacityInput(raw: FormDataEntryValue | null): CapacityParse {
  if (raw === null) return { ok: true, present: false };
  const text = String(raw).trim();
  if (text === "") return { ok: true, present: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > CAPACITY_MAX) return { ok: false };
  return { ok: true, present: true, value };
}

export function capacityBelowBookedMessage(booked: number): string {
  const students = booked === 1 ? "1 student" : `${booked} students`;
  return `This class already has ${students} booked. Capacity cannot be set below ${booked}.`;
}

/**
 * GC-S1C-3: the database's capacity floor (GCSC3_CAPACITY_BELOW_BOOKED, "... lower than the N students already booked")
 * mapped to the same owner-facing copy as the app-level check. Returns null for any other database error so the caller
 * keeps its generic message; raw database text is never shown.
 */
export function mapOccurrenceUpdateDbError(message: string | null | undefined): string | null {
  // GC-S1E-3: the database's own conflict refusal for the edited class.
  const conflict = mapGroupClassConflictDbError(message);
  if (conflict) return conflict.message;
  if (message?.includes("GCSE3_ROOM_INVALID")) return OCCURRENCE_EDIT_ERROR_COPY.invalid_room;
  if (!message || !message.includes("GCSC3_CAPACITY_BELOW_BOOKED")) return null;
  const match = /(\d+) students already booked/.exec(message);
  const booked = match ? Number(match[1]) : NaN;
  return Number.isFinite(booked) && booked > 0
    ? capacityBelowBookedMessage(booked)
    : "Capacity cannot be set below the number of students already booked.";
}

/** True when the new capacity would leave fewer seats than booked students. */
export function capacityBelowBooked(newCapacity: number | null, booked: number): boolean {
  return newCapacity !== null && newCapacity < booked;
}

export type EditableOccurrenceSnapshot = {
  instructor_id: string | null;
  room_id: string | null;
  starts_at: string;
  ends_at: string;
  roster_capacity?: number | null;
};

function sameInstant(a: string, b: string): boolean {
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return left === right;
}

/**
 * Conflict-sensitive fields are exactly instructor, room and the start/end
 * instants. Compared against the authoritative row loaded server-side.
 */
export function conflictSensitiveFieldsChanged(
  current: EditableOccurrenceSnapshot,
  next: { instructorId: string | null; roomId: string | null; startsAt: string; endsAt: string },
): boolean {
  return (
    (current.instructor_id ?? null) !== (next.instructorId ?? null) ||
    (current.room_id ?? null) !== (next.roomId ?? null) ||
    !sameInstant(current.starts_at, next.startsAt) ||
    !sameInstant(current.ends_at, next.endsAt)
  );
}

// ---------------------------------------------------------------------------
// Series context for the edit UI (plain language; never raw column values)
// ---------------------------------------------------------------------------

const OVERRIDE_LABELS: Record<string, string> = {
  title: "Title",
  instructor: "Instructor",
  room: "Room",
  location: "Location",
  capacity: "Maximum students",
  time: "Date and time",
};

/** Plain-language labels for the tracked overrides, in a stable order. */
export function describeOverriddenFields(fields: readonly string[] | null | undefined): string[] {
  const set = new Set(fields ?? []);
  return Object.keys(OVERRIDE_LABELS)
    .filter((key) => set.has(key))
    .map((key) => OVERRIDE_LABELS[key]);
}

export function seriesOccurrenceLabel(index: number | null | undefined): string | null {
  return typeof index === "number" && Number.isInteger(index) && index >= 1
    ? `Class ${index} in the series`
    : null;
}
