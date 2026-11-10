import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { colors, radius, space } from "@/theme";

type Props = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "quiet";
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
};

/** Plum is reserved for actions: primary fills with it, secondary outlines with it. */
export function AppButton({ label, onPress, variant = "primary", disabled, loading, accessibilityHint }: Props) {
  const inactive = disabled || loading;
  const textColor = variant === "primary" ? colors.onPlum : colors.plum;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" && styles.primary,
        variant === "secondary" && styles.secondary,
        variant === "quiet" && styles.quiet,
        pressed && styles.pressed,
        inactive && styles.inactive,
      ]}
    >
      <View style={styles.inner}>
        {loading ? <ActivityIndicator color={textColor} /> : null}
        <AppText variant="lead" style={[styles.label, { color: textColor }]}>
          {label}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.control,
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  inner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm },
  label: { textAlign: "center", flexShrink: 1 },
  primary: { backgroundColor: colors.plum },
  secondary: { borderWidth: 1.5, borderColor: colors.plum, backgroundColor: colors.raised },
  quiet: { paddingHorizontal: space.sm },
  pressed: { opacity: 0.85 },
  inactive: { opacity: 0.5 },
});
