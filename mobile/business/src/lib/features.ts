/*
  Staff API v2 features whose endpoints are not served yet (client lookup, attendance). They stay off in every build
  until the endpoints land, then this default flips. EXPO_PUBLIC_STAFF_FEATURES (comma list) turns them on for local
  QA against a stack or mock that serves them, e.g. EXPO_PUBLIC_STAFF_FEATURES=clients,attendance.
*/

export type StaffFeature = "clients" | "attendance";

const ENABLED_BY_DEFAULT: readonly StaffFeature[] = [];

export function parseStaffFeatures(raw: string | undefined): Set<StaffFeature> {
  const enabled = new Set<StaffFeature>(ENABLED_BY_DEFAULT);
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim();
    if (value === "clients" || value === "attendance") enabled.add(value);
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
