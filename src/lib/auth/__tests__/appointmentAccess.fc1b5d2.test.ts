import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D2 D2A: unit tests for the shared appointment relationship
 * authorization primitive (requireAppointmentRelationshipAccess). This is
 * the single choke point every mutation action in
 * src/app/app/schedule/actions.ts now calls -- proving it here in
 * isolation is more precise than only testing it indirectly through every
 * action, and every action-level test can then trust its behavior.
 *
 * Blocking-review correction: the primitive no longer branches on a single
 * studioRole string to pick between the teaching relationship and the
 * floor-rental relationship. Both are now resolved independently for every
 * non-broad caller, and "same-studio hybrid" (Section 3 of the independent
 * review) is proven below with actual resolver calls against two distinct
 * appointment rows for the SAME userId/studioId, not comments asserting how
 * production would behave.
 */

vi.mock("@/lib/auth/instructorIdentity", () => ({
  resolveViewerInstructorId: (...args: unknown[]) =>
    resolveViewerInstructorIdMock(...args),
}));

const resolveViewerInstructorIdMock = vi.fn();

const { requireAppointmentRelationshipAccess } = await import(
  "../appointmentAccess"
);

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const APPOINTMENT_ID = "appt-1";
const OWN_INSTRUCTOR_ID = "instructor-own";
const OTHER_INSTRUCTOR_ID = "instructor-other";
const CLIENT_ID = "client-1";

beforeEach(() => {
  resolveViewerInstructorIdMock.mockReset();
  resolveViewerInstructorIdMock.mockResolvedValue(null);
});

/**
 * Supports both a single constant appointment (matches any requested id --
 * the shape most tests below use) and a multi-row map keyed by appointment
 * id (needed for the same-studio hybrid tests, which resolve TWO distinct
 * appointment rows through the same mock supabase instance). Floor-rental
 * ownership is keyed by `${clientId}:${userId}` so multiple distinct
 * renters can be modeled in one mock for the hybrid/cross-renter tests.
 */
function makeSupabase(options: {
  appointment?: Record<string, unknown> | null;
  appointments?: Record<string, Record<string, unknown> | null>;
  clientAccountLink?: { id: string } | null;
  clientAccountLinksByClientAndUser?: Record<string, { id: string } | null>;
}) {
  return {
    from(table: string) {
      if (table === "appointments") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              eq: () => ({
                single: () => {
                  const row = options.appointments
                    ? (options.appointments[id] ?? null)
                    : (options.appointment ?? null);
                  return Promise.resolve(
                    row
                      ? { data: row, error: null }
                      : { data: null, error: new Error("not found") },
                  );
                },
              }),
            }),
          }),
        };
      }
      if (table === "client_account_links") {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, clientId: string) => ({
                eq: (_col2: string, userId: string) => ({
                  eq: () => ({
                    maybeSingle: () => {
                      const link = options.clientAccountLinksByClientAndUser
                        ? (options.clientAccountLinksByClientAndUser[
                            `${clientId}:${userId}`
                          ] ?? null)
                        : (options.clientAccountLink ?? null);
                      return Promise.resolve({ data: link, error: null });
                    },
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

describe("requireAppointmentRelationshipAccess -- FC-1B5D2 D2A", () => {
  it("broad roles (studio_owner) get full access regardless of instructor_id", async () => {
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "studio_owner",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope).toBe("broad");
    }
  });

  it("studio_admin gets full access regardless of instructor_id (explicit broad allow-list)", async () => {
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "studio_admin",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope).toBe("broad");
    }
  });

  it("front_desk gets full access regardless of instructor_id", async () => {
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "front_desk",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
  });

  it("platform_admin bypasses relationship checks even with no studio role", async () => {
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: null,
      isPlatformAdmin: true,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
  });

  it("default deny: an unrecognized/organizer role cannot obtain broad appointment authority merely by reaching the primitive", async () => {
    // Not platform_admin, not in the explicit BROAD_OPERATIONAL_ROLES
    // allow-list, and has no teaching or floor-rental relationship to this
    // appointment. The old implicit "everything else -> broad" fallback
    // would have granted this; the corrected primitive must deny it.
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const organizerResult = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "organizer_owner",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(organizerResult.ok).toBe(false);

    const unknownRoleResult = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "some_future_role_nobody_reviewed",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(unknownRoleResult.ok).toBe(false);

    const nullRoleResult = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: null,
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(nullRoleResult.ok).toBe(false);
  });

  it("instructor is allowed for their own currently-assigned appointment", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(OWN_INSTRUCTOR_ID);
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OWN_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope).toBe("own-instructor");
    }
  });

  it("instructor is denied for a colleague's appointment", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(OWN_INSTRUCTOR_ID);
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("instructor with no resolved instructors row is denied (never treated as broad)", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(null);
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("reassignment: authority follows the CURRENT instructor_id, not a historical one", async () => {
    resolveViewerInstructorIdMock.mockResolvedValue(OWN_INSTRUCTOR_ID);

    // Appointment now assigned to a different instructor -- even though
    // this caller may have been the original instructor, they are denied.
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("independent_instructor is allowed for their own linked floor-rental appointment", async () => {
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        appointment_type: "floor_space_rental",
      },
      clientAccountLink: { id: "link-1" },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope).toBe("own-floor-rental");
    }
  });

  it("independent_instructor is denied for a host (non-floor-rental) appointment", async () => {
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: OTHER_INSTRUCTOR_ID,
        appointment_type: "private_lesson",
      },
      clientAccountLink: { id: "link-1" },
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("independent_instructor is denied for a floor-rental appointment that isn't their own linked client", async () => {
    const supabase = makeSupabase({
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        appointment_type: "floor_space_rental",
      },
      clientAccountLink: null,
    });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("returns ok:false when the appointment does not exist", async () => {
    const supabase = makeSupabase({ appointment: null });

    const result = await requireAppointmentRelationshipAccess({
      supabase: supabase as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: USER_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });
});

describe("same-studio hybrid instructor (FC-1B5D2 D2A blocking-review correction)", () => {
  // One authenticated person, ONE studio, who is BOTH a host-assigned
  // teaching instructor (an `instructors` row resolvable via
  // resolveViewerInstructorId) AND an independent floor-rental renter (a
  // `client_account_links` row) -- WITHOUT any second user_studio_roles
  // row and WITHOUT the primitive ever being told which "role" they are.
  // Every call below passes the SAME userId/studioId; only the target
  // appointmentId (and, where noted, the caller's incidental studioRole)
  // differs, proving the two relationships are resolved independently
  // through actual resolver calls -- not asserted in a comment.
  const HYBRID_USER_ID = "hybrid-user-1";
  const HYBRID_INSTRUCTOR_ID = "hybrid-instructor-identity";
  const OTHER_RENTER_CLIENT_ID = "other-renter-client";
  const HYBRID_CLIENT_ID = "hybrid-own-client";

  const HOST_APPOINTMENT_ID = "appt-host-lesson";
  const OWN_RENTAL_APPOINTMENT_ID = "appt-own-floor-rental";
  const COLLEAGUE_APPOINTMENT_ID = "appt-colleague-lesson";
  const OTHER_RENTER_APPOINTMENT_ID = "appt-other-renter-floor-rental";

  function hybridSupabase() {
    return makeSupabase({
      appointments: {
        [HOST_APPOINTMENT_ID]: {
          id: HOST_APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          instructor_id: HYBRID_INSTRUCTOR_ID,
          appointment_type: "private_lesson",
        },
        [OWN_RENTAL_APPOINTMENT_ID]: {
          id: OWN_RENTAL_APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: HYBRID_CLIENT_ID,
          instructor_id: null,
          appointment_type: "floor_space_rental",
        },
        [COLLEAGUE_APPOINTMENT_ID]: {
          id: COLLEAGUE_APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          instructor_id: OTHER_INSTRUCTOR_ID,
          appointment_type: "private_lesson",
        },
        [OTHER_RENTER_APPOINTMENT_ID]: {
          id: OTHER_RENTER_APPOINTMENT_ID,
          studio_id: STUDIO_ID,
          client_id: OTHER_RENTER_CLIENT_ID,
          instructor_id: null,
          appointment_type: "floor_space_rental",
        },
      },
      clientAccountLinksByClientAndUser: {
        // Only the hybrid person's OWN floor-rental client is linked to
        // their user id -- the other renter's client is deliberately not
        // linked to anyone in this fixture.
        [`${HYBRID_CLIENT_ID}:${HYBRID_USER_ID}`]: { id: "hybrid-link-1" },
      },
    });
  }

  beforeEach(() => {
    // The hybrid person's resolved teaching identity is stable across all
    // calls in this block -- it comes from the `instructors` table, not
    // from whatever studioRole happens to be passed in.
    resolveViewerInstructorIdMock.mockImplementation(
      async (_supabase, _studioId, userId: string) =>
        userId === HYBRID_USER_ID ? HYBRID_INSTRUCTOR_ID : null,
    );
  });

  it("1. can manage their host-assigned appointment via the teaching relationship", async () => {
    const result = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: HOST_APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scope).toBe("own-instructor");
  });

  it("2. independently manages their own floor-rental appointment via the client-link relationship -- even called with studioRole still 'instructor'", async () => {
    // This is the crux of the correction: the SAME single studioRole value
    // ("instructor" -- there is only ever one user_studio_roles row) must
    // not prevent the floor-rental relationship from being honored for a
    // DIFFERENT appointment that genuinely belongs to this person via
    // client_account_links.
    const result = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: OWN_RENTAL_APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scope).toBe("own-floor-rental");
  });

  it("2b. also independently manages their own floor-rental appointment when called with studioRole 'independent_instructor'", async () => {
    // Same appointment, same person, the other single-role value the app
    // could plausibly have on file for them -- must resolve identically.
    const result = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: OWN_RENTAL_APPOINTMENT_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scope).toBe("own-floor-rental");
  });

  it("3. cannot manage another instructor's host appointment", async () => {
    const result = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: COLLEAGUE_APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("4. cannot manage another renter's floor-rental appointment", async () => {
    const result = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: OTHER_RENTER_APPOINTMENT_ID,
    });

    expect(result.ok).toBe(false);
  });

  it("5. possession of the teaching relationship does not broaden the floor-rental relationship, and vice versa", async () => {
    // Holding a valid own-instructor relationship for the host appointment
    // must not leak into authorizing an unrelated renter's floor-rental
    // appointment for the same hybrid caller...
    const teachingDoesNotBroadenFloorRental =
      await requireAppointmentRelationshipAccess({
        supabase: hybridSupabase() as never,
        studioId: STUDIO_ID,
        studioRole: "instructor",
        isPlatformAdmin: false,
        userId: HYBRID_USER_ID,
        appointmentId: OTHER_RENTER_APPOINTMENT_ID,
      });

    expect(teachingDoesNotBroadenFloorRental.ok).toBe(false);

    // ...and holding a valid own-floor-rental relationship must not leak
    // into authorizing a colleague's host-assigned lesson.
    const floorRentalDoesNotBroadenTeaching =
      await requireAppointmentRelationshipAccess({
        supabase: hybridSupabase() as never,
        studioId: STUDIO_ID,
        studioRole: "independent_instructor",
        isPlatformAdmin: false,
        userId: HYBRID_USER_ID,
        appointmentId: COLLEAGUE_APPOINTMENT_ID,
      });

    expect(floorRentalDoesNotBroadenTeaching.ok).toBe(false);
  });

  it("6. neither relationship produces general/broad studio appointment authority", async () => {
    // Both of the hybrid person's own appointments authorize with a
    // specific, narrow scope -- never "broad" -- proving neither
    // relationship is silently treated as studio-wide authority.
    const ownHostResult = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: HOST_APPOINTMENT_ID,
    });
    const ownRentalResult = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: OWN_RENTAL_APPOINTMENT_ID,
    });

    expect(ownHostResult.ok && ownHostResult.scope).not.toBe("broad");
    expect(ownRentalResult.ok && ownRentalResult.scope).not.toBe("broad");

    // And neither appointment (a colleague's lesson, another renter's
    // booking) becomes reachable for this hybrid caller merely because
    // they hold SOME relationship at this studio.
    const colleagueResult = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: COLLEAGUE_APPOINTMENT_ID,
    });
    const otherRenterResult = await requireAppointmentRelationshipAccess({
      supabase: hybridSupabase() as never,
      studioId: STUDIO_ID,
      studioRole: "independent_instructor",
      isPlatformAdmin: false,
      userId: HYBRID_USER_ID,
      appointmentId: OTHER_RENTER_APPOINTMENT_ID,
    });

    expect(colleagueResult.ok).toBe(false);
    expect(otherRenterResult.ok).toBe(false);
  });
});
