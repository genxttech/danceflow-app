import { createStaffApi, parseRetryAfterSeconds, StaffApiError, staffErrorKind } from "@/lib/staffApi";
import { shouldKeepStale } from "@/lib/stale";

/* HTTP 429 / code rate_limited from the staff API guard (server review S5, 2026-11-19): Retry-After-aware, never a silent loop. */

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const LIMITED = { error: "Too many requests. Try again in a moment.", code: "rate_limited" };

function setup(responses: Response[]) {
  const fetchImpl = jest.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  const sleepImpl = jest.fn(async (ms: number) => { void ms; });
  const api = createStaffApi({
    baseUrl: "https://danceflow.test",
    getAccessToken: async () => "token-1",
    refreshAccessToken: async () => "token-2",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl,
  });
  return { api, fetchImpl, sleepImpl };
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as StaffApiError;
  }
  throw new Error("expected a rejection");
}

describe("429 rate_limited", () => {
  it("is its own kind, not an outage and not a sign-out", async () => {
    const { api } = setup([res(429, LIMITED, { "Retry-After": "30" })]);
    const error = await caught(api.me());
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(30);
    expect(staffErrorKind(error)).toBe("rate_limited");
  });

  it("maps a 429 with no usable body to rate_limited by status", async () => {
    const { api } = setup([res(429, null)]);
    const error = await caught(api.me());
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("waits out a short Retry-After once for a read, then succeeds", async () => {
    const { api, fetchImpl, sleepImpl } = setup([res(429, LIMITED, { "Retry-After": "2" }), res(200, { user: { id: "u" }, workspaces: [] })]);
    await expect(api.me()).resolves.toEqual({ user: { id: "u" }, workspaces: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(2000);
  });

  it("retries a read only once: a second 429 is shown, with its own Retry-After", async () => {
    const { api, fetchImpl } = setup([res(429, LIMITED, { "Retry-After": "1" }), res(429, LIMITED, { "Retry-After": "9" })]);
    const error = await caught(api.me());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(9);
  });

  it("does not stall a screen on a long Retry-After: no sleep, no second request", async () => {
    const { api, fetchImpl, sleepImpl } = setup([res(429, LIMITED, { "Retry-After": "45" })]);
    const error = await caught(api.me());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
    expect(error.retryAfterSeconds).toBe(45);
  });

  it("does not retry without a Retry-After header", async () => {
    const { api, fetchImpl, sleepImpl } = setup([res(429, LIMITED)]);
    await caught(api.me());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("never resends a write on its own: an attendance mark that is limited is shown, one request only", async () => {
    const { api, fetchImpl, sleepImpl } = setup([res(429, LIMITED, { "Retry-After": "1" })]);
    const error = await caught(api.setAttendance("studio-1", "appt-1", "client-1", "attended", "key-1"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(1);
  });

  it("parses Retry-After as whole seconds only, capped, and ignores junk", () => {
    expect(parseRetryAfterSeconds("7")).toBe(7);
    expect(parseRetryAfterSeconds(" 12 ")).toBe(12);
    expect(parseRetryAfterSeconds("99999")).toBe(120);
    expect(parseRetryAfterSeconds("0")).toBeUndefined();
    expect(parseRetryAfterSeconds("-3")).toBeUndefined();
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfterSeconds("")).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
  });

  it("keeps stale data on a failed refresh, like an outage", () => {
    const error = new StaffApiError(429, "rate_limited", "x", 10);
    expect(shouldKeepStale({ enabled: true, mode: "refresh", hadData: true, error })).toBe(true);
    expect(shouldKeepStale({ enabled: true, mode: "initial", hadData: false, error })).toBe(false);
  });
});
