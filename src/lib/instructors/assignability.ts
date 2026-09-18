import type { SupabaseClient } from "@supabase/supabase-js";

export const INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE =
  "This instructor is no longer available for assignment.";

/**
 * Canonical instructional-assignment predicate (Landmark 1A Slice 5):
 * same studio, active, can_instruct, and account-linked. Mirrors the DB
 * trigger enforcing the identical predicate on public.appointments --
 * the two must never diverge. A null instructorId is always valid here;
 * callers decide whether null itself is acceptable for their write path.
 *
 * The query never distinguishes *why* a candidate fails (nonexistent,
 * wrong studio, inactive, incapable, unlinked) -- every failure reason
 * collapses to the same generic result and the same generic message, so
 * this never leaks cross-studio existence or identity details.
 */
export async function validateAssignableInstructor(
  supabase: SupabaseClient,
  studioId: string,
  instructorId: string | null,
): Promise<string | null> {
  if (!instructorId) return null;

  const { data, error } = await supabase
    .from("instructors")
    .select("id")
    .eq("id", instructorId)
    .eq("studio_id", studioId)
    .eq("active", true)
    .eq("can_instruct", true)
    .not("user_id", "is", null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? null : INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE;
}

/**
 * Instructional appointment_type values where instructor_id represents a
 * genuine teaching/supervision assignment. Excludes floor_space_rental
 * (instructor_id there is the renter's own identity, not a teaching
 * assignment) and room_unavailable (never carries a real instructor).
 * Mirrors the DB trigger's type list exactly -- keep both in sync.
 */
export const INSTRUCTIONAL_APPOINTMENT_TYPES = [
  "private_lesson",
  "group_class",
  "intro_lesson",
  "coaching",
  "practice_party",
  "event",
] as const;

export type InstructionalAppointmentType =
  (typeof INSTRUCTIONAL_APPOINTMENT_TYPES)[number];

export function isInstructionalAppointmentType(
  appointmentType: string,
): appointmentType is InstructionalAppointmentType {
  return (INSTRUCTIONAL_APPOINTMENT_TYPES as readonly string[]).includes(
    appointmentType,
  );
}

/**
 * Determines whether the instructional-assignment relationship itself
 * changed between the persisted row and the submitted values -- the
 * exact condition under which revalidation is required (Slice 5 §4/§6).
 * An edit that leaves instructor_id, studio_id, and appointment_type all
 * unchanged must never revalidate, even against a since-deactivated
 * instructor -- mirrors the DB trigger's IS DISTINCT FROM guard exactly.
 */
export function assignmentRelationshipChanged(params: {
  previousInstructorId: string | null;
  previousStudioId: string;
  previousAppointmentType: string;
  nextInstructorId: string | null;
  nextStudioId: string;
  nextAppointmentType: string;
}): boolean {
  return (
    params.previousInstructorId !== params.nextInstructorId ||
    params.previousStudioId !== params.nextStudioId ||
    params.previousAppointmentType !== params.nextAppointmentType
  );
}
