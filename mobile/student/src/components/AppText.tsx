import { StyleSheet, Text, useColorScheme, type TextProps } from "react-native";
import { colorsForScheme } from "@/constants/theme";

type AppTextProps = TextProps & {
  variant?: "title" | "subtitle" | "body" | "caption" | "eyebrow";
};

export function AppText({ variant = "body", style, ...props }: AppTextProps) {
  const colors = colorsForScheme(useColorScheme());
  const dynamicStyle =
    variant === "caption"
      ? { color: colors.muted }
      : variant === "eyebrow"
        ? { color: colors.primary }
        : { color: colors.text };

  return <Text {...props} style={[styles.base, styles[variant], dynamicStyle, style]} />;
}

const styles = StyleSheet.create({
  base: {
    includeFontPadding: false,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 34,
  },
  subtitle: {
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: -0.15,
    lineHeight: 25,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
  },
  caption: {
    fontSize: 13,
    lineHeight: 19,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 2.1,
    lineHeight: 16,
    textTransform: "uppercase",
  },
});
