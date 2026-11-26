/*
  The expo-notifications adapter, written against a small structural type so jest can prove every path with a fake and
  the native module is imported in one place only (pushNative.ts).

  Paths: permission denied is a normal state; a missing project id or Firebase credential makes getDeviceToken reject
  (readPushStatus turns that into "unavailable: no_credentials"); an empty token is treated the same way. Tokens are
  never logged.
*/
import type { PermissionState, PushAdapter } from "@/lib/pushSetup";
import type { TapSource } from "@/lib/push";

type PermissionResult = { status: string; granted?: boolean; canAskAgain?: boolean };

export type NotificationsModule = {
  getPermissionsAsync: () => Promise<PermissionResult>;
  requestPermissionsAsync: () => Promise<PermissionResult>;
  getExpoPushTokenAsync: (options?: { projectId?: string }) => Promise<{ data: unknown }>;
  addNotificationResponseReceivedListener: (
    handler: (response: { notification: { request: { content: { data: unknown } } } }) => void,
  ) => { remove: () => void };
  getLastNotificationResponseAsync: () => Promise<{ notification: { request: { content: { data: unknown } } } } | null>;
};

function toPermission(result: PermissionResult): PermissionState {
  if (result.granted === true || result.status === "granted") return "granted";
  // Android 13+ reports "denied" for a permission never asked (found on the emulator: the card said "turned off" with no
  // way to turn it on). Denied but still askable means the prompt can be shown, so it is not a refusal yet.
  if (result.status === "denied") return result.canAskAgain === true ? "undetermined" : "denied";
  return "undetermined";
}

// The server sender (sendMobilePushToUser) talks to Expo's push service, so the token is an Expo push token, not the raw FCM/APNs one; the same
// shape the claim function accepts.
const EXPO_TOKEN = /^(Exponent|Expo)PushToken[[A-Za-z0-9_-]+]$/;

export function createExpoPushAdapter(mod: NotificationsModule, projectId?: string): PushAdapter {
  return {
    getPermission: async () => toPermission(await mod.getPermissionsAsync()),
    requestPermission: async () => toPermission(await mod.requestPermissionsAsync()),
    getDeviceToken: async () => {
      const { data } = await mod.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      if (typeof data !== "string" || !EXPO_TOKEN.test(data)) throw new Error("no push token");
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

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;

/**
 * Registers the token with the existing claim function (the Student app uses the same one): the row follows whoever is signed in on the device, the table's RLS
 * stays as it is, and no new route or table is needed. A failure throws, which readPushStatus reports as "on, setup will finish later". Never logs the token.
 */
export function createClaimRegister(rpc: Rpc, platform: string): (token: string) => Promise<void> {
  return async (token) => {
    const { error } = await rpc("claim_mobile_push_token", {
      p_expo_push_token: token,
      p_platform: platform === "ios" || platform === "android" ? platform : "unknown",
      p_app_slug: "danceflow-business",
    });
    if (error) throw new Error("push token registration failed");
  };
}

/**
 * Removes this device's token row, so a signed-out phone stops receiving the previous person's notifications. The table's own-row delete policy allows it, so it
 * must run while that person is still signed in. Their id is read first and pinned on the delete: if reading the token stalls past the sign-out wait and someone
 * else signs in, the late delete cannot remove the new person's row. Permission is not checked: a token registered before it was turned off is still bound.
 */
export function createPushUnbind(
  adapter: PushAdapter,
  currentUserId: () => Promise<string | null>,
  remove: (token: string, userId: string) => PromiseLike<{ error: { message: string } | null }>,
): () => Promise<void> {
  return async () => {
    const userId = await currentUserId();
    if (!userId) return;
    const { error } = await remove(await adapter.getDeviceToken(), userId);
    if (error) throw new Error("push token removal failed");
  };
}
