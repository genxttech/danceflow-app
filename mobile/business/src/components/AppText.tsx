import { Platform, StyleSheet, Text, type TextProps } from "react-native";
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

/**
 * The type style for a variant on this platform. Android scales fontSize with the system text size but not a fixed
 * lineHeight, so at 200% glyphs were clipped to half a line (found on the emulator); scaling lineHeight in JS can also
 * drift from the native text scale after an activity recreation. So Android gets no fixed lineHeight at all: native
 * text layout then always fits the rendered font. iOS scales fontSize and lineHeight together, so it keeps the rhythm.
 */
export function platformTypeStyle(variant: TypeVariant, os: string = Platform.OS) {
  const base = typeScale[variant];
  if (os !== "android") return base;
  const { lineHeight: _ignored, ...rest } = base;
  return rest;
}

/** Text that scales with the system setting: font scaling stays on and nothing around it has a fixed height. */
export function AppText({ variant = "body", tone = "default", style, ...rest }: Props) {
  return <Text {...rest} style={[styles.base, platformTypeStyle(variant), { color: toneColor[tone] }, style]} />;
}

const styles = StyleSheet.create({ base: { color: colors.text } });
