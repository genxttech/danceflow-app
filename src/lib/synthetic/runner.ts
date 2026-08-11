import { loadSyntheticConfig } from "@/lib/synthetic/config";
import { signInSyntheticRole, signOutSynthetic, type SyntheticSession } from "@/lib/synthetic/auth";
import { generateSyntheticRunId } from "@/lib/synthetic/runId";
import { assertDeploymentInfoIsProductionSafe, getDeploymentInfo } from "@/lib/synthetic/deployment";
import {
  completeSyntheticTestRun,
  recordCreatedRecordRefs,
  startSyntheticTestRun,
} from "@/lib/synthetic/audit";
import { SUITE_TEST_IDS, ALL_SUITES, SyntheticSafetyError } from "@/lib/synthetic/types";
import type {
  CreatedRecordRefs,
  DeploymentInfo,
  SafeFailure,
  SyntheticConfig,
  SyntheticRunResult,
  SyntheticSuite,
  SyntheticTestOutcome,
} from "@/lib/synthetic/types";
import { SuiteAssertionError } from "@/lib/synthetic/suites/contract";
import type { SuiteCleanupFn, SuiteContext, SuiteFn } from "@/lib/synthetic/suites/contract";

import { cleanupAuthSuite, runAuthSuite } from "@/lib/synthetic/suites/auth";
import { cleanupClientSuite, runClientSuite } from "@/lib/synthetic/suites/client";
import { cleanupScheduleSuite, runScheduleSuite } from "@/lib/synthetic/suites/schedule";
import { cleanupEntitlementSuite, runEntitlementSuite } from "@/lib/synthetic/suites/entitlement";
import { cleanupEventsSuite, runEventsSuite } from "@/lib/synthetic/suites/events";
import { cleanupPaymentsReadSuite, runPaymentsReadSuite } from "@/lib/synthetic/suites/paymentsRead";

/**
 * Top-level runner: signs in the identity a suite needs, runs it,
 * cleans it up, records every step to synthetic_test_runs, and produces
 * the machine-readable SyntheticRunResult (Daniel's required result
 * fields -- FlowOps quality/SYNTHETIC-TEST-CATALOG.md).
 *
 * One synthetic_run_id is generated per call and threaded through every
 * suite and every audit row created during that call.
 */

type SyntheticRole = "owner" | "organizer" | "student";

interface RegistryEntry {
  run: SuiteFn;
  cleanup: SuiteCleanupFn;
  role: SyntheticRole;
}

const SUITE_REGISTRY: Record<SyntheticSuite, RegistryEntry> = {
  auth: { run: runAuthSuite, cleanup: cleanupAuthSuite, role: "owner" },
  client: { run: runClientSuite, cleanup: cleanupClientSuite, role: "owner" },
  schedule: { run: runScheduleSuite, cleanup: cleanupScheduleSuite, role: "owner" },
  entitlement: { run: runEntitlementSuite, cleanup: cleanupEntitlementSuite, role: "owner" },
  events: { run: runEventsSuite, cleanup: cleanupEventsSuite, role: "owner" },
  "payments-read": { run: runPaymentsReadSuite, cleanup: cleanupPaymentsReadSuite, role: "student" },
};

export interface RunSyntheticSuiteOptions {
  /** Defaults to all six approved suites. */
  suites?: SyntheticSuite[];
  triggeredBy: "manual" | "cli" | "internal_route";
  triggeredByActor?: string | null;
}

function toSafeFailure(error: unknown): SafeFailure {
  if (error instanceof SyntheticSafetyError) {
    return { code: error.code, summary: error.message };
  }
  if (error instanceof Error) {
    return { code: "ASSERTION_FAILED", summary: error.message };
  }
  return { code: "UNKNOWN_ERROR", summary: "An unknown, non-Error value was thrown." };
}

async function runOneSuite(params: {
  suite: SyntheticSuite;
  config: SyntheticConfig;
  runId: string;
  deployment: DeploymentInfo;
  options: RunSyntheticSuiteOptions;
}): Promise<SyntheticTestOutcome> {
  const { suite, config, runId, deployment, options } = params;
  const testId = SUITE_TEST_IDS[suite];
  const entry = SUITE_REGISTRY[suite];
  const startedAt = new Date().toISOString();

  const auditHandle = await startSyntheticTestRun({
    syntheticRunId: runId,
    suite,
    testId,
    studioId: config.studioId,
    deploymentSha: deployment.sha,
    deploymentVersion: deployment.version,
    environment: deployment.environment,
    triggeredBy: options.triggeredBy,
    triggeredByActor: options.triggeredByActor,
  });

  let status: "passed" | "failed" | "error" = "passed";
  let safeFailure: SafeFailure | null = null;
  let createdRecordRefs: CreatedRecordRefs = {};
  let cleanupStatus: "not_required" | "completed" | "failed" | "partial" = "not_required";
  let cleanupError: string | null = null;
  let session: SyntheticSession | null = null;
  let ctx: SuiteContext | null = null;

  try {
    // Signing in (and the fail-closed tenant check inside it) happens
    // fresh for every suite -- suites never share a session, so one
    // suite's sign-out (SYN-AUTH-001) or failure can never affect another.
    session = await signInSyntheticRole(entry.role, config);
    ctx = { runId, config, sessions: { [entry.role]: session } };

    createdRecordRefs = await entry.run(ctx);
  } catch (error) {
    // A suite can fail *after* creating a record -- most visibly a
    // security probe whose failure mode is "the write it expected to be
    // rejected actually went through." SuiteAssertionError carries
    // whatever got created before the failure so it is never silently
    // dropped from the audit trail or left uncleaned just because the
    // suite's own assertion failed.
    if (error instanceof SuiteAssertionError) {
      createdRecordRefs = error.partialRecordRefs;
    }

    // Distinguish infrastructure/safety-guard failures (SyntheticSafetyError
    // -- likely a config/environment problem) from assertion failures (the
    // system under test behaved unexpectedly -- likely a real regression).
    // This distinction is what Daniel's failure classification
    // (RELEASE-VERIFICATION.md: "test defect, environment issue, known
    // accepted issue, or probable product regression") starts from.
    status = error instanceof SyntheticSafetyError ? "error" : "failed";
    safeFailure = toSafeFailure(error);
  }

  if (ctx) {
    await recordCreatedRecordRefs(auditHandle.rowId, createdRecordRefs);
  }

  // Always attempt cleanup once a session/context exists, whether the
  // suite passed, failed with no refs, or failed partway through after
  // creating something -- a suite that fails after creating a record must
  // not leave it untracked *and* unremoved. Every cleanup function decides
  // for itself whether there's anything to do (they all return
  // "not_required" on empty/irrelevant refs), so the runner doesn't
  // pre-optimize that decision away here.
  if (ctx) {
    try {
      const cleanupResult = await entry.cleanup(ctx, createdRecordRefs);
      cleanupStatus = cleanupResult.status;
      cleanupError = cleanupResult.error;

      if (cleanupResult.status === "failed" && status === "passed") {
        // A suite that passed its assertions but failed to clean up its
        // own fixtures is still a problem worth surfacing loudly, not a
        // silent pass -- record it as an error rather than a pass. If the
        // suite had already failed for its own reasons, that failure
        // takes priority and cleanup failure doesn't overwrite it.
        status = "error";
        safeFailure = { code: "CLEANUP_FAILED", summary: cleanupResult.error ?? "Cleanup failed." };
      }
    } catch (cleanupThrown) {
      cleanupStatus = "failed";
      cleanupError = cleanupThrown instanceof Error ? cleanupThrown.message : "Unknown cleanup error";
      if (status === "passed") {
        status = "error";
        safeFailure = { code: "CLEANUP_FAILED", summary: cleanupError };
      }
    }
  }

  if (session) {
    await signOutSynthetic(session).catch(() => undefined);
  }

  const completedAt = new Date().toISOString();

  await completeSyntheticTestRun(auditHandle, {
    status,
    safeFailure,
    createdRecordRefs,
    cleanupStatus,
    cleanupError,
  });

  return {
    testId,
    suite,
    status,
    startedAt,
    completedAt,
    safeFailure,
    createdRecordRefs,
    cleanupStatus,
    cleanupError,
  };
}

export async function runSyntheticSuite(
  options: RunSyntheticSuiteOptions,
): Promise<SyntheticRunResult> {
  // Fail closed: throws immediately if anything required is unconfigured.
  // Nothing below this line executes without a valid, complete config.
  const config = loadSyntheticConfig();

  const runId = generateSyntheticRunId();
  const deployment = getDeploymentInfo();
  // Fail closed: a real run must be attributable to a specific deployment.
  // Exempt only inside automated tests -- see assertDeploymentInfoIsProductionSafe.
  assertDeploymentInfoIsProductionSafe(deployment);
  const suitesToRun = options.suites?.length ? options.suites : ALL_SUITES;
  const startedAt = new Date().toISOString();

  const tests: SyntheticTestOutcome[] = [];
  for (const suite of suitesToRun) {
    tests.push(await runOneSuite({ suite, config, runId, deployment, options }));
  }

  const completedAt = new Date().toISOString();
  const overallStatus: SyntheticRunResult["overallStatus"] = tests.some((t) => t.status === "error")
    ? "error"
    : tests.some((t) => t.status === "failed")
      ? "failed"
      : "passed";

  return {
    syntheticRunId: runId,
    deployment,
    environment: deployment.environment,
    tenantId: config.studioId,
    startedAt,
    completedAt,
    overallStatus,
    tests,
  };
}
