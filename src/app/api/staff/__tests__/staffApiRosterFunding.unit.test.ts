import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  GET .../appointments/{id}/roster/funding: roles, validation, the shape of each candidate and how database refusals become stable codes. The real database function
  (eligibility, the class's accepted funding types, tenancy) is exercised in localStack.staffApiClassRoster.test.ts.
*/

const mocks = vi.hoisted(() => ({ guard: null as unknown, rpc: vi.fn() }));

vi.mock("@/lib/auth/staffApiAuth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/staffApiAuth")>("@/lib/auth/staffApiAuth");
  return { ...actual, requireStaffApi: async () => mocks.guard };
});

const { GET } = await import("../workspaces/[studioId]/appointments/[appointmentId]/roster/funding/route");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLASS = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";

const as = (role: string) => {
  mocks.guard = { ok: true, supabase: { rpc: mocks.rpc }, studioId: STUDIO, studioRole: role, user: { id: "u" } };
};
const call = (query = `?clientId=${CLIENT}`, classId = CLASS) =>
  GET(new Request(`https://app.test/x${query}`), { params: Promise.resolve({ studioId: STUDIO, appointmentId: classId }) });
const row = (over: Record<string, unknown> = {}) => ({
  funding_type: "package",
  source_id: "p1",
  label: "10 Class Pack",
  is_unlimited: false,
  quantity_total: "10",
  used: "7",
  remaining: "3",
  ...over,
});

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  as("front_desk");
});

describe("roster funding candidates", () => {
  it.each(["instructor", "independent_instructor", "organizer_staff", "organizer_owner", "student"])("refuses the %s role without calling the database", async (role) => {
    as(role);
    const response = await call();
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("role_not_permitted");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers the guard's refusal as is", async () => {
    mocks.guard = { ok: false, response: Response.json({ code: "unauthenticated" }, { status: 401 }) };
    expect((await call()).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["", CLASS],
    ["?clientId=nope", CLASS],
    [`?clientId=${CLIENT}`, "nope"],
  ])("rejects a missing or malformed id (%s, %s)", async (query, classId) => {
    const response = await call(query, classId);
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["studio_owner", "studio_admin", "front_desk"])("lists candidates for the %s role, as the caller, with no prices", async (role) => {
    as(role);
    mocks.rpc.mockResolvedValue({
      data: [
        row(),
        row({ funding_type: "membership", source_id: "m1", label: "Gold", is_unlimited: true, remaining: null }),
        row({ funding_type: "mystery", source_id: "x" }),
      ],
      error: null,
    });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      candidates: [
        { billingType: "package_credit", sourceId: "p1", label: "10 Class Pack", unlimited: false, remaining: 3 },
        { billingType: "membership", sourceId: "m1", label: "Gold", unlimited: true, remaining: null },
      ],
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_eligible_group_class_funding_candidates", {
      p_studio_id: STUDIO,
      p_client_id: CLIENT,
      p_appointment_id: CLASS,
    });
  });

  it("lists a source that comes back twice once, with the lower count", async () => {
    mocks.rpc.mockResolvedValue({
      data: [row({ funding_type: "membership", source_id: "m1", remaining: "4" }), row({ funding_type: "membership", source_id: "m1", remaining: "2" }), row({ funding_type: "membership", source_id: "m1", remaining: "3" })],
      error: null,
    });
    const body = await (await call()).json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({ sourceId: "m1", remaining: 2 });
  });

  it.each(["Group class not found.", "Client not found for this studio.", "Not authorized to resolve funding eligibility for this studio."])(
    "answers %s as not_found without the database text",
    async (message) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { message } });
      const response = await call();
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.code).toBe("not_found");
      expect(body).toEqual({ code: "not_found", error: "Class or dancer not found." });
    },
  );

  it("any other database failure is a 503 with no database text", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "relation secret_table does not exist" } });
    const response = await call();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret_table");
  });
});
