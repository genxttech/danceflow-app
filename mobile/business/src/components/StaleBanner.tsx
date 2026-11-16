import { StyleSheet, View } from "react-native";
import { Announce } from "@/components/Announce";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { formatTime } from "@/lib/format";
import { colors, radius, space } from "@/theme";

/** Shown above data that is still on screen after a refresh failed: what happened, how old the data is, and a way to try again. */
export function StaleBanner({ loadedAt, timeZone, onRetry }: { loadedAt: number; timeZone: string | undefined; onRetry: () => void }) {
  const message = `Couldn't refresh. Showing what was loaded at ${formatTime(new Date(loadedAt).toISOString(), timeZone)}.`;
  return (
    <View style={styles.banner} accessibilityRole="alert" testID="stale-banner">
      <Announce message={message} />
      <AppText>{message}</AppText>
      <AppButton label="Try again" variant="secondary" onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.amberInk,
    backgroundColor: colors.raised,
  },
});
