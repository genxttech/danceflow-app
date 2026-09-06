import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D2 D2A (blocking-review correction): unit tests for the shared
 * booking-request relationship-authorization primitive
 * (requireBookingRequestRelationshipAccess). Mirrors
 * appointmentAccess.fc1b5d2.test.ts's structure -- proving this in
 * isolation lets every action-level test (approve/decline/status-update/
 * staff-note) trust its behavior rather than re-deriving it.
 */

vi.mock("@/lib/auth/instructorIdentity", () => ({
  resolveViewerInstructorId: (...args: unknown[]) =>
    resolveViewerInstructorIdMock(...args),
}));

const resolveViewerInstructorIdMock = vi.fn();

const { requireBookingRequestRelationshipAccess } = await import(
  "../bookingRequestAccess"
);

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const OWN_INSTRUCTOR_ID = "instructor-own";
const OTHER_INSTRUCTOR_ID = "instructor-other";
const supabase = {} as never;

beforeEach(() => {
  resolveViewerInstructorIdMock.mockReset();
  resolveViewerInstructorIdMock.mockResolvedValue(null);
});

describe("requireBookingRequestRelationshipAccess -- FC-1B5D2 D2A", () => {
  it("studio_owner gets broad triage regardless of assignment", async () => {
    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "studio_owner",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: OTHER_INSTRUCTOR_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scope).toBe("broad");
  });

  it("studio_admin gets broad triage regardless of assignment", async () => {
    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "studio_admin",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: null,
    });

    expect(result.ok).toBe(true);
  });

  it("front_desk gets broad triage regardless of assignment", async () => {
    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "front_desk",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: OTHER_INSTRUCTOR_ID,
    });

    expect(result.ok).toBe(true);
  });

  it("platform_admin gets broad triage even with no studio role", async () => {
    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: null,
      isPlatformAdmin: true,
      userId: USER_ID,
      requestInstructorId: OTHER_INSTRUCTOR_ID,
    });

    expect(result.ok).toBe(true);
  });

  it("instructor can act on a request assigned to their own resolved instructor identity", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(OWN_INSTRUCTOR_ID);

    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: OWN_INSTRUCTOR_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scope).toBe("own-instructor");
  });

  it("instructor is denied for a colleague's assigned request", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(OWN_INSTRUCTOR_ID);

    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: OTHER_INSTRUCTOR_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("instructor is denied for an unassigned new-booking request -- no claiming workflow", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(OWN_INSTRUCTOR_ID);

    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: null,
    });

    expect(result.ok).toBe(false);
    // resolveViewerInstructorId should never even be called for an
    // unassigned request -- there is nothing for it to match against, and
    // this proves no claiming workflow is silently exercised.
    expect(resolveViewerInstructorIdMock).not.toHaveBeenCalled();
  });

  it("instructor with no resolved instructor identity is denied (never treated as broad)", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(null);

    const result = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: OWN_INSTRUCTOR_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("default deny: an unrecognized/organizer role cannot obtain broad triage authority merely by reaching the primitive", async () => {
    const organizerResult = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "organizer_owner",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: OTHER_INSTRUCTOR_ID,
    });

    expect(organizerResult.ok).toBe(false);

    const unknownRoleResult = await requireBookingRequestRelationshipAccess({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "some_future_role_nobody_reviewed",
      isPlatformAdmin: false,
      userId: USER_ID,
      requestInstructorId: null,
    });

    expect(unknownRoleResult.ok).toBe(false);
  });
});
