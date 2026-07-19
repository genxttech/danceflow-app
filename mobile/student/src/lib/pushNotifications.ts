import { useCallback, useEffect, useState } from "react";
import { router } from "expo-router";
import { Linking, Platform } from "react-native";
import Constants from "expo-constants";
import { supabase } from "@/lib/supabase";

export type NotificationPreferences = {
  pushEnabled: boolean;
  scheduleUpdates: boolean;
  eventUpdates: boolean;
  favoriteUpdates: boolean;
  learningUpdates: boolean;
  accountUpdates: boolean;
  partnerUpdates: boolean;
};

type PreferenceRow = {
  push_enabled: boolean | null;
  schedule_updates: boolean | null;
  event_updates: boolean | null;
  favorite_updates: boolean | null;
  learning_updates: boolean | null;
  account_updates: boolean | null;
  partner_updates: boolean | null;
};

const DEFAULT_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  scheduleUpdates: true,
  eventUpdates: true,
  favoriteUpdates: true,
  learningUpdates: false,
  accountUpdates: true,
  partnerUpdates: true
};

let notificationHandlerConfigured = false;

function routeFromNotificationData(
  data: Record<string, unknown> | null | undefined,
) {
  if (!data) return;

  const screen = typeof data.screen === "string" ? data.screen : "";
  const appointmentId =
    typeof data.appointmentId === "string" ? data.appointmentId : "";
  const documentId =
    typeof data.documentId === "string" ? data.documentId : "";
  const assignmentId =
    typeof data.assignmentId === "string" ? data.assignmentId : documentId;
  const eventId =
    typeof data.eventId === "string" ? data.eventId : "";
  const orderId =
    typeof data.orderId === "string" ? data.orderId : "";

  if (screen === "appointment" && appointmentId) {
    router.push({
      pathname: "/appointments/[id]",
      params: { id: appointmentId },
    });
    return;
  }

  if (assignmentId) {
    router.push({
      pathname: "/wallet/documents/[assignmentId]",
      params: { assignmentId },
    } as never);
    return;
  }

  if (screen === "documents") {
    router.push("/wallet/documents" as never);
    return;
  }

  if (orderId) {
    router.push({
      pathname: "/events/orders/[orderId]",
      params: { orderId },
    } as never);
    return;
  }

  if (eventId) {
    router.push({
      pathname: "/events/[id]",
      params: { id: eventId },
    } as never);
    return;
  }

  if (screen === "event_tickets" || screen === "tickets") {
    router.push("/wallet/event-tickets" as never);
  }
}

function isExpoGo() {
  return Constants.appOwnership === "expo";
}

async function getNotificationsModule(): Promise<any | null> {
  if (isExpoGo()) return null;

  const notificationsModule = await import("expo-notifications");
  const Notifications = notificationsModule as any;

  if (!notificationHandlerConfigured) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true
      })
    });

    notificationHandlerConfigured = true;
  }

  return Notifications;
}

function toPreferenceRow(userId: string, preferences: NotificationPreferences) {
  return {
    user_id: userId,
    push_enabled: preferences.pushEnabled,
    schedule_updates: preferences.scheduleUpdates,
    event_updates: preferences.eventUpdates,
    favorite_updates: preferences.favoriteUpdates,
    learning_updates: preferences.learningUpdates,
    account_updates: preferences.accountUpdates,
    partner_updates: preferences.partnerUpdates
  };
}

function fromPreferenceRow(row: PreferenceRow | null | undefined): NotificationPreferences {
  if (!row) return DEFAULT_PREFERENCES;

  return {
    pushEnabled: row.push_enabled ?? DEFAULT_PREFERENCES.pushEnabled,
    scheduleUpdates: row.schedule_updates ?? DEFAULT_PREFERENCES.scheduleUpdates,
    eventUpdates: row.event_updates ?? DEFAULT_PREFERENCES.eventUpdates,
    favoriteUpdates: row.favorite_updates ?? DEFAULT_PREFERENCES.favoriteUpdates,
    learningUpdates: row.learning_updates ?? DEFAULT_PREFERENCES.learningUpdates,
    accountUpdates: row.account_updates ?? DEFAULT_PREFERENCES.accountUpdates,
    partnerUpdates: row.partner_updates ?? DEFAULT_PREFERENCES.partnerUpdates
  };
}

function projectId() {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

export async function getNotificationPermissionStatus() {
  const Notifications = await getNotificationsModule();

  if (!Notifications) {
    return "development_build_required";
  }

  const current = await Notifications.getPermissionsAsync();
  return current.status;
}

export async function requestNotificationPermission() {
  const Notifications = await getNotificationsModule();

  if (!Notifications) {
    return false;
  }

  const current = await Notifications.getPermissionsAsync();

  if (current.granted) {
    return true;
  }

  const next = await Notifications.requestPermissionsAsync();
  return next.granted;
}


export async function openNotificationSettings() {
  await Linking.openSettings();
}

export async function registerPushToken(userId: string, askPermission = false) {
  const Notifications = await getNotificationsModule();

  if (!Notifications) {
    return null;
  }

  const status = await Notifications.getPermissionsAsync();

  if (!status.granted) {
    if (!askPermission) return null;

    const granted = await requestNotificationPermission();
    if (!granted) return null;
  }

  const resolvedProjectId = projectId();
  const tokenResponse = resolvedProjectId
    ? await Notifications.getExpoPushTokenAsync({ projectId: resolvedProjectId })
    : await Notifications.getExpoPushTokenAsync();

  const expoPushToken = tokenResponse.data;

  const { error } = await supabase.from("mobile_push_tokens").upsert(
    {
      user_id: userId,
      expo_push_token: expoPushToken,
      platform: Platform.OS === "ios" || Platform.OS === "android" || Platform.OS === "web" ? Platform.OS : "unknown",
      app_slug: "danceflow-student",
      enabled: true,
      last_registered_at: new Date().toISOString()
    },
    { onConflict: "expo_push_token" }
  );

  if (error) throw error;

  return expoPushToken;
}

export async function loadNotificationPreferences(userId: string) {
  const { data, error } = await supabase
    .from("mobile_notification_preferences")
    .select("push_enabled, schedule_updates, event_updates, favorite_updates, learning_updates, account_updates, partner_updates")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const { error: insertError } = await supabase
      .from("mobile_notification_preferences")
      .insert(toPreferenceRow(userId, DEFAULT_PREFERENCES));

    if (insertError) throw insertError;

    return DEFAULT_PREFERENCES;
  }

  return fromPreferenceRow(data as PreferenceRow);
}

export async function saveNotificationPreferences(userId: string, preferences: NotificationPreferences) {
  const { error } = await supabase
    .from("mobile_notification_preferences")
    .upsert(toPreferenceRow(userId, preferences), { onConflict: "user_id" });

  if (error) throw error;

  if (!preferences.pushEnabled) {
    await supabase
      .from("mobile_push_tokens")
      .update({ enabled: false })
      .eq("user_id", userId);
  }

  return preferences;
}

export function usePushNotificationBootstrap(userId: string | null | undefined) {
  useEffect(() => {
    if (!userId) return;

    const activeUserId = userId;
    let cancelled = false;
    let responseSubscription: { remove: () => void } | null = null;

    async function registerExistingPermission() {
      try {
        const status = await getNotificationPermissionStatus();

        if (!cancelled && status === "granted") {
          await registerPushToken(activeUserId, false);
        }
      } catch (_error) {
        // Preferences screen can guide the dancer to retry.
      }
    }

    registerExistingPermission();

    getNotificationsModule()
      .then((Notifications) => {
        if (!Notifications || cancelled) return;

        responseSubscription =
          Notifications.addNotificationResponseReceivedListener((response: any) => {
            routeFromNotificationData(
              (response.notification.request.content.data ?? {}) as Record<string, unknown>,
            );
          });

        return Notifications.getLastNotificationResponseAsync();
      })
      .then((lastResponse) => {
        if (!lastResponse || cancelled) return;
        routeFromNotificationData(
          (lastResponse.notification.request.content.data ?? {}) as Record<string, unknown>,
        );
      })
      .catch(() => {
        // Notification routing remains optional when the native module is unavailable.
      });

    return () => {
      cancelled = true;
      responseSubscription?.remove();
    };
  }, [userId]);
}

export function useNotificationPreferences(userId: string | null | undefined) {
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [permissionStatus, setPermissionStatus] = useState<string>(isExpoGo() ? "development_build_required" : "undetermined");
  const [loading, setLoading] = useState(Boolean(userId));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const [nextPreferences, status] = await Promise.all([
        loadNotificationPreferences(userId),
        getNotificationPermissionStatus()
      ]);

      setPreferences(nextPreferences);
      setPermissionStatus(status);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updatePreferences = useCallback(
    async (nextPreferences: NotificationPreferences) => {
      if (!userId) return;

      setSaving(true);
      setMessage(null);

      try {
        await saveNotificationPreferences(userId, nextPreferences);
        setPreferences(nextPreferences);
        setMessage("Notification preferences updated.");
      } finally {
        setSaving(false);
      }
    },
    [userId]
  );

  const setPushEnabled = useCallback(
    async (enabled: boolean) => {
      if (!userId) return;

      setSaving(true);
      setMessage(null);

      try {
        if (!enabled) {
          const nextPreferences = { ...preferences, pushEnabled: false };
          await saveNotificationPreferences(userId, nextPreferences);
          setPreferences(nextPreferences);
          setMessage("Push notifications turned off.");
          return;
        }

        if (isExpoGo()) {
          setPermissionStatus("development_build_required");
          setMessage("Push notifications require the DanceFlow preview app.");
          return;
        }

        const token = await registerPushToken(userId, true);
        const status = await getNotificationPermissionStatus();
        setPermissionStatus(status);

        if (!token) {
          setMessage(
            status === "denied"
              ? "Push notifications are blocked in your device settings."
              : "Push notifications were not enabled.",
          );
          return;
        }

        const nextPreferences = { ...preferences, pushEnabled: true };
        await saveNotificationPreferences(userId, nextPreferences);
        setPreferences(nextPreferences);
        setMessage("Push notifications are on.");
      } finally {
        setSaving(false);
      }
    },
    [preferences, userId],
  );

  return {
    preferences,
    permissionStatus,
    loading,
    saving,
    message,
    refresh,
    updatePreferences,
    setPushEnabled,
    openNotificationSettings
  };
}
