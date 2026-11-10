import { StyleSheet, Text, useColorScheme, type TextProps } from "react-native";
import { colorsForScheme } from "@/constants/theme";

type AppTextProps = TextProps & {
  variant?: "display" | "title" | "subtitle" | "body" | "caption" | "eyebrow";
};

export function AppText({ variant = "body", style, ...props }: AppTextProps) {
  const colors = colorsForScheme(useColorScheme());
  const dynamicStyle =
    variant === "caption"
      ? { color: colors.muted }
      : variant === "eyebrow"
        ? { color: colors.primary }
        : { color: colors.text };

  return <Text {...props} maxFontSizeMultiplier={1.35} style={[styles.base, styles[variant], dynamicStyle, style]} />;
}

const styles = StyleSheet.create({
  base: {
    includeFontPadding: false,
  },
  // Names, dates and moments (design direction: display type). System font until the
  // approved display face's licence is confirmed.
  display: {
    fontSize: 36,
    fontWeight: "800",
    letterSpacing: -0.7,
    lineHeight: 40,
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
