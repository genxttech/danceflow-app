import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Membership Usage-Period Alignment -- single-writer cutover regression.
 *
 * Proves that markAppointmentAttendedAction's membership-billing branch no
 * longer inserts into client_membership_usage via the old TypeScript path
 * (syncMembershipUsageForAppointment) for private_lesson/intro_lesson/
 * coaching appointments -- that responsibility now belongs exclusively to
 * the canonical DB trigger (sync_membership_usage_for_private_lesson_
 * appointment), once enabled. The fake Supabase client below throws on any
 * unexpected table access, so if the guard regresses and the old path's
 * client_memberships/membership_plan_benefits/client_membership_periods/
 * studio_settings queries are reached again, this test fails loudly rather
 * than silently passing.
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
    membershipUsageDeleteCalls: 0,
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
        // clearMembershipUsageForAppointment's unconditional, idempotent
        // clear -- expected to run once, harmlessly, regardless of the
        // cutover guard. No insert should ever be attempted here for a
        // private_lesson/intro_lesson/coaching appointment -- if one is,
        // .insert() below is intentionally left unimplemented so the test
        // fails loudly instead of silently succeeding.
        return {
          delete: () => {
            state.membershipUsageDeleteCalls += 1;
            return makeChain(() => ({ error: null }));
          },
        };
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
  it("private_lesson, billing_type=membership, already attended: clears usage once, never queries the old membership-resolution tables, redirects success", async () => {
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

    expect(digestUrl(error)).toContain("success=appointment_attended");
    expect(state.appointmentUpdateCalls).toHaveLength(0);
    expect(state.membershipUsageDeleteCalls).toBe(1);
  });

  it("intro_lesson, billing_type=membership, already attended (replay): clears usage once, never queries the old membership-resolution tables", async () => {
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

    expect(digestUrl(error)).toContain("success=appointment_attended");
    expect(state.appointmentUpdateCalls).toHaveLength(0);
    expect(state.membershipUsageDeleteCalls).toBe(1);
  });
});
