/*
  DanceFlow Business tokens, from docs/mobile/Mobile_Design_Direction.md (approved 2026-11-09).
  Light paper surface, plum for actions only. These move to mobile/shared once the
  Student app's stabilization lands; until then they are local to this app.
*/

export const colors = {
  surface: "#fff9f3",
  raised: "#ffffff",
  plum: "#5b145e",
  plumDark: "#431046",
  tint: "#f6edf7",
  border: "#ead9cb",
  text: "#2b1b2a",
  muted: "#6f5b6b",
  amberInk: "#8A5210",
  success: "#1F6B45",
  error: "#A32A1E",
  onPlum: "#ffffff",
  skeleton: "#f1e6dc",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const gutter = 20;

export const radius = { control: 8, row: 12, card: 20, full: 999 } as const;

// System font until the Bricolage Grotesque / Hanken Grotesk licences are confirmed.
export const type = {
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600" as const },
  body: { fontSize: 15, lineHeight: 21 },
  lead: { fontSize: 17, lineHeight: 23, fontWeight: "600" as const },
  title: { fontSize: 20, lineHeight: 26, fontWeight: "700" as const },
  heading: { fontSize: 28, lineHeight: 34, fontWeight: "700" as const },
} as const;

export type TypeVariant = keyof typeof type;

// Aligned numerals for times, per the Business type emphasis.
export const tabularNums = { fontVariant: ["tabular-nums" as const] };
