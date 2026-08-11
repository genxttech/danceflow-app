import { describe, expect, it, vi, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";

let table: FakeTable;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeAdminClient({ synthetic_test_runs: table }),
}));

const { startSyntheticTestRun, recordCreatedRecordRefs, completeSyntheticTestRun } = await import(
  "@/lib/synthetic/audit"
);

beforeEach(() => {
  table = new FakeTable();
});

describe("synthetic_test_runs audit helpers", () => {
  it("starts a run with status 'running' and returns a handle", async () => {
    const handle = await startSyntheticTestRun({
      syntheticRunId: "syn_test",
      suite: "client",
      testId: "SYN-CLIENT-001",
      studioId: "studio-syn",
      deploymentSha: "abc123",
      deploymentVersion: "1.0.0",
      environment: "test",
      triggeredBy: "cli",
      triggeredByActor: "operator",
    });

    expect(handle.rowId).toBeTruthy();
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      synthetic_run_id: "syn_test",
      suite: "client",
      test_id: "SYN-CLIENT-001",
      synthetic_studio_id: "studio-syn",
      status: "running",
      triggered_by: "cli",
      triggered_by_actor: "operator",
    });
  });

  it("records created_record_refs onto the existing row without changing its status", async () => {
    const handle = await startSyntheticTestRun({
      syntheticRunId: "syn_test",
      suite: "entitlement",
      testId: "SYN-ENT-001",
      studioId: "studio-syn",
      deploymentSha: "abc123",
      deploymentVersion: null,
      environment: "test",
      triggeredBy: "cli",
    });

    await recordCreatedRecordRefs(handle.rowId, { clients: ["c1"], client_packages: ["p1"] });

    expect(table.rows[0].created_record_refs).toEqual({ clients: ["c1"], client_packages: ["p1"] });
    expect(table.rows[0].status).toBe("running");
  });

  it("completes a run with a passed result and no failure fields set", async () => {
    const handle = await startSyntheticTestRun({
      syntheticRunId: "syn_test",
      suite: "auth",
      testId: "SYN-AUTH-001",
      studioId: "studio-syn",
      deploymentSha: "abc123",
      deploymentVersion: null,
      environment: "test",
      triggeredBy: "manual",
    });

    await completeSyntheticTestRun(handle, {
      status: "passed",
      safeFailure: null,
      createdRecordRefs: {},
      cleanupStatus: "not_required",
      cleanupError: null,
    });

    expect(table.rows[0]).toMatchObject({
      status: "passed",
      safe_failure_code: null,
      safe_failure_summary: null,
      cleanup_status: "not_required",
    });
    expect(table.rows[0].completed_at).toBeTruthy();
  });

  it("completes a run with a failure, persisting the safe failure code/summary", async () => {
    const handle = await startSyntheticTestRun({
      syntheticRunId: "syn_test",
      suite: "schedule",
      testId: "SYN-SCHED-001",
      studioId: "studio-syn",
      deploymentSha: "abc123",
      deploymentVersion: null,
      environment: "test",
      triggeredBy: "cli",
    });

    await completeSyntheticTestRun(handle, {
      status: "failed",
      safeFailure: { code: "ASSERTION_FAILED", summary: "Appointment did not reach cancelled status." },
      createdRecordRefs: { appointments: ["a1"] },
      cleanupStatus: "completed",
      cleanupError: null,
    });

    expect(table.rows[0]).toMatchObject({
      status: "failed",
      safe_failure_code: "ASSERTION_FAILED",
      safe_failure_summary: "Appointment did not reach cancelled status.",
      cleanup_status: "completed",
    });
  });
});
