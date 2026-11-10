import { createStaffApi, StaffApiError, staffErrorKind } from "@/lib/staffApi";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function textResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  } as unknown as Response;
}

function setup(responses: Response[], tokens: { access?: string | null; refreshed?: string | null } = {}) {
  const fetchImpl = jest.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  const getAccessToken = jest.fn(async () => (tokens.access === undefined ? "token-1" : tokens.access));
  const refreshAccessToken = jest.fn(async () => (tokens.refreshed === undefined ? "token-2" : tokens.refreshed));
  const api = createStaffApi({
    baseUrl: "https://danceflow.test/",
    getAccessToken,
    refreshAccessToken,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { api, fetchImpl, getAccessToken, refreshAccessToken };
}

function headersOf(call: unknown[]) {
  return (call[1] as RequestInit).headers as Record<string, string>;
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as StaffApiError;
  }
  throw new Error("expected a rejection");
}

describe("staff API client", () => {
  it("sends the access token as a bearer, with no cookie or student header", async () => {
    const { api, fetchImpl } = setup([jsonResponse(200, { user: { id: "u" }, workspaces: [] })]);

    await api.me();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://danceflow.test/api/staff/me");
    expect(init.method).toBe("GET");
    expect(headersOf(fetchImpl.mock.calls[0] as unknown[])).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token-1",
    });
    expect(init.credentials).toBeUndefined();
  });

  it("builds the workspace routes with encoded ids and an optional date", async () => {
    const { api, fetchImpl } = setup([
      jsonResponse(200, { appointments: [] }),
      jsonResponse(200, { appointments: [] }),
      jsonResponse(200, { id: "a" }),
    ]);

    await api.today("studio 1");
    await api.today("studio-1", "2026-11-09");
    await api.appointment("studio-1", "appt/1");

    const urls = fetchImpl.mock.calls.map((call) => (call as unknown[])[0]);
    expect(urls).toEqual([
      "https://danceflow.test/api/staff/workspaces/studio%201/today",
      "https://danceflow.test/api/staff/workspaces/studio-1/today?date=2026-11-09",
      "https://danceflow.test/api/staff/workspaces/studio-1/appointments/appt%2F1",
    ]);
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const { api, fetchImpl, refreshAccessToken } = setup([
      jsonResponse(401, { error: "Sign in", code: "unauthenticated" }),
      jsonResponse(200, { user: { id: "u" }, workspaces: [] }),
    ]);

    await expect(api.me()).resolves.toEqual({ user: { id: "u" }, workspaces: [] });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(headersOf(fetchImpl.mock.calls[1] as unknown[]).Authorization).toBe("Bearer token-2");
  });

  it("stops after one retry when the second answer is still 401", async () => {
    const { api, fetchImpl, refreshAccessToken } = setup([
      jsonResponse(401, { error: "Sign in", code: "unauthenticated" }),
      jsonResponse(401, { error: "Sign in", code: "unauthenticated" }),
    ]);

    const error = await caught(api.me());
    expect(error).toBeInstanceOf(StaffApiError);
    expect(error.status).toBe(401);
    expect(staffErrorKind(error)).toBe("sign_in_again");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the refresh fails", async () => {
    const { api, fetchImpl } = setup([jsonResponse(401, { code: "unauthenticated" })], { refreshed: null });

    expect(staffErrorKind(await caught(api.me()))).toBe("sign_in_again");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not call the network without a session", async () => {
    const { api, fetchImpl } = setup([], { access: null });

    expect(staffErrorKind(await caught(api.me()))).toBe("sign_in_again");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [403, "not_a_member", "no_access"],
    [403, "workspace_paused", "paused"],
    [403, "role_not_permitted", "not_permitted"],
    [403, "account_inactive", "account_inactive"],
    [403, "platform_admin_unsupported", "platform_admin"],
    [404, "not_found", "not_found"],
    [400, "invalid_request", "client_bug"],
    [503, "service_unavailable", "unavailable"],
  ])("maps %i %s to %s and keeps the server's code and text", async (status, code, kind) => {
    const { api, refreshAccessToken } = setup([jsonResponse(status, { error: `Server says ${code}`, code })]);

    const error = await caught(api.today("studio-1"));
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe(`Server says ${code}`);
    expect(staffErrorKind(error)).toBe(kind);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("does not sign out on a 503: token verification outages are retryable", async () => {
    const { api } = setup([jsonResponse(503, { error: "Try again in a moment.", code: "service_unavailable" })]);
    expect(staffErrorKind(await caught(api.me()))).toBe("unavailable");
  });

  it("falls back to the status when a body has no known code", async () => {
    const { api } = setup([jsonResponse(403, { error: "Nope", code: "brand_new_code" })]);
    const error = await caught(api.me());
    expect(error.code).toBe("not_a_member");
    expect(staffErrorKind(error)).toBe("no_access");
  });

  it("treats an HTML error page from a proxy as unavailable", async () => {
    const { api } = setup([textResponse(502)]);
    const error = await caught(api.me());
    expect(error.code).toBe("service_unavailable");
    expect(staffErrorKind(error)).toBe("unavailable");
  });

  it("treats a 200 that is not JSON as unavailable", async () => {
    const { api } = setup([textResponse(200)]);
    const error = await caught(api.me());
    expect(error.code).toBe("unexpected_response");
    expect(staffErrorKind(error)).toBe("unavailable");
  });

  it("reports a network failure as unavailable, never as signed out", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("Network request failed");
    });
    const api = createStaffApi({
      baseUrl: "https://danceflow.test",
      getAccessToken: async () => "token-1",
      refreshAccessToken: async () => "token-2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await caught(api.me());
    expect(error.code).toBe("network_error");
    expect(staffErrorKind(error)).toBe("unavailable");
  });

  it("maps a non-API error to unavailable", () => {
    expect(staffErrorKind(new Error("boom"))).toBe("unavailable");
  });
});
