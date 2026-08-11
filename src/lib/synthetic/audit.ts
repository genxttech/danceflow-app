import { createAdminClient } from "@/lib/supabase/admin";
import type {
  CreatedRecordRefs,
  SafeFailure,
  SyntheticSuite,
  SyntheticTestId,
} from "@/lib/synthetic/types";

/**
 * synthetic_test_runs audit read/write helpers.
 *
 * This is the ONLY place in the harness that uses the service-role admin
 * client (see the note in src/lib/synthetic/auth.ts and
 * FlowOps quality/PRODUCTION-SYNTHETIC-TESTING.md safety requirement #4).
 * It writes exclusively to synthetic_test_runs -- never to any business
 * table -- and never reads or writes customer data. Every business-flow
 * operation in every suite goes through the synthetic user's own
 * RLS-scoped session (src/lib/synthetic/auth.ts) instead.
 */

export interface AuditRunHandle {
  rowId: string;
  syntheticRunId: string;
  suite: SyntheticSuite;
  testId: SyntheticTestId;
}

export async function startSyntheticTestRun(params: {
  syntheticRunId: string;
  suite: SyntheticSuite;
  testId: SyntheticTestId;
  studioId: string;
  deploymentSha: string;
  deploymentVersion: string | null;
  environment: string;
  triggeredBy: "manual" | "cli" | "internal_route";
  triggeredByActor?: string | null;
}): Promise<AuditRunHandle> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("synthetic_test_runs")
    .insert({
      synthetic_run_id: params.syntheticRunId,
      suite: params.suite,
      test_id: params.testId,
      synthetic_studio_id: params.studioId,
      deployment_sha: params.deploymentSha,
      deployment_version: params.deploymentVersion,
      environment: params.environment,
      status: "running",
      triggered_by: params.triggeredBy,
      triggered_by_actor: params.triggeredByActor ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `Failed to start synthetic_test_runs audit row: ${error?.message ?? "unknown error"}`,
    );
  }

  return {
    rowId: data.id as string,
    syntheticRunId: params.syntheticRunId,
    suite: params.suite,
    testId: params.testId,
  };
}

export async function recordCreatedRecordRefs(
  rowId: string,
  refs: CreatedRecordRefs,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("synthetic_test_runs")
    .update({ created_record_refs: refs })
    .eq("id", rowId);

  if (error) {
    throw new Error(
      `Failed to record created_record_refs for audit row ${rowId}: ${error.message}`,
    );
  }
}

export async function completeSyntheticTestRun(
  handle: AuditRunHandle,
  result: {
    status: "passed" | "failed" | "error";
    safeFailure: SafeFailure | null;
    createdRecordRefs: CreatedRecordRefs;
    cleanupStatus: "not_required" | "completed" | "failed" | "partial";
    cleanupError: string | null;
  },
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("synthetic_test_runs")
    .update({
      status: result.status,
      completed_at: new Date().toISOString(),
      safe_failure_code: result.safeFailure?.code ?? null,
      safe_failure_summary: result.safeFailure?.summary ?? null,
      created_record_refs: result.createdRecordRefs,
      cleanup_status: result.cleanupStatus,
      cleanup_error: result.cleanupError,
    })
    .eq("id", handle.rowId);

  if (error) {
    throw new Error(
      `Failed to complete synthetic_test_runs audit row ${handle.rowId}: ${error.message}`,
    );
  }
}
