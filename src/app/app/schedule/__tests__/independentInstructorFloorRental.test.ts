import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1: Independent Instructor Authorization Correction.
 *
 * SR-A found that `independent_instructor` was granted general staff
 * appointment create/edit/attendance authority (via canCreateAppointments/
 * canEditAppointments/canMarkAttendance), with the intended narrowing --
 * acting only on their own floor-rental relationship -- enforced in just
 * one branch of createAppointmentAction. Every other appointment-mutating
 * action (updateAppointmentAction, deleteAppointmentAction,
 * cancelAppointmentAction, and non-floor-rental appointmentType values
 * inside createAppointmentAction/updateAppointmentAction) was reachable
 * with no scoping at all -- and updateAppointmentAction did not even
 * select the EXISTING appointment's client_id/appointment_type, so an
 * independent_instructor could retarget an unrelated appointment by
 * submitting a floor-rental-shaped form for someone else's appointmentId.
 *
 * The fix: canCreateAppointments/canEditAppointments/canMarkAttendance no
 * longer include independent_instructor (see permissions.independent
 * Instructor.test.ts for that layer). The four appointment-lifecycle
 * actions independent instructors legitimately need
 * (create/update/delete/cancel their OWN floor-rental booking) now use a
 * new, narrow requireFloorRentalAppointmentAccess guard, followed by an
 * explicit, data-layer requireOwnFloorRentalTarget check verifying the
 * TARGET (submitted, and -- for update/delete/cancel -- the appointment's
 * actual EXISTING stored client_id/appointment_type) is genuinely this
 * user's own client_account_links-linked record in this studio, not
 * merely "some" independent-instructor-flagged client.
 *
 * This suite drives the real actions (not stand-ins), with
 * requireFloorRentalAppointmentAccess mocked to hand back a fake Supabase
 * client plus a controllable studioRole -- exactly mirroring the
 * established markAppointmentAttendedAction.test.ts convention of mocking
 * the serverRoleGuard entry point while exercising the action's own real
 * logic. detectAppointmentConflicts, package/compensation side-effect
 * helpers are mocked (per that same established convention) since they are
 * unrelated to the authorization boundary under test.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
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
  stageInstructorEarningForAppointment: vi
    .fn()
    .mockResolvedValue({ staged: false, reason: "not_exercised_by_this_test" }),
}));

vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: vi
    .fn()
    .mockResolvedValue({ completedPackageIds: [] }),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...args: unknown[]) =>
    requireFloorRentalAppointmentAccessMock(...args),
  requireAppointmentCreateAccess: vi.fn(),
  requireAppointmentEditAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));

const {
  createAppointmentAction,
  updateAppointmentAction,
  deleteAppointmentAction,
  cancelAppointmentAction,
} = await import("@/app/app/schedule/actions");

type Row = Record<string, unknown>;
type FakeResult = { data?: unknown; error?: { message: string } | null };

// `onEq` records every `.eq(column, value)` call made against this chain
// (in call order) so a table's resolver can inspect exactly what was
// filtered on -- avoids any monkey-patching of the chain after the fact.
function makeChain(
  resolve: (filters: Record<string, unknown>) => FakeResult | Promise<FakeResult>,
) {
  const filters: Record<string, unknown> = {};
  const chain = {
    eq(col: string, val: unknown) {
      filters[col] = val;
      return chain;
    },
    in(col: string, vals: unknown[]) {
      filters[col] = vals;
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    select() {
      return chain;
    },
    async maybeSingle(): Promise<FakeResult> {
      const result = await resolve(filters);
      if (result.error) return { data: null, error: result.error };
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data
          ? [result.data]
          : [];
      return { data: rows[0] ?? null, error: null };
    },
    async single(): Promise<FakeResult> {
      const result = await resolve(filters);
      if (result.error) return { data: null, error: result.error };
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data
          ? [result.data]
          : [];
      if (!rows.length) return { data: null, error: { message: "Row not found" } };
      return { data: rows[0], error: null };
    },
    then(
      onFulfilled: (value: FakeResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(resolve(filters)).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

const STUDIO_ID = "studio-1";
const STAFF_USER_ID = "staff-1";
const INSTRUCTOR_USER_ID = "instructor-user-1";
const OWN_CLIENT_ID = "client-own-instructor-record";
const UNRELATED_CLIENT_ID = "client-unrelated-lesson-client";
const OTHER_STUDIO_ID = "studio-2";
const APPOINTMENT_ID = "appt-1";

function linkRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `link-${Math.random().toString(36).slice(2)}`,
    studio_id: STUDIO_ID,
    client_id: OWN_CLIENT_ID,
    user_id: INSTRUCTOR_USER_ID,
    status: "linked",
    ...overrides,
  };
}

function clientRow(overrides: Partial<Row> = {}): Row {
  return {
    id: OWN_CLIENT_ID,
    studio_id: STUDIO_ID,
    status: "active",
    is_independent_instructor: true,
    ...overrides,
  };
}

function appointmentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: APPOINTMENT_ID,
    studio_id: STUDIO_ID,
    client_id: OWN_CLIENT_ID,
    appointment_type: "floor_space_rental",
    status: "scheduled",
    starts_at: "2020-01-01T10:00:00",
    ends_at: "2020-01-01T11:00:00",
    recurrence_series_id: null,
    payment_status: "waived",
    ...overrides,
  };
}

function createFakeSupabase(options: {
  links?: Row[];
  clients?: Row[];
  existingAppointment?: Row | null;
}) {
  const state = {
    links: options.links ?? [],
    clients: options.clients ?? [clientRow()],
    existingAppointment: options.existingAppointment ?? null,
    insertedAppointmentRows: [] as Row[],
    updateCalls: [] as Row[],
    deleteCalls: 0,
    seq: 0,
  };

  const supabase = {
    from(table: string) {
      if (table === "client_account_links") {
        return {
          select: () =>
            makeChain((filters) => {
              const match = state.links.find(
                (row) =>
                  row.studio_id === filters.studio_id &&
                  row.client_id === filters.client_id &&
                  row.user_id === filters.user_id &&
                  row.status === filters.status,
              );
              return { data: match ?? null, error: null };
            }),
        };
      }

      if (table === "clients") {
        return {
          select: () =>
            makeChain((filters) => {
              const match = state.clients.find((row) => row.id === filters.id);
              return { data: match ?? null, error: null };
            }),
        };
      }

      if (table === "appointments") {
        return {
          select: () =>
            makeChain((filters) => {
              if (
                filters.id &&
                state.existingAppointment?.id === filters.id
              ) {
                return { data: { ...state.existingAppointment }, error: null };
              }
              return { data: null, error: { message: "Row not found" } };
            }),
          insert: (rows: Row | Row[]) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const inserted = list.map((row) => {
              state.seq += 1;
              return { id: `new-appt-${state.seq}`, ...row };
            });
            state.insertedAppointmentRows.push(...inserted);
            return makeChain(() => ({ data: inserted, error: null }));
          },
          update: (payload: Row) => {
            state.updateCalls.push(payload);
            return makeChain(() => ({ data: null, error: null }));
          },
          delete: () => {
            state.deleteCalls += 1;
            return makeChain(() => ({ data: null, error: null }));
          },
        };
      }

      // Any other table this run happens to touch (e.g. lead_activities,
      // outbound_deliveries) safely no-ops -- exercised only via the
      // already-tested graceful-return branches of
      // promoteLeadClientAfterBookedAppointment/queueAppointmentOutbound
      // Delivery when their own preconditions (non-"lead" client status,
      // past-dated slot) aren't met.
      return {
        select: () => makeChain(() => ({ data: null, error: null })),
        insert: () => makeChain(() => ({ data: null, error: null })),
        update: () => makeChain(() => ({ data: null, error: null })),
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

async function runAction(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

beforeEach(() => {
  requireFloorRentalAppointmentAccessMock.mockReset();
});

function mockGuard(options: {
  supabase: unknown;
  studioId?: string;
  studioRole: string;
  userId: string;
}) {
  requireFloorRentalAppointmentAccessMock.mockResolvedValue({
    supabase: options.supabase,
    studioId: options.studioId ?? STUDIO_ID,
    studioRole: options.studioRole,
    user: { id: options.userId },
    isPlatformAdmin: false,
  });
}

describe("createAppointmentAction -- FC-1", () => {
  it("independent instructor CANNOT create a normal lesson appointment for an unrelated host-studio client", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow()],
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const result = await createAppointmentAction(
      {},
      formDataFor({
        clientId: UNRELATED_CLIENT_ID,
        appointmentType: "private_lesson",
      }),
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("floor space rental"),
    });
    expect(state.insertedAppointmentRows).toHaveLength(0);
  });

  it("independent instructor CANNOT create a floor rental appointment for a DIFFERENT independent instructor's client record", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow()], // only linked to OWN_CLIENT_ID, not UNRELATED_CLIENT_ID
      clients: [clientRow(), clientRow({ id: UNRELATED_CLIENT_ID })],
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const result = await createAppointmentAction(
      {},
      formDataFor({
        clientId: UNRELATED_CLIENT_ID,
        appointmentType: "floor_space_rental",
        slotsJson: JSON.stringify([
          { date: "2020-01-01", startTime: "10:00", endTime: "11:00" },
        ]),
      }),
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("your own"),
    });
    expect(state.insertedAppointmentRows).toHaveLength(0);
  });

  it("a REVOKED/unlinked independent-instructor relationship does not retain floor-rental authority", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow({ status: "disconnected" })],
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const result = await createAppointmentAction(
      {},
      formDataFor({
        clientId: OWN_CLIENT_ID,
        appointmentType: "floor_space_rental",
        slotsJson: JSON.stringify([
          { date: "2020-01-01", startTime: "10:00", endTime: "11:00" },
        ]),
      }),
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("your own"),
    });
    expect(state.insertedAppointmentRows).toHaveLength(0);
  });

  it("independent instructor CAN book their own eligible floor-rental slot (legitimate behavior preserved)", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow()],
      clients: [clientRow()],
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const error = await runAction(
      createAppointmentAction(
        {},
        formDataFor({
          clientId: OWN_CLIENT_ID,
          appointmentType: "floor_space_rental",
          slotsJson: JSON.stringify([
            { date: "2020-01-01", startTime: "10:00", endTime: "11:00" },
          ]),
        }),
      ),
    );

    expect(digestUrl(error)).toContain("/app/schedule/");
    expect(state.insertedAppointmentRows).toHaveLength(1);
    expect(state.insertedAppointmentRows[0]).toMatchObject({
      client_id: OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
    });
  });

  it("studio owner behavior is unchanged -- can still create an ordinary lesson appointment", async () => {
    const { supabase } = createFakeSupabase({
      clients: [clientRow({ id: UNRELATED_CLIENT_ID, is_independent_instructor: false })],
    });
    mockGuard({ supabase, studioRole: "studio_owner", userId: STAFF_USER_ID });

    // Reaching the general (non-floor-rental) booking path exercises a lot
    // of unrelated package/membership/conflict machinery already mocked
    // above; here we only need to confirm staff are NOT blocked by the
    // FC-1 gate itself (i.e. execution proceeds past requireOwnFloorRental
    // Target, which never runs for non-independent-instructor roles) and
    // that the fix didn't touch the client-selection field requirement.
    const result = await createAppointmentAction(
      {},
      formDataFor({
        clientId: "",
        appointmentType: "private_lesson",
      }),
    );

    // Missing clientId is rejected by the action's own pre-existing
    // validation (unrelated to FC-1) -- proves we reached that check, i.e.
    // the new FC-1 gate did not reject the studio_owner role itself.
    expect(result).toEqual({ error: "Client and appointment type are required." });
  });
});

describe("updateAppointmentAction -- FC-1", () => {
  it("independent instructor CANNOT edit an unrelated host-studio appointment (existing appointment belongs to someone else)", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow()],
      existingAppointment: appointmentRow({
        client_id: UNRELATED_CLIENT_ID,
        appointment_type: "private_lesson",
      }),
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const result = await updateAppointmentAction(
      {},
      formDataFor({
        appointmentId: APPOINTMENT_ID,
        clientId: OWN_CLIENT_ID, // honest-looking submitted value
        appointmentType: "floor_space_rental", // honest-looking submitted value
        startsAt: "2020-01-01T10:00:00",
        endsAt: "2020-01-01T11:00:00",
      }),
    );

    // Must be rejected specifically because the EXISTING appointment was
    // never their own floor rental (its stored appointment_type is
    // "private_lesson") -- not any other incidental error -- proving the
    // fix re-checks stored state, not just the honest-looking submitted
    // form. "floor space rental bookings" is common to both of
    // requireOwnFloorRentalTarget's rejection messages (type mismatch and
    // ownership mismatch), so this stays specific to the FC-1 check
    // without over-fitting to which of the two branches fires first.
    expect(result).toMatchObject({
      error: expect.stringContaining("floor space rental bookings"),
    });
    expect(state.updateCalls).toHaveLength(0);
  });

  it("independent instructor CANNOT retarget their own floor rental appointment onto an unrelated client via the submitted form", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow()],
      existingAppointment: appointmentRow(), // this one genuinely is their own
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const result = await updateAppointmentAction(
      {},
      formDataFor({
        appointmentId: APPOINTMENT_ID,
        clientId: UNRELATED_CLIENT_ID, // attempting to retarget
        appointmentType: "floor_space_rental",
        startsAt: "2020-01-01T10:00:00",
        endsAt: "2020-01-01T11:00:00",
      }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("your own") });
    expect(state.updateCalls).toHaveLength(0);
  });

  it("studio owner behavior is unchanged -- editing an ordinary appointment is not blocked by the FC-1 gate", async () => {
    const { supabase } = createFakeSupabase({
      existingAppointment: appointmentRow({
        appointment_type: "private_lesson",
        client_id: UNRELATED_CLIENT_ID,
      }),
    });
    mockGuard({ supabase, studioRole: "studio_owner", userId: STAFF_USER_ID });

    const result = await updateAppointmentAction(
      {},
      formDataFor({
        appointmentId: "",
        clientId: "",
        appointmentType: "",
      }),
    );

    // Missing-fields validation is pre-existing/unrelated to FC-1; reaching
    // it (rather than an FC-1 authorization error) proves studio_owner is
    // not gated by the new independent-instructor-only check.
    expect(result).toEqual({ error: "Missing required appointment fields." });
  });
});

describe("deleteAppointmentAction -- FC-1", () => {
  it("independent instructor CANNOT delete an unrelated host-studio appointment", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow()],
      existingAppointment: appointmentRow({
        client_id: UNRELATED_CLIENT_ID,
        appointment_type: "private_lesson",
        status: "scheduled",
      }),
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const error = await runAction(
      deleteAppointmentAction(
        formDataFor({
          appointmentId: APPOINTMENT_ID,
          confirmDeleteAppointment: "DELETE",
        }),
      ),
    );

    expect(digestUrl(error)).toContain("error=not_own_floor_rental");
    expect(state.deleteCalls).toBe(0);
  });
});

describe("cancelAppointmentAction -- FC-1", () => {
  it("independent instructor CANNOT cancel an unrelated host-studio appointment", async () => {
    const { supabase, state } = createFakeSupabase({
      links: [linkRow()],
      existingAppointment: appointmentRow({
        client_id: UNRELATED_CLIENT_ID,
        appointment_type: "private_lesson",
      }),
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const error = await runAction(
      cancelAppointmentAction(
        formDataFor({
          appointmentId: APPOINTMENT_ID,
          cancellationReason: "No longer needed",
          cancellationRequestedBy: "instructor",
        }),
      ),
    );

    expect(digestUrl(error)).toContain("error=not_own_floor_rental");
    expect(state.updateCalls).toHaveLength(0);
  });
});

describe("cross-host isolation -- FC-1", () => {
  it("a client_account_links row linked at a DIFFERENT studio does not satisfy the current session's studio-scoped ownership check", async () => {
    const { supabase, state } = createFakeSupabase({
      // Linked, but at OTHER_STUDIO_ID, not the current session's STUDIO_ID.
      links: [linkRow({ studio_id: OTHER_STUDIO_ID })],
    });
    mockGuard({ supabase, studioRole: "independent_instructor", userId: INSTRUCTOR_USER_ID });

    const result = await createAppointmentAction(
      {},
      formDataFor({
        clientId: OWN_CLIENT_ID,
        appointmentType: "floor_space_rental",
        slotsJson: JSON.stringify([
          { date: "2020-01-01", startTime: "10:00", endTime: "11:00" },
        ]),
      }),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("your own") });
    expect(state.insertedAppointmentRows).toHaveLength(0);
  });
});
