/*
  Staff API slice-2 features (client lookup, class attendance). ON by default since 2026-11-10: the owner's gate was an
  integration walk against the real endpoints (#453), which passed 27/27 (docs/mobile/screenshots/business-shell/s2-walk-evidence.json).

  The server must serve slice 2 before an app build with these on reaches it. EXPO_PUBLIC_STAFF_FEATURES (comma list)
  is a per-build override: "none" turns both off, "-clients" / "-attendance" turn one off, and naming one keeps it on.
*/

export type StaffFeature = "clients" | "attendance";

const ENABLED_BY_DEFAULT: readonly StaffFeature[] = ["clients", "attendance"];

const isFeature = (value: string): value is StaffFeature => value === "clients" || value === "attendance";

export function parseStaffFeatures(raw: string | undefined): Set<StaffFeature> {
  const enabled = new Set<StaffFeature>(ENABLED_BY_DEFAULT);
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim();
    if (value === "none") enabled.clear();
    else if (value.startsWith("-") && isFeature(value.slice(1))) enabled.delete(value.slice(1) as StaffFeature);
    else if (isFeature(value)) enabled.add(value);
  }
  return enabled;
}

const enabled = parseStaffFeatures(process.env.EXPO_PUBLIC_STAFF_FEATURES);

export function isStaffFeatureEnabled(feature: StaffFeature) {
  return enabled.has(feature);
}

/** One key per user action; a retry of the same action reuses it so the server applies it once. */
export function newIdempotencyKey() {
  const random = () => Math.random().toString(36).slice(2, 10);
  return `df-bus-${Date.now().toString(36)}-${random()}${random()}`;
}
