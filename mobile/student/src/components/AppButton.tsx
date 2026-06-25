import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  type PressableProps
} from "react-native";
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
  return (
    <Pressable
      {...props}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        typeof style === "function" ? style({ pressed, hovered: false }) : style
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? "#fff" : colors.primary} />
      ) : (
        <AppText style={[styles.label, variant !== "primary" && styles.altLabel]}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: 12,
    minHeight: 52,
    justifyContent: "center",
    paddingHorizontal: 18
  },
  primary: {
    backgroundColor: colors.primary
  },
  secondary: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1
  },
  ghost: {
    backgroundColor: "transparent"
  },
  label: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800"
  },
  altLabel: {
    color: colors.primary
  },
  pressed: {
    opacity: 0.78
  },
  disabled: {
    opacity: 0.55
  }
});
