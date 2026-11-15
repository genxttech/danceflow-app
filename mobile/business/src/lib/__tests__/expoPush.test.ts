import { createClaimRegister, createExpoPushAdapter, createExpoTapSource, type NotificationsModule } from "../expoPush";
import { enablePush, readPushStatus } from "../pushSetup";

function fake(over: Partial<NotificationsModule> = {}): NotificationsModule {
  return {
    getPermissionsAsync: async () => ({ status: "undetermined" }),
    requestPermissionsAsync: async () => ({ status: "granted", granted: true }),
    getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[abc_123-X]" }),
    addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
    getLastNotificationResponseAsync: async () => null,
    ...over,
  };
}

describe("expo push adapter", () => {
  it("denied-but-askable (Android never asked) is not asked yet, so the button can show; denied with no re-ask is denied", async () => {
    const askable = createExpoPushAdapter(fake({ getPermissionsAsync: async () => ({ status: "denied", canAskAgain: true }) }));
    expect(await readPushStatus(askable)).toEqual({ kind: "not_asked" });
    const blocked = createExpoPushAdapter(fake({ getPermissionsAsync: async () => ({ status: "denied", canAskAgain: false }) }));
    expect(await readPushStatus(blocked)).toEqual({ kind: "denied" });
  });

  it("does not prompt when only reading status", async () => {
    const request = jest.fn();
    const status = await readPushStatus(createExpoPushAdapter(fake({ requestPermissionsAsync: request })));
    expect(status).toEqual({ kind: "not_asked" });
    expect(request).not.toHaveBeenCalled();
  });

  it("denied permission is a normal state and never asks for a token", async () => {
    const token = jest.fn();
    const adapter = createExpoPushAdapter(
      fake({ requestPermissionsAsync: async () => ({ status: "denied" }), getExpoPushTokenAsync: token }),
    );
    expect(await enablePush(adapter)).toEqual({ kind: "denied" });
    expect(token).not.toHaveBeenCalled();
  });

  it("missing credentials (token read throws) is unavailable, not a crash", async () => {
    const adapter = createExpoPushAdapter(
      fake({ getExpoPushTokenAsync: async () => { throw new Error("Default FirebaseApp is not initialized"); } }),
    );
    expect(await enablePush(adapter)).toEqual({ kind: "unavailable", reason: "no_credentials" });
  });

  it("an empty or non-string token is unavailable", async () => {
    for (const data of ["", null, 5, "raw-fcm-token-not-an-expo-token", "ExponentPushToken[bad token]"]) {
      const adapter = createExpoPushAdapter(fake({ getExpoPushTokenAsync: async () => ({ data }) }));
      expect(await enablePush(adapter)).toEqual({ kind: "unavailable", reason: "no_credentials" });
    }
  });

  it("granted with a token is ready; registered only when register succeeds", async () => {
    const adapter = createExpoPushAdapter(fake());
    expect(await enablePush(adapter)).toEqual({ kind: "ready", registered: false });
    const register = jest.fn(async () => undefined);
    expect(await enablePush(adapter, register)).toEqual({ kind: "ready", registered: true });
    expect(register).toHaveBeenCalledWith("ExponentPushToken[abc_123-X]");
  });

  it("tap source forwards the notification data, removes the listener, and reads the launch notification", async () => {
    const remove = jest.fn();
    let handler: (r: never) => void = () => undefined;
    const data = { type: "client", id: "x" };
    const taps = createExpoTapSource(
      fake({
        addNotificationResponseReceivedListener: ((h: never) => { handler = h; return { remove }; }) as never,
        getLastNotificationResponseAsync: async () => ({ notification: { request: { content: { data } } } }),
      }),
    );
    const seen: unknown[] = [];
    const off = taps.subscribe((d) => seen.push(d));
    handler({ notification: { request: { content: { data } } } } as never);
    expect(seen).toEqual([data]);
    off();
    expect(remove).toHaveBeenCalled();
    expect(await taps.getInitial()).toEqual(data);
  });
});

describe("expo token and claim registration", () => {
  it("asks Expo for the token with the EAS project id when there is one", async () => {
    const getExpoPushTokenAsync = jest.fn(async () => ({ data: "ExpoPushToken[xyz]" }));
    await createExpoPushAdapter(fake({ getExpoPushTokenAsync }), "proj-1").getDeviceToken();
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "proj-1" });
    await createExpoPushAdapter(fake({ getExpoPushTokenAsync })).getDeviceToken();
    expect(getExpoPushTokenAsync).toHaveBeenLastCalledWith(undefined);
  });

  it("registers through claim_mobile_push_token for the Business app slug", async () => {
    const rpc = jest.fn(async () => ({ error: null }));
    await createClaimRegister(rpc, "android")("ExpoPushToken[xyz]");
    expect(rpc).toHaveBeenCalledWith("claim_mobile_push_token", { p_expo_push_token: "ExpoPushToken[xyz]", p_platform: "android", p_app_slug: "danceflow-business" });
    await createClaimRegister(rpc, "web")("ExpoPushToken[xyz]");
    expect(rpc).toHaveBeenLastCalledWith("claim_mobile_push_token", expect.objectContaining({ p_platform: "unknown" }));
  });

  it("a refused registration throws a message with no token in it, and the status stays ready/unregistered", async () => {
    const register = createClaimRegister(async () => ({ error: { message: "invalid push token ExpoPushToken[secret]" } }), "android");
    await expect(register("ExpoPushToken[secret]")).rejects.toThrow("push token registration failed");
    await expect(register("ExpoPushToken[secret]")).rejects.not.toThrow(/secret/);
    const adapter = createExpoPushAdapter(fake({ getPermissionsAsync: async () => ({ status: "granted", granted: true }) }));
    expect(await readPushStatus(adapter, register)).toEqual({ kind: "ready", registered: false });
  });
});
