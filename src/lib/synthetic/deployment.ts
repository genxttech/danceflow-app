import { SyntheticSafetyError } from "@/lib/synthetic/types";
import type { DeploymentInfo } from "@/lib/synthetic/types";

/**
 * Deployment identity capture (Ethan's requirement). Vercel sets these
 * automatically on every deployment; when running outside Vercel (local
 * dev, a manual CLI invocation against a non-Vercel target) we fall back
 * to explicit overrides so a run is never recorded with an unknown
 * deployment identity.
 */
export function getDeploymentInfo(): DeploymentInfo {
  const sha =
    process.env.SYNTHETIC_DEPLOYMENT_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    "unknown";

  const version =
    process.env.SYNTHETIC_DEPLOYMENT_VERSION?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    process.env.npm_package_version?.trim() ||
    null;

  const environment =
    process.env.SYNTHETIC_ENVIRONMENT?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    "unknown";

  return { sha, version, environment };
}

/**
 * True when the current process is a Vitest run. Both of these are set
 * automatically by Vitest itself (verified empirically, not assumed) --
 * checking both is redundant on purpose so a future config change that
 * drops one of them doesn't silently disable this detection.
 */
export function isTestExecutionContext(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

/**
 * Fail closed on unresolved deployment identity outside of automated
 * tests. Every real (non-test) synthetic run gets persisted to
 * synthetic_test_runs and is meant to be attributable to a specific
 * deployment -- a run recorded with sha/environment "unknown" is exactly
 * as useless to Daniel's release-verification process as no record at
 * all, so this refuses to proceed rather than silently recording it.
 *
 * Local/unit-test usage is intentionally exempt: tests exercise
 * getDeploymentInfo()'s fallback behavior directly and must not be forced
 * to set production-only env vars just to run.
 */
export function assertDeploymentInfoIsProductionSafe(info: DeploymentInfo): void {
  if (isTestExecutionContext()) return;

  const unresolved: string[] = [];
  if (info.sha === "unknown") unresolved.push("deployment SHA");
  if (info.environment === "unknown") unresolved.push("environment");

  if (unresolved.length === 0) return;

  throw new SyntheticSafetyError(
    `Fail-closed: ${unresolved.join(" and ")} could not be determined. Set ` +
      `SYNTHETIC_DEPLOYMENT_SHA and SYNTHETIC_ENVIRONMENT explicitly (or run ` +
      `where Vercel's own VERCEL_GIT_COMMIT_SHA/VERCEL_ENV are already set) ` +
      `before running the synthetic harness outside of automated tests.`,
    "DEPLOYMENT_METADATA_UNRESOLVED",
  );
}
