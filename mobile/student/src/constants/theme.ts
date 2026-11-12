import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance, type ColorSchemeName } from "react-native";

const APPEARANCE_STORAGE_KEY = "danceflow.appearanceMode";

export type AppearanceMode = "system" | "light" | "dark";

/*
  Approved mobile palette (docs/mobile/Mobile_Design_Direction.md, owner-approved 2026-11-09).
  Dark: Ground #180C1B, Raised #241327, Gold #F0B15E, Orchid #D69AD9, text #FBF3EE, muted #C4B3C3.
  Light: brand plum #5b145e / #431046, tint #f6edf7, surface #fff9f3, border #ead9cb, text #2b1b2a,
  muted #6f5b6b, plus Amber ink #8A5210, Success #1F6B45, Error #A32A1E.
  Navy, hot pink, lavender and coral are retired. Contrast is checked by
  src/constants/__tests__/theme.contrast.test.ts.
*/

export type ThemeColors = {
  background: string;
  backgroundSoft: string;
  surface: string;
  surfaceAlt: string;
  surfaceGlow: string;
  text: string;
  muted: string;
  border: string;
  borderStrong: string;
  primary: string;
  primaryDark: string;
  /** Text and icons placed on a primary fill. */
  onPrimary: string;
  accent: string;
  accentSoft: string;
  danger: string;
  success: string;
  white: string;
  black: string;
  brandGradient: readonly [string, string];
  appBackgroundGradient: readonly [string, string, string];
};

export const darkColors: ThemeColors = {
  background: "#180C1B",
  backgroundSoft: "#241327",
  surface: "#241327",
  // Raised with 6% of the dark text colour: a third elevation for chips and wells.
  surfaceAlt: "#312033",
  surfaceGlow: "rgba(240, 177, 94, 0.12)",
  text: "#FBF3EE",
  muted: "#C4B3C3",
  border: "rgba(251, 243, 238, 0.14)",
  borderStrong: "rgba(251, 243, 238, 0.26)",
  primary: "#F0B15E",
  primaryDark: "#5B145E",
  onPrimary: "#180C1B",
  accent: "#D69AD9",
  accentSoft: "rgba(214, 154, 217, 0.16)",
  // Status colours on dark are not in the approved set yet; these keep 4.5:1 on Raised.
  danger: "#FB7185",
  success: "#34D399",
  white: "#FFFFFF",
  black: "#000000",
  brandGradient: ["#F0B15E", "#F0B15E"],
  appBackgroundGradient: ["#180C1B", "#180C1B", "#180C1B"]
};

export const lightColors: ThemeColors = {
  background: "#FFF9F3",
  backgroundSoft: "#F6EDF7",
  surface: "#FFFFFF",
  surfaceAlt: "#F6EDF7",
  surfaceGlow: "rgba(91, 20, 94, 0.06)",
  text: "#2B1B2A",
  muted: "#6F5B6B",
  border: "#EAD9CB",
  borderStrong: "rgba(43, 27, 42, 0.24)",
  primary: "#5B145E",
  primaryDark: "#431046",
  onPrimary: "#FFFFFF",
  accent: "#8A5210",
  accentSoft: "rgba(138, 82, 16, 0.10)",
  danger: "#A32A1E",
  success: "#1F6B45",
  white: "#FFFFFF",
  black: "#2B1B2A",
  brandGradient: ["#5B145E", "#431046"],
  appBackgroundGradient: ["#FFF9F3", "#FFF9F3", "#FFF9F3"]
};

export function colorsForScheme(scheme: ColorSchemeName): ThemeColors {
  return scheme === "light" ? lightColors : darkColors;
}

/** React Native Web's Appearance has no setColorScheme (web follows the browser), so it is skipped there. */
function applyColorScheme(mode: AppearanceMode) {
  if (typeof Appearance.setColorScheme !== "function") return;
  Appearance.setColorScheme(mode === "system" ? (null as unknown as ColorSchemeName) : mode);
}

export async function getAppearanceMode(): Promise<AppearanceMode> {
  const value = await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export async function setAppearanceMode(mode: AppearanceMode) {
  await AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, mode);
  applyColorScheme(mode);
}

export async function hydrateAppearanceMode() {
  const mode = await getAppearanceMode();
  applyColorScheme(mode);
  return mode;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32
};


export const radii = {
  sm: 12,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
};

export const touchTargets = {
  minimum: 44,
  comfortable: 52,
};

export const shadows = {
  card: {
    elevation: 2,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.07,
    shadowRadius: 16,
  },
};
