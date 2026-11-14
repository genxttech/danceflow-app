import { darkPalette, lightPalette, type Palette } from "@/theme";

function luminance(hex: string) {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background]: every text-on-surface pair the screens use
const TEXT_PAIRS: [keyof Palette, keyof Palette][] = [
  ["text", "surface"],
  ["text", "raised"],
  ["text", "tint"],
  ["muted", "surface"],
  ["muted", "raised"],
  ["plum", "surface"],
  ["plum", "raised"],
  ["plumDark", "surface"],
  ["error", "surface"],
  ["error", "raised"],
  ["success", "raised"],
  ["amberInk", "raised"],
  ["amberInk", "surface"],
  ["onPlum", "plum"],
];

describe.each([
  ["light", lightPalette],
  ["dark", darkPalette],
])("%s palette contrast (WCAG AA 4.5:1 for text)", (_name, palette) => {
  it.each(TEXT_PAIRS)("%s on %s", (fg, bg) => {
    expect(contrast(palette[fg], palette[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it("has the same keys in both palettes", () => {
    expect(Object.keys(darkPalette).sort()).toEqual(Object.keys(lightPalette).sort());
  });
});
