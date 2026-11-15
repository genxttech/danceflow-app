import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { createClaimRegister, createExpoPushAdapter, createExpoTapSource, type NotificationsModule } from "@/lib/expoPush";
import { supabase } from "@/lib/supabase";

// The one place the native module is imported. The token is an Expo push token for the EAS project, registered with the existing claim function.
const mod = Notifications as unknown as NotificationsModule;
const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

export const nativePush = {
  adapter: createExpoPushAdapter(mod, projectId),
  taps: createExpoTapSource(mod),
  register: createClaimRegister((fn, args) => supabase.rpc(fn, args), Platform.OS),
};
