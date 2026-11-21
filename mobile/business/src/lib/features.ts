/*
  Staff API slice-2 features (client lookup, class attendance). ON by default since 2026-11-10: the owner's gate was an
  integration walk against the real endpoints (#453), which passed 27/27 (docs/mobile/screenshots/business-shell/s2-walk-evidence.json).

  The server must serve slice 2 before an app build with these on reaches it. EXPO_PUBLIC_STAFF_FEATURES (comma list)
  is a per-build override: "none" turns both off, "-clients" / "-attendance" turn one off, and naming one keeps it on.
*/

/**
 * "pulse" (the Pulse tab, GET /pulse) and "studioSchedule" (the studio-wide day, GET /schedule) are OFF by default: the routes are merged and QA'd, the screens
 * are not yet device-verified. Two more are OFF until they have been walked on a device: "bulkAttendance" (Mark all present on a class roster) and "keepStale" (keep the last
 * loaded schedule on screen, with a banner, when a refresh fails for a transient reason). Turn one on per build with EXPO_PUBLIC_STAFF_FEATURES=pulse (or studioSchedule, bulkAttendance, keepStale).
 */
export type StaffFeature =
  | "clients"
  | "attendance"
  | "pulse"
  | "studioSchedule"
  | "bulkAttendance"
  | "keepStale"
  | "appointmentAttendance"
  | "clientNotes"
  | "clientCreate"
  | "classRoster"
  | "ariaAssistant";

/**
 * "ariaAssistant" (the in-app ARIA assistant, A1 groundwork: local stub only, no network) is OFF by default and never a release word (Test-StaffFeatures refuses unknown words).
 */
/**
 * The Phase 1A WRITE features (Business expansion plan). All default OFF and only reachable through EXPO_PUBLIC_STAFF_FEATURES. They match the server's write capability keys
 * (src/lib/staff/writeGuard.ts), which are a second, independent switch: a build with the word on still gets `writes_disabled` until the server policy enables it.
 * Build-ReleaseAab.ps1 refuses these words unless iso-qa device-smoke evidence for that exact commit exists (docs/mobile/tools/Test-StaffFeatures.ps1).
 */
export const WRITE_FEATURES = ["appointmentAttendance", "clientNotes", "clientCreate", "classRoster"] as const satisfies readonly StaffFeature[];

const ENABLED_BY_DEFAULT: readonly StaffFeature[] = ["clients", "attendance"];

const isFeature = (value: string): value is StaffFeature =>
  value === "clients" ||
  value === "attendance" ||
  value === "pulse" ||
  value === "studioSchedule" ||
  value === "bulkAttendance" ||
  value === "keepStale" ||
  value === "appointmentAttendance" ||
  value === "clientNotes" ||
  value === "clientCreate" ||
  value === "classRoster" ||
  value === "ariaAssistant";

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
