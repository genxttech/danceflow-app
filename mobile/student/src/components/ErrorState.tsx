import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useColorScheme, View } from "react-native";
import Animated from "react-native-reanimated";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { colorsForScheme } from "@/constants/theme";
import { ERROR_COPY, classifyError, type ErrorKind } from "@/lib/errorKind";
import { useEnterUp } from "@/lib/motion";

const ICONS: Record<ErrorKind, keyof typeof Ionicons.glyphMap> = {
  offline: "cloud-offline-outline",
  signedOut: "log-in-outline",
  forbidden: "lock-closed-outline",
  notFound: "search-outline",
  unknown: "alert-circle-outline"
};

type ErrorStateProps = {
  /** What failed, in the screen's words, for example "Tickets unavailable". Used for unknown failures. */
  title: string;
  /** The caught error or its message. */
  error?: unknown;
  /** Shown when there is no message. */
  fallback?: string;
  onRetry?: () => void;
};

/** A failure the dancer can tell apart from the others: offline, signed out, no access, gone, or unknown. */
export function ErrorState({ title, error, fallback, onRetry }: ErrorStateProps) {
  const colors = colorsForScheme(useColorScheme());
  const entering = useEnterUp();
  const kind = classifyError(error);
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const copy = kind === "unknown" ? { title, detail: message || fallback || "Something went wrong. Try again." } : ERROR_COPY[kind];
  const detail = kind === "notFound" && fallback ? fallback : copy.detail;

  return (
    <Animated.View entering={entering}>
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderStrong }]}
        testID={`error-state-${kind}`}
      >
        <View style={[styles.icon, { backgroundColor: colors.surfaceAlt }]}>
          <Ionicons accessibilityElementsHidden color={kind === "unknown" ? colors.danger : colors.primary} importantForAccessibility="no" name={ICONS[kind]} size={22} />
        </View>
        <AppText variant="subtitle">{copy.title}</AppText>
        <AppText variant="caption">{detail}</AppText>
        {onRetry && kind !== "signedOut" && kind !== "forbidden" ? (
          <AppButton label="Try again" onPress={onRetry} variant="secondary" />
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, borderWidth: 1, gap: 8, padding: 18 },
  icon: { alignItems: "center", borderRadius: 999, height: 44, justifyContent: "center", marginBottom: 4, width: 44 }
});
