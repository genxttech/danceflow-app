/**
 * New Student Intake -- who may see and change a studio's intake configuration.
 *
 * Two independent gates, both fail closed:
 *  1. Role: only the studio owner and studio admin configure intake (spec 4.1). Platform admins and every other role
 *     are refused here exactly as the database refuses them (`intake_private.assert_staff`, capability 'configure').
 *  2. Availability: Student Intake is NOT a separately priced feature (owner decision 2026-11-23): there is no billing
 *     feature, plan requirement or paid entitlement for it. Availability is a rollout control only: the database pilot grants
 *     (`intake_feature_grants`, platform-admin managed, expiring) govern development access and staged rollout. Until the
 *     settings UI reads those grants, this page is gated by an explicit per-studio allowlist in the
 *     STUDENT_INTAKE_CONFIG_STUDIO_IDS environment variable (comma-separated studio ids). Empty or unset = nobody.
 *     Nothing grants a studio automatically, and nothing here can block an authorized studio on billing grounds.
 */

export const STUDENT_INTAKE_CONFIG_ENV = "STUDENT_INTAKE_CONFIG_STUDIO_IDS";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canConfigureStudentIntake(role: string | null | undefined): boolean {
  return role === "studio_owner" || role === "studio_admin";
}

export function parseAllowlist(raw: string | undefined | null): Set<string> {
  const ids = (raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => UUID_PATTERN.test(value));
  return new Set(ids);
}

export function isStudentIntakeConfigAvailable(
  studioId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!studioId || !UUID_PATTERN.test(studioId)) return false;
  return parseAllowlist(env[STUDENT_INTAKE_CONFIG_ENV]).has(studioId.toLowerCase());
}
