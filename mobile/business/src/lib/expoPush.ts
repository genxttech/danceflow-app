/*
  The expo-notifications adapter, written against a small structural type so jest can prove every path with a fake and
  the native module is imported in one place only (pushNative.ts).

  Paths: permission denied is a normal state; a missing project id or Firebase credential makes getDeviceToken reject
  (readPushStatus turns that into "unavailable: no_credentials"); an empty token is treated the same way. Tokens are
  never logged.
*/
import type { PermissionState, PushAdapter } from "@/lib/pushSetup";
import type { TapSource } from "@/lib/push";

export type NotificationsModule = {
  getPermissionsAsync: () => Promise<{ status: string; granted?: boolean }>;
  requestPermissionsAsync: () => Promise<{ status: string; granted?: boolean }>;
  getDevicePushTokenAsync: () => Promise<{ data: unknown }>;
  addNotificationResponseReceivedListener: (
    handler: (response: { notification: { request: { content: { data: unknown } } } }) => void,
  ) => { remove: () => void };
  getLastNotificationResponseAsync: () => Promise<{ notification: { request: { content: { data: unknown } } } } | null>;
};

function toPermission(result: { status: string; granted?: boolean }): PermissionState {
  if (result.granted === true || result.status === "granted") return "granted";
  if (result.status === "denied") return "denied";
  return "undetermined";
}

export function createExpoPushAdapter(mod: NotificationsModule): PushAdapter {
  return {
    getPermission: async () => toPermission(await mod.getPermissionsAsync()),
    requestPermission: async () => toPermission(await mod.requestPermissionsAsync()),
    getDeviceToken: async () => {
      const { data } = await mod.getDevicePushTokenAsync();
      if (typeof data !== "string" || data.length === 0) throw new Error("no device token");
      return data;
    },
  };
}

export function createExpoTapSource(mod: NotificationsModule): TapSource {
  return {
    subscribe: (handler) => {
      const sub = mod.addNotificationResponseReceivedListener((r) => handler(r.notification.request.content.data));
      return () => sub.remove();
    },
    getInitial: async () => (await mod.getLastNotificationResponseAsync())?.notification.request.content.data ?? null,
  };
}
