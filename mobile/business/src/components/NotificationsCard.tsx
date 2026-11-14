import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { usePushSetup } from "@/lib/push";
import { colors, radius, space } from "@/theme";

/** Hidden until a push adapter is provided, so a build without push credentials shows nothing misleading. */
export function NotificationsCard() {
  const { available, status, busy, enable } = usePushSetup();
  if (!available || !status) return null;

  return (
    <View style={styles.card} testID="notifications">
      <AppText variant="label" tone="muted" accessibilityRole="header">
        Notifications
      </AppText>
      {status.kind === "not_asked" ? (
        <>
          <AppText>Get a heads-up about your schedule. You can turn this off in system settings.</AppText>
          <AppButton label="Turn on notifications" onPress={() => void enable()} loading={busy} />
        </>
      ) : null}
      {status.kind === "denied" ? (
        <AppText testID="notifications-denied">Notifications are off. Turn them on for DanceFlow Business in your phone's settings.</AppText>
      ) : null}
      {status.kind === "unavailable" ? (
        <AppText tone="muted" testID="notifications-unavailable">
          Notifications are not available on this build yet. Everything else works as usual.
        </AppText>
      ) : null}
      {status.kind === "ready" ? (
        <AppText testID="notifications-ready">{status.registered ? "Notifications are on." : "Notifications are on. Setup will finish when you are back online."}</AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
});
