import { enablePush, readPushStatus, type PushAdapter } from "@/lib/pushSetup";

function adapter(over: Partial<PushAdapter> = {}): PushAdapter {
  return {
    getPermission: jest.fn(async () => "undetermined" as const),
    requestPermission: jest.fn(async () => "granted" as const),
    getDeviceToken: jest.fn(async () => "token-1"),
    ...over,
  };
}

describe("readPushStatus (never prompts)", () => {
  it("is not_asked while undetermined and does not touch the OS prompt or the token", async () => {
    const a = adapter();
    expect(await readPushStatus(a)).toEqual({ kind: "not_asked" });
    expect(a.requestPermission).not.toHaveBeenCalled();
    expect(a.getDeviceToken).not.toHaveBeenCalled();
  });

  it("reports denied as a normal state", async () => {
    expect(await readPushStatus(adapter({ getPermission: async () => "denied" }))).toEqual({ kind: "denied" });
  });

  it("treats a failing permission read as not asked, not as a crash", async () => {
    expect(await readPushStatus(adapter({ getPermission: async () => Promise.reject(new Error("x")) }))).toEqual({ kind: "not_asked" });
  });

  it("registers the token when already granted", async () => {
    const register = jest.fn(async () => {});
    const status = await readPushStatus(adapter({ getPermission: async () => "granted" }), register);
    expect(status).toEqual({ kind: "ready", registered: true });
    expect(register).toHaveBeenCalledWith("token-1");
  });
});

describe("enablePush (from a user action)", () => {
  it("prompts, then registers", async () => {
    const a = adapter();
    const register = jest.fn(async () => {});
    expect(await enablePush(a, register)).toEqual({ kind: "ready", registered: true });
    expect(a.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("denied at the prompt stops there: no token read", async () => {
    const a = adapter({ requestPermission: async () => "denied" });
    expect(await enablePush(a)).toEqual({ kind: "denied" });
    expect(a.getDeviceToken).not.toHaveBeenCalled();
  });

  it("without credentials the app carries on as unavailable", async () => {
    const a = adapter({ getDeviceToken: async () => Promise.reject(new Error("Default FirebaseApp is not initialized")) });
    expect(await enablePush(a, jest.fn())).toEqual({ kind: "unavailable", reason: "no_credentials" });
  });

  it("a failed server registration keeps permission and reports not registered, never throwing", async () => {
    const register = jest.fn(async () => Promise.reject(new Error("503")));
    expect(await enablePush(adapter(), register)).toEqual({ kind: "ready", registered: false });
  });

  it("without a register function the token is read but not sent anywhere", async () => {
    expect(await enablePush(adapter())).toEqual({ kind: "ready", registered: false });
  });
});
