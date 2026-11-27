import { createStaffApi, isAllowedBaseUrl, REQUEST_TIMEOUT_MS, StaffApiError } from "@/lib/staffApi";

/*
  Transport safety of the staff API client: the bearer token only goes over HTTPS (plain http only for the emulator and loopback of a QA build),
  and a request that never answers ends as a network error instead of a spinner that never stops.
*/

const base = { getAccessToken: async () => "t", refreshAccessToken: async () => null };

describe("base URL rule", () => {
  it("accepts https and the QA loopback hosts, refuses plain http to a real host", () => {
    expect(isAllowedBaseUrl("https://idanceflow.com")).toBe(true);
    expect(isAllowedBaseUrl("http://10.0.2.2:3107")).toBe(true);
    expect(isAllowedBaseUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedBaseUrl("http://127.0.0.1:3000/")).toBe(true);
    expect(isAllowedBaseUrl("http://idanceflow.com")).toBe(false);
    expect(isAllowedBaseUrl("http://10.0.2.2.evil.test")).toBe(false);
    expect(isAllowedBaseUrl("ftp://idanceflow.com")).toBe(false);
    expect(isAllowedBaseUrl("")).toBe(false);
  });

  it("createStaffApi throws on a base URL that would send the token in clear text", () => {
    expect(() => createStaffApi({ ...base, baseUrl: "http://idanceflow.com" })).toThrow(/https/);
    expect(() => createStaffApi({ ...base, baseUrl: "https://idanceflow.com" })).not.toThrow();
  });
});

describe("request timeout", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("aborts a request that never answers and reports a network error", async () => {
    const fetchImpl = jest.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const api = createStaffApi({ ...base, baseUrl: "https://danceflow.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const pending = api.me().catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const error = (await pending) as StaffApiError;
    expect(error).toBeInstanceOf(StaffApiError);
    expect(error.code).toBe("network_error");
  });

  it("does not leave a timer running after a normal answer", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "u" }, workspaces: [] }) }));
    const api = createStaffApi({ ...base, baseUrl: "https://danceflow.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.me();
    expect(jest.getTimerCount()).toBe(0);
  });
});
