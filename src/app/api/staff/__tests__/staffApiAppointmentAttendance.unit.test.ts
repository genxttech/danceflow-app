import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  Route mapping for PUT .../appointments/{id}/attendance (Phase 1A S1): validation, the role check and how each lib outcome becomes a status and a stable code.
  The data behaviour (exactly-once deduction, terminal outcomes, tenancy, RLS) is proven against real Postgres in localStack.staffApiAppointmentAttendance.test.ts.
*/

const mocks = vi.hoisted(() => ({ guard: null as unknown, mark: vi.fn() }));

vi.mock("@/lib/staff/writeGuard", () => ({ requireStaffWrite: async () => mocks.guard }));
vi.mock("@/lib/staff/appointmentAttendance", () => ({ markAppointmentAttendance: (...args: unknown[]) => mocks.mark(...args) }));

const { PUT } = await import("../workspaces/[studioId]/appointments/[appointmentId]/attendance/route");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT = "22222222-2222-4222-8222-222222222222";

const as = (role: string) => {
  mocks.guard = { ok: true, supabase: {}, studioId: STUDIO, studioRole: role, user: { id: "user-1" } };
};
const call = (body: unknown, key: string | null = "key-12345678") =>
  PUT(
    new Request("https://app.test/x", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId: STUDIO, appointmentId: APPOINTMENT }) },
  );
const code = async (response: Response) => (await response.json()).code;
const ok = (status: string, extra: Record<string, unknown> = {}) => ({
  ok: true,
  appointmentId: APPOINTMENT,
  clientId: "c",
  status,
  alreadyApplied: false,
  usageSyncPending: false,
  ...extra,
});

beforeEach(() => {
  mocks.mark.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  as("front_desk");
});

describe("PUT appointment attendance route", () => {
  it("answers the write gate's refusal as is, before anything else", async () => {
    mocks.guard = {
      ok: false,
      get response() {
        return Response.json({ code: "writes_disabled" }, { status: 403 });
      },
    };
    expect(await code(await call({ status: "attended" }))).toBe("writes_disabled");
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it.each(["independent_instructor", "organizer_staff", "organizer_owner", "student"])("refuses the %s role before touching the lib", async (role) => {
    as(role);
    const response = await call({ status: "attended" });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("role_not_permitted");
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it.each(["studio_owner", "studio_admin", "front_desk", "instructor"])("lets the %s role through, always restricted to one-to-one appointments", async (role) => {
    as(role);
    mocks.mark.mockResolvedValue(ok("attended"));
    const response = await call({ status: "attended" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appointment: { id: APPOINTMENT, status: "attended", alreadyApplied: false } });
    expect(mocks.mark).toHaveBeenCalledWith(
      expect.objectContaining({
        studioId: STUDIO,
        appointmentId: APPOINTMENT,
        status: "attended",
        restrictToPrivateLessons: true,
        actor: { userId: "user-1", studioRole: role, isPlatformAdmin: false },
      }),
    );
  });

  it("validates the key, the body, the status, the charge and the id before the lib", async () => {
    for (const response of [
      await call({ status: "attended" }, null),
      await call({ status: "attended" }, "short"),
      await call("not json"),
      await call({ status: "checked_in" }),
      await call({}),
      await call({ status: "no_show", missedAppointmentCharge: "cash" }),
      await call({ status: "no_show", missedAppointmentCharge: 5 }),
    ]) {
      expect(response.status).toBe(400);
      expect(await code(response)).toBe("invalid_request");
    }
    const badId = await PUT(new Request("https://app.test/x", { method: "PUT", headers: { "idempotency-key": "key-12345678" }, body: "{}" }), {
      params: Promise.resolve({ studioId: STUDIO, appointmentId: "nope" }),
    });
    expect(badId.status).toBe(400);
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("passes the charge policy only for a no-show", async () => {
    mocks.mark.mockResolvedValue(ok("no_show"));
    await call({ status: "no_show", missedAppointmentCharge: "package" });
    expect(mocks.mark.mock.calls[0][0].missedAppointmentCharge).toBe("package");
    mocks.mark.mockClear();
    mocks.mark.mockResolvedValue(ok("attended"));
    await call({ status: "attended", missedAppointmentCharge: "package" });
    expect(mocks.mark.mock.calls[0][0].missedAppointmentCharge).toBeUndefined();
  });

  it.each([
    ["not_found", 404, "not_found"],
    ["not_markable", 409, "not_markable"],
    ["attended_cannot_be_marked_no_show", 409, "outcome_conflict"],
    ["no_show_cannot_be_marked_attended", 409, "outcome_conflict"],
    ["payment_required", 409, "payment_required"],
    ["charge_changed", 409, "outcome_conflict"],
    ["package_changed", 409, "outcome_conflict"],
  ])("maps the lib refusal %s to %i %s", async (reason, status, expected) => {
    mocks.mark.mockResolvedValue({ ok: false, reason });
    const response = await call({ status: "attended" });
    expect(response.status).toBe(status);
    expect(await code(response)).toBe(expected);
  });

  it("maps a failed charge, a pending usage sync and a failed write", async () => {
    mocks.mark.mockResolvedValue({ ok: false, reason: "charge_failed", message: "No package is linked to this appointment." });
    const charge = await call({ status: "no_show", missedAppointmentCharge: "package" });
    expect(charge.status).toBe(409);
    expect(await charge.json()).toMatchObject({ code: "charge_failed", error: "No package is linked to this appointment." });

    mocks.mark.mockResolvedValue(ok("attended", { usageSyncPending: true, packageExhausted: true }));
    const exhausted = await call({ status: "attended" });
    expect(exhausted.status).toBe(409);
    expect(await code(exhausted)).toBe("package_exhausted");

    mocks.mark.mockResolvedValue(ok("attended", { usageSyncPending: true }));
    const pending = await call({ status: "attended" });
    expect(pending.status).toBe(409);
    expect(await code(pending)).toBe("usage_sync_pending");

    mocks.mark.mockResolvedValue({ ok: false, reason: "write_failed" });
    expect((await call({ status: "attended" })).status).toBe(503);
    mocks.mark.mockRejectedValue(new Error("boom"));
    expect((await call({ status: "attended" })).status).toBe(503);
  });
});
