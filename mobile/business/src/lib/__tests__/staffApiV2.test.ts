import { createStaffApi, staffErrorKind, StaffApiError, toClientDetail, toClientPage } from "@/lib/staffApi";
import { newIdempotencyKey, parseStaffFeatures } from "@/lib/features";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function setup(responses: Response[]) {
  const fetchImpl = jest.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  const refreshAccessToken = jest.fn(async () => "token-2");
  const api = createStaffApi({
    baseUrl: "https://danceflow.test",
    getAccessToken: async () => "token-1",
    refreshAccessToken,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const call = (i: number) => fetchImpl.mock.calls[i] as unknown as [string, RequestInit & { headers: Record<string, string> }];
  return { api, fetchImpl, refreshAccessToken, call };
}

describe("client lookup (proposed v2 shape)", () => {
  it("searches with a trimmed query and no empty parameters", async () => {
    const { api, call } = setup([jsonResponse(200, { clients: [], nextCursor: null }), jsonResponse(200, { clients: [] })]);

    await api.searchClients("studio 1", { q: "  ana r " });
    await api.searchClients("studio-1", { q: "   ", cursor: null });

    expect(call(0)[0]).toBe("https://danceflow.test/api/staff/workspaces/studio%201/clients?q=ana+r");
    expect(call(1)[0]).toBe("https://danceflow.test/api/staff/workspaces/studio-1/clients");
    expect(call(0)[1].method).toBe("GET");
    expect(call(0)[1].headers.Authorization).toBe("Bearer token-1");
  });

  it("pages with the cursor the server returned", async () => {
    const { api, call } = setup([jsonResponse(200, { clients: [{ id: "c1", firstName: "Ana", lastName: "R", status: "active" }], nextCursor: "abc/=" })]);

    const page = await api.searchClients("studio-1", { q: "a", cursor: "abc/=" });
    expect(call(0)[0]).toBe("https://danceflow.test/api/staff/workspaces/studio-1/clients?q=a&cursor=abc%2F%3D");
    expect(page).toEqual({ clients: [{ id: "c1", firstName: "Ana", lastName: "R", status: "active" }], nextCursor: "abc/=" });
  });

  it("reads one client", async () => {
    const { api, call } = setup([
      jsonResponse(200, { id: "c/1", firstName: "Ana", lastName: null, status: "lead", nextAppointment: { id: "a1", startsAt: "2026-11-10T15:00:00Z", appointmentType: "private_lesson" } }),
    ]);
    const client = await api.client("studio-1", "c/1");
    expect(call(0)[0]).toBe("https://danceflow.test/api/staff/workspaces/studio-1/clients/c%2F1");
    expect(client.nextAppointment).toEqual({ id: "a1", startsAt: "2026-11-10T15:00:00Z", appointmentType: "private_lesson" });
  });

  it("maps a role without client access to not_permitted", async () => {
    const { api } = setup([jsonResponse(403, { error: "No.", code: "role_not_permitted" })]);
    await expect(api.searchClients("studio-1", {})).rejects.toBeInstanceOf(StaffApiError);
    const again = setup([jsonResponse(403, { error: "No.", code: "role_not_permitted" })]);
    const error = await again.api.searchClients("studio-1", {}).catch((e: unknown) => e);
    expect(staffErrorKind(error)).toBe("not_permitted");
  });
});

describe("adapters keep screens safe from an unexpected payload", () => {
  it("drops rows without an id and coerces non-string fields to null", () => {
    expect(toClientPage({ clients: [{ id: "c1", firstName: 7, lastName: "X" }, { firstName: "No id" }], nextCursor: 5 })).toEqual({
      clients: [{ id: "c1", firstName: null, lastName: "X", status: null }],
      nextCursor: null,
    });
    expect(toClientPage(null)).toEqual({ clients: [], nextCursor: null });
  });

  it("treats a malformed next appointment as none", () => {
    expect(toClientDetail({ id: "c1", nextAppointment: { id: "a1" } }).nextAppointment).toBeNull();
  });
});

describe("attendance (proposed v2 shape)", () => {
  it("PUTs the mark as JSON with the idempotency key and bearer", async () => {
    const { api, call } = setup([jsonResponse(200, { clientId: "c1", attendanceStatus: "attended" })]);

    const result = await api.setAttendance("studio-1", "appt-1", "c1", "attended", "key-1");

    const [url, init] = call(0);
    expect(url).toBe("https://danceflow.test/api/staff/workspaces/studio-1/appointments/appt-1/attendance/c1");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ status: "attended" }));
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token-1",
      "Content-Type": "application/json",
      "Idempotency-Key": "key-1",
    });
    expect(result).toEqual({ clientId: "c1", attendanceStatus: "attended" });
  });

  it("retries a 401 once with the SAME idempotency key, so the write cannot apply twice", async () => {
    const { api, call, refreshAccessToken } = setup([
      jsonResponse(401, { code: "unauthenticated" }),
      jsonResponse(200, { clientId: "c1", attendanceStatus: "absent" }),
    ]);

    await api.setAttendance("studio-1", "appt-1", "c1", "absent", "key-9");

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(call(0)[1].headers["Idempotency-Key"]).toBe("key-9");
    expect(call(1)[1].headers["Idempotency-Key"]).toBe("key-9");
    expect(call(1)[1].headers.Authorization).toBe("Bearer token-2");
    expect(call(1)[1].body).toBe(call(0)[1].body);
  });

  it("falls back to the requested client when the response omits it", async () => {
    const { api } = setup([jsonResponse(200, { attendanceStatus: "attended" })]);
    expect(await api.setAttendance("s", "a", "c7", "attended", "k")).toEqual({ clientId: "c7", attendanceStatus: "attended" });
  });
});

describe("feature flags", () => {
  it("are off unless named", () => {
    expect([...parseStaffFeatures(undefined)]).toEqual([]);
    expect([...parseStaffFeatures("")]).toEqual([]);
  });

  it("accept only known features", () => {
    expect([...parseStaffFeatures(" clients , attendance,payments ")].sort()).toEqual(["attendance", "clients"]);
  });

  it("make a fresh idempotency key per action", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });
});
