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
  background: "#FFF9FC",
  backgroundSoft: "#F7F3FF",
  surface: "#FFFFFF",
  surfaceAlt: "#F8F4FA",
  surfaceGlow: "rgba(219, 39, 119, 0.08)",
  text: "#2B1830",
  muted: "#6F6373",
  border: "rgba(77,31,71,0.11)",
  borderStrong: "rgba(77,31,71,0.2)",
  primary: "#A64AC9",
  primaryDark: "#7A2E90",
  accent: "#E66A3A",
  accentSoft: "rgba(230, 106, 58, 0.12)",
  magenta: "#C53B91",
  orange: "#E66A3A",
  danger: "#D92D59",
  success: "#168A63",
  white: "#FFFFFF",
  black: "#140B16",
  brandGradient: ["#A64AC9", "#FF7A59"] as const,
  brandGradientSoft: ["rgba(166, 74, 201, 0.14)", "rgba(255, 122, 89, 0.11)"] as const,
  appBackgroundGradient: ["#FFFDFE", "#FFF9FC", "#F7F3FF"] as const
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
  Appearance.setColorScheme(mode === "system" ? (null as unknown as ColorSchemeName) : mode);
}

export async function hydrateAppearanceMode() {
  const mode = await getAppearanceMode();
  Appearance.setColorScheme(mode === "system" ? (null as unknown as ColorSchemeName) : mode);
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
