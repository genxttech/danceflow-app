import { ATTENDANCE_MARKS, createStaffApi, readErrorBody, staffErrorKind, StaffApiError, toClientDetail, toClientPage } from "@/lib/staffApi";
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
    const { api, call } = setup([
      jsonResponse(200, { attendee: { clientId: "c1", displayName: "Ana R.", status: "attended", updatedAt: "2026-11-10T20:00:00Z" } }),
    ]);

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
    expect(result).toEqual({ clientId: "c1", attendanceStatus: "attended", displayName: "Ana R.", updatedAt: "2026-11-10T20:00:00Z" });
  });

  it("sends only values from the single ATTENDANCE_MARKS list, which are values of the DB roster attendance set", () => {
    const dbSet = ["registered", "checked_in", "attended", "no_show", "cancelled"];
    expect([...ATTENDANCE_MARKS]).toEqual(["attended", "no_show"]);
    for (const mark of ATTENDANCE_MARKS) expect(dbSet).toContain(mark);
  });

  it("maps 409 (not markable) to its own kind, from the code or from the status alone", async () => {
    const coded = setup([jsonResponse(409, { error: { code: "not_markable", message: "Class is cancelled." } })]);
    const e1 = await coded.api.setAttendance("s", "a", "c", "attended", "k").catch((e: unknown) => e as StaffApiError);
    expect(staffErrorKind(e1)).toBe("not_markable");
    expect((e1 as StaffApiError).message).toBe("Class is cancelled.");

    const bare = setup([jsonResponse(409, { error: { code: "attendance_window_closed", message: "Too late." } })]);
    expect(staffErrorKind(await bare.api.setAttendance("s", "a", "c", "attended", "k").catch((e: unknown) => e))).toBe("not_markable");
  });

  it("retries a 401 once with the SAME idempotency key, so the write cannot apply twice", async () => {
    const { api, call, refreshAccessToken } = setup([
      jsonResponse(401, { code: "unauthenticated" }),
      jsonResponse(200, { attendee: { clientId: "c1", displayName: "Ana R.", status: "no_show", updatedAt: "2026-11-10T20:00:00Z" } }),
    ]);

    await api.setAttendance("studio-1", "appt-1", "c1", "no_show", "key-9");

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(call(0)[1].headers["Idempotency-Key"]).toBe("key-9");
    expect(call(1)[1].headers["Idempotency-Key"]).toBe("key-9");
    expect(call(1)[1].headers.Authorization).toBe("Bearer token-2");
    expect(call(1)[1].body).toBe(call(0)[1].body);
  });

  it("falls back to the requested client when the response omits it", async () => {
    const { api } = setup([jsonResponse(200, { attendee: { status: "attended" } })]);
    expect(await api.setAttendance("s", "a", "c7", "attended", "k")).toEqual({
      clientId: "c7",
      attendanceStatus: "attended",
      displayName: null,
      updatedAt: null,
    });
  });
});

describe("error bodies: both shapes are read", () => {
  it("reads #439's flat { error, code }", () => {
    expect(readErrorBody({ error: "Paused.", code: "workspace_paused" })).toEqual({ code: "workspace_paused", message: "Paused." });
  });

  it("reads the provisional nested { error: { code, message } }", () => {
    expect(readErrorBody({ error: { code: "role_not_permitted", message: "No." } })).toEqual({ code: "role_not_permitted", message: "No." });
  });

  it("maps a nested 403 role_not_permitted on client lookup to not_permitted", async () => {
    const { api } = setup([jsonResponse(403, { error: { code: "role_not_permitted", message: "No client lookup for your role." } })]);
    const error = await api.searchClients("s", {}).catch((e: unknown) => e as StaffApiError);
    expect(staffErrorKind(error)).toBe("not_permitted");
    expect((error as StaffApiError).message).toBe("No client lookup for your role.");
  });
});

describe("client detail (provisional)", () => {
  it("keeps package names and remaining counts only, and the studio zone", () => {
    const detail = toClientDetail({
      id: "c1",
      firstName: "Ana",
      lastName: "Rivera",
      status: "active",
      activePackages: [{ name: "10 privates", remaining: 4, priceCents: 90000 }, { name: "Unlimited classes", remaining: null }, { remaining: 2 }],
      nextAppointment: { id: "a1", startsAt: "2026-11-12T15:00:00Z", appointmentType: "private_lesson" },
      timeZone: "America/New_York",
    });
    expect(detail.activePackages).toEqual([
      { name: "10 privates", remaining: 4 },
      { name: "Unlimited classes", remaining: null },
    ]);
    expect(JSON.stringify(detail)).not.toContain("price");
    expect(detail.timeZone).toBe("America/New_York");
  });

  it("accepts the next appointment as a bare time", () => {
    expect(toClientDetail({ id: "c1", nextAppointment: "2026-11-12T15:00:00Z" }).nextAppointment).toEqual({
      id: null,
      startsAt: "2026-11-12T15:00:00Z",
      appointmentType: null,
    });
  });

  it("sends limit only when it is a positive integer", async () => {
    const { api, call } = setup([jsonResponse(200, { clients: [] }), jsonResponse(200, { clients: [] })]);
    await api.searchClients("s", { limit: 25 });
    await api.searchClients("s", { limit: 0 });
    expect(call(0)[0]).toBe("https://danceflow.test/api/staff/workspaces/s/clients?limit=25");
    expect(call(1)[0]).toBe("https://danceflow.test/api/staff/workspaces/s/clients");
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
