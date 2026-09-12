import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Membership Usage-Period Alignment -- single-writer cutover regression.
 *
 * Proves that markAppointmentAttendedAction's membership-billing branch no
 * longer touches client_membership_usage via the old TypeScript path
 * (syncMembershipUsageForAppointment) at all for private_lesson/
 * intro_lesson/coaching appointments -- that responsibility now belongs
 * exclusively to the canonical DB trigger (sync_membership_usage_for_
 * private_lesson_appointment). The fake Supabase client below throws on
 * any access to client_membership_usage OR to any of the old path's
 * resolution tables (client_memberships/membership_plan_benefits/
 * client_membership_periods/studio_settings), so if the guard regresses
 * in either direction this test fails loudly rather than silently
 * passing.
 *
 * P6d/P6e correction (this file previously asserted the OPPOSITE of what
 * is now correct): syncMembershipUsageForAppointment used to call
 * clearMembershipUsageForAppointment (an unconditional, direct DELETE
 * against client_membership_usage) BEFORE checking the appointment type,
 * so every call for a private-lesson-family appointment still deleted
 * client_membership_usage once, even though the private-lesson early
 * return prevented the old path's reinsert logic from running. That
 * delete was a live bug, not intended behavior: it silently undid the
 * DB trigger's own, already-committed usage row moments after the same
 * status-changing UPDATE that triggered it -- confirmed by direct source
 * tracing during P6e's implementation, not merely inferred. The function
 * now checks the appointment type FIRST and returns immediately for
 * private_lesson/intro_lesson/coaching, before ever touching
 * client_membership_usage, so this test now asserts zero contact with
 * that table, not one delete call.
 *
 * Same faithful-mock convention as markAppointmentAttendedAction.test.ts --
 * drives the real action, fakes only the transport layer.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/compensation/earnings", () => ({
  stageInstructorEarningForAppointment: vi
    .fn()
    .mockResolvedValue({ staged: false, reason: "not_exercised_by_this_test" }),
}));

vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi
    .fn()
    .mockResolvedValue({ completedPackageIds: [] }),
}));

const requireAttendanceAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireAttendanceAccess: (...args: unknown[]) =>
    requireAttendanceAccessMock(...args),
  requireAppointmentEditAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
}));

const { markAppointmentAttendedAction } = await import(
  "@/app/app/schedule/actions"
);

type FakeResult = { data?: unknown; error?: { message: string } | null };

function makeChain(resolve: () => FakeResult | Promise<FakeResult>) {
  const chain: {
    eq: (...args: unknown[]) => typeof chain;
    in: (...args: unknown[]) => typeof chain;
    limit: (...args: unknown[]) => typeof chain;
    maybeSingle: () => Promise<FakeResult>;
    single: () => Promise<FakeResult>;
    then: (
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => unknown;
  } = {
    eq: () => chain,
    in: () => chain,
    limit: () => chain,
    async maybeSingle() {
      const result = await resolve();
      if (result.error) return { data: null, error: result.error };
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data
          ? [result.data]
          : [];
      return { data: rows[0] ?? null, error: null };
    },
    async single() {
      const result = await resolve();
      if (result.error) return { data: null, error: result.error };
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data
          ? [result.data]
          : [];
      if (!rows.length) return { data: null, error: { message: "Row not found" } };
      return { data: rows[0], error: null };
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

const APPOINTMENT_ID = "appt-mupa-1";
const STUDIO_ID = "studio-mupa-1";
const CLIENT_ID = "client-mupa-1";
const MEMBERSHIP_ID = "membership-mupa-1";

function membershipAppointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    client_id: CLIENT_ID,
    instructor_id: "instructor-mupa-1",
    appointment_type: "private_lesson",
    starts_at: new Date().toISOString(),
    client_package_id: null,
    client_membership_id: MEMBERSHIP_ID,
    price_amount: null,
    payment_status: "paid",
    billing_type: "membership",
    status: "attended",
    ...overrides,
  };
}

function createFakeSupabase(appointment: ReturnType<typeof membershipAppointmentRow>) {
  const state = {
    appointment: { ...appointment },
    appointmentUpdateCalls: [] as Record<string, unknown>[],
  };

  const supabase = {
    from(table: string) {
      if (table === "appointments") {
        return {
          select: () =>
            makeChain(() => ({ data: { ...state.appointment }, error: null })),
          update: (payload: Record<string, unknown>) => {
            state.appointmentUpdateCalls.push(payload);
            Object.assign(state.appointment, payload);
            return makeChain(() => ({ error: null }));
          },
        };
      }

      if (table === "client_membership_usage") {
        // P6d/P6e correction: this table must now never be touched at all
        // by the TS writer for a private_lesson/intro_lesson/coaching
        // appointment -- not even the old unconditional clear. Any access
        // here means the type-check-before-clear ordering has regressed.
        throw new Error(
          "Unexpected client_membership_usage access -- syncMembershipUsageForAppointment must return before touching this table for private_lesson/intro_lesson/coaching appointments; that responsibility belongs exclusively to the DB trigger.",
        );
      }

      throw new Error(
        `Unexpected table in fake action supabase: ${table} -- the single-writer cutover guard should have short-circuited before any of client_memberships/membership_plan_benefits/client_membership_periods/studio_settings was ever queried for a private_lesson/intro_lesson/coaching membership-billed appointment.`,
      );
    },
  };

  return { supabase, state };
}

function formDataFor(appointmentId: string) {
  const formData = new FormData();
  formData.set("appointmentId", appointmentId);
  return formData;
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

beforeEach(() => {
  requireAttendanceAccessMock.mockReset();
});

describe("markAppointmentAttendedAction — membership usage-sync single-writer cutover", () => {
  it("private_lesson, billing_type=membership, already attended: never touches client_membership_usage, never queries the old membership-resolution tables, redirects success", async () => {
    const { supabase, state } = createFakeSupabase(membershipAppointmentRow());
    requireAttendanceAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: "user-mupa-1" },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });

    const error = await markAppointmentAttendedAction(
      formDataFor(APPOINTMENT_ID),
    ).catch((e) => e);

    // Reaching this assertion at all (rather than the fake's thrown error)
    // is itself the proof that client_membership_usage was never touched.
    expect(digestUrl(error)).toContain("success=appointment_attended");
    expect(state.appointmentUpdateCalls).toHaveLength(0);
  });

  it("intro_lesson, billing_type=membership, already attended (replay): never touches client_membership_usage, never queries the old membership-resolution tables", async () => {
    const { supabase, state } = createFakeSupabase(
      membershipAppointmentRow({ appointment_type: "intro_lesson" }),
    );
    requireAttendanceAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: "user-mupa-1" },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });

    const error = await markAppointmentAttendedAction(
      formDataFor(APPOINTMENT_ID),
    ).catch((e) => e);

    // Reaching this assertion at all (rather than the fake's thrown error)
    // is itself the proof that client_membership_usage was never touched.
    expect(digestUrl(error)).toContain("success=appointment_attended");
    expect(state.appointmentUpdateCalls).toHaveLength(0);
  });
});
