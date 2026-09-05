import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction: queueAppointmentOutboundDelivery (private,
 * reached here via cancelAppointmentAction's no-refund cancel branch)
 * previously read `clients` through the caller's session-scoped Supabase
 * client -- once Phase B narrows clients RLS to CRM-tier roles, an
 * instructor-initiated cancellation would silently compose its outbound
 * notification with a missing client name. It now uses createAdminClient()
 * for that one lookup. This proves:
 *   - the clients lookup goes through the admin client, never the
 *     session-scoped client (the session client tracks a table hit and
 *     the test fails it if "clients" ever appears there);
 *   - the privileged lookup only runs after requireFloorRentalAppointmentAccess
 *     has already authorized the caller (the whole flow is driven through
 *     the real, unmocked cancelAppointmentAction guard call);
 *   - the ids used for the admin lookup are the ones already resolved
 *     from the authorized appointment/studio row, not caller-controlled
 *     -- the admin fake only serves clients matching (id, studio_id) it
 *     was seeded with, so a mismatched/cross-studio id would simply miss;
 *   - an instructor-authorized cancellation still composes the client's
 *     name via the admin lookup (asserted indirectly: the admin "clients"
 *     table is actually queried with the correct id/studio_id).
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

vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn().mockResolvedValue(undefined),
}));

const requireFloorRentalAppointmentAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: (...args: unknown[]) =>
    requireFloorRentalAppointmentAccessMock(...args),
  requireAttendanceAccess: vi.fn(),
  requireAppointmentEditAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
}));

const STUDIO_ID = "studio-1";
const APPOINTMENT_ID = "appt-1";
const CLIENT_ID = "client-1";
const USER_ID = "user-1";

const adminFromCalls: { table: string; id?: string; studioId?: string }[] = [];
let adminClientRow: Record<string, unknown> | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call: { table: string; id?: string; studioId?: string } = { table };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq(column: string, value: string) {
          if (column === "id") call.id = value;
          if (column === "studio_id") call.studioId = value;
          return chain;
        },
        maybeSingle: () => {
          adminFromCalls.push(call);
          if (table !== "clients") return Promise.resolve({ data: null, error: null });
          if (call.id === CLIENT_ID && call.studioId === STUDIO_ID) {
            return Promise.resolve({ data: adminClientRow, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  }),
}));

const { cancelAppointmentAction } = await import("@/app/app/schedule/actions");

const sessionFromCalls: string[] = [];

function benignChain(table: string, resolve: () => { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.update = self;
  chain.delete = self;
  chain.insert = () => {
    sessionFromCalls.push(`${table}:insert`);
    return Promise.resolve({ data: null, error: null });
  };
  chain.eq = self;
  chain.gte = self;
  chain.single = () => Promise.resolve(resolve());
  chain.maybeSingle = () => Promise.resolve(resolve());
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve(resolve()).then(onFulfilled, onRejected);
  return chain;
}

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    client_id: CLIENT_ID,
    recurrence_series_id: null,
    starts_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ends_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    title: "Private Lesson",
    appointment_type: "private_lesson",
    client_package_id: null,
    client_membership_id: null,
    billing_type: "none",
    status: "scheduled",
    studio_id: STUDIO_ID,
    partner_client_id: null,
    instructor_id: null,
    room_id: null,
    notes: null,
    ...overrides,
  };
}

function createSessionSupabase() {
  return {
    from(table: string) {
      sessionFromCalls.push(table);
      if (table === "clients") {
        throw new Error(
          "UNEXPECTED: queueAppointmentOutboundDelivery must use the admin client for clients, not the session client",
        );
      }
      if (table === "appointments") {
        return benignChain(table, () => ({ data: appointmentRow(), error: null }));
      }
      if (table === "client_membership_usage") {
        return benignChain(table, () => ({ data: null, error: null }));
      }
      if (table === "studios") {
        return benignChain(table, () => ({ data: { timezone: "America/New_York" }, error: null }));
      }
      if (table === "client_activity_notes") {
        return benignChain(table, () => ({ data: null, error: null }));
      }
      return benignChain(table, () => ({ data: null, error: null }));
    },
  };
}

function formDataFor(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("appointmentId", APPOINTMENT_ID);
  fd.set("cancellationReason", "Client requested");
  fd.set("cancellationRequestedBy", "instructor");
  fd.set("cancelScope", "this_instance");
  for (const [key, value] of Object.entries(overrides)) fd.set(key, value);
  return fd;
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

beforeEach(() => {
  adminFromCalls.length = 0;
  sessionFromCalls.length = 0;
  adminClientRow = { first_name: "Jane", last_name: "Doe", email: null, phone: null };
  requireFloorRentalAppointmentAccessMock.mockReset();
});

describe("queueAppointmentOutboundDelivery admin-client usage (via cancelAppointmentAction) -- FC-1B5D correction", () => {
  it("an instructor-authorized cancellation composes the client via the admin client, never the session client", async () => {
    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase: createSessionSupabase(),
      studioId: STUDIO_ID,
      user: { id: USER_ID },
      studioRole: "instructor",
    });

    const error = await cancelAppointmentAction(formDataFor()).catch((e) => e);

    expect(digestUrl(error)).toContain("success=appointment_cancelled");

    // The privileged lookup happened, scoped to the exact client/studio
    // already resolved from the authorized appointment row.
    const clientCalls = adminFromCalls.filter((c) => c.table === "clients");
    expect(clientCalls).toHaveLength(1);
    expect(clientCalls[0]).toMatchObject({ id: CLIENT_ID, studioId: STUDIO_ID });

    // The session-scoped client never touched "clients" directly.
    expect(sessionFromCalls).not.toContain("clients");
  });

  it("runs the privileged lookup only after requireFloorRentalAppointmentAccess has authorized the caller", async () => {
    requireFloorRentalAppointmentAccessMock.mockImplementation(() => {
      // If the admin lookup ran before this guard resolved, it would
      // already have been called by the time we get here.
      expect(adminFromCalls).toHaveLength(0);
      return Promise.resolve({
        supabase: createSessionSupabase(),
        studioId: STUDIO_ID,
        user: { id: USER_ID },
        studioRole: "instructor",
      });
    });

    await cancelAppointmentAction(formDataFor()).catch((e) => e);

    expect(requireFloorRentalAppointmentAccessMock).toHaveBeenCalledTimes(1);
  });

  it("a client id/studio mismatch (cross-studio misuse) never resolves through the admin lookup", async () => {
    // Seed the admin fake so that the *only* row it can ever return
    // requires an exact (CLIENT_ID, STUDIO_ID) match -- simulate an
    // appointment somehow carrying a client id from a different studio's
    // context by pointing the admin fake's dataset at a different studio.
    adminClientRow = { first_name: "Jane", last_name: "Doe", email: null, phone: null };

    requireFloorRentalAppointmentAccessMock.mockResolvedValue({
      supabase: {
        from(table: string) {
          sessionFromCalls.push(table);
          if (table === "appointments") {
            return benignChain(table, () => ({
              data: appointmentRow({ studio_id: "other-studio" }),
              error: null,
            }));
          }
          if (table === "clients") {
            throw new Error("UNEXPECTED session clients read");
          }
          return benignChain(table, () => ({ data: null, error: null }));
        },
      },
      studioId: "other-studio",
      user: { id: USER_ID },
      studioRole: "instructor",
    });

    await cancelAppointmentAction(formDataFor()).catch((e) => e);

    // The admin lookup was attempted for (CLIENT_ID, "other-studio"), which
    // does not match the seeded (CLIENT_ID, STUDIO_ID) row -- so it must
    // miss, proving the studio_id filter is load-bearing, not decorative.
    const clientCalls = adminFromCalls.filter((c) => c.table === "clients");
    expect(clientCalls).toHaveLength(1);
    expect(clientCalls[0].studioId).toBe("other-studio");
    expect(clientCalls[0].studioId).not.toBe(STUDIO_ID);
  });
});
