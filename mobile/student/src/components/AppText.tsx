import { StyleSheet, Text, useColorScheme, type TextProps } from "react-native";
import { colorsForScheme } from "@/constants/theme";

type AppTextProps = TextProps & {
  variant?: "title" | "subtitle" | "body" | "caption" | "eyebrow";
};

export function AppText({ variant = "body", style, ...props }: AppTextProps) {
  const colors = colorsForScheme(useColorScheme());
  const dynamicStyle =
    variant === "title" || variant === "subtitle"
      ? { color: colors.text }
      : variant === "caption"
        ? { color: colors.muted }
        : variant === "eyebrow"
          ? { color: colors.accent }
          : { color: colors.text };

  return <Text {...props} style={[styles.base, styles[variant], dynamicStyle, style]} />;
}

const styles = StyleSheet.create({
  base: {},
  title: {
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 36
  },
  subtitle: {
    fontSize: 20,
    fontWeight: "800",
    lineHeight: 26
  },
  body: {
    fontSize: 16,
    lineHeight: 24
  },
  caption: {
    fontSize: 13,
    lineHeight: 18
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 2.6,
    textTransform: "uppercase"
  }
});
