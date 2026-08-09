import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression coverage for the P0.1 re-review's second blocking finding:
 * the already-`attended` guard in `markAppointmentAttendedAction` must not
 * report false success while a package/membership deduction is still
 * stranded, and replaying the action for an already-attended appointment
 * must be able to *complete* a missing deduction (not just no-op).
 *
 * This drives the real `markAppointmentAttendedAction` (not a stand-in),
 * with `next/navigation`'s `redirect` mocked to capture the destination
 * instead of exiting, and `requireAttendanceAccess` mocked to hand back a
 * fake Supabase client. `syncPackageUsageForAttendedAppointment` and the
 * `deduct_package_credit_for_appointment` RPC it calls are NOT mocked —
 * only the RPC's transport is faked (same faithful model used in
 * syncPackageUsage.test.ts) — so this exercises the real integration
 * between the action's replay guard and the real sync function, not just
 * the action's own branching in isolation.
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

const APPOINTMENT_ID = "appt-1";
const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const PACKAGE_ID = "package-1";

function baseAppointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    client_id: CLIENT_ID,
    instructor_id: "instructor-1",
    appointment_type: "private_lesson",
    starts_at: new Date().toISOString(),
    client_package_id: PACKAGE_ID,
    client_membership_id: null,
    price_amount: 50,
    payment_status: "paid",
    billing_type: "package_credit",
    status: "scheduled",
    ...overrides,
  };
}

function createFakeSupabase(options: {
  appointment: ReturnType<typeof baseAppointmentRow>;
  rpcAlreadyDeducted?: boolean;
  rpcError?: string;
  packageQuantityRemaining?: number;
}) {
  const state = {
    appointment: { ...options.appointment },
    appointmentUpdateCalls: [] as Record<string, unknown>[],
    rpcCalls: [] as Record<string, unknown>[],
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

      if (table === "client_package_items") {
        // Backs canMarkAppointmentAttendedWithoutPaymentWarning's
        // pre-flight credit check for the not-yet-attended path.
        return {
          select: () =>
            makeChain(() => ({
              data: {
                id: "item-1",
                quantity_remaining: options.packageQuantityRemaining ?? 5,
                is_unlimited: false,
                client_packages: {
                  id: PACKAGE_ID,
                  studio_id: STUDIO_ID,
                  client_id: CLIENT_ID,
                  active: true,
                },
              },
              error: null,
            })),
        };
      }

      throw new Error(`Unexpected table in fake action supabase: ${table}`);
    },
    rpc(name: string, params: Record<string, unknown>) {
      state.rpcCalls.push({ name, params });

      if (name !== "deduct_package_credit_for_appointment") {
        throw new Error(`Unexpected rpc: ${name}`);
      }

      if (options.rpcError) {
        return Promise.resolve({ data: null, error: { message: options.rpcError } });
      }

      const alreadyDeducted = options.rpcAlreadyDeducted ?? false;
      const remaining = options.packageQuantityRemaining ?? 5;

      return Promise.resolve({
        data: [
          {
            found_item: true,
            already_deducted: alreadyDeducted,
            is_unlimited: false,
            quantity_used: alreadyDeducted ? 1 : 6 - remaining,
            quantity_remaining: alreadyDeducted ? remaining : remaining - 1,
          },
        ],
        error: null,
      });
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

describe("markAppointmentAttendedAction — replay/recovery for a stranded deduction", () => {
  it("already-attended + deduction already exists: no-op, redirects success, does not rewrite appointment status", async () => {
    const { supabase, state } = createFakeSupabase({
      appointment: baseAppointmentRow({ status: "attended" }),
      rpcAlreadyDeducted: true,
    });
    requireAttendanceAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const error = await markAppointmentAttendedAction(
      formDataFor(APPOINTMENT_ID),
    ).catch((e) => e);

    expect(digestUrl(error)).toContain("success=appointment_attended");
    expect(state.appointmentUpdateCalls).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("already-attended + deduction missing: retry completes exactly one deduction and redirects success", async () => {
    const { supabase, state } = createFakeSupabase({
      appointment: baseAppointmentRow({ status: "attended" }),
      rpcAlreadyDeducted: false,
    });
    requireAttendanceAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const error = await markAppointmentAttendedAction(
      formDataFor(APPOINTMENT_ID),
    ).catch((e) => e);

    expect(digestUrl(error)).toContain("success=appointment_attended");
    // The whole point of the fix: appointments.status is not rewritten on
    // replay, but the sync still ran and completed exactly once.
    expect(state.appointmentUpdateCalls).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      name: "deduct_package_credit_for_appointment",
      params: expect.objectContaining({
        p_appointment_id: APPOINTMENT_ID,
        p_client_package_id: PACKAGE_ID,
      }),
    });
  });

  it("first-time attendance: marks attended, deducts exactly one credit, redirects success", async () => {
    const { supabase, state } = createFakeSupabase({
      appointment: baseAppointmentRow({ status: "scheduled" }),
      rpcAlreadyDeducted: false,
    });
    requireAttendanceAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const error = await markAppointmentAttendedAction(
      formDataFor(APPOINTMENT_ID),
    ).catch((e) => e);

    expect(digestUrl(error)).toContain("success=appointment_attended");
    expect(state.appointmentUpdateCalls).toHaveLength(1);
    expect(state.appointmentUpdateCalls[0]).toMatchObject({ status: "attended" });
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("deduction failure on replay: deterministic error redirect, not a silent false success", async () => {
    const { supabase, state } = createFakeSupabase({
      appointment: baseAppointmentRow({ status: "attended" }),
      rpcError: "The selected package has no remaining credits.",
    });
    requireAttendanceAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const error = await markAppointmentAttendedAction(
      formDataFor(APPOINTMENT_ID),
    ).catch((e) => e);

    const url = digestUrl(error);
    expect(url).toContain("error=attendance_sync_failed");
    expect(url).not.toContain("success=appointment_attended");
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("deduction failure on first-time attendance: appointment is still marked attended, but success is not falsely reported", async () => {
    const { supabase, state } = createFakeSupabase({
      appointment: baseAppointmentRow({ status: "scheduled" }),
      rpcError: "The selected package has no remaining credits.",
    });
    requireAttendanceAccessMock.mockResolvedValue({ supabase, studioId: STUDIO_ID });

    const error = await markAppointmentAttendedAction(
      formDataFor(APPOINTMENT_ID),
    ).catch((e) => e);

    const url = digestUrl(error);
    expect(url).toContain("error=attendance_sync_failed");
    expect(url).not.toContain("success=appointment_attended");
    // Attendance itself still gets recorded — only the financial sync
    // outcome is reported honestly as needing attention.
    expect(state.appointmentUpdateCalls).toHaveLength(1);
  });
});
