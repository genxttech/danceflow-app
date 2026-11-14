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
jest.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: jest.fn(async () => ({ error: null })),
    from: jest.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    })),
  },
}));

import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import {
  resetRoutedNotificationsForTests,
  routeNotificationResponse,
  useNotificationPreferences,
} from "@/lib/pushNotifications";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

const push = router.push as jest.Mock;
const tap = (identifier: string, data: Record<string, unknown>) => ({
  notification: { request: { identifier, content: { data } } },
});

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  jest.clearAllMocks();
  resetRoutedNotificationsForTests();
});

describe("notification tap routing", () => {
  it.each([
    [{ screen: "appointment", appointmentId: "a1" }, { pathname: "/appointments/[id]", params: { id: "a1" } }],
    [{ orderId: "o1" }, { pathname: "/events/orders/[orderId]", params: { orderId: "o1" } }],
    [{ eventId: "e1" }, { pathname: "/events/[id]", params: { id: "e1" } }],
    [{ documentId: "d1" }, { pathname: "/wallet/documents/[assignmentId]", params: { assignmentId: "d1" } }],
    [{ screen: "documents" }, "/wallet/documents"],
    [{ screen: "tickets" }, "/wallet/event-tickets"],
  ])("opens the screen for %j", (data, target) => {
    expect(routeNotificationResponse(tap("n", data))).toBe(true);
    expect(push).toHaveBeenCalledWith(target);
  });

  it("does nothing for a payload with no destination", () => {
    routeNotificationResponse(tap("n", { screen: "unknown" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores ids that are not id-shaped instead of passing them into a route", () => {
    routeNotificationResponse(tap("n", { eventId: "../../settings" }));
    routeNotificationResponse(tap("m", { orderId: "o1/../x", assignmentId: "a b" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("routes a tap once: the same last response arriving again after a later sign-in is dropped", () => {
    expect(routeNotificationResponse(tap("same", { eventId: "e1" }))).toBe(true);
    expect(routeNotificationResponse(tap("same", { eventId: "e1" }))).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("turning push on without working credentials", () => {
  it("explains it and leaves the preference off instead of failing silently", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, status: "granted" });
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValue(new Error("FCM not configured"));

    const { result } = renderHook(() => useNotificationPreferences("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setPushEnabled(true);
    });

    expect(result.current.message).toMatch(/could not be set up on this device yet/);
    expect(result.current.saving).toBe(false);
  });

  it("says push is blocked in device settings when permission is denied", async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, status: "denied" });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    const { result } = renderHook(() => useNotificationPreferences("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setPushEnabled(true);
    });

    expect(result.current.message).toBe("Push notifications are blocked in your device settings.");
  });
});
