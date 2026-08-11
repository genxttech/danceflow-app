import { SyntheticSafetyError } from "@/lib/synthetic/types";
import type { CreatedRecordRefs, SyntheticConfig } from "@/lib/synthetic/types";

/**
 * Fail-closed production safety guards.
 *
 * FlowOps quality/PRODUCTION-SYNTHETIC-TESTING.md safety requirements:
 *   1. "Runner must fail closed if the target tenant is not the configured
 *      synthetic tenant."
 *   2. "Cleanup may only touch records created by the current synthetic run
 *      or explicitly tagged synthetic fixtures."
 *
 * Every suite and every cleanup step calls one of these before touching
 * any data. There is no "proceed anyway" path -- a guard failure always
 * throws SyntheticSafetyError, which the runner treats as an immediate
 * hard stop for that test (never downgraded to a soft warning).
 */

/**
 * Call immediately after authenticating a synthetic identity, and again
 * before any write, with whatever studio_id the operation is about to
 * touch. This is the single most important check in the whole harness:
 * every suite, every mutation, every cleanup step is gated on this.
 */
export function assertSyntheticStudio(
  config: SyntheticConfig,
  resolvedStudioId: string | null | undefined,
  context: string,
): void {
  if (!resolvedStudioId || resolvedStudioId !== config.studioId) {
    throw new SyntheticSafetyError(
      `Fail-closed (${context}): resolved studio_id does not match the configured synthetic tenant. Refusing to proceed.`,
      "TENANT_MISMATCH",
    );
  }
}

/**
 * Cleanup-time guard: a record id is only safe to touch if it appears in
 * this run's own created_record_refs for the given table. This makes
 * cleanup incapable of touching anything the run didn't itself create,
 * even if a bug elsewhere in the suite computed the wrong id.
 */
export function assertRecordWasCreatedByThisRun(
  createdRefs: CreatedRecordRefs,
  table: string,
  recordId: string,
): void {
  const ids = createdRefs[table] ?? [];
  if (!ids.includes(recordId)) {
    throw new SyntheticSafetyError(
      `Fail-closed (cleanup): record ${recordId} in table "${table}" is not present in this run's created_record_refs. Refusing to clean up a record this run did not create.`,
      "CLEANUP_SCOPE_VIOLATION",
    );
  }
}

/**
 * Guard for the one deliberate "explicitly tagged synthetic fixture"
 * exception the spec allows (safety requirement #2's second clause) --
 * currently only the pre-provisioned Events fixture, which is reused
 * across runs rather than created and torn down every time. Any id passed
 * here MUST come from loadSyntheticConfig(), never from user input or a
 * suite's own runtime state, so this can't be used to launder an
 * unrelated id into "looks like a fixture."
 */
export function assertIsConfiguredFixture(
  configuredFixtureId: string,
  candidateId: string,
  context: string,
): void {
  if (candidateId !== configuredFixtureId) {
    throw new SyntheticSafetyError(
      `Fail-closed (${context}): ${candidateId} is not the configured synthetic fixture. Refusing to proceed.`,
      "FIXTURE_MISMATCH",
    );
  }
}
