import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance, type ColorSchemeName } from "react-native";

const APPEARANCE_STORAGE_KEY = "danceflow.appearanceMode";

export type AppearanceMode = "system" | "light" | "dark";

export const darkColors = {
  background: "#071427",
  backgroundSoft: "#0B1B2E",
  surface: "#0E2035",
  surfaceAlt: "#132A44",
  surfaceGlow: "rgba(244, 63, 142, 0.14)",
  text: "#F8FAFC",
  muted: "#A8B3C7",
  border: "rgba(255,255,255,0.14)",
  borderStrong: "rgba(255,255,255,0.24)",
  primary: "#F43F8E",
  primaryDark: "#BE185D",
  accent: "#FB923C",
  accentSoft: "rgba(251, 146, 60, 0.16)",
  magenta: "#F43F8E",
  orange: "#FB923C",
  danger: "#FB7185",
  success: "#34D399",
  white: "#FFFFFF",
  black: "#020617",
  brandGradient: ["#F43F8E", "#FB923C"] as const,
  brandGradientSoft: ["rgba(244, 63, 142, 0.22)", "rgba(251, 146, 60, 0.16)"] as const,
  appBackgroundGradient: ["#071427", "#0B1B2E", "#132A44"] as const
};

export const lightColors = {
  background: "#F8FAFC",
  backgroundSoft: "#EEF2FF",
  surface: "#FFFFFF",
  surfaceAlt: "#F1F5F9",
  surfaceGlow: "rgba(244, 63, 142, 0.09)",
  text: "#111827",
  muted: "#64748B",
  border: "rgba(15,23,42,0.12)",
  borderStrong: "rgba(15,23,42,0.2)",
  primary: "#DB2777",
  primaryDark: "#BE185D",
  accent: "#EA580C",
  accentSoft: "rgba(234, 88, 12, 0.12)",
  magenta: "#DB2777",
  orange: "#EA580C",
  danger: "#E11D48",
  success: "#059669",
  white: "#FFFFFF",
  black: "#020617",
  brandGradient: ["#DB2777", "#EA580C"] as const,
  brandGradientSoft: ["rgba(219, 39, 119, 0.12)", "rgba(234, 88, 12, 0.1)"] as const,
  appBackgroundGradient: ["#FFFFFF", "#F8FAFC", "#EEF2FF"] as const
};

export function colorsForScheme(scheme: ColorSchemeName) {
  return scheme === "light" ? lightColors : darkColors;
}

export async function getAppearanceMode(): Promise<AppearanceMode> {
  const value = await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export async function setAppearanceMode(mode: AppearanceMode) {
  await AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, mode);
  Appearance.setColorScheme(mode === "system" ? null : mode);
}

export async function hydrateAppearanceMode() {
  const mode = await getAppearanceMode();
  Appearance.setColorScheme(mode === "system" ? null : mode);
  return mode;
}

export const colors = {
  ...darkColors
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32
};
