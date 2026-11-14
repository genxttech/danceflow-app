import { StyleSheet, useColorScheme, View, type DimensionValue } from "react-native";
import Animated from "react-native-reanimated";
import { colorsForScheme } from "@/constants/theme";
import { usePulse } from "@/lib/motion";

type SkeletonProps = { width?: DimensionValue; height?: number; radius?: number };

/** One placeholder block. Decorative: the surrounding LoadingState carries the label. */
export function Skeleton({ width = "100%", height = 14, radius = 8 }: SkeletonProps) {
  const colors = colorsForScheme(useColorScheme());
  const pulse = usePulse();

  return (
    <Animated.View
      importantForAccessibility="no-hide-descendants"
      style={[{ backgroundColor: colors.surfaceAlt, borderRadius: radius, height, width }, pulse]}
    />
  );
}

type LoadingStateProps = {
  /** Read by screen readers, for example "Loading tickets". */
  label: string;
  /** How many placeholder cards to show; match roughly what will arrive. */
  rows?: number;
};

/** Skeleton cards shaped like the content that is loading, instead of a spinner or a "Loading..." card. */
export function LoadingState({ label, rows = 2 }: LoadingStateProps) {
  const colors = colorsForScheme(useColorScheme());

  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={styles.stack}
      testID="loading-state"
    >
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Skeleton height={10} width="28%" />
          <Skeleton height={18} width="72%" />
          <Skeleton height={12} width="90%" />
          <Skeleton height={12} width="55%" />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  card: { borderRadius: 20, borderWidth: 1, gap: 10, padding: 18 }
});
