import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guardState = vi.hoisted(() => ({ calls: [] as Array<{ studioId: string; method: string }>, result: null as unknown }));

vi.mock("@/lib/auth/staffApiAuth", () => ({
  requireStaffApi: async (request: Request, studioId: string) => {
    guardState.calls.push({ studioId, method: request.method });
    return guardState.result;
  },
}));

const { APP_HEADER, STAFF_WRITE_CAPABILITIES, evaluateWriteGate, parseAppHeader, parseStaffWritePolicy, requireStaffWrite } = await import(
  "@/lib/staff/writeGuard"
);

const OK_CONTEXT = { ok: true, user: { id: "u1" }, supabase: {}, fullName: null, studioId: "s1", studioRole: "front_desk", studioTimeZone: null };
const AUTH_FAILURE = { ok: false, response: new Response(JSON.stringify({ error: "Authentication required.", code: "unauthenticated" }), { status: 401 }) };

const POLICY = JSON.stringify({ enabled: ["clientNotes", "classRoster"], minimumCode: { android: 2 }, blockedCodes: { android: [3] } });
const HEADER_OK = "business/0.2.0/4/android";

function request(method: string, header?: string | null) {
  return new Request("https://app.test/api/staff/workspaces/s1/clients/c1/notes", {
    method,
    headers: header === null || header === undefined ? {} : { [APP_HEADER]: header },
  });
}

beforeEach(() => {
  guardState.calls = [];
  guardState.result = OK_CONTEXT;
  process.env.STAFF_API_WRITE_POLICY = POLICY;
});
afterEach(() => {
  delete process.env.STAFF_API_WRITE_POLICY;
});

describe("parseStaffWritePolicy: only a clean explicit policy is trusted", () => {
  it("parses a valid policy", () => {
    const policy = parseStaffWritePolicy(POLICY)!;
    expect([...policy.enabled].sort()).toEqual(["classRoster", "clientNotes"]);
    expect(policy.minimumCode).toEqual({ android: 2, ios: 0 });
    expect([...policy.blockedCodes.android]).toEqual([3]);
  });
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["not JSON", "clientNotes,classRoster"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a string", '"clientNotes"'],
    ["enabled missing", "{}"],
    ["enabled not an array", '{"enabled":"clientNotes"}'],
    ["enabled with a non-string", '{"enabled":[1]}'],
    ["minimumCode a string", '{"enabled":[],"minimumCode":{"android":"3"}}'],
    ["minimumCode negative", '{"enabled":[],"minimumCode":{"android":-1}}'],
    ["minimumCode a float", '{"enabled":[],"minimumCode":{"android":1.5}}'],
    ["minimumCode not an object", '{"enabled":[],"minimumCode":3}'],
    ["blockedCodes not an array", '{"enabled":[],"blockedCodes":{"android":"3"}}'],
    ["blockedCodes with a string", '{"enabled":[],"blockedCodes":{"android":["3"]}}'],
  ])("%s is untrusted (null, so every write is disabled)", (_name, raw) => {
    expect(parseStaffWritePolicy(raw as string | undefined)).toBeNull();
  });
  it("ignores an unknown capability word and never lets it enable anything", () => {
    const policy = parseStaffWritePolicy('{"enabled":["futureThing","clientNotes"]}')!;
    expect([...policy.enabled]).toEqual(["clientNotes"]);
  });
});

describe("parseAppHeader", () => {
  it("accepts the documented shape", () => {
    expect(parseAppHeader("business/0.2.0/12/android")).toEqual({ version: "0.2.0", code: 12, platform: "android" });
    expect(parseAppHeader("business/1.0.0-rc.1/3/ios")).toEqual({ version: "1.0.0-rc.1", code: 3, platform: "ios" });
  });
  it.each([
    null,
    undefined,
    "",
    "business",
    "student/0.1.0/3/android",
    "business/0.2.0/x/android",
    "business/0.2.0/3/windows",
    "business/0.2.0/3",
    "business//3/android",
    "business/0.2.0/3/android/extra",
    "business/0.2.0/-3/android",
    "business/0.2.0/99999999999/android",
  ])("rejects %s", (value) => expect(parseAppHeader(value as string | null | undefined)).toBeNull());
});

describe("evaluateWriteGate", () => {
  const policy = parseStaffWritePolicy(POLICY);
  it("allows an enabled capability from a current build", () => {
    expect(evaluateWriteGate({ policy, capability: "clientNotes", appHeader: HEADER_OK })).toEqual({ allowed: true });
  });
  it("disables a capability that is not listed, and every capability when the policy is untrusted", () => {
    expect(evaluateWriteGate({ policy, capability: "clientCreate", appHeader: HEADER_OK })).toMatchObject({ allowed: false, code: "writes_disabled" });
    for (const capability of STAFF_WRITE_CAPABILITIES) {
      expect(evaluateWriteGate({ policy: null, capability, appHeader: HEADER_OK })).toMatchObject({ allowed: false, code: "writes_disabled" });
    }
  });
  it("answers upgrade_required for a missing or malformed header, a low code, a blocked code, and another app", () => {
    for (const appHeader of [null, "", "garbage", "business/0.1.0/1/android", "business/0.2.0/3/android", "student/0.2.0/9/android"]) {
      expect(evaluateWriteGate({ policy, capability: "clientNotes", appHeader })).toMatchObject({ allowed: false, code: "upgrade_required" });
    }
  });
  it("applies the minimum per platform: ios has no minimum here", () => {
    expect(evaluateWriteGate({ policy, capability: "clientNotes", appHeader: "business/0.2.0/1/ios" })).toEqual({ allowed: true });
  });
  it("checks the capability before the version, so a disabled capability never says upgrade", () => {
    expect(evaluateWriteGate({ policy, capability: "clientCreate", appHeader: null })).toMatchObject({ code: "writes_disabled" });
  });
});

describe("requireStaffWrite", () => {
  it("returns the guard context for an enabled capability from a current build", async () => {
    const result = await requireStaffWrite(request("POST", HEADER_OK), "s1", "clientNotes");
    expect(result.ok).toBe(true);
    expect(guardState.calls).toEqual([{ studioId: "s1", method: "POST" }]);
  });

  it("identity refusals come first and pass through untouched (401 before any switch)", async () => {
    guardState.result = AUTH_FAILURE;
    delete process.env.STAFF_API_WRITE_POLICY;
    const result = await requireStaffWrite(request("POST", HEADER_OK), "s1", "clientNotes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });

  it("FAIL CLOSED: an unset or unreadable policy answers 403 writes_disabled with the flat body", async () => {
    for (const raw of [undefined, "", "not json", '{"enabled":"x"}']) {
      if (raw === undefined) delete process.env.STAFF_API_WRITE_POLICY;
      else process.env.STAFF_API_WRITE_POLICY = raw;
      const result = await requireStaffWrite(request("PUT", HEADER_OK), "s1", "clientNotes");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(403);
      expect(result.response.headers.get("cache-control")).toBe("private, no-store");
      expect(await result.response.json()).toEqual({ error: "This change is turned off right now. Try again later.", code: "writes_disabled" });
    }
  });

  it("a capability not in the list is disabled even when others are on", async () => {
    const result = await requireStaffWrite(request("POST", HEADER_OK), "s1", "appointmentAttendance");
    expect(result.ok === false && (await result.response.json()).code).toBe("writes_disabled");
  });

  it("answers 426 upgrade_required for an old, blocked, missing or foreign header", async () => {
    for (const header of [null, "business/0.1.0/1/android", "business/0.2.0/3/android", "nonsense"]) {
      const result = await requireStaffWrite(request("POST", header), "s1", "clientNotes");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(426);
      expect(await result.response.json()).toEqual({ error: "Update DanceFlow Business to make this change.", code: "upgrade_required" });
    }
  });

  it("reads are never gated: a GET passes with no policy and no header", async () => {
    delete process.env.STAFF_API_WRITE_POLICY;
    const result = await requireStaffWrite(request("GET", null), "s1", "clientNotes");
    expect(result.ok).toBe(true);
  });

  it("an unknown capability key fails closed without touching the guard", async () => {
    const result = await requireStaffWrite(request("POST", HEADER_OK), "s1", "somethingElse" as never);
    expect(result.ok).toBe(false);
    expect(guardState.calls).toHaveLength(0);
  });

  it("reads the policy on every call, so a changed variable takes effect without a restart", async () => {
    expect((await requireStaffWrite(request("POST", HEADER_OK), "s1", "clientNotes")).ok).toBe(true);
    process.env.STAFF_API_WRITE_POLICY = '{"enabled":[]}';
    expect((await requireStaffWrite(request("POST", HEADER_OK), "s1", "clientNotes")).ok).toBe(false);
  });
});
