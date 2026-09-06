import type { requireAppointmentEditAccess } from "@/lib/auth/serverRoleGuard";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";

// FC-1B5D2 D2A (blocking-review correction): approve/decline/status-update/
// staff-note triage on a booking_requests row must be relationship-scoped
// the same way appointment mutations are in appointmentAccess.ts --
// owner/admin/front_desk (+platform_admin) retain studio-wide triage; an
// ordinary instructor may only act on a request explicitly assigned to
// their own resolved instructor identity (booking_requests.instructor_id).
// An UNASSIGNED request (instructor_id === null) is never
// instructor-actionable -- it stays in the owner/admin/front_desk
// operational queue; this deliberately does not invent an
// instructor-claiming workflow for it. Explicit allow-list, default deny --
// mirrors requireAppointmentRelationshipAccess's corrected design: broad
// authority is an explicit role allow-list, not an implicit fallback.
//
// Lives in a plain, non-"use server" library file (like
// appointmentAccess.ts) specifically so it can be imported from both
// src/app/app/schedule/requests/actions.ts and
// src/app/app/schedule/actions.ts -- both are "use server" action files,
// and a helper can't be usefully shared by exporting it from one of them.

type SupabaseServerClient = Awaited<
  ReturnType<typeof requireAppointmentEditAccess>
>["supabase"];

const BROAD_BOOKING_REQUEST_ROLES = new Set([
  "studio_owner",
  "studio_admin",
  "front_desk",
]);

export type BookingRequestAuthorityResult =
  | { ok: true; scope: "broad" | "own-instructor" }
  | { ok: false; reason: string };

export async function requireBookingRequestRelationshipAccess(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  studioRole: string | null | undefined;
  isPlatformAdmin: boolean;
  userId: string;
  requestInstructorId: string | null;
}): Promise<BookingRequestAuthorityResult> {
  const {
    supabase,
    studioId,
    studioRole,
    isPlatformAdmin,
    userId,
    requestInstructorId,
  } = params;

  if (isPlatformAdmin || BROAD_BOOKING_REQUEST_ROLES.has(studioRole ?? "")) {
    return { ok: true, scope: "broad" };
  }

  if (requestInstructorId) {
    const viewerInstructorId = await resolveViewerInstructorId(
      supabase,
      studioId,
      userId,
    );

    if (viewerInstructorId && viewerInstructorId === requestInstructorId) {
      return { ok: true, scope: "own-instructor" };
    }
  }

  return {
    ok: false,
    reason: requestInstructorId
      ? "You can only act on booking requests assigned to you."
      : "This request is not yet assigned to an instructor -- a studio admin or front desk teammate needs to triage it.",
  };
}
