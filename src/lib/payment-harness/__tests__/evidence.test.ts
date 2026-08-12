import { describe, expect, it, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import {
  markPaymentHarnessRunError,
  markPaymentHarnessRunFailed,
  markPaymentHarnessRunPassed,
  readPaymentHarnessRunById,
  startPaymentHarnessRun,
  updatePaymentHarnessRunEvidence,
} from "@/lib/payment-harness/evidence";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";
import type { PaymentHarnessConfig } from "@/lib/payment-harness/types";

/**
 * Regression coverage for the Payment Harness evidence layer. Uses the
 * same generic fake Supabase fixture already shared across the payments
 * test suite (src/lib/payments/__tests__/fakeSupabase.ts) -- no real
 * database connection, and no parallel reimplementation of Supabase query
 * semantics.
 */

const CONFIG: PaymentHarnessConfig = Object.freeze({
  studioId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  environment: "development",
});

const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_CLIENT_ID = "88888888-8888-4888-8888-888888888888";

let runsTable: FakeTable;

function fakeAdmin() {
  return createFakeAdminClient({ payment_harness_runs: runsTable }) as never;
}

beforeEach(() => {
  runsTable = new FakeTable();
});

function seedRun(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `seeded-${runsTable.rows.length + 1}`,
    run_id: "run-1",
    scenario: "floor-rental-open-balance",
    environment: "development",
    deployment_sha: "abc123",
    studio_id: CONFIG.studioId,
    client_id: CONFIG.clientId,
    expected_balance_cents: 4000,
    status: "running",
    redelivery_check_result: "not_run",
    checkpoints: [],
    created_record_refs: {},
    started_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  runsTable.rows.push(row);
  return row;
}

describe("startPaymentHarnessRun", () => {
  it("writes only the configured studio/client -- never anything else", async () => {
    const record = await startPaymentHarnessRun({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      scenario: "floor-rental-open-balance",
      deploymentSha: "abc123",
      expectedBalanceCents: 4000,
    });

    expect(record.studioId).toBe(CONFIG.studioId);
    expect(record.clientId).toBe(CONFIG.clientId);
    expect(record.status).toBe("running");
    expect(record.redeliveryCheckResult).toBe("not_run");
    expect(runsTable.rows).toHaveLength(1);
    expect(runsTable.rows[0].studio_id).toBe(CONFIG.studioId);
    expect(runsTable.rows[0].client_id).toBe(CONFIG.clientId);
  });

  it("fails closed when the configured environment is not on the allowlist", async () => {
    const tamperedConfig = { ...CONFIG, environment: "production" } as unknown as PaymentHarnessConfig;

    await expect(
      startPaymentHarnessRun({
        adminSupabase: fakeAdmin(),
        config: tamperedConfig,
        runId: "run-1",
        scenario: "floor-rental-open-balance",
        deploymentSha: "abc123",
        expectedBalanceCents: 4000,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    // The disallowed-environment run was never written at all.
    expect(runsTable.rows).toHaveLength(0);
  });
});

describe("identity re-validation before every write", () => {
  it("fails closed with STUDIO_MISMATCH before writing, when the run belongs to a different studio", async () => {
    seedRun({ studio_id: OTHER_STUDIO_ID });

    await expect(
      markPaymentHarnessRunPassed({ adminSupabase: fakeAdmin(), config: CONFIG, runId: "run-1" }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    try {
      await markPaymentHarnessRunPassed({ adminSupabase: fakeAdmin(), config: CONFIG, runId: "run-1" });
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STUDIO_MISMATCH");
    }

    // The row was never modified -- still "running", not "passed".
    expect(runsTable.rows[0].status).toBe("running");
  });

  it("fails closed with CLIENT_MISMATCH before writing, when the run belongs to a different client", async () => {
    seedRun({ client_id: OTHER_CLIENT_ID });

    try {
      await markPaymentHarnessRunPassed({ adminSupabase: fakeAdmin(), config: CONFIG, runId: "run-1" });
      throw new Error("expected markPaymentHarnessRunPassed to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CLIENT_MISMATCH");
    }

    expect(runsTable.rows[0].status).toBe("running");
  });

  it("fails closed when the configured environment is disallowed, before ever reading the row", async () => {
    seedRun();
    const tamperedConfig = { ...CONFIG, environment: "production" } as unknown as PaymentHarnessConfig;

    await expect(
      updatePaymentHarnessRunEvidence({
        adminSupabase: fakeAdmin(),
        config: tamperedConfig,
        runId: "run-1",
        patch: { stripeCheckoutSessionId: "cs_test_123" },
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);

    expect(runsTable.rows[0].stripe_checkout_session_id).toBeUndefined();
  });
});

describe("updatePaymentHarnessRunEvidence", () => {
  it("updates only the allowed evidence fields", async () => {
    seedRun();

    const record = await updatePaymentHarnessRunEvidence({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      patch: {
        stripeCheckoutSessionId: "cs_test_abc",
        firstSessionId: "cs_test_abc",
      },
    });

    expect(record.stripeCheckoutSessionId).toBe("cs_test_abc");
    expect(record.firstSessionId).toBe("cs_test_abc");
  });

  it("cannot silently change studio/client identity via a checkpoint/evidence update", async () => {
    seedRun();

    // Even bypassing the type system, an attacker-shaped patch cannot
    // influence studio_id/client_id -- the update payload is built
    // key-by-key from known fields only, never a spread of caller input.
    const sneakyPatch = {
      stripeCheckoutSessionId: "cs_test_abc",
      studioId: OTHER_STUDIO_ID,
      clientId: OTHER_CLIENT_ID,
    } as never;

    const record = await updatePaymentHarnessRunEvidence({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      patch: sneakyPatch,
    });

    expect(record.studioId).toBe(CONFIG.studioId);
    expect(record.clientId).toBe(CONFIG.clientId);
    expect(runsTable.rows[0].studio_id).toBe(CONFIG.studioId);
    expect(runsTable.rows[0].client_id).toBe(CONFIG.clientId);
  });

  it("appends a checkpoint without discarding earlier ones", async () => {
    seedRun({ checkpoints: [{ name: "fixture", status: "passed", at: "2026-01-01T00:00:00Z" }] });

    const record = await updatePaymentHarnessRunEvidence({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      checkpoint: { name: "first-submit", status: "passed", at: "2026-01-01T00:01:00Z" },
    });

    expect(record.checkpoints).toHaveLength(2);
    expect(record.checkpoints[0].name).toBe("fixture");
    expect(record.checkpoints[1].name).toBe("first-submit");
  });

  it("preserves not_available and not_verified as distinct from passed", async () => {
    seedRun();

    const notAvailable = await updatePaymentHarnessRunEvidence({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      patch: { redeliveryCheckResult: "not_available" },
    });
    expect(notAvailable.redeliveryCheckResult).toBe("not_available");
    expect(notAvailable.redeliveryCheckResult).not.toBe("passed");

    const notVerified = await updatePaymentHarnessRunEvidence({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      patch: { redeliveryCheckResult: "not_verified" },
    });
    expect(notVerified.redeliveryCheckResult).toBe("not_verified");
    expect(notVerified.redeliveryCheckResult).not.toBe("passed");

    const passed = await updatePaymentHarnessRunEvidence({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      patch: { redeliveryCheckResult: "passed" },
    });
    expect(passed.redeliveryCheckResult).toBe("passed");
  });
});

describe("status transitions", () => {
  it("marks a run passed, with a completed_at timestamp and no failure reason", async () => {
    seedRun();
    const record = await markPaymentHarnessRunPassed({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
    });
    expect(record.status).toBe("passed");
    expect(record.failureReason).toBeNull();
    expect(record.completedAt).not.toBeNull();
  });

  it("marks a run failed, recording the failure reason", async () => {
    seedRun();
    const record = await markPaymentHarnessRunFailed({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      failureReason: "amount mismatch",
    });
    expect(record.status).toBe("failed");
    expect(record.failureReason).toBe("amount mismatch");
  });

  it("marks a run errored, distinct from failed", async () => {
    seedRun();
    const record = await markPaymentHarnessRunError({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      failureReason: "unexpected exception",
    });
    expect(record.status).toBe("error");
    expect(record.status).not.toBe("failed");
    expect(record.failureReason).toBe("unexpected exception");
  });
});

describe("readPaymentHarnessRunById", () => {
  it("reads a started run back by run_id", async () => {
    await startPaymentHarnessRun({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
      scenario: "floor-rental-open-balance",
      deploymentSha: "abc123",
      expectedBalanceCents: 4000,
    });

    const record = await readPaymentHarnessRunById({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "run-1",
    });

    expect(record).not.toBeNull();
    expect(record?.runId).toBe("run-1");
    expect(record?.expectedBalanceCents).toBe(4000);
  });

  it("returns null for a run_id that does not exist", async () => {
    const record = await readPaymentHarnessRunById({
      adminSupabase: fakeAdmin(),
      config: CONFIG,
      runId: "does-not-exist",
    });
    expect(record).toBeNull();
  });

  it("fails closed rather than returning another tenant's row", async () => {
    seedRun({ studio_id: OTHER_STUDIO_ID });

    await expect(
      readPaymentHarnessRunById({ adminSupabase: fakeAdmin(), config: CONFIG, runId: "run-1" }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });
});

describe("error messages do not expose secrets or raw sensitive configuration", () => {
  it("a not-found error names only the run_id, nothing else", async () => {
    let message = "";
    try {
      await markPaymentHarnessRunPassed({
        adminSupabase: fakeAdmin(),
        config: CONFIG,
        runId: "no-such-run",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("no-such-run");
    expect(message).not.toContain(CONFIG.studioId);
    expect(message).not.toContain(CONFIG.clientId);
  });

  it("a mismatch error does not print either the expected or actual studio id", async () => {
    seedRun({ studio_id: OTHER_STUDIO_ID });
    let message = "";
    try {
      await markPaymentHarnessRunPassed({ adminSupabase: fakeAdmin(), config: CONFIG, runId: "run-1" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(CONFIG.studioId);
    expect(message).not.toContain(OTHER_STUDIO_ID);
  });
});
