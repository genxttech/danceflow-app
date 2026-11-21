import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Marketing M-0 stage-2 precondition: deleteAppointmentAction clears the appointment's queued notifications. Stage 2
 * removes every client-role write to outbound_deliveries, so that delete must use the service-role client; the user
 * client is only used for the appointment checks and the appointment delete itself.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) => typeof (error as { digest?: string })?.digest === "string",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => ({
  userTables: [] as string[],
  adminOps: [] as Array<{ table: string; op: string; filters: Array<[string, unknown]> }>,
  adminResult: { error: null as null | { message: string } },
  adminThrows: false,
}));

function chainFor(table: string, record: (op: string, filters: Array<[string, unknown]>) => void, result: () => unknown) {
  const filters: Array<[string, unknown]> = [];
  let op = "select";
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.delete = () => {
    op = "delete";
    return chain;
  };
  chain.eq = (c: string, v: unknown) => {
    filters.push([c, v]);
    return chain;
  };
  chain.in = (c: string, v: unknown) => {
    filters.push([c, v]);
    return chain;
  };
  chain.single = () => Promise.resolve({ data: { id: "appt-1", client_id: null, appointment_type: "private_lesson", status: "scheduled", group_class_series_id: null }, error: null });
  chain.then = (resolve: (v: unknown) => void) => {
    record(op, filters);
    return resolve(result());
  };
  return chain;
}

const userSupabase = {
  from(table: string) {
    h.userTables.push(table);
    return chainFor(table, () => undefined, () => ({ data: null, error: null, count: 0 }));
  },
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (h.adminThrows) throw new Error("admin unavailable");
    return {
      from(table: string) {
        return chainFor(table, (op, filters) => h.adminOps.push({ table, op, filters }), () => h.adminResult);
      },
    };
  },
}));
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireAppointmentDeleteAccess: async () => ({ supabase: userSupabase, studioId: "studio-1" }),
  requireFloorRentalAppointmentAccess: vi.fn(),
  requireAppointmentEditAccess: vi.fn(),
  requireAppointmentPaymentAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));
vi.mock("@/lib/auth/appointmentAccess", () => ({ requireAppointmentRelationshipAccess: vi.fn() }));
vi.mock("@/lib/schedule/conflicts", () => ({ detectAppointmentConflicts: vi.fn() }));
vi.mock("@/lib/compensation/earnings", () => ({ stageInstructorEarningForAppointment: vi.fn() }));
vi.mock("@/lib/packages/lifecycle", () => ({ reconcileClientPackageLifecycle: vi.fn() }));
vi.mock("@/lib/instructors/assignability", () => ({
  isInstructionalAppointmentType: () => true,
  validateAssignableInstructor: vi.fn(),
  assignmentRelationshipChanged: () => true,
}));
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendAppointmentSchedulePush: vi.fn(),
  sendGroupClassCancellationPush: vi.fn(),
}));

const { deleteAppointmentAction } = await import("../actions");

async function run() {
  const fd = new FormData();
  fd.set("appointmentId", "appt-1");
  fd.set("confirmDeleteAppointment", "DELETE");
  try {
    await deleteAppointmentAction(fd);
    return "";
  } catch (error) {
    return ((error as { digest?: string }).digest ?? "").split(";")[2] ?? "";
  }
}

beforeEach(() => {
  h.userTables.length = 0;
  h.adminOps.length = 0;
  h.adminResult = { error: null };
  h.adminThrows = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deleteAppointmentAction queued-notification cleanup (M-0 stage 2 precondition)", () => {
  it("deletes the queued/pending appointment notifications with the service-role client, scoped to this studio and appointment", async () => {
    await run();
    expect(h.adminOps).toEqual([
      {
        table: "outbound_deliveries",
        op: "delete",
        filters: [
          ["studio_id", "studio-1"],
          ["related_table", "appointments"],
          ["related_id", "appt-1"],
          ["status", ["queued", "pending"]],
        ],
      },
    ]);
  });

  it("never touches outbound_deliveries with the signed-in user's client", async () => {
    await run();
    expect(h.userTables).not.toContain("outbound_deliveries");
    expect(h.userTables).toContain("appointments");
  });

  it("stays best-effort: a returned error is logged and the appointment delete still runs", async () => {
    h.adminResult = { error: { message: "boom" } };
    await run();
    expect(console.error).toHaveBeenCalledWith("Could not clear queued appointment notifications:", "boom");
    expect(h.userTables.filter((t) => t === "appointments").length).toBeGreaterThanOrEqual(2);
  });

  it("stays best-effort when the admin client cannot be created", async () => {
    h.adminThrows = true;
    await run();
    expect(h.userTables.filter((t) => t === "appointments").length).toBeGreaterThanOrEqual(2);
  });
});
