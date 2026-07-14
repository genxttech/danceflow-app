import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
  type PressableProps,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AppText } from "@/components/AppText";
import { colorsForScheme } from "@/constants/theme";

type AppButtonProps = PressableProps & {
  label: string;
  variant?: "primary" | "secondary" | "ghost";
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
  const colors = colorsForScheme(useColorScheme());

  return (
    <Pressable
      {...props}
      disabled={disabled || loading}
      style={({ pressed }) => [
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
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        typeof style === "function"
  ? style({ pressed, hovered: false })
  : style,
      ]}
    >
      {isPrimary ? (
        <LinearGradient colors={colors.brandGradient} style={StyleSheet.absoluteFill} />
      ) : null}

      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={isPrimary ? colors.white : colors.primary} />
        ) : (
          <AppText
            style={[
              styles.label,
              { color: isPrimary ? colors.white : colors.text },
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
    transform: [{ scale: 0.985 }],
  },
  disabled: {
    opacity: 0.5,
  },
});
