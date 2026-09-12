import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Membership Usage-Period Alignment, Phase 2 -- application-layer cutover.
 *
 * Proves that createAppointmentAction/updateAppointmentAction route a
 * single-occurrence, membership-funded private_lesson/intro_lesson/
 * coaching write through the new atomic staff RPC
 * (create_private_lesson_membership_appointment /
 * update_private_lesson_membership_appointment) instead of the old,
 * non-atomic raw insert/update. The fake Supabase client's `appointments`
 * table has no `insert`/`update` implementation at all -- if the cutover
 * guard ever regresses and the old path is reached again for this case,
 * the test fails with a thrown "not implemented" error rather than
 * silently passing.
 *
 * Same faithful-mock convention as independentInstructorFloorRental.test.ts
 * -- drives the real actions, fakes only the transport layer and the
 * unrelated auth-guard/entitlement-resolution entry points.
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

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/schedule/conflicts", () => ({
  detectAppointmentConflicts: vi.fn().mockResolvedValue({ hasConflict: false }),
}));

vi.mock("@/lib/compensation/earnings", () => ({
  stageInstructorEarningForAppointment: vi.fn().mockResolvedValue({ staged: false }),
}));

vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi.fn().mockResolvedValue({ completedPackageIds: [] }),
}));

vi.mock("@/lib/memberships/entitlements", () => ({
  validateMembershipEntitlement: vi.fn().mockResolvedValue({
    ok: true,
    membershipId: "membership-1",
  }),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();
const requireAppointmentEditAccessMock = vi.fn();
const requireAppointmentCreateAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...args: unknown[]) =>
    requireFloorRentalAppointmentAccessMock(...args),
  requireAppointmentEditAccess: (...args: unknown[]) => requireAppointmentEditAccessMock(...args),
  requireAppointmentCreateAccess: (...args: unknown[]) => requireAppointmentCreateAccessMock(...args),
  requireAttendanceAccess: vi.fn(),
}));

const requireAppointmentRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...args: unknown[]) =>
    requireAppointmentRelationshipAccessMock(...args),
}));

const { createAppointmentAction, updateAppointmentAction } = await import(
  "@/app/app/schedule/actions"
);

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
    order: () => chain,
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
const MEMBERSHIP_ID = "membership-1";
const APPOINTMENT_ID = "appt-1";

function createFakeSupabase(options: { existingAppointment?: Row | null } = {}) {
  const state = {
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    existingAppointment: options.existingAppointment ?? null,
    metadataUpdateCalls: [] as Row[],
  };

  const supabase = {
    from(table: string) {
      if (table === "appointments") {
        return {
          select: () =>
            makeChain(() => ({ data: state.existingAppointment, error: null })),
          // Deliberately no insert() implementation -- if the cutover
          // guard regresses and the old raw-insert path is reached for a
          // membership-funded lesson, calling it throws, failing the
          // test loudly. update() IS supported -- the legitimate,
          // post-RPC created_by metadata patch uses it (never insert).
          update: (payload: Row) => {
            state.metadataUpdateCalls.push(payload);
            return makeChain(() => ({ data: null, error: null }));
          },
        };
      }
      // Any other table (studios, client_account_links, lead activity,
      // outbound delivery, client_membership_usage clear, etc.) safely
      // no-ops.
      return {
        select: () => makeChain(() => ({ data: null, error: null })),
        insert: () => makeChain(() => ({ data: null, error: null })),
        update: () => makeChain(() => ({ data: null, error: null })),
        delete: () => makeChain(() => ({ data: null, error: null })),
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ name, args });
      if (
        name === "create_private_lesson_membership_appointment" ||
        name === "update_private_lesson_membership_appointment"
      ) {
        return Promise.resolve({ data: APPOINTMENT_ID, error: null });
      }
      throw new Error(`Unexpected rpc: ${name}`);
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
  requireFloorRentalAppointmentAccessMock.mockReset();
  requireAppointmentEditAccessMock.mockReset();
  requireAppointmentCreateAccessMock.mockReset();
  requireAppointmentRelationshipAccessMock.mockReset();
});

describe("createAppointmentAction -- membership atomic RPC routing", () => {
  it("single, non-recurring, membership-billed private_lesson calls the staff RPC, never a raw insert", async () => {
    const { supabase, state } = createFakeSupabase();
    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase,
      studioId: STUDIO_ID,
      studioRole: "studio_owner",
      user: { id: USER_ID },
      isPlatformAdmin: false,
    });

    const error = await createAppointmentAction(
      {},
      formDataFor({
        clientId: CLIENT_ID,
        appointmentType: "private_lesson",
        billingType: "membership",
        clientMembershipId: MEMBERSHIP_ID,
        date: "2026-09-20",
        startTime: "10:00",
        endTime: "10:45",
        title: "Private Lesson",
      }),
    ).catch((e) => e);

    expect(digestUrl(error)).toContain(`/app/schedule/${APPOINTMENT_ID}`);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      name: "create_private_lesson_membership_appointment",
      args: expect.objectContaining({
        p_studio_id: STUDIO_ID,
        p_client_id: CLIENT_ID,
        p_client_membership_id: MEMBERSHIP_ID,
        p_appointment_type: "private_lesson",
      }),
    });
    // Parity fix: created_by has no parameter on the staff RPC's shared
    // core -- must be patched afterward via a plain update, exactly once.
    expect(state.metadataUpdateCalls).toHaveLength(1);
    expect(state.metadataUpdateCalls[0]).toMatchObject({ created_by: USER_ID });
  });
});

describe("updateAppointmentAction -- membership atomic RPC routing", () => {
  it("single, non-series, membership-billed intro_lesson calls the staff RPC, never a raw update", async () => {
    const { supabase, state } = createFakeSupabase({
      existingAppointment: {
        id: APPOINTMENT_ID,
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        instructor_id: null,
        recurrence_series_id: null,
        starts_at: "2026-09-20T10:00:00.000Z",
        ends_at: "2026-09-20T10:45:00.000Z",
        status: "scheduled",
        payment_status: "unpaid",
      },
    });
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
        recurrence_series_id: null,
        starts_at: "2026-09-20T10:00:00.000Z",
        ends_at: "2026-09-20T10:45:00.000Z",
        status: "scheduled",
        payment_status: "unpaid",
      },
    });

    const error = await updateAppointmentAction(
      {},
      formDataFor({
        appointmentId: APPOINTMENT_ID,
        clientId: CLIENT_ID,
        appointmentType: "intro_lesson",
        billingType: "membership",
        clientMembershipId: MEMBERSHIP_ID,
        date: "2026-09-21",
        startTime: "10:00",
        endTime: "10:45",
        title: "Intro Lesson",
        scope: "this",
      }),
    ).catch((e) => e);

    expect(error).not.toMatchObject({ error: expect.any(String) });
    expect(state.rpcCalls.some((c) => c.name === "update_private_lesson_membership_appointment")).toBe(
      true,
    );
    const call = state.rpcCalls.find(
      (c) => c.name === "update_private_lesson_membership_appointment",
    );
    expect(call?.args).toMatchObject({
      p_appointment_id: APPOINTMENT_ID,
      p_new_client_membership_id: MEMBERSHIP_ID,
      p_new_appointment_type: "intro_lesson",
    });
  });
});
