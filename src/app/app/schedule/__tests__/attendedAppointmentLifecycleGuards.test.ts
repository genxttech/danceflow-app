import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Terminal attendance lifecycle guards (P6e's application-layer half):
 * attended/no_show are terminal outcomes for private_lesson/intro_lesson/
 * coaching -- cancelAppointmentAction, markAppointmentNoShowAction, and
 * markAppointmentAttendedAction must all reject a transition away from
 * (or into, for the no_show->attended case) a completed outcome, before
 * any downstream membership-usage write is ever reached. The fake
 * Supabase client's `appointments.update()` throws if called for the
 * rejected cases, so a regression that lets the write proceed fails
 * loudly rather than silently passing.
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

vi.mock("@/lib/compensation/earnings", () => ({
  stageInstructorEarningForAppointment: vi
    .fn()
    .mockResolvedValue({ staged: false, reason: "not_exercised_by_this_test" }),
}));

vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi.fn().mockResolvedValue({ completedPackageIds: [] }),
}));

const requireAttendanceAccessMock = vi.fn();
const requireFloorRentalAppointmentAccessMock = vi.fn();
const requireAppointmentEditAccessMock = vi.fn();
const requireAppointmentCreateAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireAttendanceAccess: (...args: unknown[]) => requireAttendanceAccessMock(...args),
  requireFloorRentalAppointmentAccess: (...args: unknown[]) =>
    requireFloorRentalAppointmentAccessMock(...args),
  requireAppointmentEditAccess: (...args: unknown[]) => requireAppointmentEditAccessMock(...args),
  requireAppointmentCreateAccess: (...args: unknown[]) =>
    requireAppointmentCreateAccessMock(...args),
}));

const requireAppointmentRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...args: unknown[]) =>
    requireAppointmentRelationshipAccessMock(...args),
}));

const {
  cancelAppointmentAction,
  markAppointmentNoShowAction,
  markAppointmentAttendedAction,
} = await import("@/app/app/schedule/actions");

type Row = Record<string, unknown>;

function makeChain(resolve: () => { data?: unknown; error?: { message: string } | null }) {
  const chain = {
    eq: () => chain,
    neq: () => chain,
    not: () => chain,
    in: () => chain,
    gte: () => chain,
    limit: () => chain,
    select: () => chain,
    async maybeSingle() {
      const r = await resolve();
      return { data: r.data ?? null, error: r.error ?? null };
    },
    async single() {
      const r = await resolve();
      if (r.error) return { data: null, error: r.error };
      return { data: r.data ?? null, error: r.data ? null : { message: "Row not found" } };
    },
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

const STUDIO_ID = "studio-1";
const USER_ID = "staff-1";
const CLIENT_ID = "client-1";
const APPOINTMENT_ID = "appt-1";

function createFakeSupabase() {
  const state = {
    appointmentUpdateCalls: [] as Row[],
  };

  const supabase = {
    from(table: string) {
      if (table === "appointments") {
        return {
          select: () => makeChain(() => ({ data: null, error: null })),
          // Deliberately no update() implementation -- if a lifecycle
          // guard regresses and a rejected transition's write is reached
          // anyway, calling it throws, failing the test loudly.
          update: (payload: Row) => {
            state.appointmentUpdateCalls.push(payload);
            throw new Error(
              "Unexpected appointments.update() call -- the terminal lifecycle guard should have rejected this transition before any write was attempted.",
            );
          },
        };
      }
      return {
        select: () => makeChain(() => ({ data: null, error: null })),
        insert: () => makeChain(() => ({ data: null, error: null })),
        update: () => makeChain(() => ({ data: null, error: null })),
        delete: () => makeChain(() => ({ data: null, error: null })),
      };
    },
  };

  return { supabase, state };
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

beforeEach(() => {
  requireAttendanceAccessMock.mockReset();
  requireFloorRentalAppointmentAccessMock.mockReset();
  requireAppointmentEditAccessMock.mockReset();
  requireAppointmentCreateAccessMock.mockReset();
  requireAppointmentRelationshipAccessMock.mockReset();
});

describe("cancelAppointmentAction -- terminal attendance lifecycle guard", () => {
  it("rejects cancelling an attended private_lesson before any write is attempted", async () => {
    const { supabase } = createFakeSupabase();
    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "studio_owner",
      user: { id: USER_ID },
      isPlatformAdmin: false,
    });
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        appointment_type: "private_lesson",
        recurrence_series_id: null,
        starts_at: "2026-09-20T10:00:00.000Z",
        title: "Private Lesson",
        client_package_id: null,
        client_membership_id: null,
        billing_type: "membership",
        status: "attended",
      },
    });

    const error = await cancelAppointmentAction(
      formDataFor({
        appointmentId: APPOINTMENT_ID,
        cancellationRequestedBy: "studio",
        cancellationReason: "test",
        cancelScope: "this_instance",
      }),
    ).catch((e) => e);

    expect(digestUrl(error)).toContain("attended_cannot_be_cancelled");
  });

  it("still allows cancelling a scheduled private_lesson normally", async () => {
    const state = {
      appointmentUpdateCalls: [] as Row[],
    };
    const supabase = {
      from(table: string) {
        if (table === "appointments") {
          return {
            select: () => makeChain(() => ({ data: null, error: null })),
            update: (payload: Row) => {
              state.appointmentUpdateCalls.push(payload);
              return makeChain(() => ({ data: { id: APPOINTMENT_ID }, error: null }));
            },
          };
        }
        return {
          select: () => makeChain(() => ({ data: null, error: null })),
          insert: () => makeChain(() => ({ data: null, error: null })),
          update: () => makeChain(() => ({ data: null, error: null })),
          delete: () => makeChain(() => ({ data: null, error: null })),
        };
      },
    };
    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "studio_owner",
      user: { id: USER_ID },
      isPlatformAdmin: false,
    });
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        appointment_type: "private_lesson",
        recurrence_series_id: null,
        starts_at: "2026-09-20T10:00:00.000Z",
        title: "Private Lesson",
        client_package_id: null,
        client_membership_id: null,
        billing_type: "membership",
        status: "scheduled",
      },
    });

    const error = await cancelAppointmentAction(
      formDataFor({
        appointmentId: APPOINTMENT_ID,
        cancellationRequestedBy: "studio",
        cancellationReason: "test",
        cancelScope: "this_instance",
      }),
    ).catch((e) => e);

    expect(digestUrl(error)).not.toContain("attended_cannot_be_cancelled");
    expect(state.appointmentUpdateCalls.length).toBeGreaterThan(0);
    expect(state.appointmentUpdateCalls[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("markAppointmentNoShowAction -- terminal attendance lifecycle guard", () => {
  it("rejects marking an already-attended private_lesson as no-show", async () => {
    const { supabase } = createFakeSupabase();
    requireAttendanceAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        appointment_type: "private_lesson",
        starts_at: "2026-09-20T10:00:00.000Z",
        title: "Private Lesson",
        client_package_id: null,
        client_membership_id: null,
        billing_type: "membership",
        status: "attended",
      },
    });

    const error = await markAppointmentNoShowAction(
      formDataFor({ appointmentId: APPOINTMENT_ID }),
    ).catch((e) => e);

    expect(digestUrl(error)).toContain("attended_cannot_be_marked_no_show");
  });
});

describe("markAppointmentAttendedAction -- terminal attendance lifecycle guard", () => {
  it("rejects re-marking a no_show private_lesson as attended", async () => {
    const { supabase } = createFakeSupabase();
    requireAttendanceAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "studio_owner",
      isPlatformAdmin: false,
    });
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: true,
      appointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        appointment_type: "private_lesson",
        starts_at: "2026-09-20T10:00:00.000Z",
        client_package_id: null,
        client_membership_id: null,
        price_amount: null,
        payment_status: "unpaid",
        billing_type: "membership",
        status: "no_show",
      },
    });

    const error = await markAppointmentAttendedAction(
      formDataFor({ appointmentId: APPOINTMENT_ID }),
    ).catch((e) => e);

    expect(digestUrl(error)).toContain("no_show_cannot_be_marked_attended");
  });
});
