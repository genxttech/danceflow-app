import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
  type PressableProps,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useReducedMotion } from "react-native-reanimated";
import { AppText } from "@/components/AppText";
import { colorsForScheme } from "@/constants/theme";
import { EVENT_ART_ACCENT } from "@/lib/eventArt";
import { pressedTransform } from "@/lib/motion";

/** Ground, on the gold onArt button. */
const ON_ART_TEXT = "#180C1B";

type AppButtonProps = PressableProps & {
  label: string;
  /** onArt: gold with dark text, for buttons on event art or photos (same in both themes). */
  variant?: "primary" | "secondary" | "ghost" | "onArt";
  loading?: boolean;
};

export function AppButton({
  label,
  variant = "primary",
  loading,
  disabled,
  style,
  ...props
}: AppButtonProps) {
  const isPrimary = variant === "primary";
  const isOnArt = variant === "onArt";
  const colors = colorsForScheme(useColorScheme());
  const reducedMotion = useReducedMotion();

  return (
    <Pressable
      {...props}
      accessibilityLabel={props.accessibilityLabel ?? label}
      accessibilityRole={props.accessibilityRole ?? "button"}
      accessibilityState={{
        disabled: Boolean(disabled || loading),
        busy: Boolean(loading),
      }}
      disabled={disabled || loading}
      hitSlop={props.hitSlop ?? 4}
      style={(state) => [
        styles.button,
        isPrimary && {
          borderColor: "rgba(255,255,255,0.24)",
          shadowColor: colors.primaryDark,
        },
        variant === "secondary" && {
          backgroundColor: colors.surface,
          borderColor: colors.borderStrong,
          shadowColor: colors.black,
        },
        variant === "ghost" && styles.ghost,
        isOnArt && { backgroundColor: EVENT_ART_ACCENT, borderColor: EVENT_ART_ACCENT, shadowColor: colors.black },
        state.pressed && [styles.pressed, { transform: pressedTransform(reducedMotion) }],
        (disabled || loading) && styles.disabled,
        typeof style === "function" ? style(state) : style,
      ]}
    >
      {isPrimary ? (
        <LinearGradient colors={colors.brandGradient} style={StyleSheet.absoluteFill} />
      ) : null}

      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={isPrimary ? colors.onPrimary : isOnArt ? ON_ART_TEXT : colors.primary} />
        ) : (
          <AppText
            style={[
              styles.label,
              { color: isPrimary ? colors.onPrimary : isOnArt ? ON_ART_TEXT : colors.text },
            ]}
          >
            {label}
          </AppText>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    elevation: 2,
    justifyContent: "center",
    minHeight: 52,
    minWidth: 44,
    overflow: "hidden",
    paddingHorizontal: 18,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
    width: "100%",
  },
  ghost: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    elevation: 0,
    shadowOpacity: 0,
  },
  label: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.15,
  },
  pressed: {
    opacity: 0.88,
  },
  disabled: {
    opacity: 0.5,
  },
});
