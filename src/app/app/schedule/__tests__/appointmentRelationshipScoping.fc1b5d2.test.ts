import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D2 D2A: action-level authorization tests proving every appointment
 * mutation now requires relationship authorization (own-instructor /
 * own-floor-rental / broad-role) before any mutation, financial side
 * effect, or deduction -- not merely role-level eligibility.
 *
 * requireAppointmentRelationshipAccess itself is unit-tested in
 * src/lib/auth/__tests__/appointmentAccess.fc1b5d2.test.ts; here it is
 * mocked so each action's own behavior (call the check, react correctly to
 * allow/deny, never reach mutation on deny) can be proven in isolation
 * with call-tracking, matching this codebase's established pattern.
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
  createAdminClient: () => ({
    from: () => {
      throw new Error("UNEXPECTED admin client from() call in this test");
    },
  }),
}));

vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi.fn().mockResolvedValue({ completedPackageIds: [] }),
}));

vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }),
}));

vi.mock("@/lib/utils/recurrence", () => ({
  generateWeeklyOccurrenceDates: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/compensation/earnings", () => ({
  stageInstructorEarningForAppointment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/memberships/entitlements", () => ({
  validateMembershipEntitlement: vi.fn().mockResolvedValue({ ok: true, membershipId: null }),
}));

vi.mock("@/lib/packages/entitlement", () => ({
  validateClientPackageForBooking: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/security/uploads", () => ({
  VIDEO_UPLOAD_MIME_TYPES: ["video/mp4"],
  safeOriginalFileName: (name: string) => name,
  validateUploadFile: vi.fn().mockReturnValue({ ok: true }),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();
const requireAttendanceAccessMock = vi.fn();
const requireAppointmentEditAccessMock = vi.fn();
const requireAppointmentDeleteAccessMock = vi.fn();
const requireAppointmentPaymentAccessMock = vi.fn();
const requireAppointmentCreateAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...args: unknown[]) =>
    requireFloorRentalAppointmentAccessMock(...args),
  requireAttendanceAccess: (...args: unknown[]) => requireAttendanceAccessMock(...args),
  requireAppointmentEditAccess: (...args: unknown[]) => requireAppointmentEditAccessMock(...args),
  requireAppointmentDeleteAccess: (...args: unknown[]) => requireAppointmentDeleteAccessMock(...args),
  requireAppointmentPaymentAccess: (...args: unknown[]) => requireAppointmentPaymentAccessMock(...args),
  requireAppointmentCreateAccess: (...args: unknown[]) => requireAppointmentCreateAccessMock(...args),
}));

const resolveViewerInstructorIdMock = vi.fn();
vi.mock("@/lib/auth/instructorIdentity", () => ({
  resolveViewerInstructorId: (...args: unknown[]) => resolveViewerInstructorIdMock(...args),
}));

const requireAppointmentRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...args: unknown[]) =>
    requireAppointmentRelationshipAccessMock(...args),
}));

const requireBookingRequestRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/bookingRequestAccess", () => ({
  requireBookingRequestRelationshipAccess: (...args: unknown[]) =>
    requireBookingRequestRelationshipAccessMock(...args),
}));

const fromCalls: string[] = [];

function benignChain() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.update = self;
  chain.insert = () => Promise.resolve({ data: null, error: null });
  chain.delete = self;
  chain.eq = self;
  chain.neq = self;
  chain.in = self;
  chain.gte = self;
  chain.lt = self;
  chain.order = self;
  chain.limit = self;
  chain.single = () => Promise.resolve({ data: null, error: new Error("not found") });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve({ data: [], error: null, count: 0 }).then(onFulfilled, onRejected);
  return chain;
}

function createFakeSupabase() {
  return {
    from(table: string) {
      fromCalls.push(table);
      return benignChain();
    },
  };
}

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const APPOINTMENT_ID = "appt-1";

function baseCtx(studioRole: string) {
  return {
    supabase: createFakeSupabase(),
    studioId: STUDIO_ID,
    user: { id: USER_ID },
    studioRole,
    isPlatformAdmin: false,
  };
}

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

const actions = await import("@/app/app/schedule/actions");

beforeEach(() => {
  fromCalls.length = 0;
  requireFloorRentalAppointmentAccessMock.mockReset();
  requireAttendanceAccessMock.mockReset();
  requireAppointmentEditAccessMock.mockReset();
  requireAppointmentDeleteAccessMock.mockReset();
  requireAppointmentPaymentAccessMock.mockReset();
  requireAppointmentCreateAccessMock.mockReset();
  resolveViewerInstructorIdMock.mockReset();
  requireAppointmentRelationshipAccessMock.mockReset();
  requireBookingRequestRelationshipAccessMock.mockReset();
});

describe("createAppointmentAction -- instructor self-lock (FC-1B5D2 D2A)", () => {
  it("locks the created appointment's instructor to the caller's own resolved instructors.id, ignoring a submitted colleague id -- proven against the actual INSERT payload", async () => {
    const ctx = baseCtx("instructor");
    requireFloorRentalAppointmentAccessMock.mockResolvedValue(ctx);
    resolveViewerInstructorIdMock.mockResolvedValue("instructor-own");

    // Unlike the shared benignChain() (whose insert() returns a bare
    // resolved value, not a chainable/thenable object -- incompatible with
    // this action's real `.insert({...}).select("id").single()` shape), this
    // tracking fake actually captures the INSERT payload and lets the
    // action reach its success path, so the malicious id's exclusion is
    // proven against real mutation data, not merely inferred from a helper
    // call.
    const insertedAppointments: Record<string, unknown>[] = [];
    const trackingSupabase = {
      from(table: string) {
        fromCalls.push(table);
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
    ctx.supabase = trackingSupabase as never;

    const formData = formDataFor({
      clientId: "client-1",
      appointmentType: "private_lesson",
      instructorId: "instructor-COLLEAGUE-malicious",
      date: "2026-01-01",
      startTime: "10:00",
      endTime: "11:00",
    });

    await run(actions.createAppointmentAction({ error: "" }, formData));

    expect(resolveViewerInstructorIdMock).toHaveBeenCalledWith(
      ctx.supabase,
      STUDIO_ID,
      USER_ID,
    );
    expect(insertedAppointments).toHaveLength(1);
    expect(insertedAppointments[0]).toMatchObject({
      instructor_id: "instructor-own",
    });
    expect(insertedAppointments[0].instructor_id).not.toBe(
      "instructor-COLLEAGUE-malicious",
    );
  });

  it("returns an error rather than creating an appointment when the instructor has no resolved instructors row", async () => {
    const ctx = baseCtx("instructor");
    requireFloorRentalAppointmentAccessMock.mockResolvedValue(ctx);
    resolveViewerInstructorIdMock.mockResolvedValue(null);

    const formData = formDataFor({
      clientId: "client-1",
      appointmentType: "private_lesson",
      startsAt: "2026-01-01T10:00:00.000Z",
      endsAt: "2026-01-01T11:00:00.000Z",
    });

    const result = await actions.createAppointmentAction({ error: "" }, formData);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(fromCalls).not.toContain("appointments");
  });

  it("owner/admin/front_desk retain free instructor assignment (self-lock does not run)", async () => {
    const ctx = baseCtx("studio_owner");
    requireFloorRentalAppointmentAccessMock.mockResolvedValue(ctx);

    const formData = formDataFor({
      clientId: "client-1",
      appointmentType: "private_lesson",
      instructorId: "instructor-any",
      startsAt: "2026-01-01T10:00:00.000Z",
      endsAt: "2026-01-01T11:00:00.000Z",
    });

    await run(actions.createAppointmentAction({ error: "" }, formData));

    expect(resolveViewerInstructorIdMock).not.toHaveBeenCalled();
  });
});

describe("updateAppointmentAction -- relationship authorization (FC-1B5D2 D2A)", () => {
  it("denied colleague update never reaches the mutation", async () => {
    const ctx = baseCtx("instructor");
    requireFloorRentalAppointmentAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "You can only manage appointments assigned to you.",
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      clientId: "client-1",
      appointmentType: "private_lesson",
      startsAt: "2026-01-01T10:00:00.000Z",
      endsAt: "2026-01-01T11:00:00.000Z",
    });

    const result = await actions.updateAppointmentAction({ error: "" }, formData);

    expect(result).toMatchObject({ error: expect.any(String) });
    // getStudioTimeZone's own "studios" lookup is harmless (no
    // appointment/client data) and runs before authorization purely for
    // date-parsing setup -- the security-relevant assertion is that
    // "appointments" itself was never queried/mutated.
    expect(fromCalls).not.toContain("appointments");
  });

  it("allowed own-appointment update proceeds to the mutation", async () => {
    const ctx = baseCtx("instructor");
    requireFloorRentalAppointmentAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: "client-1",
        instructor_id: "instructor-own",
        appointment_type: "private_lesson",
        recurrence_series_id: null,
        starts_at: "2026-01-01T09:00:00.000Z",
        ends_at: "2026-01-01T10:00:00.000Z",
        status: "scheduled",
        payment_status: "unpaid",
      },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      clientId: "client-1",
      appointmentType: "private_lesson",
      startsAt: "2026-01-01T10:00:00.000Z",
      endsAt: "2026-01-01T11:00:00.000Z",
    });

    await run(actions.updateAppointmentAction({ error: "" }, formData));

    expect(fromCalls.length).toBeGreaterThan(0);
  });
});

describe("cancelAppointmentAction -- relationship authorization (FC-1B5D2 D2A)", () => {
  it("denied colleague cancel never reaches the status mutation or missed-charge logic", async () => {
    const ctx = baseCtx("instructor");
    requireFloorRentalAppointmentAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "denied",
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      cancellationReason: "no longer needed",
      cancellationRequestedBy: "client",
    });

    await run(actions.cancelAppointmentAction(formData));

    expect(fromCalls).toEqual([]);
  });
});

describe("deleteAppointmentAction -- administrative-only, no relationship path (FC-1B5D2 D2A)", () => {
  it("instructor is denied before any appointment query, even for their own appointment", async () => {
    requireAppointmentDeleteAccessMock.mockRejectedValue(
      new Error("You do not have permission to delete appointments."),
    );

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      confirmDeleteAppointment: "DELETE",
    });

    await run(actions.deleteAppointmentAction(formData));

    expect(fromCalls).toEqual([]);
    // Confirms delete never consults the relationship primitive at all --
    // ownership is never a path to delete authority.
    expect(requireAppointmentRelationshipAccessMock).not.toHaveBeenCalled();
  });

  it("front_desk (legitimate mistake-correction) reaches the appointment lookup", async () => {
    requireAppointmentDeleteAccessMock.mockResolvedValue({
      supabase: createFakeSupabase(),
      studioId: STUDIO_ID,
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      confirmDeleteAppointment: "DELETE",
    });

    await run(actions.deleteAppointmentAction(formData));

    expect(fromCalls.length).toBeGreaterThan(0);
  });

  it("owner/admin delete access preserved (guard resolves, reaches lookup)", async () => {
    requireAppointmentDeleteAccessMock.mockResolvedValue({
      supabase: createFakeSupabase(),
      studioId: STUDIO_ID,
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      confirmDeleteAppointment: "DELETE",
    });

    await run(actions.deleteAppointmentAction(formData));

    expect(fromCalls.length).toBeGreaterThan(0);
  });
});

describe("markAppointmentAttendedAction / markAppointmentNoShowAction -- authorization before deductions (FC-1B5D2 D2A)", () => {
  it("attend: denied colleague appointment never reaches package/membership deduction or pay staging", async () => {
    const ctx = baseCtx("instructor");
    requireAttendanceAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "denied",
    });

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID });

    await run(actions.markAppointmentAttendedAction(formData));

    expect(fromCalls).toEqual([]);
  });

  it("attend: own appointment proceeds to the status mutation", async () => {
    const ctx = baseCtx("instructor");
    requireAttendanceAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: "client-1",
        instructor_id: "instructor-own",
        appointment_type: "private_lesson",
        starts_at: "2026-01-01T09:00:00.000Z",
        client_package_id: null,
        client_membership_id: null,
        price_amount: 0,
        payment_status: "paid",
        billing_type: "free_comped",
        status: "scheduled",
      },
    });

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID });

    await run(actions.markAppointmentAttendedAction(formData));

    expect(fromCalls.length).toBeGreaterThan(0);
  });

  it("no-show: denied colleague appointment never reaches the mutation or missed-charge logic", async () => {
    const ctx = baseCtx("instructor");
    requireAttendanceAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "denied",
    });

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID });

    await run(actions.markAppointmentNoShowAction(formData));

    expect(fromCalls).toEqual([]);
  });
});

describe("bulkMarkDailyAppointmentsAttendedAction -- instructor query scoping (FC-1B5D2 D2A)", () => {
  it("instructor: query is filtered to their own resolved instructor_id", async () => {
    const ctx = baseCtx("instructor");
    requireAttendanceAccessMock.mockResolvedValue(ctx);
    resolveViewerInstructorIdMock.mockResolvedValue("instructor-own");

    // FC-1B5D2 D2A (blocking-review correction): eq() calls are captured
    // PER TABLE (not into one cross-table array) so the assertion below can
    // be bound specifically to the "appointments" query chain -- proving
    // the production bulk-attendance query itself carries the
    // instructor_id filter, rather than merely proving SOME eq("instructor_id", ...)
    // call happened somewhere in the action's run (which could, in
    // principle, have come from an unrelated table).
    const capturedEqCallsByTable: Record<string, [string, unknown][]> = {};
    const trackingSupabase = {
      from(table: string) {
        fromCalls.push(table);
        const eqCallsForTable = (capturedEqCallsByTable[table] ??= []);
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = self;
        chain.eq = (col: string, val: unknown) => {
          eqCallsForTable.push([col, val]);
          return chain;
        };
        chain.gte = self;
        chain.lt = self;
        chain.in = self;
        // NOTE: order() must stay chainable (not resolve immediately) --
        // bulkMarkDailyAppointmentsAttendedAction conditionally calls
        // .eq("instructor_id", ...) AFTER .order(...) for instructor
        // callers, so the query builder needs to still be a chain object
        // at that point, not a bare Promise. It resolves via .then, like
        // the real Supabase query builder (and benignChain() above).
        chain.order = self;
        chain.then = (
          onFulfilled: (v: unknown) => unknown,
          onRejected?: (r: unknown) => unknown,
        ) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        chain.single = () =>
          Promise.resolve({ data: { timezone: "America/New_York" }, error: null });
        chain.maybeSingle = () =>
          Promise.resolve({ data: { timezone: "America/New_York" }, error: null });
        return chain;
      },
    };
    ctx.supabase = trackingSupabase as never;

    const formData = formDataFor({ date: "2026-01-01" });

    await run(actions.bulkMarkDailyAppointmentsAttendedAction(formData));

    expect(
      (capturedEqCallsByTable.appointments ?? []).some(
        ([col, val]) => col === "instructor_id" && val === "instructor-own",
      ),
    ).toBe(true);
  });

  it("owner/admin/front_desk: query remains studio-wide (no instructor_id filter)", async () => {
    const ctx = baseCtx("studio_owner");
    requireAttendanceAccessMock.mockResolvedValue(ctx);

    // FC-1B5D2 D2A (blocking-review correction): eq() calls are captured
    // PER TABLE (not into one cross-table array) so the assertion below can
    // be bound specifically to the "appointments" query chain -- proving
    // the production bulk-attendance query itself carries the
    // instructor_id filter, rather than merely proving SOME eq("instructor_id", ...)
    // call happened somewhere in the action's run (which could, in
    // principle, have come from an unrelated table).
    const capturedEqCallsByTable: Record<string, [string, unknown][]> = {};
    const trackingSupabase = {
      from(table: string) {
        fromCalls.push(table);
        const eqCallsForTable = (capturedEqCallsByTable[table] ??= []);
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = self;
        chain.eq = (col: string, val: unknown) => {
          eqCallsForTable.push([col, val]);
          return chain;
        };
        chain.gte = self;
        chain.lt = self;
        chain.in = self;
        // NOTE: order() must stay chainable (not resolve immediately) --
        // bulkMarkDailyAppointmentsAttendedAction conditionally calls
        // .eq("instructor_id", ...) AFTER .order(...) for instructor
        // callers, so the query builder needs to still be a chain object
        // at that point, not a bare Promise. It resolves via .then, like
        // the real Supabase query builder (and benignChain() above).
        chain.order = self;
        chain.then = (
          onFulfilled: (v: unknown) => unknown,
          onRejected?: (r: unknown) => unknown,
        ) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        chain.single = () =>
          Promise.resolve({ data: { timezone: "America/New_York" }, error: null });
        chain.maybeSingle = () =>
          Promise.resolve({ data: { timezone: "America/New_York" }, error: null });
        return chain;
      },
    };
    ctx.supabase = trackingSupabase as never;

    const formData = formDataFor({ date: "2026-01-01" });

    await run(actions.bulkMarkDailyAppointmentsAttendedAction(formData));

    expect(
      (capturedEqCallsByTable.appointments ?? []).some(
        ([col]) => col === "instructor_id",
      ),
    ).toBe(false);
    expect(resolveViewerInstructorIdMock).not.toHaveBeenCalled();
  });
});

describe("recap actions -- relationship authorization (FC-1B5D2 D2A)", () => {
  it("upsertLessonRecapAction: denied colleague appointment never reaches the recap table", async () => {
    const ctx = baseCtx("instructor");
    requireAppointmentEditAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "denied",
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      summary: "great class",
    });

    const result = await actions.upsertLessonRecapAction({ error: "" }, formData);

    expect(result).toMatchObject({ error: expect.any(String) });
    // getStudioTimeZone's own "studios" lookup is harmless and runs before
    // authorization -- the security-relevant assertion is that no recap
    // table was ever reached.
    expect(fromCalls).not.toContain("lesson_recaps");
    expect(fromCalls).not.toContain("appointments");
  });

  it("upsertLessonRecapAction: own appointment proceeds to recap read/write", async () => {
    const ctx = baseCtx("instructor");
    requireAppointmentEditAccessMock.mockResolvedValue(ctx);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: "client-1",
        instructor_id: "instructor-own",
        appointment_type: "private_lesson",
        status: "attended",
      },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      summary: "great class",
    });

    await run(actions.upsertLessonRecapAction({ error: "" }, formData));

    expect(fromCalls.length).toBeGreaterThan(0);
  });
});

describe("financial appointment actions -- separate payment authority (FC-1B5D2 D2A)", () => {
  it("recordPayAsYouGoLessonPaymentAction: instructor is denied before the guard even resolves (role-only, not appointment-edit)", async () => {
    requireAppointmentPaymentAccessMock.mockRejectedValue(
      new Error("You do not have permission to manage appointment payments."),
    );

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      clientId: "client-1",
      amount: "50",
    });

    await run(actions.recordPayAsYouGoLessonPaymentAction(formData));

    expect(fromCalls).toEqual([]);
  });

  it("recordPayAsYouGoLessonPaymentAction: front_desk reaches the appointment lookup", async () => {
    requireAppointmentPaymentAccessMock.mockResolvedValue({
      supabase: createFakeSupabase(),
      studioId: STUDIO_ID,
      user: { id: USER_ID },
    });

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      clientId: "client-1",
      amount: "50",
    });

    await run(actions.recordPayAsYouGoLessonPaymentAction(formData));

    expect(fromCalls.length).toBeGreaterThan(0);
  });

  it("recordFloorRentalPaymentAction: instructor is denied via the shared payment guard", async () => {
    requireAppointmentPaymentAccessMock.mockRejectedValue(
      new Error("You do not have permission to manage appointment payments."),
    );

    const formData = formDataFor({
      appointmentId: APPOINTMENT_ID,
      clientId: "client-1",
      amount: "25",
    });

    await run(actions.recordFloorRentalPaymentAction(formData));

    expect(fromCalls).toEqual([]);
  });

  it("markFloorRentalWaivedAction: instructor is denied via the shared payment guard", async () => {
    requireAppointmentPaymentAccessMock.mockRejectedValue(
      new Error("You do not have permission to manage appointment payments."),
    );

    const formData = formDataFor({ appointmentId: APPOINTMENT_ID });

    await run(actions.markFloorRentalWaivedAction(formData));

    expect(fromCalls).toEqual([]);
  });
});

describe("updateBookingRequestStatusAction / addBookingRequestStaffNoteAction -- booking-request relationship scoping (FC-1B5D2 D2A)", () => {
  const REQUEST_ID = "req-1";
  const OWN_INSTRUCTOR_ID = "instructor-own";

  function trackingBookingRequestSupabase(request: Record<string, unknown> | null) {
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
                      request ? { data: request, error: null } : { data: null, error: null },
                    ),
                }),
              }),
            }),
            update: (payload: Record<string, unknown>) => {
              bookingRequestUpdates.push(payload);
              return {
                eq: () => ({
                  eq: () => Promise.resolve({ error: null }),
                }),
              };
            },
          };
        }
        return benignChain();
      },
    };
    return { supabase, bookingRequestUpdates };
  }

  it("updateBookingRequestStatusAction: denied colleague request never reaches the status mutation", async () => {
    const { supabase, bookingRequestUpdates } = trackingBookingRequestSupabase({
      id: REQUEST_ID,
      client_id: "client-1",
      status: "pending",
      instructor_id: "instructor-other",
    });
    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "instructor",
      isPlatformAdmin: false,
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "You can only act on booking requests assigned to you.",
    });

    const formData = formDataFor({ requestId: REQUEST_ID, status: "in_review" });

    await run(actions.updateBookingRequestStatusAction(formData));

    expect(bookingRequestUpdates).toHaveLength(0);
    expect(fromCalls).not.toContain("lead_activities");
  });

  it("updateBookingRequestStatusAction: own assigned request proceeds to the status mutation", async () => {
    const { supabase, bookingRequestUpdates } = trackingBookingRequestSupabase({
      id: REQUEST_ID,
      client_id: "client-1",
      status: "pending",
      instructor_id: OWN_INSTRUCTOR_ID,
    });
    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "instructor",
      isPlatformAdmin: false,
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
    });

    const formData = formDataFor({ requestId: REQUEST_ID, status: "in_review" });

    await run(actions.updateBookingRequestStatusAction(formData));

    expect(bookingRequestUpdates).toHaveLength(1);
    expect(bookingRequestUpdates[0]).toMatchObject({ status: "in_review" });
  });

  it("updateBookingRequestStatusAction: owner/admin/front_desk studio-wide triage preserved", async () => {
    const { supabase, bookingRequestUpdates } = trackingBookingRequestSupabase({
      id: REQUEST_ID,
      client_id: "client-1",
      status: "pending",
      instructor_id: "instructor-other",
    });
    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "front_desk",
      isPlatformAdmin: false,
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "broad",
    });

    const formData = formDataFor({ requestId: REQUEST_ID, status: "declined" });

    await run(actions.updateBookingRequestStatusAction(formData));

    expect(bookingRequestUpdates).toHaveLength(1);
  });

  it("addBookingRequestStaffNoteAction: denied colleague request never reaches the note mutation", async () => {
    const { supabase, bookingRequestUpdates } = trackingBookingRequestSupabase({
      id: REQUEST_ID,
      client_id: "client-1",
      instructor_id: "instructor-other",
    });
    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "instructor",
      isPlatformAdmin: false,
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "You can only act on booking requests assigned to you.",
    });

    const formData = formDataFor({ requestId: REQUEST_ID, staffNote: "hello" });

    await run(actions.addBookingRequestStaffNoteAction(formData));

    expect(bookingRequestUpdates).toHaveLength(0);
  });

  it("addBookingRequestStaffNoteAction: own assigned request proceeds to the note mutation", async () => {
    const { supabase, bookingRequestUpdates } = trackingBookingRequestSupabase({
      id: REQUEST_ID,
      client_id: "client-1",
      instructor_id: OWN_INSTRUCTOR_ID,
    });
    requireAppointmentEditAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "instructor",
      isPlatformAdmin: false,
    });
    requireBookingRequestRelationshipAccessMock.mockResolvedValue({
      ok: true,
      scope: "own-instructor",
    });

    const formData = formDataFor({ requestId: REQUEST_ID, staffNote: "hello" });

    await run(actions.addBookingRequestStaffNoteAction(formData));

    expect(bookingRequestUpdates).toHaveLength(1);
  });
});
