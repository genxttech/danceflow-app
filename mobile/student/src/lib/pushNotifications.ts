import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { supabase } from "@/lib/supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true
  })
});

export type NotificationPreferences = {
  pushEnabled: boolean;
  scheduleUpdates: boolean;
  eventUpdates: boolean;
  favoriteUpdates: boolean;
  learningUpdates: boolean;
  accountUpdates: boolean;
};

type PreferenceRow = {
  push_enabled: boolean | null;
  schedule_updates: boolean | null;
  event_updates: boolean | null;
  favorite_updates: boolean | null;
  learning_updates: boolean | null;
  account_updates: boolean | null;
};

const DEFAULT_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  scheduleUpdates: true,
  eventUpdates: true,
  favoriteUpdates: true,
  learningUpdates: false,
  accountUpdates: true
};

function toPreferenceRow(userId: string, preferences: NotificationPreferences) {
  return {
    user_id: userId,
    push_enabled: preferences.pushEnabled,
    schedule_updates: preferences.scheduleUpdates,
    event_updates: preferences.eventUpdates,
    favorite_updates: preferences.favoriteUpdates,
    learning_updates: preferences.learningUpdates,
    account_updates: preferences.accountUpdates
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
    accountUpdates: row.account_updates ?? DEFAULT_PREFERENCES.accountUpdates
  };
}

function projectId() {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

export async function getNotificationPermissionStatus() {
  const current = await Notifications.getPermissionsAsync();
  return current.status;
}

export async function requestNotificationPermission() {
  const current = await Notifications.getPermissionsAsync();

  if (current.granted) {
    return true;
  }

  const next = await Notifications.requestPermissionsAsync();
  return next.granted;
}

export async function registerPushToken(userId: string, askPermission = false) {
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
    .select("push_enabled, schedule_updates, event_updates, favorite_updates, learning_updates, account_updates")
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

    return () => {
      cancelled = true;
    };
  }, [userId]);
}

export function useNotificationPreferences(userId: string | null | undefined) {
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [permissionStatus, setPermissionStatus] = useState<string>("undetermined");
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

  const enableNotifications = useCallback(async () => {
    if (!userId) return;

    setSaving(true);
    setMessage(null);

    try {
      const token = await registerPushToken(userId, true);
      const status = await getNotificationPermissionStatus();
      setPermissionStatus(status);

      if (token) {
        const nextPreferences = { ...preferences, pushEnabled: true };
        await saveNotificationPreferences(userId, nextPreferences);
        setPreferences(nextPreferences);
        setMessage("Notifications are ready.");
      } else {
        setMessage("Notifications were not enabled. You can try again later.");
      }
    } finally {
      setSaving(false);
    }
  }, [preferences, userId]);

  return {
    preferences,
    permissionStatus,
    loading,
    saving,
    message,
    refresh,
    updatePreferences,
    enableNotifications
  };
}
