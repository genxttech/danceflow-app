import { createExpoPushAdapter, createExpoTapSource, type NotificationsModule } from "../expoPush";
import { enablePush, readPushStatus } from "../pushSetup";

function fake(over: Partial<NotificationsModule> = {}): NotificationsModule {
  return {
    getPermissionsAsync: async () => ({ status: "undetermined" }),
    requestPermissionsAsync: async () => ({ status: "granted", granted: true }),
    getDevicePushTokenAsync: async () => ({ data: "tok" }),
    addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
    getLastNotificationResponseAsync: async () => null,
    ...over,
  };
}

describe("expo push adapter", () => {
  it("does not prompt when only reading status", async () => {
    const request = jest.fn();
    const status = await readPushStatus(createExpoPushAdapter(fake({ requestPermissionsAsync: request })));
    expect(status).toEqual({ kind: "not_asked" });
    expect(request).not.toHaveBeenCalled();
  });

  it("denied permission is a normal state and never asks for a token", async () => {
    const token = jest.fn();
    const adapter = createExpoPushAdapter(
      fake({ requestPermissionsAsync: async () => ({ status: "denied" }), getDevicePushTokenAsync: token }),
    );
    expect(await enablePush(adapter)).toEqual({ kind: "denied" });
    expect(token).not.toHaveBeenCalled();
  });

  it("missing credentials (token read throws) is unavailable, not a crash", async () => {
    const adapter = createExpoPushAdapter(
      fake({ getDevicePushTokenAsync: async () => { throw new Error("Default FirebaseApp is not initialized"); } }),
    );
    expect(await enablePush(adapter)).toEqual({ kind: "unavailable", reason: "no_credentials" });
  });

  it("an empty or non-string token is unavailable", async () => {
    for (const data of ["", null, 5]) {
      const adapter = createExpoPushAdapter(fake({ getDevicePushTokenAsync: async () => ({ data }) }));
      expect(await enablePush(adapter)).toEqual({ kind: "unavailable", reason: "no_credentials" });
    }
  });

  it("granted with a token is ready; registered only when register succeeds", async () => {
    const adapter = createExpoPushAdapter(fake());
    expect(await enablePush(adapter)).toEqual({ kind: "ready", registered: false });
    const register = jest.fn(async () => undefined);
    expect(await enablePush(adapter, register)).toEqual({ kind: "ready", registered: true });
    expect(register).toHaveBeenCalledWith("tok");
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
