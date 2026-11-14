import { Appearance } from "react-native";

function loadTheme(scheme: "light" | "dark" | null) {
  jest.resetModules();
  jest.spyOn(Appearance, "getColorScheme").mockReturnValue(scheme);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/theme") as typeof import("@/theme");
}

describe("colors follow the system appearance at launch", () => {
  afterEach(() => jest.restoreAllMocks());

  it("uses the dark palette in dark mode", () => {
    const theme = loadTheme("dark");
    expect(theme.colors).toBe(theme.darkPalette);
    expect(theme.colors.surface).toBe("#1a1119");
  });

  it("uses the light palette in light mode and when the system gives none", () => {
    for (const scheme of ["light", null] as const) {
      const theme = loadTheme(scheme);
      expect(theme.colors).toBe(theme.lightPalette);
    }
  });
});
