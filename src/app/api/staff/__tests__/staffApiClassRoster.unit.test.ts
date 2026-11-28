import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  Route mapping for POST / DELETE .../appointments/{id}/roster (Phase 1A S2): the write gate, role check, validation and how each lib outcome becomes a status and a code.
  The data behaviour (capacity, duplicates, funding, removal, tenancy, RLS) is proven against real Postgres in localStack.staffApiClassRoster.test.ts.
*/

const mocks = vi.hoisted(() => ({ guard: null as unknown, enroll: vi.fn(), cancel: vi.fn() }));

vi.mock("@/lib/staff/writeGuard", () => ({ requireStaffWrite: async () => mocks.guard }));
vi.mock("@/lib/staff/classRoster", () => ({
  enrollClassAttendee: (...args: unknown[]) => mocks.enroll(...args),
  cancelClassAttendeeForClient: (...args: unknown[]) => mocks.cancel(...args),
}));

const { POST } = await import("../workspaces/[studioId]/appointments/[appointmentId]/roster/route");
const { DELETE } = await import("../workspaces/[studioId]/appointments/[appointmentId]/roster/[clientId]/route");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLASS = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const PACKAGE = "44444444-4444-4444-8444-444444444444";

const as = (role: string) => {
  mocks.guard = { ok: true, supabase: {}, studioId: STUDIO, studioRole: role, user: { id: "user-1" } };
};
const post = (body: unknown, key: string | null = "key-12345678", classId = CLASS) =>
  POST(
    new Request("https://app.test/x", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId: STUDIO, appointmentId: classId }) },
  );
const del = (key: string | null = "key-12345678", clientId = CLIENT) =>
  DELETE(new Request("https://app.test/x", { method: "DELETE", headers: key ? { "idempotency-key": key } : {} }), {
    params: Promise.resolve({ studioId: STUDIO, appointmentId: CLASS, clientId }),
  });
const code = async (response: Response) => (await response.json()).code;

beforeEach(() => {
  mocks.enroll.mockReset();
  mocks.cancel.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  as("front_desk");
});

describe("class roster routes", () => {
  it("answers the gate's refusal as is, before anything else", async () => {
    mocks.guard = {
      ok: false,
      get response() {
        return Response.json({ code: "writes_disabled" }, { status: 403 });
      },
    };
    expect(await code(await post({ clientId: CLIENT }))).toBe("writes_disabled");
    expect(await code(await del())).toBe("writes_disabled");
    expect(mocks.enroll).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it.each(["independent_instructor", "organizer_staff", "student"])("refuses the %s role", async (role) => {
    as(role);
    expect((await post({ clientId: CLIENT })).status).toBe(403);
    expect((await del()).status).toBe(403);
    expect(mocks.enroll).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("validates before calling the lib", async () => {
    for (const response of [
      await post({ clientId: CLIENT }, null),
      await post("nope"),
      await post({}),
      await post({ clientId: "x" }),
      await post({ clientId: CLIENT, billingType: "cash" }),
      await post({ clientId: CLIENT, clientPackageId: "x" }),
      await post({ clientId: CLIENT }, "key-12345678", "not-a-uuid"),
      await del(null),
      await del("key-12345678", "nope"),
    ]) {
      expect(response.status).toBe(400);
      expect(await code(response)).toBe("invalid_request");
    }
    expect(mocks.enroll).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("enrolls: 201 for a new attendee, 200 for a replay, passing the funding fields and the replay flag", async () => {
    mocks.enroll.mockResolvedValue({ ok: true, attendeeId: "a1", alreadyEnrolled: false });
    const created = await post({ clientId: CLIENT, billingType: "package_credit", clientPackageId: PACKAGE });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ attendee: { id: "a1", clientId: CLIENT, alreadyEnrolled: false } });
    expect(mocks.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        studioId: STUDIO,
        appointmentId: CLASS,
        clientId: CLIENT,
        billingType: "package_credit",
        clientPackageId: PACKAGE,
        clientMembershipId: null,
        treatAlreadyEnrolledAsSuccess: true,
      }),
    );
    mocks.enroll.mockResolvedValue({ ok: true, attendeeId: "a1", alreadyEnrolled: true });
    const replay = await post({ clientId: CLIENT });
    expect(replay.status).toBe(200);
    expect((await replay.json()).attendee.alreadyEnrolled).toBe(true);
  });

  it.each([
    ["not_found", 404, "not_found"],
    ["enrollment_not_authorized", 404, "not_found"],
    ["membership_requires_selection", 400, "invalid_request"],
    ["invalid_funding", 409, "invalid_funding"],
    ["already_enrolled", 409, "already_enrolled"],
    ["class_full", 409, "class_full"],
    ["class_cancelled", 409, "class_cancelled"],
    ["no_eligible_entitlement", 409, "no_eligible_entitlement"],
    ["entitlement_exhausted", 409, "entitlement_exhausted"],
    ["membership_not_active", 409, "membership_not_active"],
    ["ambiguous_funding_source", 409, "ambiguous_funding_source"],
    ["enrollment_failed", 409, "enrollment_failed"],
  ])("maps the enroll refusal %s to %i %s", async (reason, status, expected) => {
    mocks.enroll.mockResolvedValue({ ok: false, reason });
    const response = await post({ clientId: CLIENT });
    expect(response.status).toBe(status);
    expect(await code(response)).toBe(expected);
  });

  it("removes: 200 with alreadyApplied, and maps the refusals", async () => {
    mocks.cancel.mockResolvedValue({ ok: true, changed: true });
    expect(await (await del()).json()).toEqual({ removed: true, alreadyApplied: false });
    mocks.cancel.mockResolvedValue({ ok: true, changed: false });
    expect(await (await del()).json()).toEqual({ removed: true, alreadyApplied: true });
    for (const reason of ["class_not_found", "not_found", "attendee_not_authorized"]) {
      mocks.cancel.mockResolvedValue({ ok: false, reason });
      const response = await del();
      expect(response.status).toBe(404);
      expect(await code(response)).toBe("not_found");
    }
    mocks.cancel.mockResolvedValue({ ok: false, reason: "attendee_attendance_recorded" });
    const conflict = await del();
    expect(conflict.status).toBe(409);
    expect(await code(conflict)).toBe("attendance_recorded");
    mocks.cancel.mockResolvedValue({ ok: false, reason: "attendee_cancel_failed" });
    expect((await del()).status).toBe(503);
  });
});
