import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AppText } from "@/components/AppText";
import { colors } from "@/constants/theme";

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

  return (
    <Pressable
      {...props}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        !isPrimary && styles[variant],
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        typeof style === "function" ? style({ pressed, hovered: false }) : style
      ]}
    >
      {isPrimary ? (
        <LinearGradient colors={colors.brandGradient} style={StyleSheet.absoluteFill} />
      ) : null}
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={isPrimary ? colors.white : colors.primary} />
        ) : (
          <AppText style={[styles.label, !isPrimary && styles.altLabel]}>{label}</AppText>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: 14,
    minHeight: 52,
    justifyContent: "center",
    overflow: "hidden",
    paddingHorizontal: 18
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
    width: "100%"
  },
  secondary: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: 1
  },
  ghost: {
    backgroundColor: "transparent"
  },
  label: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "800"
  },
  altLabel: {
    color: colors.text
  },
  pressed: {
    opacity: 0.78
  },
  disabled: {
    opacity: 0.55
  }
});
