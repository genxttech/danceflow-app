import { describe, expect, it, vi, beforeEach } from "vitest";
import { SyntheticSafetyError } from "@/lib/synthetic/types";
import type { CreatedRecordRefs, SafeFailure, SyntheticConfig } from "@/lib/synthetic/types";
import { SuiteAssertionError, type SuiteCleanupResult } from "@/lib/synthetic/suites/contract";

/**
 * Orchestration tests for runner.ts -- the part of the harness where a bug
 * would be most dangerous (wrong audit records, cleanup skipped, a failure
 * silently downgraded to a pass, sign-out skipped). Every suite module and
 * every I/O boundary (auth, audit, deployment, config) is mocked so this
 * exercises ONLY the runner's own dispatch/bookkeeping logic -- it proves
 * nothing about whether any individual suite's business assertions are
 * correct against a real database (that requires a real synthetic tenant,
 * which does not exist yet; see the implementation report).
 */

const FAKE_CONFIG: SyntheticConfig = {
  studioId: "studio-syn",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon-key",
  identities: {
    owner: { email: "owner@synthetic.invalid", password: "x" },
    student: { email: "student@synthetic.invalid", password: "x", clientId: "client-syn" },
  },
  eventFixture: null,
};

interface AuditStartParams {
  syntheticRunId: string;
  suite: string;
  testId: string;
  studioId: string;
  deploymentSha: string;
  deploymentVersion: string | null;
  environment: string;
  triggeredBy: string;
  triggeredByActor?: string | null;
}

interface AuditCompleteParams {
  status: string;
  safeFailure: SafeFailure | null;
  createdRecordRefs: CreatedRecordRefs;
  cleanupStatus: string;
  cleanupError: string | null;
}

const auditRows: (AuditStartParams & { rowId: string })[] = [];
let nextAuditRowId = 0;

function defaultStartImpl(params: AuditStartParams) {
  nextAuditRowId += 1;
  const rowId = `row-${nextAuditRowId}`;
  auditRows.push({ rowId, ...params });
  return Promise.resolve({ rowId, syntheticRunId: params.syntheticRunId, suite: params.suite, testId: params.testId });
}

const startSyntheticTestRun = vi.fn(defaultStartImpl);
const recordCreatedRecordRefs = vi.fn<(rowId: string, refs: CreatedRecordRefs) => Promise<void>>(() =>
  Promise.resolve(undefined),
);
const completeSyntheticTestRun = vi.fn<
  (handle: { rowId: string }, result: AuditCompleteParams) => Promise<void>
>(() => Promise.resolve(undefined));

const signOutSynthetic = vi.fn<(session: unknown) => Promise<void>>(() => Promise.resolve(undefined));
function defaultSignInImpl(role: string) {
  return Promise.resolve({ role, client: {}, userId: `user-${role}`, studioId: FAKE_CONFIG.studioId });
}
const signInSyntheticRole = vi.fn(defaultSignInImpl);

vi.mock("@/lib/synthetic/config", () => ({
  loadSyntheticConfig: () => FAKE_CONFIG,
}));

vi.mock("@/lib/synthetic/audit", () => ({
  startSyntheticTestRun,
  recordCreatedRecordRefs,
  completeSyntheticTestRun,
}));

vi.mock("@/lib/synthetic/auth", () => ({
  signInSyntheticRole,
  signOutSynthetic,
}));

const getDeploymentInfo = vi.fn(() => ({ sha: "deadbeef", version: "1.2.3", environment: "test" }));
const assertDeploymentInfoIsProductionSafe = vi.fn<(info: unknown) => void>(() => undefined);

vi.mock("@/lib/synthetic/deployment", () => ({
  getDeploymentInfo: () => getDeploymentInfo(),
  assertDeploymentInfoIsProductionSafe: (info: unknown) => assertDeploymentInfoIsProductionSafe(info),
}));

function makeSuiteMock() {
  return {
    run: vi.fn<(ctx: unknown) => Promise<CreatedRecordRefs>>(() => Promise.resolve({})),
    cleanup: vi.fn<(ctx: unknown, refs: CreatedRecordRefs) => Promise<SuiteCleanupResult>>(() =>
      Promise.resolve({ status: "not_required", error: null }),
    ),
  };
}

const suiteMocks = {
  auth: makeSuiteMock(),
  client: makeSuiteMock(),
  schedule: makeSuiteMock(),
  entitlement: makeSuiteMock(),
  events: makeSuiteMock(),
  paymentsRead: makeSuiteMock(),
};

vi.mock("@/lib/synthetic/suites/auth", () => ({
  runAuthSuite: suiteMocks.auth.run,
  cleanupAuthSuite: suiteMocks.auth.cleanup,
}));
vi.mock("@/lib/synthetic/suites/client", () => ({
  runClientSuite: suiteMocks.client.run,
  cleanupClientSuite: suiteMocks.client.cleanup,
}));
vi.mock("@/lib/synthetic/suites/schedule", () => ({
  runScheduleSuite: suiteMocks.schedule.run,
  cleanupScheduleSuite: suiteMocks.schedule.cleanup,
}));
vi.mock("@/lib/synthetic/suites/entitlement", () => ({
  runEntitlementSuite: suiteMocks.entitlement.run,
  cleanupEntitlementSuite: suiteMocks.entitlement.cleanup,
}));
vi.mock("@/lib/synthetic/suites/events", () => ({
  runEventsSuite: suiteMocks.events.run,
  cleanupEventsSuite: suiteMocks.events.cleanup,
}));
vi.mock("@/lib/synthetic/suites/paymentsRead", () => ({
  runPaymentsReadSuite: suiteMocks.paymentsRead.run,
  cleanupPaymentsReadSuite: suiteMocks.paymentsRead.cleanup,
}));

// Imported after the mocks above are registered.
const { runSyntheticSuite } = await import("@/lib/synthetic/runner");

beforeEach(() => {
  auditRows.length = 0;
  nextAuditRowId = 0;
  vi.clearAllMocks();
  // Restore default resolved behavior after vi.clearAllMocks() wipes it.
  startSyntheticTestRun.mockImplementation(defaultStartImpl);
  recordCreatedRecordRefs.mockResolvedValue(undefined);
  completeSyntheticTestRun.mockResolvedValue(undefined);
  signInSyntheticRole.mockImplementation(defaultSignInImpl);
  signOutSynthetic.mockResolvedValue(undefined);
  getDeploymentInfo.mockReturnValue({ sha: "deadbeef", version: "1.2.3", environment: "test" });
  assertDeploymentInfoIsProductionSafe.mockImplementation(() => undefined);
  for (const mock of Object.values(suiteMocks)) {
    mock.run.mockResolvedValue({});
    mock.cleanup.mockResolvedValue({ status: "not_required", error: null });
  }
});

describe("runSyntheticSuite", () => {
  it("runs all six suites by default and reports overallStatus passed", async () => {
    const result = await runSyntheticSuite({ triggeredBy: "cli" });
    expect(result.tests).toHaveLength(6);
    expect(result.overallStatus).toBe("passed");
    expect(result.tenantId).toBe(FAKE_CONFIG.studioId);
    expect(result.deployment).toEqual({ sha: "deadbeef", version: "1.2.3", environment: "test" });
  });

  it("checks deployment metadata via assertDeploymentInfoIsProductionSafe before any suite runs", async () => {
    await runSyntheticSuite({ triggeredBy: "cli" });
    expect(assertDeploymentInfoIsProductionSafe).toHaveBeenCalledWith({
      sha: "deadbeef",
      version: "1.2.3",
      environment: "test",
    });
  });

  it("propagates a SyntheticSafetyError from assertDeploymentInfoIsProductionSafe and never signs in or starts a suite (production fail-closed wiring)", async () => {
    assertDeploymentInfoIsProductionSafe.mockImplementation(() => {
      throw new SyntheticSafetyError("deployment SHA and environment could not be determined", "DEPLOYMENT_METADATA_UNRESOLVED");
    });

    await expect(runSyntheticSuite({ triggeredBy: "cli" })).rejects.toThrow(SyntheticSafetyError);
    expect(signInSyntheticRole).not.toHaveBeenCalled();
    expect(startSyntheticTestRun).not.toHaveBeenCalled();
  });

  it("shares one synthetic_run_id across every suite's audit row", async () => {
    const result = await runSyntheticSuite({ triggeredBy: "cli" });
    const runIds = new Set(auditRows.map((r) => r.syntheticRunId));
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toBe(result.syntheticRunId);
  });

  it("runs only the requested subset of suites", async () => {
    const result = await runSyntheticSuite({ suites: ["auth", "client"], triggeredBy: "cli" });
    expect(result.tests.map((t) => t.suite).sort()).toEqual(["auth", "client"]);
    expect(suiteMocks.schedule.run).not.toHaveBeenCalled();
  });

  it("classifies a plain assertion failure as status 'failed', not 'error'", async () => {
    suiteMocks.client.run.mockRejectedValue(new Error("client tenant scoping check failed"));
    const result = await runSyntheticSuite({ suites: ["client"], triggeredBy: "cli" });
    expect(result.overallStatus).toBe("failed");
    expect(result.tests[0].status).toBe("failed");
    expect(result.tests[0].safeFailure?.code).toBe("ASSERTION_FAILED");
    expect(result.tests[0].safeFailure?.summary).toBe("client tenant scoping check failed");
  });

  it("classifies a SyntheticSafetyError as status 'error' and preserves its code", async () => {
    suiteMocks.entitlement.run.mockRejectedValue(new SyntheticSafetyError("tenant mismatch", "TENANT_MISMATCH"));
    const result = await runSyntheticSuite({ suites: ["entitlement"], triggeredBy: "cli" });
    expect(result.overallStatus).toBe("error");
    expect(result.tests[0].status).toBe("error");
    expect(result.tests[0].safeFailure?.code).toBe("TENANT_MISMATCH");
  });

  it("forces status 'error' when a suite passes but its cleanup fails", async () => {
    suiteMocks.schedule.cleanup.mockResolvedValue({ status: "failed", error: "could not cancel appointment" });
    const result = await runSyntheticSuite({ suites: ["schedule"], triggeredBy: "cli" });
    expect(result.tests[0].status).toBe("error");
    expect(result.tests[0].safeFailure?.code).toBe("CLEANUP_FAILED");
    expect(result.tests[0].cleanupStatus).toBe("failed");
  });

  it("signs out even when the suite throws", async () => {
    suiteMocks.events.run.mockRejectedValue(new Error("boom"));
    await runSyntheticSuite({ suites: ["events"], triggeredBy: "cli" });
    expect(signOutSynthetic).toHaveBeenCalledTimes(1);
  });

  it("does not abort remaining suites when an earlier suite fails", async () => {
    suiteMocks.auth.run.mockRejectedValue(new Error("auth suite failed"));
    const result = await runSyntheticSuite({ triggeredBy: "cli" });
    expect(result.tests).toHaveLength(6);
    expect(suiteMocks.client.run).toHaveBeenCalled();
    expect(suiteMocks.paymentsRead.run).toHaveBeenCalled();
  });

  it("signs in the student role specifically for payments-read", async () => {
    await runSyntheticSuite({ suites: ["payments-read"], triggeredBy: "cli" });
    expect(signInSyntheticRole).toHaveBeenCalledWith("student", FAKE_CONFIG);
  });

  it("signs in the owner role for the other five suites", async () => {
    await runSyntheticSuite({
      suites: ["auth", "client", "schedule", "entitlement", "events"],
      triggeredBy: "cli",
    });
    for (const call of signInSyntheticRole.mock.calls) {
      expect(call[0]).toBe("owner");
    }
  });

  it("records created_record_refs and completes the audit row for a passing suite", async () => {
    suiteMocks.client.run.mockResolvedValue({ clients: ["synthetic-client-1"] });
    await runSyntheticSuite({ suites: ["client"], triggeredBy: "cli" });

    expect(recordCreatedRecordRefs).toHaveBeenCalledWith("row-1", { clients: ["synthetic-client-1"] });
    expect(completeSyntheticTestRun).toHaveBeenCalledTimes(1);
    const completedWith = completeSyntheticTestRun.mock.calls[0][1];
    expect(completedWith.status).toBe("passed");
    expect(completedWith.createdRecordRefs).toEqual({ clients: ["synthetic-client-1"] });
  });

  it("tags every audit row with the triggeredBy source and actor", async () => {
    await runSyntheticSuite({ suites: ["auth"], triggeredBy: "cli", triggeredByActor: "test-operator" });
    expect(auditRows[0]).toMatchObject({ triggeredBy: "cli", triggeredByActor: "test-operator" });
  });

  it("still records refs and runs cleanup when a suite fails via SuiteAssertionError carrying partial refs (e.g. SYN-PAY-READ-001's unexpected-success case)", async () => {
    suiteMocks.paymentsRead.run.mockRejectedValue(
      new SuiteAssertionError("unauthorized write was not rejected", { payments: ["leaked-row-1"] }),
    );

    const result = await runSyntheticSuite({ suites: ["payments-read"], triggeredBy: "cli" });

    // The failure is never silently swallowed just because it happened to
    // create a record on its way down.
    expect(result.tests[0].status).toBe("failed");
    expect(result.tests[0].safeFailure?.summary).toMatch(/not rejected/);

    // But the record it created is still auditable...
    expect(result.tests[0].createdRecordRefs).toEqual({ payments: ["leaked-row-1"] });
    expect(recordCreatedRecordRefs).toHaveBeenCalledWith("row-1", { payments: ["leaked-row-1"] });

    // ...and still gets cleaned up, not abandoned.
    expect(suiteMocks.paymentsRead.cleanup).toHaveBeenCalledTimes(1);
    expect(suiteMocks.paymentsRead.cleanup.mock.calls[0][1]).toEqual({ payments: ["leaked-row-1"] });
  });

  it("still attempts cleanup (with empty refs) when a suite fails without having created anything", async () => {
    suiteMocks.client.run.mockRejectedValue(new Error("plain assertion failure, nothing created"));
    const result = await runSyntheticSuite({ suites: ["client"], triggeredBy: "cli" });

    expect(result.tests[0].status).toBe("failed");
    expect(result.tests[0].cleanupStatus).toBe("not_required");
    // The suite's own cleanup function is still given the chance to run
    // and correctly decides for itself there's nothing to do -- the
    // runner never pre-decides that based on refs being empty.
    expect(suiteMocks.client.cleanup).toHaveBeenCalledWith(expect.anything(), {});
    expect(recordCreatedRecordRefs).toHaveBeenCalledWith("row-1", {});
  });

  it("a cleanup failure does not overwrite a suite's own prior failure status", async () => {
    suiteMocks.paymentsRead.run.mockRejectedValue(
      new SuiteAssertionError("unauthorized write was not rejected", { payments: ["leaked-row-2"] }),
    );
    suiteMocks.paymentsRead.cleanup.mockResolvedValue({ status: "failed", error: "delete blocked" });

    const result = await runSyntheticSuite({ suites: ["payments-read"], triggeredBy: "cli" });

    // Still "failed" (the original assertion failure), not overwritten by
    // the CLEANUP_FAILED "error" classification that would apply if the
    // suite had otherwise passed.
    expect(result.tests[0].status).toBe("failed");
    expect(result.tests[0].safeFailure?.summary).toMatch(/not rejected/);
    expect(result.tests[0].cleanupStatus).toBe("failed");
  });
});
