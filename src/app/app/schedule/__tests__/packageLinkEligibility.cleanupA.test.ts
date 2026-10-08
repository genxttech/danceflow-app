import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cleanup PR A: attaching a package to a lesson uses the canonical eligibility rule
 * (`evaluatePackageForAppointment`, the same rule the scheduling picker uses), whatever the
 * studio's former "warn only" setting says. Drives the real create/update actions; fakes only the
 * transport and the unrelated auth/conflict/earnings entry points (same convention as
 * membershipAtomicRpcRouting.test.ts).
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));
vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }),
}));
vi.mock("@/lib/compensation/earnings", () => ({
  stageInstructorEarningForAppointment: vi.fn().mockResolvedValue({ staged: false }),
}));
vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi.fn().mockResolvedValue({ completedPackageIds: [] }),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...args: unknown[]) => requireFloorRentalAppointmentAccessMock(...args),
  requireAppointmentEditAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));
const requireAppointmentRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...args: unknown[]) => requireAppointmentRelationshipAccessMock(...args),
}));

const { createAppointmentAction, updateAppointmentAction } = await import("@/app/app/schedule/actions");

type Row = Record<string, unknown>;

function makeChain(resolve: () => { data?: unknown; error?: { message: string } | null }) {
  const chain = {
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    is: () => chain,
    not: () => chain,
    gte: () => chain,
    lte: () => chain,
    gt: () => chain,
    lt: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    select: () => chain,
    async maybeSingle() {
      const r = resolve();
      return { data: r.data ?? null, error: r.error ?? null };
    },
    async single() {
      const r = resolve();
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
const CLIENT_ID = "client-1";
const APPOINTMENT_ID = "appt-1";
const PACKAGE_ID = "pkg-1";

function pkg(overrides: Row = {}): Row {
  return {
    id: PACKAGE_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    active: true,
    archived_at: null,
    expiration_date: null,
    refund_status: null,
    client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 4, is_unlimited: false }],
    ...overrides,
  };
}

function createFakeSupabase(packageRow: Row | null, settings: Row = { block_depleted_package_booking: false }) {
  const state = { appointmentWrites: [] as Row[], packageReads: 0 };
  const supabase = {
    from(table: string) {
      if (table === "client_packages") {
        return {
          select: () =>
            makeChain(() => {
              state.packageReads += 1;
              return { data: packageRow, error: null };
            }),
        };
      }
      if (table === "studio_settings") {
        return { select: () => makeChain(() => ({ data: settings, error: null })) };
      }
      if (table === "appointments") {
        return {
          select: () => makeChain(() => ({ data: null, error: null })),
          insert: (payload: Row) => {
            state.appointmentWrites.push(payload);
            return makeChain(() => ({ data: [{ id: APPOINTMENT_ID, starts_at: "2026-09-20T14:00:00.000Z" }], error: null }));
          },
          update: (payload: Row) => {
            state.appointmentWrites.push(payload);
            return makeChain(() => ({ data: null, error: null }));
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
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { supabase, state };
}

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const lessonFields = {
  clientId: CLIENT_ID,
  appointmentType: "private_lesson",
  billingType: "package_credit",
  clientPackageId: PACKAGE_ID,
  date: "2026-09-20",
  startTime: "10:00",
  endTime: "10:45",
  title: "Private Lesson",
};

function access(supabase: unknown) {
  requireFloorRentalAppointmentAccessMock.mockResolvedValue({
    supabase,
    studioId: STUDIO_ID,
    studioRole: "studio_owner",
    user: { id: "staff-1" },
    isPlatformAdmin: false,
  });
}

beforeEach(() => {
  requireFloorRentalAppointmentAccessMock.mockReset();
  requireAppointmentRelationshipAccessMock.mockReset();
});

const INELIGIBLE: Array<[string, Row, RegExp]> = [
  ["depleted", { client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false }] }, /no remaining balance/],
  ["expired before the appointment date", { expiration_date: "2026-09-19" }, /expired for this appointment date/],
  ["inactive", { active: false }, /inactive/],
  ["archived", { archived_at: "2026-09-01T00:00:00Z" }, /inactive/],
  ["fully refunded", { refund_status: "full" }, /refunded/],
  ["of the wrong usage type", { client_package_items: [{ usage_type: "group_class", quantity_remaining: 5, is_unlimited: false }] }, /does not cover this type of appointment/],
  ["another client's", { client_id: "client-2" }, /does not belong to the chosen client/],
];

describe("createAppointmentAction -- attaching a package", () => {
  it.each(INELIGIBLE)("rejects a newly selected %s package, even with the studio set to 'warn only', before any write", async (_label, overrides, message) => {
    const { supabase, state } = createFakeSupabase(pkg(overrides), { block_depleted_package_booking: false });
    access(supabase);
    const result = await createAppointmentAction({}, formDataFor(lessonFields));
    expect(result).toEqual({ error: expect.stringMatching(message) });
    expect(state.appointmentWrites).toEqual([]);
  });

  it("an eligible package passes the package check (the booking proceeds to the write)", async () => {
    const { supabase, state } = createFakeSupabase(pkg());
    access(supabase);
    await createAppointmentAction({}, formDataFor(lessonFields)).catch((e) => e);
    expect(state.packageReads).toBeGreaterThan(0);
    expect(state.appointmentWrites.length).toBeGreaterThan(0);
  });

  it("booking WITHOUT a package is unaffected (no package read, no package error)", async () => {
    const { supabase, state } = createFakeSupabase(null);
    access(supabase);
    const result = await createAppointmentAction({}, formDataFor({ ...lessonFields, clientPackageId: "" })).catch((e) => e);
    expect(result).not.toMatchObject({ error: expect.stringMatching(/package/i) });
    expect(state.packageReads).toBe(0);
  });
});

function storedAppointment(overrides: Row = {}): Row {
  return {
    id: APPOINTMENT_ID,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    instructor_id: null,
    appointment_type: "private_lesson",
    room_id: null,
    starts_at: "2026-09-20T14:00:00.000Z",
    ends_at: "2026-09-20T14:45:00.000Z",
    roster_capacity: null,
    location_name: null,
    client_package_id: PACKAGE_ID,
    recurrence_series_id: null,
    status: "scheduled",
    payment_status: "unpaid",
    ...overrides,
  };
}

describe("updateAppointmentAction -- package linkage", () => {
  it("keeps an unchanged historical link (now depleted) without rejecting or unlinking it", async () => {
    const { supabase, state } = createFakeSupabase(
      pkg({ client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false }] }),
    );
    access(supabase);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({ ok: true, appointment: storedAppointment() });
    const result = await updateAppointmentAction(
      {},
      formDataFor({ ...lessonFields, appointmentId: APPOINTMENT_ID, scope: "this" }),
    ).catch((e) => e);
    expect(result).not.toMatchObject({ error: expect.stringMatching(/package/i) });
    expect(state.packageReads).toBe(0);
    // the update reached its write and kept the existing link (never unlinked)
    const write = state.appointmentWrites.find((w) => "client_package_id" in w);
    expect(write?.client_package_id).toBe(PACKAGE_ID);
  });

  it.each(INELIGIBLE)("rejects a NEWLY linked %s package", async (_label, overrides, message) => {
    const { supabase, state } = createFakeSupabase(pkg({ ...overrides, id: "pkg-new" }));
    access(supabase);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({ ok: true, appointment: storedAppointment({ client_package_id: null }) });
    const result = await updateAppointmentAction(
      {},
      formDataFor({ ...lessonFields, clientPackageId: "pkg-new", appointmentId: APPOINTMENT_ID, scope: "this" }),
    );
    expect(result).toEqual({ error: expect.stringMatching(message) });
    expect(state.appointmentWrites).toEqual([]);
  });

  it("re-validates the stored package when the appointment is moved to another client", async () => {
    const { supabase } = createFakeSupabase(pkg());
    access(supabase);
    requireAppointmentRelationshipAccessMock.mockResolvedValue({ ok: true, appointment: storedAppointment({ client_id: "client-0" }) });
    const result = await updateAppointmentAction(
      {},
      formDataFor({ ...lessonFields, clientId: "client-2", appointmentId: APPOINTMENT_ID, scope: "this" }),
    );
    expect(result).toEqual({ error: expect.stringMatching(/does not belong to the chosen client/) });
  });
});
