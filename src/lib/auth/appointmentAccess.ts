import type { requireAppointmentEditAccess } from "@/lib/auth/serverRoleGuard";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";

// FC-1B5D2 D2A (corrected per independent review): the single shared
// appointment relationship-authorization primitive. This is deliberately
// separate from the role-level canX guards in serverRoleGuard.ts -- those
// answer "may this caller perform this KIND of appointment operation at
// all" (e.g. canEditAppointments), while this answers "may this caller
// perform it on THIS PARTICULAR appointment". Every mutation/read that
// previously fetched an appointment by id+studio_id alone (with no
// instructor_id check) should call this instead, right after its existing
// role-level guard resolves.
//
// Correction: the original version of this primitive branched on a single
// `studioRole` string to pick between an "instructor" relationship check
// and an "independent_instructor" relationship check, treating them as
// mutually exclusive. That cannot represent a genuine same-studio hybrid
// person -- someone who is both a host-assigned teaching instructor AND an
// independent floor-rental renter at the same studio. user_studio_roles
// only ever stores one role per (studio_id, user_id) (see
// settings/team/actions.ts's upsert onConflict + the invite-accept RPC's
// on-conflict overwrite), so a hybrid person's *identity* -- their
// instructors-table row and their client_account_links row -- can exist
// independently of whatever single studioRole they currently carry.
// Hybrid is a combination of relationships, not a role: this primitive now
// resolves the caller's teaching relationship (via resolveViewerInstructorId)
// and their floor-rental relationship (via client_account_links)
// independently of studioRole, for every non-broad caller, and grants
// access if either matches the target appointment. Neither relationship
// implies the other, and neither implies broad (studio-wide) access.
//
// Deliberately returns a discriminated result rather than throwing or
// redirecting -- this codebase's appointment actions use two different
// error-handling conventions (some return `{ error }` for useActionState,
// others call redirect(getErrorRedirect(...))), and this primitive must
// not force either one. Callers adapt `ok: false` into whichever
// convention that action already uses.

type SupabaseServerClient = Awaited<
  ReturnType<typeof requireAppointmentEditAccess>
>["supabase"];

type AppointmentRelationshipRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  instructor_id: string | null;
  appointment_type: string;
};

export type AppointmentAuthorityScope =
  | "broad"
  | "own-instructor"
  | "own-floor-rental";

export type AppointmentAuthorityResult<Row extends AppointmentRelationshipRow> =
  | { ok: true; appointment: Row; scope: AppointmentAuthorityScope }
  | { ok: false; reason: string };

const MANDATORY_APPOINTMENT_FIELDS = [
  "id",
  "studio_id",
  "client_id",
  "instructor_id",
  "appointment_type",
];

function buildSelect(extraSelect: string | undefined): string {
  const requested = (extraSelect ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const additional = requested.filter(
    (field) => !MANDATORY_APPOINTMENT_FIELDS.includes(field),
  );
  return [...MANDATORY_APPOINTMENT_FIELDS, ...additional].join(", ");
}

// FC-1B5D2 D2A: explicit allow-list for studio-wide ("broad") appointment
// authority. Deliberately explicit rather than an implicit "everything
// else" fallback -- a new/unrecognized AppRole value (or a role from the
// unrelated organizer_* workspace family reaching this primitive through
// some future, differently-scoped guard) must default-deny, not silently
// inherit full access. platform_admin is checked separately via
// isPlatformAdmin, not included here.
const BROAD_OPERATIONAL_ROLES = new Set([
  "studio_owner",
  "studio_admin",
  "front_desk",
]);

// Resolves whether the caller's OWN teaching identity (their resolved
// instructors.id at this studio) is the appointment's CURRENT
// instructor_id. Independent of studioRole -- a hybrid person's
// instructors-table row exists regardless of which single role
// user_studio_roles currently has on file for them. Reassignment is
// transparent: this always checks the live, current instructor_id, never a
// historical one.
async function isOwnInstructorAppointment(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  userId: string;
  instructorId: string | null;
}): Promise<boolean> {
  const { supabase, studioId, userId, instructorId } = params;

  if (!instructorId) {
    return false;
  }

  const viewerInstructorId = await resolveViewerInstructorId(
    supabase,
    studioId,
    userId,
  );

  return Boolean(viewerInstructorId) && viewerInstructorId === instructorId;
}

// Mirrors the relationship check already established in
// src/app/app/schedule/actions.ts's requireOwnFloorRentalTarget --
// duplicated here (rather than imported) because that function lives in a
// "use server" actions file and this module needs to stay a plain,
// non-action library file. Keep both in sync if the floor-rental
// relationship model ever changes. Independent of studioRole -- a hybrid
// person's client_account_links row exists regardless of which single role
// user_studio_roles currently has on file for them.
async function isOwnFloorRentalAppointment(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  userId: string;
  clientId: string | null;
  appointmentType: string;
}): Promise<boolean> {
  const { supabase, studioId, userId, clientId, appointmentType } = params;

  if (appointmentType !== "floor_space_rental" || !clientId) {
    return false;
  }

  const { data: link, error } = await supabase
    .from("client_account_links")
    .select("id")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("user_id", userId)
    .eq("status", "linked")
    .maybeSingle();

  return !error && Boolean(link);
}

/**
 * Fetches the target appointment (mandatory relationship fields plus any
 * additional fields the caller needs) and determines whether the caller is
 * authorized for it. This is called after the caller's role-level canX
 * guard has already run (so "may this caller attempt this KIND of
 * operation at all" is already settled) -- this only answers "may they do
 * it to THIS appointment."
 *
 * Three facts are derived independently, not as mutually-exclusive
 * branches on a single studioRole:
 *
 * - broad: isPlatformAdmin, or studioRole is one of the explicit
 *   BROAD_OPERATIONAL_ROLES (studio_owner/studio_admin/front_desk).
 * - own-instructor: the caller has a resolved instructors.id at this
 *   studio that matches the appointment's CURRENT instructor_id.
 * - own-floor-rental: the appointment is a floor_space_rental whose client
 *   is linked (client_account_links, status "linked") to the caller.
 *
 * A single authenticated person can have BOTH the own-instructor and
 * own-floor-rental relationships true (for different appointment rows) at
 * the same studio -- this is the same-studio hybrid case. Possessing
 * either relationship never implies broad access, and never implies the
 * other relationship for an unrelated appointment. Anyone who is neither
 * broad nor matches either relationship for this specific row is denied --
 * there is no implicit fallback grant.
 */
export async function requireAppointmentRelationshipAccess<
  Row extends AppointmentRelationshipRow = AppointmentRelationshipRow,
>(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  studioRole: string | null | undefined;
  isPlatformAdmin: boolean;
  userId: string;
  appointmentId: string;
  select?: string;
}): Promise<AppointmentAuthorityResult<Row>> {
  const {
    supabase,
    studioId,
    studioRole,
    isPlatformAdmin,
    userId,
    appointmentId,
    select,
  } = params;

  const { data: appointment, error } = await supabase
    .from("appointments")
    .select(buildSelect(select))
    .eq("id", appointmentId)
    .eq("studio_id", studioId)
    .single();

  if (error || !appointment) {
    return { ok: false, reason: "Appointment not found." };
  }

  const row = appointment as unknown as Row;

  if (isPlatformAdmin || BROAD_OPERATIONAL_ROLES.has(studioRole ?? "")) {
    return { ok: true, appointment: row, scope: "broad" };
  }

  const [ownInstructorAppointment, ownFloorRentalAppointment] =
    await Promise.all([
      isOwnInstructorAppointment({
        supabase,
        studioId,
        userId,
        instructorId: row.instructor_id,
      }),
      isOwnFloorRentalAppointment({
        supabase,
        studioId,
        userId,
        clientId: row.client_id,
        appointmentType: row.appointment_type,
      }),
    ]);

  if (ownInstructorAppointment) {
    return { ok: true, appointment: row, scope: "own-instructor" };
  }

  if (ownFloorRentalAppointment) {
    return { ok: true, appointment: row, scope: "own-floor-rental" };
  }

  return {
    ok: false,
    reason:
      "You can only manage your own assigned appointments or your own floor space rental bookings.",
  };
}
