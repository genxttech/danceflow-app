import { Pressable, StyleSheet, Switch, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { colors } from "@/constants/theme";
import {
  type NotificationPreferences,
  useNotificationPreferences
} from "@/lib/pushNotifications";

type PreferenceOption = {
  key: keyof NotificationPreferences;
  title: string;
  detail: string;
};

const preferenceOptions: PreferenceOption[] = [
  {
    key: "scheduleUpdates",
    title: "Schedule updates",
    detail: "Private lessons, group classes, booking requests, and schedule changes."
  },
  {
    key: "eventUpdates",
    title: "Event updates",
    detail: "Ticket confirmations, event reminders, and admission updates."
  },
  {
    key: "favoriteUpdates",
    title: "Favorite updates",
    detail: "New classes, events, or announcements from favorites you follow."
  },
  {
    key: "learningUpdates",
    title: "Learning updates",
    detail: "New recaps, syllabus updates, and practice focus reminders."
  },
  {
    key: "accountUpdates",
    title: "Account updates",
    detail: "Profile, membership, package, wallet, and payment request updates."
  },
  {
    key: "partnerUpdates",
    title: "Partner message updates",
    detail: "Partner search messages, replies, and conversation updates."
  }
];

export function NotificationPreferencesCard({ userId }: { userId: string }) {
  const {
    preferences,
    permissionStatus,
    loading,
    saving,
    message,
    updatePreferences,
    setPushEnabled,
    openNotificationSettings
  } = useNotificationPreferences(userId);

  function updatePreference(preferenceKey: keyof NotificationPreferences, value: boolean) {
    updatePreferences({ ...preferences, [preferenceKey]: value });
  }

  function togglePushNotifications(value: boolean) {
    void setPushEnabled(value);
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Notification Preferences</AppText>
          <AppText variant="subtitle">Choose what DanceFlow sends you</AppText>
          <AppText variant="caption">
            {loading
              ? "Loading notification settings..."
              : permissionStatus === "granted"
                ? "Push notifications are available on this device."
                : permissionStatus === "denied"
                  ? "Push notifications are blocked in your device settings."
                  : permissionStatus === "development_build_required"
                    ? "Push notifications require the DanceFlow preview app."
                    : "Turn on Push Notifications to allow alerts from DanceFlow."}
          </AppText>
        </View>
        {message ? <AppText style={styles.saved}>{message}</AppText> : null}
      </View>

      <Pressable
        onPress={() => togglePushNotifications(!preferences.pushEnabled)}
        style={({ pressed }) => [styles.masterOption, pressed && styles.optionPressed]}
      >
        <View style={{ flex: 1 }}>
          <AppText style={styles.optionTitle}>Push notifications</AppText>
          <AppText variant="caption">Master switch for DanceFlow mobile notifications.</AppText>
        </View>
        <Switch
          disabled={saving || loading}
          onValueChange={togglePushNotifications}
          thumbColor="#fff"
          trackColor={{ false: colors.border, true: colors.primary }}
          value={preferences.pushEnabled}
        />
      </Pressable>

      <View style={styles.options}>
        {preferenceOptions.map((option) => (
          <Pressable
            key={option.key}
            disabled={saving || loading || !preferences.pushEnabled}
            onPress={() => updatePreference(option.key, !preferences[option.key])}
            style={({ pressed }) => [
              styles.option,
              !preferences.pushEnabled && styles.optionDisabled,
              pressed && styles.optionPressed,
            ]}
          >
            <View style={{ flex: 1 }}>
              <AppText style={styles.optionTitle}>{option.title}</AppText>
              <AppText variant="caption">{option.detail}</AppText>
            </View>
            <Switch
              disabled={saving || loading || !preferences.pushEnabled}
              onValueChange={(value) => updatePreference(option.key, value)}
              thumbColor="#fff"
              trackColor={{ false: colors.border, true: colors.primary }}
              value={preferences[option.key]}
            />
          </Pressable>
        ))}
      </View>

      {permissionStatus === "denied" ? (
        <AppButton
          label="Open Device Settings"
          onPress={openNotificationSettings}
          variant="secondary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 14,
    padding: 16
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12
  },
  masterOption: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14
  },
  option: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 14
  },
  optionDisabled: {
    opacity: 0.5
  },
  optionPressed: {
    opacity: 0.78
  },
  options: {
    marginTop: -2
  },
  optionTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900",
    marginBottom: 3
  },
  saved: {
    color: colors.success,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "900",
    textAlign: "right"
  }
});
