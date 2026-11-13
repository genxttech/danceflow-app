import * as Notifications from "expo-notifications";
import { registerPushToken, unbindPushTokenForSignOut } from "@/lib/pushNotifications";
import { secureSessionStorage } from "@/lib/secureSessionStorage";
import { supabase } from "@/lib/supabase";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { appOwnership: null, expoConfig: { extra: { eas: { projectId: "project-1" } } } },
}));
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));
jest.mock("@/lib/secureSessionStorage", () => ({
  secureSessionStorage: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));

const mockEq = jest.fn();
const mockDelete = jest.fn(() => ({ eq: mockEq }));
const mockFrom = jest.fn((_table: string) => ({ delete: mockDelete }));
const mockRpc = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => mockFrom(table),
  },
}));

const TOKEN = "ExponentPushToken[device_1]";
const permissions = Notifications.getPermissionsAsync as jest.Mock;
const expoToken = Notifications.getExpoPushTokenAsync as jest.Mock;
const storage = secureSessionStorage as jest.Mocked<typeof secureSessionStorage>;

beforeEach(() => {
  permissions.mockResolvedValue({ granted: true });
  expoToken.mockResolvedValue({ data: TOKEN });
  mockRpc.mockResolvedValue({ error: null });
  mockEq.mockResolvedValue({ error: null });
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockResolvedValue(undefined);
  storage.removeItem.mockResolvedValue(undefined);
});

describe("registerPushToken", () => {
  it("claims the device through the server function, which works when the row names another user", async () => {
    await expect(registerPushToken("user-b")).resolves.toBe(TOKEN);

    expect(mockRpc).toHaveBeenCalledWith("claim_mobile_push_token", {
      p_expo_push_token: TOKEN,
      p_platform: "ios",
      p_app_slug: "danceflow-student",
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith("danceflow-expo-push-token", TOKEN);
  });

  it("raises a refused claim and does not remember the token", async () => {
    mockRpc.mockResolvedValue({ error: new Error("refused") });

    await expect(registerPushToken("user-b")).rejects.toThrow("refused");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not ask for a token without permission", async () => {
    permissions.mockResolvedValue({ granted: false });

    await expect(registerPushToken("user-b")).resolves.toBeNull();
    expect(expoToken).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("unbindPushTokenForSignOut", () => {
  it("deletes this device's row and forgets the token", async () => {
    storage.getItem.mockResolvedValue(TOKEN);

    await unbindPushTokenForSignOut();

    expect(mockFrom).toHaveBeenCalledWith("mobile_push_tokens");
    expect(mockEq).toHaveBeenCalledWith("expo_push_token", TOKEN);
    expect(storage.removeItem).toHaveBeenCalledWith("danceflow-expo-push-token");
    expect(expoToken).not.toHaveBeenCalled();
  });

  it("asks the device for its token when an older build did not remember it", async () => {
    await unbindPushTokenForSignOut();

    expect(mockEq).toHaveBeenCalledWith("expo_push_token", TOKEN);
  });

  it("does nothing on a device that never allowed notifications", async () => {
    permissions.mockResolvedValue({ granted: false });

    await unbindPushTokenForSignOut();

    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("never blocks sign-out when the delete fails, and keeps the token for the next claim", async () => {
    storage.getItem.mockResolvedValue(TOKEN);
    mockEq.mockResolvedValue({ error: new Error("offline") });

    await expect(unbindPushTokenForSignOut()).resolves.toBeUndefined();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("gives up on a hung network", async () => {
    jest.useFakeTimers();
    try {
      storage.getItem.mockResolvedValue(TOKEN);
      mockEq.mockReturnValue(new Promise(() => undefined));

      const unbinding = unbindPushTokenForSignOut();
      await jest.advanceTimersByTimeAsync(4000);

      await expect(unbinding).resolves.toBeUndefined();
    } finally {
      // A failure above must not leave fake timers on for later tests in this file.
      jest.useRealTimers();
    }
  });
});
