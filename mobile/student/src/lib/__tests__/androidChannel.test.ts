jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { appOwnership: null, expoConfig: { extra: { eas: { projectId: "project-1" } } } },
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => ({})),
  AndroidImportance: { DEFAULT: 3 },
  getPermissionsAsync: jest.fn(async () => ({ status: "undetermined" })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  getExpoPushTokenAsync: jest.fn(),
}));
jest.mock("@/lib/secureSessionStorage", () => ({
  secureSessionStorage: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock("@/lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  ANDROID_CHANNEL_ID,
  getNotificationPermissionStatus,
  requestNotificationPermission,
  resetAndroidChannelForTests,
} from "@/lib/pushNotifications";

const setChannel = Notifications.setNotificationChannelAsync as jest.Mock;
const order: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  resetAndroidChannelForTests();
  order.length = 0;
});

function os(name: "android" | "ios") {
  Object.defineProperty(Platform, "OS", { configurable: true, get: () => name });
}

describe("Android notification channel", () => {
  it("is created once, with a name and default importance", async () => {
    os("android");
    await getNotificationPermissionStatus();
    await getNotificationPermissionStatus();
    expect(setChannel).toHaveBeenCalledTimes(1);
    expect(setChannel).toHaveBeenCalledWith(ANDROID_CHANNEL_ID, { name: "DanceFlow", importance: 3 });
  });

  it("exists before the permission prompt (Android 13 shows none without a channel)", async () => {
    os("android");
    setChannel.mockImplementationOnce(async () => {
      order.push("channel");
    });
    (Notifications.requestPermissionsAsync as jest.Mock).mockImplementationOnce(async () => {
      order.push("prompt");
      return { status: "granted" };
    });
    await requestNotificationPermission();
    expect(order).toEqual(["channel", "prompt"]);
  });

  it("is not created on iOS", async () => {
    os("ios");
    await getNotificationPermissionStatus();
    expect(setChannel).not.toHaveBeenCalled();
  });

  it("never blocks push setup when the channel call fails, and retries next time", async () => {
    os("android");
    setChannel.mockRejectedValueOnce(new Error("boom"));
    await expect(getNotificationPermissionStatus()).resolves.toBe("undetermined");
    await getNotificationPermissionStatus();
    expect(setChannel).toHaveBeenCalledTimes(2);
  });
});
