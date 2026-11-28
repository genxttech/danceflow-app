import { describe, expect, it, vi } from "vitest";

/*
  The package lifecycle reconcile runs AFTER the deduction RPC has committed. If it throws, the charge is nevertheless applied: the lib must re-read the deduction marker,
  report success (not charge_failed) and correct the no-show note to "deducted" instead of leaving "requested, not applied".
*/

vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: async (params: { appointmentId: string }) => ({
    ok: true,
    scope: "broad",
    appointment: {
      id: params.appointmentId,
      studio_id: "studio-1",
      client_id: "client-1",
      instructor_id: "ins-1",
      appointment_type: "private_lesson",
      starts_at: "2026-11-21T15:00:00Z",
      title: "Lesson",
      client_package_id: "pkg-1",
      client_membership_id: null,
      price_amount: null,
      payment_status: "unpaid",
      billing_type: "package_credit",
      status: "scheduled",
    },
  }),
}));
vi.mock("@/lib/compensation/earnings", () => ({ stageInstructorEarningForAppointment: vi.fn() }));
vi.mock("@/lib/packages/lifecycle", () => ({
  reconcileClientPackageLifecycle: async () => {
    throw new Error("reconcile blew up after the deduction committed");
  },
}));

const { markAppointmentAttendance } = await import("../appointmentAttendance");

type Call = { table: string; op: string; payload?: unknown };

function fakeClient(options: { markerPresent: boolean }) {
  const calls: Call[] = [];
  const noteBody = { value: "" };
  const chain = (table: string, op: string, result: unknown, payload?: unknown) => {
    calls.push({ table, op, payload });
    const c: Record<string, unknown> = {};
    for (const method of ["eq", "in", "limit", "like", "order", "select", "delete"]) c[method] = () => c;
    c.then = (resolve: (value: unknown) => unknown) => resolve(result);
    return c;
  };
  const client = {
    from: (table: string) => ({
      update: (payload: unknown) => {
        if (table === "client_activity_notes") noteBody.value = String((payload as { body: string }).body);
        return chain(table, "update", { data: table === "appointments" ? [{ id: "appt-1" }] : [], error: null }, payload);
      },
      delete: () => chain(table, "delete", { data: [], error: null }),
      insert: (payload: unknown) => {
        if (table === "client_activity_notes") noteBody.value = String((payload as { body: string }).body);
        return chain(table, "insert", { data: [{ id: "note-1", body: noteBody.value }], error: null }, payload);
      },
      select: () =>
        chain(table, "select", {
          data:
            table === "lesson_transactions" && options.markerPresent
              ? [{ client_package_id: "pkg-1", transaction_type: "lesson_deduction" }]
              : [],
          error: null,
        }),
    }),
    rpc: (name: string) => {
      calls.push({ table: "rpc", op: name });
      return Promise.resolve({ data: [{ found_item: true, is_unlimited: false }], error: null });
    },
  };
  return { client, calls, noteBody };
}

const base = { studioId: "studio-1", appointmentId: "appt-1", actor: { userId: "u1", studioRole: "front_desk", isPlatformAdmin: false } };

describe("reconcile throws after the deduction committed", () => {
  it("trusts the deduction marker: success, and the note says deducted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, calls, noteBody } = fakeClient({ markerPresent: true });
    const result = await markAppointmentAttendance({ ...base, supabase: client as never, status: "no_show", missedAppointmentCharge: "package" });
    expect(result).toMatchObject({ ok: true, status: "no_show", alreadyApplied: false });
    expect(calls.some((call) => call.table === "rpc" && call.op === "deduct_package_credit_for_appointment")).toBe(true);
    // the note was inserted as "requested, not applied" before the charge, then corrected
    const inserted = calls.find((call) => call.table === "client_activity_notes" && call.op === "insert");
    expect(String((inserted?.payload as { body: string }).body)).toContain("Package credit requested, not applied");
    expect(calls.filter((call) => call.table === "client_activity_notes" && call.op === "update")).toHaveLength(1);
    expect(noteBody.value).toContain("Charge policy: Package credit deducted");
    expect(noteBody.value).not.toContain("not applied");
  });

  it("without a marker the exception is a real failure: charge_failed with the fixed sentence, note left as requested", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, calls, noteBody } = fakeClient({ markerPresent: false });
    const result = await markAppointmentAttendance({ ...base, supabase: client as never, status: "no_show", missedAppointmentCharge: "package" });
    expect(result).toEqual({ ok: false, reason: "charge_failed", message: "The missed-lesson charge could not be applied." });
    expect(calls.filter((call) => call.table === "client_activity_notes" && call.op === "update")).toHaveLength(0);
    expect(noteBody.value).toContain("Package credit requested, not applied");
  });
});
