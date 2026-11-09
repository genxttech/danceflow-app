jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import { darkColors, lightColors, type ThemeColors } from "@/constants/theme";

type Rgb = [number, number, number];

function parse(color: string, base?: Rgb): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (rgba && base) {
    const a = Number(rgba[4]);
    return [1, 2, 3].map((i, k) => Math.round(Number(rgba[i]) * a + base[k] * (1 - a))) as Rgb;
  }
  throw new Error(`Cannot parse ${color}`);
}

function luminance([r, g, b]: Rgb) {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrast(fg: Rgb, bg: Rgb) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const textTokens = ["text", "muted", "primary", "accent", "danger", "success"] as const;
const surfaceTokens = ["background", "backgroundSoft", "surface", "surfaceAlt"] as const;

describe.each([
  ["light", lightColors],
  ["dark", darkColors]
] as [string, ThemeColors][])("%s theme contrast (WCAG AA 4.5:1)", (_name, colors) => {
  const pairs: [string, string, Rgb, Rgb][] = [];
  for (const bgKey of surfaceTokens) {
    const bg = parse(colors[bgKey]);
    for (const fgKey of textTokens) pairs.push([fgKey, bgKey, parse(colors[fgKey]), bg]);
  }
  pairs.push(["onPrimary", "primary", parse(colors.onPrimary), parse(colors.primary)]);
  pairs.push(["onPrimary", "accent", parse(colors.onPrimary), parse(colors.accent)]);
  pairs.push(["white", "primaryDark", parse(colors.white), parse(colors.primaryDark)]);
  const surface = parse(colors.surface);
  pairs.push(["accent", "accentSoft on surface", parse(colors.accent), parse(colors.accentSoft, surface)]);
  pairs.push(["text", "surfaceGlow on surface", parse(colors.text), parse(colors.surfaceGlow, surface)]);

  it.each(pairs)("%s on %s", (_fg, _bg, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("retired colours", () => {
  it("are not in either palette", () => {
    const retired = ["#071427", "#0B1B2E", "#0E2035", "#132A44", "#F43F8E", "#FB923C", "#A64AC9", "#E66A3A", "#FF7A59", "#C53B91"];
    const values = JSON.stringify([lightColors, darkColors]).toUpperCase();
    for (const value of retired) expect(values).not.toContain(value);
  });
});
