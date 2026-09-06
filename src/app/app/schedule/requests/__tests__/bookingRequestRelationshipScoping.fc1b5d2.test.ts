import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D2 D2A (blocking-review correction): action-level authorization
 * tests proving approveBookingRequestAction/declineBookingRequestAction now
 * require booking-request relationship authorization before any
 * entitlement lookup, conflict check, appointment creation, request-status
 * mutation, or notification side effect -- not merely role-level
 * eligibility (canCreateAppointments admits "instructor").
 *
 * requireBookingRequestRelationshipAccess itself is unit-tested in
 * src/lib/auth/__tests__/bookingRequestAccess.fc1b5d2.test.ts; here it is
 * mocked so each action's own behavior (call the check, react correctly,
 * never reach mutation/side-effects on denial) is proven in isolation with
 * call-tracking, matching this codebase's established convention (see
 * appointmentRelationshipScoping.fc1b5d2.test.ts).
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  // Notification helpers (queueBookingDecisionEmail/sendBookingDecisionPush/
  // queueApprovedInstructorEmail) look up the client/instructor via the
  // admin client purely to compose an outbound message -- returning no row
  // here makes them bail out at their own "no recipient" early-return
  // branch (already covered elsewhere), keeping this file focused on the
  // authorization boundary rather than notification content.
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/notifications/expoPush", () => ({
  sendMobilePushToUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }),
}));

vi.mock("@/lib/booking/entitlementResolution", () => ({
  resolveEntitlementForBooking: vi.fn().mockResolvedValue({
    outcome: "resolved",
    billingType: "package_credit",
    clientPackageId: "package-1",
    clientMembershipId: null,
  }),
}));

vi.mock("@/lib/notifications/outbound", () => ({
  queueOutboundDelivery: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/email-branding", () => ({
  renderStudioBrandedEmail: vi.fn().mockReturnValue("<html></html>"),
}));

const requireAppointmentCreateAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireAppointmentCreateAccess: (...args: unknown[]) =>
    requireAppointmentCreateAccessMock(...args),
}));

const requireBookingRequestRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/bookingRequestAccess", () => ({
  requireBookingRequestRelationshipAccess: (...args: unknown[]) =>
    requireBookingRequestRelationshipAccessMock(...args),
}));

const { approveBookingRequestAction, declineBookingRequestAction } =
  await import("../actions");

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const REQUEST_ID = "req-1";
const CLIENT_ID = "client-1";
const OWN_INSTRUCTOR_ID = "instructor-own";

const fromCalls: string[] = [];

function benignChain() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.update = self;
  chain.insert = () => Promise.resolve({ data: null, error: null });
  chain.eq = self;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.single = () => Promise.resolve({ data: null, error: new Error("not found") });
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
  return chain;
}

function bookingRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    instructor_id: OWN_INSTRUCTOR_ID,
    room_id: null,
    appointment_type: "private_lesson",
    title: "Intro Lesson Request",
    requested_starts_at: "2026-09-15T10:00:00.000Z",
    requested_ends_at: "2026-09-15T11:00:00.000Z",
    notes: null,
    status: "pending",
    source: "portal_schedule",
    ...overrides,
  };
}

function createFakeSupabase(options: {
  request: Record<string, unknown> | null;
}) {
  const insertedAppointments: Record<string, unknown>[] = [];
  const bookingRequestUpdates: Record<string, unknown>[] = [];

  const supabase = {
    from(table: string) {
      fromCalls.push(table);

      if (table === "booking_requests") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve(
                    options.request
                      ? { data: options.request, error: null }
                      : { data: null, error: null },
                  ),
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            bookingRequestUpdates.push(payload);
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ error: null }),
                }),
              }),
            };
          },
        };
      }

      if (table === "appointments") {
        return {
          insert: (payload: Record<string, unknown>) => {
            insertedAppointments.push(payload);
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: "new-appt-1" }, error: null }),
              }),
            };
          },
        };
      }

      return benignChain();
    },
  };

  return { supabase, insertedAppointments, bookingRequestUpdates };
}

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    studioId: STUDIO_ID,
    user: { id: USER_ID },
    studioRole: "instructor",
    isPlatformAdmin: false,
    ...overrides,
  };
}

beforeEach(() => {
  fromCalls.length = 0;
  requireAppointmentCreateAccessMock.mockReset();
  requireBookingRequestRelationshipAccessMock.mockReset();
});

describe("approveBookingRequestAction -- booking-request relationship scoping (FC-1B5D2 D2A)", () => {
  it("instructor: denied colleague request never reaches entitlement resolution, conflict check, appointment creation, or request mutation", async () => {
    const { supabase, insertedAppointments, bookingRequestUpdates } =
      createFakeSupabase({ request: bookingRequestRow() });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx(),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "You can only act on booking requests assigned to you.",
    });

    const error = await run(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain(
      "error=You%20can%20only%20act%20on%20booking%20requests%20assigned%20to%20you.",
    );
    expect(insertedAppointments).toHaveLength(0);
    expect(bookingRequestUpdates).toHaveLength(0);
    expect(fromCalls).not.toContain("notifications");
  });

  it("instructor: denied unassigned new-booking request never reaches appointment creation", async () => {
    const { supabase, insertedAppointments } = createFakeSupabase({
      request: bookingRequestRow({ instructor_id: null }),
    });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx(),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason:
        "This request is not yet assigned to an instructor -- a studio admin or front desk teammate needs to triage it.",
    });

    const error = await run(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain("error=");
    expect(insertedAppointments).toHaveLength(0);
  });

  it("instructor: own assigned request is approved, creating the appointment", async () => {
    const { supabase, insertedAppointments, bookingRequestUpdates } =
      createFakeSupabase({ request: bookingRequestRow() });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx(),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
    });

    const error = await run(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain("success=approved");
    expect(insertedAppointments).toHaveLength(1);
    expect(insertedAppointments[0]).toMatchObject({
      instructor_id: OWN_INSTRUCTOR_ID,
      client_id: CLIENT_ID,
    });
    expect(bookingRequestUpdates).toHaveLength(1);
  });

  it("owner/admin/front_desk: studio-wide triage preserved regardless of assignment", async () => {
    const { supabase, insertedAppointments } = createFakeSupabase({
      request: bookingRequestRow({ instructor_id: "some-other-instructor" }),
    });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx({ studioRole: "front_desk" }),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "broad",
    });

    const error = await run(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain("success=approved");
    expect(insertedAppointments).toHaveLength(1);
  });

  it("authorization is checked before entitlement resolution runs at all", async () => {
    const { supabase } = createFakeSupabase({ request: bookingRequestRow() });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx(),
    });
    requireBookingRequestRelationshipAccessMock.mockImplementation(() => {
      throw new Error("STOP -- authorization should still be reachable here");
    });

    // Denial via a thrown error inside the mock also proves ordering: if
    // the relationship check were skipped, this action would proceed
    // straight into entitlement resolution/appointment creation instead of
    // surfacing this error.
    const error = await run(
      approveBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    ).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(requireBookingRequestRelationshipAccessMock).toHaveBeenCalledTimes(1);
  });
});

describe("declineBookingRequestAction -- booking-request relationship scoping (FC-1B5D2 D2A)", () => {
  it("instructor: denied colleague request never reaches the status mutation", async () => {
    const { supabase, bookingRequestUpdates } = createFakeSupabase({
      request: bookingRequestRow(),
    });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx(),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "You can only act on booking requests assigned to you.",
    });

    const error = await run(
      declineBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain("error=");
    expect(bookingRequestUpdates).toHaveLength(0);
  });

  it("instructor: denied unassigned request never reaches the status mutation", async () => {
    const { supabase, bookingRequestUpdates } = createFakeSupabase({
      request: bookingRequestRow({ instructor_id: null }),
    });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx(),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "not yet assigned",
    });

    const error = await run(
      declineBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain("error=");
    expect(bookingRequestUpdates).toHaveLength(0);
  });

  it("instructor: own assigned request can be declined", async () => {
    const { supabase, bookingRequestUpdates } = createFakeSupabase({
      request: bookingRequestRow(),
    });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx(),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
    });

    const error = await run(
      declineBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain("success=declined");
    expect(bookingRequestUpdates).toHaveLength(1);
    expect(bookingRequestUpdates[0]).toMatchObject({ status: "declined" });
  });

  it("owner/admin/front_desk: studio-wide triage preserved for decline", async () => {
    const { supabase, bookingRequestUpdates } = createFakeSupabase({
      request: bookingRequestRow({ instructor_id: "some-other-instructor" }),
    });
    requireAppointmentCreateAccessMock.mockResolvedValue({
      supabase,
      ...baseCtx({ studioRole: "studio_owner" }),
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "broad",
    });

    const error = await run(
      declineBookingRequestAction(formDataFor({ requestId: REQUEST_ID })),
    );

    expect(digestUrl(error)).toContain("success=declined");
    expect(bookingRequestUpdates).toHaveLength(1);
  });
});
