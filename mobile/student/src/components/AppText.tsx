import { StyleSheet, Text, type TextProps } from "react-native";
import { colors } from "@/constants/theme";

type AppTextProps = TextProps & {
  variant?: "title" | "subtitle" | "body" | "caption" | "eyebrow";
};

export function AppText({ variant = "body", style, ...props }: AppTextProps) {
  return <Text {...props} style={[styles.base, styles[variant], style]} />;
}

const styles = StyleSheet.create({
  base: {
    color: colors.text
  },
  title: {
    color: colors.white,
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 36
  },
  subtitle: {
    color: colors.white,
    fontSize: 20,
    fontWeight: "800",
    lineHeight: 26
  },
  body: {
    fontSize: 16,
    lineHeight: 24
  },
  caption: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18
  },
  eyebrow: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 2.6,
    textTransform: "uppercase"
  }
});
