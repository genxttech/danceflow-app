import { Switch, View, StyleSheet } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { colors } from "@/constants/theme";
import { useNotificationPreferences, type NotificationPreferences } from "@/lib/pushNotifications";

type PreferenceKey = keyof NotificationPreferences;

const ROWS: Array<{
  key: PreferenceKey;
  title: string;
  detail: string;
}> = [
  {
    key: "scheduleUpdates",
    title: "Schedule updates",
    detail: "Lessons scheduled, rescheduled, or cancelled."
  },
  {
    key: "eventUpdates",
    title: "Event updates",
    detail: "Ticket reminders, event changes, and event-day notices."
  },
  {
    key: "favoriteUpdates",
    title: "Saved studio updates",
    detail: "New events from studios and organizers you save."
  },
  {
    key: "learningUpdates",
    title: "Learning updates",
    detail: "Lesson recaps, practice reminders, and LUMI progress prompts."
  },
  {
    key: "accountUpdates",
    title: "Account updates",
    detail: "Wallet, profile, and studio connection notices."
  }
];

function PreferenceRow({
  title,
  detail,
  value,
  disabled,
  onValueChange
}: {
  title: string;
  detail: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.preferenceRow}>
      <View style={styles.preferenceText}>
        <AppText variant="subtitle">{title}</AppText>
        <AppText variant="caption">{detail}</AppText>
      </View>
      <Switch disabled={disabled} onValueChange={onValueChange} value={value} />
    </View>
  );
}

export function NotificationPreferencesCard({ userId }: { userId: string | null | undefined }) {
  const {
    preferences,
    permissionStatus,
    loading,
    saving,
    message,
    updatePreferences,
    enableNotifications
  } = useNotificationPreferences(userId);

  if (!userId) {
    return null;
  }

  const permissionReady = permissionStatus === "granted";
  const disabled = loading || saving;

  function setPreference(key: PreferenceKey, value: boolean) {
    updatePreferences({
      ...preferences,
      [key]: value
    });
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <AppText variant="subtitle">Notifications</AppText>
        <AppText variant="caption">
          Choose which DanceFlow updates you want on this device.
        </AppText>
      </View>
      <View style={styles.content}>
        {!permissionReady ? (
          <View style={styles.permissionCard}>
            <AppText variant="subtitle">Enable push notifications</AppText>
            <AppText variant="caption">
              Get lesson changes, ticket reminders, saved studio updates, and account notices when they matter.
            </AppText>
            <AppButton
              label={saving ? "Setting up..." : "Enable notifications"}
              onPress={enableNotifications}
              variant="primary"
            />
          </View>
        ) : (
          <FeatureCard
            title="Notifications are ready"
            detail="DanceFlow can send updates to this device."
          />
        )}

        <PreferenceRow
          title="Push notifications"
          detail="Turn all mobile notifications on or off."
          value={preferences.pushEnabled}
          disabled={disabled}
          onValueChange={(value) => setPreference("pushEnabled", value)}
        />

        {ROWS.map((row) => (
          <PreferenceRow
            key={row.key}
            title={row.title}
            detail={row.detail}
            value={Boolean(preferences[row.key])}
            disabled={disabled || !preferences.pushEnabled}
            onValueChange={(value) => setPreference(row.key, value)}
          />
        ))}

        {message ? <AppText variant="caption">{message}</AppText> : null}
      </View>
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
    padding: 18
  },
  header: {
    gap: 6
  },
  content: {
    gap: 12
  },
  permissionCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 14
  },
  preferenceRow: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    padding: 14
  },
  preferenceText: {
    flex: 1,
    gap: 4
  }
});
