export * from "@/lib/synthetic/types";
export { loadSyntheticConfig, __resetSyntheticConfigCacheForTests } from "@/lib/synthetic/config";
export { signInSyntheticRole, signOutSynthetic } from "@/lib/synthetic/auth";
export type { SyntheticSession } from "@/lib/synthetic/auth";
export { generateSyntheticRunId, isValidSyntheticRunId, syntheticTag } from "@/lib/synthetic/runId";
export { getDeploymentInfo } from "@/lib/synthetic/deployment";
export {
  assertSyntheticStudio,
  assertRecordWasCreatedByThisRun,
  assertIsConfiguredFixture,
} from "@/lib/synthetic/guards";
export { runSyntheticSuite } from "@/lib/synthetic/runner";
export type { RunSyntheticSuiteOptions } from "@/lib/synthetic/runner";
