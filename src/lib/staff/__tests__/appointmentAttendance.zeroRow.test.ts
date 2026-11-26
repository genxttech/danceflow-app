import { describe, expect, it, vi } from "vitest";

/*
  A status UPDATE that touches zero rows (RLS, a row that vanished) must never go on to the SECURITY DEFINER deduction RPC, the membership-usage clear, the charge or
  the note. Proven here with a fake client that records every call.
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
      billing_type: "free_comped",
      status: "scheduled",
    },
  }),
}));
vi.mock("@/lib/compensation/earnings", () => ({ stageInstructorEarningForAppointment: vi.fn() }));

const { markAppointmentAttendance } = await import("../appointmentAttendance");

function fakeClient(updateRows: unknown[] | null) {
  const calls: string[] = [];
  const chain = (name: string, result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const method of ["eq", "neq", "in", "limit", "like", "order", "select", "delete", "insert", "update"]) c[method] = () => c;
    c.maybeSingle = async () => ({ data: null, error: null });
    c.then = (resolve: (value: unknown) => unknown) => resolve(result);
    calls.push(name);
    return c;
  };
  return {
    calls,
    client: {
      from: (table: string) => ({
        update: () => chain(`update:${table}`, { data: updateRows, error: null }),
        delete: () => chain(`delete:${table}`, { data: [], error: null }),
        insert: () => chain(`insert:${table}`, { data: [], error: null }),
        select: () => chain(`select:${table}`, { data: [], error: null }),
      }),
      rpc: () => {
        calls.push("rpc");
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
}

const base = { studioId: "studio-1", appointmentId: "appt-1", actor: { userId: "u1", studioRole: "front_desk", isPlatformAdmin: false } };

describe("a zero-row status update stops everything", () => {
  it.each(["attended", "no_show"] as const)("%s: not_found, and no RPC, clear, charge, note or staging", async (status) => {
    const { client, calls } = fakeClient([]);
    const result = await markAppointmentAttendance({ ...base, supabase: client as never, status, missedAppointmentCharge: "package" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    // a no-show re-reads the status once, to tell "someone else just recorded it" from "not there"
    expect(calls).toEqual(status === "no_show" ? ["update:appointments", "select:appointments"] : ["update:appointments"]);
  });

  it.each(["attended", "no_show"] as const)("%s: a null result is write_failed, with the same silence", async (status) => {
    const { client, calls } = fakeClient(null);
    const result = await markAppointmentAttendance({ ...base, supabase: client as never, status });
    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(calls).toEqual(["update:appointments"]);
  });
});
