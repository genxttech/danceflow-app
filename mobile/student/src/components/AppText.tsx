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
    fontSize: 30,
    fontWeight: "800",
    lineHeight: 36
  },
  subtitle: {
    fontSize: 20,
    fontWeight: "700",
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
    fontWeight: "800",
    letterSpacing: 3,
    textTransform: "uppercase"
  }
});
