import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { createClaimRegister, createExpoPushAdapter, createExpoTapSource, createPushUnbind, type NotificationsModule } from "@/lib/expoPush";
import { readPushStatus } from "@/lib/pushSetup";
import { supabase } from "@/lib/supabase";

// The one place the native module is imported. The token is an Expo push token for the EAS project, registered with the existing claim function.
const mod = Notifications as unknown as NotificationsModule;
const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

const adapter = createExpoPushAdapter(mod, projectId);

export const unbindNativePush = createPushUnbind(
  adapter,
  async () => (await supabase.auth.getSession()).data.session?.user.id ?? null,
  (token, userId) => supabase.from("mobile_push_tokens").delete().eq("expo_push_token", token).eq("user_id", userId),
);

export const nativePush = {
  adapter,
  taps: createExpoTapSource(mod),
  register: createClaimRegister((fn, args) => supabase.rpc(fn, args), Platform.OS),
};

/** Binds the token again when notifications are already allowed (never prompts). Used when a sign-out everywhere was refused after the unbind. */
export async function rebindNativePush() {
  await readPushStatus(nativePush.adapter, nativePush.register);
}
