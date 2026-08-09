import { describe, expect, it, vi } from "vitest";
import { syncPackageUsageForAttendedAppointment } from "@/app/app/schedule/actions";

/**
 * These tests exercise the P0.1 double-deduction fix as it exists after the
 * independent-review follow-up: `syncPackageUsageForAttendedAppointment` no
 * longer does its own read-then-write against `client_package_items` at
 * all. It delegates entirely to the `deduct_package_credit_for_appointment`
 * Postgres RPC (see
 * `src/lib/supabase/migrations/20260809120000_atomic_package_credit_deduction.sql`),
 * which:
 *   - takes `for update` on the `client_package_items` row so two
 *     concurrent deductions against the same package (one via the
 *     attendance trigger, one via this JS sole-deductor path) serialize
 *     instead of racing and losing an update; and
 *   - recognizes BOTH the current (`lesson_deduction`) and legacy
 *     (`appointment_attendance`) `lesson_transactions` marker as evidence a
 *     deduction already happened, so replaying a deduction for an
 *     appointment that was attended before the `lesson_deduction` marker
 *     existed cannot consume a second credit.
 *
 * The fake `rpc` below is a faithful line-for-line model of that SQL
 * function's control flow (not a stub that assumes the contract away), so
 * these tests genuinely exercise the marker-recognition and
 * insufficient-balance/not-found decision points the real function makes.
 * The one thing a JS-level fake cannot exercise is genuine row-level
 * locking under real concurrent transactions — that guarantee comes from
 * Postgres's `for update` semantics in the migration itself, which has no
 * substitute short of an integration test against a live database (none
 * exists in this repo today). What *is* verified here is the structural
 * half of that fix: `syncPackageUsageForAttendedAppointment` makes exactly
 * one RPC call and never touches `client_package_items` or
 * `lesson_transactions` directly — see "does not perform any direct
 * read-then-write against client_package_items" below, which fails loudly
 * (via the fake's `from()` throwing on unexpected tables) if that
 * regresses.
 *
 * Security-review follow-up: the RPC now also verifies (a) the calling
 * user has an authorized studio role for p_studio_id, via auth.uid(), and
 * (b) p_appointment_id is a real appointment whose studio/client/package
 * match the supplied parameters. Neither check can be genuinely exercised
 * from JS — auth.uid() is Postgres session context, not a value this
 * wrapper passes — so the "unauthorized"/"mismatched" tests below model
 * the RPC's *documented contract* (reject and leave all state untouched)
 * rather than proving the real Postgres-level enforcement, which requires
 * a live database this repo does not have test infrastructure for. This
 * mirrors the same acknowledged limitation as the concurrency lock itself.
 */

type FakeResult = { data?: unknown; error?: { message: string } | null };

function makeChain(resolve: () => FakeResult | Promise<FakeResult>) {
  const chain: {
    eq: (...args: unknown[]) => typeof chain;
    in: (...args: unknown[]) => typeof chain;
    order: (...args: unknown[]) => typeof chain;
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
    order: () => chain,
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
      if (!rows.length) {
        return { data: null, error: { message: "Row not found" } };
      }
      return { data: rows[0], error: null };
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

type FakeLessonTransaction = {
  id: string;
  appointment_id: string;
  client_package_id: string;
  transaction_type: string;
  lessons_delta: number;
  balance_after: number | null;
};

type RpcParams = {
  p_studio_id: string;
  p_client_id: string;
  p_client_package_id: string;
  p_appointment_id: string;
  p_usage_type: string;
};

function createFakePackageDb(options: {
  studioId: string;
  clientId: string;
  clientPackageId: string;
  appointmentId?: string;
  quantityUsed: number;
  quantityRemaining: number;
  isUnlimited?: boolean;
  legacyLessonsUsed?: number;
  legacyLessonsRemaining?: number | null;
  packageActive?: boolean;
  /** Seed a prior deduction row exactly as either the trigger (new marker)
   * or pre-fix app code (legacy marker) would have left it. */
  seedDeductionMarker?: "lesson_deduction" | "appointment_attendance";
  /** Simulate a hard RPC-level failure (connection error, etc). */
  rpcError?: string;
  /** Models whether auth.uid() resolves to a caller with an authorized
   * studio role for p_studio_id. Defaults to true (the common case). */
  callerAuthorizedForStudio?: boolean;
  /** Models the real `appointments` row the RPC cross-checks
   * p_appointment_id/p_studio_id/p_client_id/p_client_package_id against.
   * Defaults to a row that matches the params under test; pass an object
   * with different ids (or `null` for "no such appointment") to model a
   * fabricated/mismatched/cross-tenant call. */
  appointmentRecord?: {
    studioId: string;
    clientId: string;
    clientPackageId: string;
  } | null;
}) {
  const appointmentId = options.appointmentId ?? "appt-1";
  const appointmentRecord =
    options.appointmentRecord === undefined
      ? {
          studioId: options.studioId,
          clientId: options.clientId,
          clientPackageId: options.clientPackageId,
        }
      : options.appointmentRecord;

  const state = {
    quantityUsed: options.quantityUsed,
    quantityRemaining: options.quantityRemaining,
    isUnlimited: options.isUnlimited ?? false,
    legacyLessonsUsed: options.legacyLessonsUsed ?? 0,
    legacyLessonsRemaining: options.legacyLessonsRemaining ?? null,
    packageActive: options.packageActive ?? true,
    transactions: [] as FakeLessonTransaction[],
    itemUpdateCalls: [] as Record<string, unknown>[],
    packagesUpdateCalls: [] as Record<string, unknown>[],
    rpcCallCount: 0,
  };

  if (options.seedDeductionMarker) {
    state.transactions.push({
      id: "seed-txn-1",
      appointment_id: appointmentId,
      client_package_id: options.clientPackageId,
      transaction_type: options.seedDeductionMarker,
      lessons_delta: state.isUnlimited ? 0 : -1,
      balance_after: state.isUnlimited ? null : options.quantityRemaining,
    });
  }

  function alreadyDeducted(params: RpcParams) {
    return state.transactions.some(
      (row) =>
        row.appointment_id === params.p_appointment_id &&
        row.client_package_id === params.p_client_package_id &&
        (row.transaction_type === "lesson_deduction" ||
          row.transaction_type === "appointment_attendance"),
    );
  }

  // Faithful model of deduct_package_credit_for_appointment's control flow.
  function rpc(name: string, params: RpcParams) {
    state.rpcCallCount += 1;

    if (name !== "deduct_package_credit_for_appointment") {
      throw new Error(`Unexpected rpc in fake package db: ${name}`);
    }

    if (options.rpcError) {
      return Promise.resolve({ data: null, error: { message: options.rpcError } });
    }

    if (options.callerAuthorizedForStudio === false) {
      return Promise.resolve({
        data: null,
        error: {
          message: "Not authorized to record package usage for this studio.",
        },
      });
    }

    const appointmentMatches =
      appointmentRecord !== null &&
      appointmentRecord.studioId === params.p_studio_id &&
      appointmentRecord.clientId === params.p_client_id &&
      appointmentRecord.clientPackageId === params.p_client_package_id;

    if (!appointmentMatches) {
      return Promise.resolve({
        data: null,
        error: {
          message:
            "Appointment does not match the supplied studio, client, and package.",
        },
      });
    }

    const wasAlreadyDeducted = alreadyDeducted(params);
    const foundItem = state.packageActive;

    if (!foundItem) {
      if (wasAlreadyDeducted) {
        return Promise.resolve({
          data: [
            {
              found_item: false,
              already_deducted: true,
              is_unlimited: false,
              quantity_used: null,
              quantity_remaining: null,
            },
          ],
          error: null,
        });
      }

      return Promise.resolve({
        data: null,
        error: {
          message:
            "No matching active package credit was found for this appointment.",
        },
      });
    }

    if (state.isUnlimited) {
      if (!wasAlreadyDeducted) {
        state.transactions.push({
          id: `txn-${state.transactions.length + 1}`,
          appointment_id: params.p_appointment_id,
          client_package_id: params.p_client_package_id,
          transaction_type: "lesson_deduction",
          lessons_delta: 0,
          balance_after: null,
        });
      }

      return Promise.resolve({
        data: [
          {
            found_item: true,
            already_deducted: wasAlreadyDeducted,
            is_unlimited: true,
            quantity_used: state.quantityUsed,
            quantity_remaining: state.quantityRemaining,
          },
        ],
        error: null,
      });
    }

    let nextUsed = state.quantityUsed;
    let nextRemaining = state.quantityRemaining;

    if (!wasAlreadyDeducted) {
      if (nextRemaining <= 0) {
        return Promise.resolve({
          data: null,
          error: { message: "The selected package has no remaining credits." },
        });
      }

      nextUsed += 1;
      nextRemaining -= 1;

      state.quantityUsed = nextUsed;
      state.quantityRemaining = nextRemaining;
      state.itemUpdateCalls.push({
        quantity_used: nextUsed,
        quantity_remaining: nextRemaining,
      });
      state.transactions.push({
        id: `txn-${state.transactions.length + 1}`,
        appointment_id: params.p_appointment_id,
        client_package_id: params.p_client_package_id,
        transaction_type: "lesson_deduction",
        lessons_delta: -1,
        balance_after: nextRemaining,
      });
    }

    if (params.p_usage_type === "private_lesson") {
      const priorLegacyRemainingWasSet = state.legacyLessonsRemaining !== null;
      state.legacyLessonsUsed = nextUsed;
      if (priorLegacyRemainingWasSet) {
        state.legacyLessonsRemaining = nextRemaining;
      }
      state.packagesUpdateCalls.push({
        lessons_used: nextUsed,
        ...(priorLegacyRemainingWasSet
          ? { lessons_remaining: nextRemaining }
          : {}),
      });
    } else {
      state.packagesUpdateCalls.push({ updated_at: true });
    }

    return Promise.resolve({
      data: [
        {
          found_item: true,
          already_deducted: wasAlreadyDeducted,
          is_unlimited: false,
          quantity_used: nextUsed,
          quantity_remaining: nextRemaining,
        },
      ],
      error: null,
    });
  }

  const supabase = {
    from(table: string) {
      if (table === "client_packages") {
        return {
          select: () =>
            makeChain(() => ({
              data: state.packageActive
                ? [
                    {
                      id: options.clientPackageId,
                      active: true,
                      client_package_items: [
                        {
                          quantity_remaining: state.quantityRemaining,
                          is_unlimited: state.isUnlimited,
                        },
                      ],
                    },
                  ]
                : [],
              error: null,
            })),
          update: (payload: Record<string, unknown>) => {
            state.packagesUpdateCalls.push(payload);
            if (payload.active === false) {
              state.packageActive = false;
            }
            return makeChain(() => ({ error: null }));
          },
        };
      }

      if (table === "automation_actions") {
        return { select: () => makeChain(() => ({ data: [], error: null })) };
      }

      throw new Error(`Unexpected table in fake package db: ${table}`);
    },
    rpc,
  };

  return { supabase, state };
}

const baseParams = {
  studioId: "studio-1",
  appointmentId: "appt-1",
  clientId: "client-1",
  clientPackageId: "package-1",
};

describe("syncPackageUsageForAttendedAppointment — P0.1 double-deduction fix", () => {
  it("normal first-time attendance (no prior marker) deducts exactly one credit", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 5,
    });

    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(state.itemUpdateCalls).toHaveLength(1);
    expect(state.quantityUsed).toBe(1);
    expect(state.quantityRemaining).toBe(4);
    expect(
      state.transactions.filter((t) => t.transaction_type === "lesson_deduction"),
    ).toHaveLength(1);
    expect(state.packagesUpdateCalls.at(-1)).toMatchObject({ lessons_used: 1 });
  });

  it("historical appointment_attendance row present → no second deduction", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 1,
      quantityRemaining: 4,
      seedDeductionMarker: "appointment_attendance",
    });

    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(state.itemUpdateCalls).toHaveLength(0);
    expect(state.quantityRemaining).toBe(4);
    expect(state.quantityUsed).toBe(1);
    expect(
      state.transactions.filter(
        (t) =>
          t.transaction_type === "lesson_deduction" ||
          t.transaction_type === "appointment_attendance",
      ),
    ).toHaveLength(1);
    expect(state.packagesUpdateCalls.at(-1)).toMatchObject({ lessons_used: 1 });
  });

  it("new lesson_deduction row present (trigger already ran) → no second deduction", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 1,
      quantityRemaining: 4,
      seedDeductionMarker: "lesson_deduction",
    });

    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(state.itemUpdateCalls).toHaveLength(0);
    expect(state.quantityRemaining).toBe(4);
    expect(state.quantityUsed).toBe(1);
    expect(
      state.transactions.filter((t) => t.transaction_type === "lesson_deduction"),
    ).toHaveLength(1);
    expect(state.packagesUpdateCalls.at(-1)).toMatchObject({ lessons_used: 1 });
  });

  it("already-attended appointment replay → no duplicate financial effect (legacy marker)", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 1,
      quantityRemaining: 4,
      seedDeductionMarker: "appointment_attendance",
    });

    // Simulates markAppointmentAttendedAction being invoked twice for an
    // appointment that was already attended under the pre-fix marker.
    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });
    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(state.itemUpdateCalls).toHaveLength(0);
    expect(state.quantityRemaining).toBe(4);
    expect(
      state.transactions.filter(
        (t) =>
          t.transaction_type === "lesson_deduction" ||
          t.transaction_type === "appointment_attendance",
      ),
    ).toHaveLength(1);
  });

  it("replaying a fresh sole-deductor charge does not consume a second credit", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 4,
      quantityRemaining: 1,
    });

    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(state.quantityRemaining).toBe(0);
    expect(state.itemUpdateCalls).toHaveLength(1);
    expect(
      state.transactions.find((t) => t.transaction_type === "lesson_deduction"),
    ).toMatchObject({ lessons_delta: -1, balance_after: 0 });

    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(state.quantityRemaining).toBe(0);
    expect(state.itemUpdateCalls).toHaveLength(1);
  });

  it("does not deduct when the appointment has no linked package", async () => {
    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: {
          from() {
            throw new Error("Expected no database access");
          },
          rpc() {
            throw new Error("Expected no rpc call");
          },
        } as never,
        studioId: baseParams.studioId,
        appointmentId: baseParams.appointmentId,
        clientId: baseParams.clientId,
        appointmentType: "private_lesson",
        clientPackageId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not deduct for an appointment type with no qualifying package usage type", async () => {
    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: {
          from() {
            throw new Error("Expected no database access");
          },
          rpc() {
            throw new Error("Expected no rpc call");
          },
        } as never,
        ...baseParams,
        appointmentType: "floor_rental",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws deterministically when the RPC call fails", async () => {
    const { supabase } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 5,
      rpcError: "connection reset",
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentType: "private_lesson",
      }),
    ).rejects.toThrow("connection reset");
  });

  it("throws when no active package credit is found and nothing was already deducted", async () => {
    const { supabase } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 0,
      packageActive: false,
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentType: "private_lesson",
      }),
    ).rejects.toThrow("No matching active package credit was found");
  });

  it("does not throw on replay after the package was already reconciled to inactive", async () => {
    const { supabase } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 5,
      quantityRemaining: 0,
      packageActive: false,
      seedDeductionMarker: "lesson_deduction",
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentType: "private_lesson",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws deterministically when the sole deductor finds zero remaining credit", async () => {
    const { supabase } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 5,
      quantityRemaining: 0,
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentType: "private_lesson",
      }),
    ).rejects.toThrow("no remaining credits");
  });

  it("records unlimited-package usage exactly once, even under replay", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 0,
      isUnlimited: true,
    });

    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "group_class",
    });
    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "group_class",
    });

    expect(
      state.transactions.filter((t) => t.transaction_type === "lesson_deduction"),
    ).toHaveLength(1);
    expect(state.itemUpdateCalls).toHaveLength(0);
  });

  it("does not perform any direct read-then-write against client_package_items or lesson_transactions", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 5,
    });
    const rpcSpy = vi.fn(supabase.rpc);
    const spiedSupabase = { ...supabase, rpc: rpcSpy };

    // The fake's `from()` throws on any table other than client_packages /
    // automation_actions, so if the deduction logic regressed back to
    // touching client_package_items or lesson_transactions directly (the
    // non-atomic pattern that caused the P0.1 concurrency gap), this test
    // fails immediately rather than silently passing.
    await syncPackageUsageForAttendedAppointment({
      supabase: spiedSupabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      "deduct_package_credit_for_appointment",
      expect.objectContaining({
        p_studio_id: baseParams.studioId,
        p_client_id: baseParams.clientId,
        p_client_package_id: baseParams.clientPackageId,
        p_appointment_id: baseParams.appointmentId,
        p_usage_type: "private_lesson",
      }),
    );
    expect(state.rpcCallCount).toBe(1);
  });
});

describe("deduct_package_credit_for_appointment RPC authorization contract", () => {
  it("an authorized caller for the correct studio succeeds", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 5,
      callerAuthorizedForStudio: true,
    });

    await syncPackageUsageForAttendedAppointment({
      supabase: supabase as never,
      ...baseParams,
      appointmentType: "private_lesson",
    });

    expect(state.quantityRemaining).toBe(4);
    expect(state.itemUpdateCalls).toHaveLength(1);
  });

  it("a caller without an authorized role for the studio is rejected, and no balance is mutated", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 5,
      callerAuthorizedForStudio: false,
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentType: "private_lesson",
      }),
    ).rejects.toThrow("Not authorized");

    expect(state.itemUpdateCalls).toHaveLength(0);
    expect(state.quantityRemaining).toBe(5);
    expect(state.transactions).toHaveLength(0);
  });

  it("cross-tenant invocation (appointment belongs to a different studio) is rejected, and no balance is mutated", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 5,
      // The real appointment this id/package belong to is under a
      // different studio than the caller is asserting.
      appointmentRecord: {
        studioId: "studio-other",
        clientId: baseParams.clientId,
        clientPackageId: baseParams.clientPackageId,
      },
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentType: "private_lesson",
      }),
    ).rejects.toThrow("does not match the supplied studio");

    expect(state.itemUpdateCalls).toHaveLength(0);
    expect(state.quantityRemaining).toBe(5);
    expect(state.transactions).toHaveLength(0);
  });

  it("a fabricated appointment id (no matching appointment at all) is rejected, and no balance is mutated", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: "appt-does-not-exist",
      quantityUsed: 0,
      quantityRemaining: 5,
      appointmentRecord: null,
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentId: "appt-does-not-exist",
        appointmentType: "private_lesson",
      }),
    ).rejects.toThrow("does not match the supplied studio");

    expect(state.itemUpdateCalls).toHaveLength(0);
    expect(state.quantityRemaining).toBe(5);
    expect(state.transactions).toHaveLength(0);
  });

  it("a mismatched client_package_id on an otherwise-real appointment is rejected, and no balance is mutated", async () => {
    const { supabase, state } = createFakePackageDb({
      studioId: baseParams.studioId,
      clientId: baseParams.clientId,
      clientPackageId: baseParams.clientPackageId,
      appointmentId: baseParams.appointmentId,
      quantityUsed: 0,
      quantityRemaining: 5,
      // The real appointment is tied to a different client's package.
      appointmentRecord: {
        studioId: baseParams.studioId,
        clientId: baseParams.clientId,
        clientPackageId: "someone-elses-package",
      },
    });

    await expect(
      syncPackageUsageForAttendedAppointment({
        supabase: supabase as never,
        ...baseParams,
        appointmentType: "private_lesson",
      }),
    ).rejects.toThrow("does not match the supplied studio");

    expect(state.itemUpdateCalls).toHaveLength(0);
    expect(state.quantityRemaining).toBe(5);
    expect(state.transactions).toHaveLength(0);
  });
});
