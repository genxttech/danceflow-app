import { buildAppHeader } from "@/lib/appVersion";
import { createStaffApi, StaffApiError, staffErrorKind } from "@/lib/staffApi";

/* Write-path additions to the staff API client (Business expansion, Phase 0, P0-3a). */

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function setup(responses: Response[], appHeader?: string | null) {
  const fetchImpl = jest.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  const api = createStaffApi({
    baseUrl: "https://danceflow.test",
    getAccessToken: async () => "token-1",
    refreshAccessToken: async () => "token-2",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => {},
    appHeader,
  });
  return { api, fetchImpl };
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as StaffApiError;
  }
  throw new Error("expected a rejection");
}

const headersOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;

describe("X-DanceFlow-App header", () => {
  it("is sent on requests when the build knows its version", async () => {
    const { api, fetchImpl } = setup([res(200, { user: { id: "u" }, workspaces: [] })], "business/0.2.0/3/android");
    await api.me();
    expect(headersOf(fetchImpl.mock.calls[0] as unknown[])["X-DanceFlow-App"]).toBe("business/0.2.0/3/android");
  });
  it("is omitted (so the server refuses gated writes) when the version is unknown", async () => {
    const { api, fetchImpl } = setup([res(200, { user: { id: "u" }, workspaces: [] })], null);
    await api.me();
    expect(headersOf(fetchImpl.mock.calls[0] as unknown[])["X-DanceFlow-App"]).toBeUndefined();
  });
});

describe("buildAppHeader", () => {
  it("builds the documented shape from the app config", () => {
    expect(buildAppHeader({ version: "0.2.0", android: { versionCode: 3 } }, "android")).toBe("business/0.2.0/3/android");
    expect(buildAppHeader({ version: "0.2.0", ios: { buildNumber: "12" } }, "ios")).toBe("business/0.2.0/12/ios");
    expect(buildAppHeader({ version: "1.0.0-rc.1", android: { versionCode: "4" } }, "android")).toBe("business/1.0.0-rc.1/4/android");
  });
  it.each([
    ["no config", null, "android"],
    ["no version", { android: { versionCode: 3 } }, "android"],
    ["bad version", { version: "bad version!", android: { versionCode: 3 } }, "android"],
    ["no code", { version: "0.2.0" }, "android"],
    ["non-integer code", { version: "0.2.0", android: { versionCode: 1.5 } }, "android"],
    ["junk code", { version: "0.2.0", android: { versionCode: "x3" } }, "android"],
    ["negative code", { version: "0.2.0", android: { versionCode: -1 } }, "android"],
    ["web", { version: "0.2.0", android: { versionCode: 3 } }, "web"],
  ])("returns null for %s, so no header is sent", (_n, config, os) => {
    expect(buildAppHeader(config as never, os)).toBeNull();
  });
});

describe("write refusals map to their own kinds", () => {
  it("403 writes_disabled", async () => {
    const { api } = setup([res(403, { error: "off", code: "writes_disabled" })]);
    const error = await caught(api.setAttendance("s", "a", "c", "attended", "key-12345678"));
    expect(error.code).toBe("writes_disabled");
    expect(staffErrorKind(error)).toBe("writes_disabled");
  });
  it("426 upgrade_required, by code and by status alone", async () => {
    const byCode = await caught(setup([res(426, { error: "old", code: "upgrade_required" })]).api.me());
    expect(staffErrorKind(byCode)).toBe("upgrade_required");
    const byStatus = await caught(setup([res(426, null)]).api.me());
    expect(byStatus.code).toBe("upgrade_required");
  });
  it("409 with a slice code is a conflict that keeps the raw code and the server's current state", async () => {
    const { api } = setup([res(409, { error: "Already marked no-show.", code: "outcome_conflict", current: { appointment: { id: "a", status: "no_show" } } })]);
    const error = await caught(api.setAttendance("s", "a", "c", "attended", "key-12345678"));
    expect(error.status).toBe(409);
    expect(error.code).toBe("conflict");
    expect(error.extra?.serverCode).toBe("outcome_conflict");
    expect(error.extra?.current).toEqual({ appointment: { id: "a", status: "no_show" } });
    expect(staffErrorKind(error)).toBe("conflict");
  });
  it("v0.1 meaning kept: 409 not_markable, and a 409 with no code, stay not_markable", async () => {
    expect(staffErrorKind(await caught(setup([res(409, { error: "x", code: "not_markable" })]).api.me()))).toBe("not_markable");
    expect(staffErrorKind(await caught(setup([res(409, null)]).api.me()))).toBe("not_markable");
  });
  it("a 409 does not trigger the read-only 429 retry or any resend", async () => {
    const { api, fetchImpl } = setup([res(409, { error: "x", code: "idempotency_conflict" })]);
    await caught(api.setAttendance("s", "a", "c", "attended", "key-12345678"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
