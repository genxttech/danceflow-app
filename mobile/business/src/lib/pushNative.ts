import * as Notifications from "expo-notifications";
import { createExpoPushAdapter, createExpoTapSource, type NotificationsModule } from "@/lib/expoPush";

// The one place the native module is imported. No register callback yet: no staff endpoint exists (contract proposal P1).
const mod = Notifications as unknown as NotificationsModule;
export const nativePush = { adapter: createExpoPushAdapter(mod), taps: createExpoTapSource(mod) };
