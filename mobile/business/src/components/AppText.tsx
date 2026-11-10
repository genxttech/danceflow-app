import { StyleSheet, Text, type TextProps } from "react-native";
import { colors, type TypeVariant, type as typeScale } from "@/theme";

type Tone = "default" | "muted" | "error" | "success" | "plum";

type Props = TextProps & { variant?: TypeVariant; tone?: Tone };

const toneColor: Record<Tone, string> = {
  default: colors.text,
  muted: colors.muted,
  error: colors.error,
  success: colors.success,
  plum: colors.plum,
};

/** Text that scales with the system setting: font scaling stays on and nothing around it has a fixed height. */
export function AppText({ variant = "body", tone = "default", style, ...rest }: Props) {
  return <Text {...rest} style={[styles.base, typeScale[variant], { color: toneColor[tone] }, style]} />;
}

const styles = StyleSheet.create({ base: { color: colors.text } });
