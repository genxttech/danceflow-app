import type { createAdminClient } from "@/lib/supabase/admin";
import {
  PaymentHarnessSafetyError,
  assertPaymentHarnessClient,
  assertPaymentHarnessEnvironmentAllowed,
  assertPaymentHarnessStudio,
} from "@/lib/payment-harness/guards";
import type {
  PaymentHarnessCheckpoint,
  PaymentHarnessConfig,
  PaymentHarnessRunEvidencePatch,
  PaymentHarnessRunRecord,
  PaymentHarnessRunStatus,
} from "@/lib/payment-harness/types";

/**
 * `payment_harness_runs` read/write layer.
 *
 * Dependency-injected on purpose: every function here takes the Supabase
 * client as a parameter rather than constructing one internally, so this
 * whole module can be unit tested against the same
 * src/lib/payments/__tests__/fakeSupabase.ts fixture already used
 * throughout the payments test suite, with no real database connection.
 * The type only requires the subset of the Supabase client surface these
 * functions actually call.
 *
 * Every write (and every read, for the same reason) re-validates the
 * target row's studio_id/client_id against the configured
 * PaymentHarnessConfig via the Slice 1 guards, and re-checks the
 * environment allowlist -- not merely relies on a WHERE-clause filter.
 * This is deliberate: it means a genuine identity mismatch produces the
 * same specific, distinguishable STUDIO_MISMATCH/CLIENT_MISMATCH error
 * every other write path in the harness produces, not a generic
 * "not found." No function here accepts an operator-supplied studio/client
 * id for scoping -- identity always comes from `config`.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

const TABLE = "payment_harness_runs";

function assertEnvironmentAllowedForWrite(config: PaymentHarnessConfig, context: string): void {
  assertPaymentHarnessEnvironmentAllowed(config.environment, context);
}

function mapRow(row: Record<string, unknown>): PaymentHarnessRunRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    scenario: row.scenario as string,
    environment: row.environment as PaymentHarnessConfig["environment"],
    deploymentSha: row.deployment_sha as string,
    studioId: row.studio_id as string,
    clientId: row.client_id as string,
    expectedBalanceCents: row.expected_balance_cents as number,
    paymentId: (row.payment_id as string | null) ?? null,
    stripeCheckoutSessionId: (row.stripe_checkout_session_id as string | null) ?? null,
    stripePaymentIntentId: (row.stripe_payment_intent_id as string | null) ?? null,
    firstSessionId: (row.first_session_id as string | null) ?? null,
    reusedSessionId: (row.reused_session_id as string | null) ?? null,
    stripeWebhookEventId: (row.stripe_webhook_event_id as string | null) ?? null,
    stripeConnectedAccountId: (row.stripe_connected_account_id as string | null) ?? null,
    appointmentIdsBefore: (row.appointment_ids_before as Record<string, string> | null) ?? null,
    appointmentIdsAfter: (row.appointment_ids_after as Record<string, string> | null) ?? null,
    redeliveryTriggerMechanism: (row.redelivery_trigger_mechanism as string | null) ?? null,
    redeliveryCheckResult:
      row.redelivery_check_result as PaymentHarnessRunRecord["redeliveryCheckResult"],
    status: row.status as PaymentHarnessRunStatus,
    failureReason: (row.failure_reason as string | null) ?? null,
    checkpoints: (row.checkpoints as PaymentHarnessCheckpoint[] | null) ?? [],
    createdRecordRefs: (row.created_record_refs as Record<string, string[]> | null) ?? {},
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    triggeredByActor: (row.triggered_by_actor as string | null) ?? null,
  };
}

/**
 * Fetches the raw row for `runId` and validates it against `config` before
 * returning it -- the single choke point every write (and the public read)
 * goes through, so the identity re-check can never accidentally be skipped
 * by a new function forgetting to call it.
 */
async function loadRunRowForIdentity(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
  context: string;
}): Promise<Record<string, unknown>> {
  const { adminSupabase, config, runId, context } = params;

  const { data, error } = await adminSupabase
    .from(TABLE)
    .select("*")
    .eq("run_id", runId)
    .maybeSingle();

  if (error) {
    throw new PaymentHarnessSafetyError(
      `Failed to look up payment_harness_runs row for run_id=${runId}: ${error.message}`,
      "EVIDENCE_LOOKUP_FAILED",
    );
  }

  if (!data) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): no payment_harness_runs row found for run_id=${runId}. ` +
        `Refusing to proceed.`,
      "EVIDENCE_RUN_NOT_FOUND",
    );
  }

  const row = data as Record<string, unknown>;

  // Explicit identity re-check against the real Slice 1 guards -- not a
  // WHERE-clause filter standing in for it. A mismatch here throws the
  // same STUDIO_MISMATCH/CLIENT_MISMATCH the rest of the harness uses.
  assertPaymentHarnessStudio(config, row.studio_id as string, context);
  assertPaymentHarnessClient(config, row.client_id as string, context);

  return row;
}

/**
 * Starts (inserts) a new run evidence row. Studio/client always come from
 * `config` -- there is no parameter here that could let a caller write a
 * different tenant's id into this row.
 */
export async function startPaymentHarnessRun(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
  scenario: string;
  deploymentSha: string;
  expectedBalanceCents: number;
  triggeredByActor?: string | null;
}): Promise<PaymentHarnessRunRecord> {
  const { adminSupabase, config, runId, scenario, deploymentSha, expectedBalanceCents, triggeredByActor } =
    params;

  assertEnvironmentAllowedForWrite(config, "start run");

  const { data, error } = await adminSupabase
    .from(TABLE)
    .insert({
      run_id: runId,
      scenario,
      environment: config.environment,
      deployment_sha: deploymentSha,
      studio_id: config.studioId,
      client_id: config.clientId,
      expected_balance_cents: expectedBalanceCents,
      status: "running",
      redelivery_check_result: "not_run",
      checkpoints: [],
      created_record_refs: {},
      triggered_by_actor: triggeredByActor ?? null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new PaymentHarnessSafetyError(
      `Failed to start payment_harness_runs evidence row for run_id=${runId}: ` +
        `${error?.message ?? "unknown error"}`,
      "EVIDENCE_START_FAILED",
    );
  }

  return mapRow(data as Record<string, unknown>);
}

/**
 * Updates only the explicitly-allowed evidence fields on an existing run
 * (PaymentHarnessRunEvidencePatch -- see types.ts for why studio/client/
 * run/environment/status can never appear in this shape), optionally
 * appending one checkpoint to the run's checkpoint history in the same
 * call. The update payload is built key-by-key from known fields only --
 * never a raw spread of caller input -- so even a patch object with an
 * unexpected extra property (e.g. via an `as never`/`any` cast bypassing
 * the type) cannot influence what gets written.
 */
export async function updatePaymentHarnessRunEvidence(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
  patch?: PaymentHarnessRunEvidencePatch;
  checkpoint?: PaymentHarnessCheckpoint;
}): Promise<PaymentHarnessRunRecord> {
  const { adminSupabase, config, runId, patch = {}, checkpoint } = params;

  assertEnvironmentAllowedForWrite(config, "update run evidence");
  const row = await loadRunRowForIdentity({
    adminSupabase,
    config,
    runId,
    context: "update run evidence",
  });

  const updatePayload: Record<string, unknown> = {};
  if ("paymentId" in patch) updatePayload.payment_id = patch.paymentId;
  if ("stripeCheckoutSessionId" in patch) {
    updatePayload.stripe_checkout_session_id = patch.stripeCheckoutSessionId;
  }
  if ("stripePaymentIntentId" in patch) {
    updatePayload.stripe_payment_intent_id = patch.stripePaymentIntentId;
  }
  if ("firstSessionId" in patch) updatePayload.first_session_id = patch.firstSessionId;
  if ("reusedSessionId" in patch) updatePayload.reused_session_id = patch.reusedSessionId;
  if ("stripeWebhookEventId" in patch) {
    updatePayload.stripe_webhook_event_id = patch.stripeWebhookEventId;
  }
  if ("stripeConnectedAccountId" in patch) {
    updatePayload.stripe_connected_account_id = patch.stripeConnectedAccountId;
  }
  if ("appointmentIdsBefore" in patch) {
    updatePayload.appointment_ids_before = patch.appointmentIdsBefore;
  }
  if ("appointmentIdsAfter" in patch) {
    updatePayload.appointment_ids_after = patch.appointmentIdsAfter;
  }
  if ("redeliveryTriggerMechanism" in patch) {
    updatePayload.redelivery_trigger_mechanism = patch.redeliveryTriggerMechanism;
  }
  if ("redeliveryCheckResult" in patch) {
    updatePayload.redelivery_check_result = patch.redeliveryCheckResult;
  }

  if (checkpoint) {
    const existingCheckpoints = (row.checkpoints as PaymentHarnessCheckpoint[] | null) ?? [];
    updatePayload.checkpoints = [...existingCheckpoints, checkpoint];
  }

  const { data, error } = await adminSupabase
    .from(TABLE)
    .update(updatePayload)
    .eq("id", row.id)
    .select("*")
    .maybeSingle();

  if (error || !data) {
    throw new PaymentHarnessSafetyError(
      `Failed to update payment_harness_runs evidence for run_id=${runId}: ` +
        `${error?.message ?? "unknown error"}`,
      "EVIDENCE_UPDATE_FAILED",
    );
  }

  return mapRow(data as Record<string, unknown>);
}

async function setPaymentHarnessRunStatus(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
  status: Extract<PaymentHarnessRunStatus, "passed" | "failed" | "error">;
  failureReason?: string | null;
}): Promise<PaymentHarnessRunRecord> {
  const { adminSupabase, config, runId, status, failureReason } = params;

  assertEnvironmentAllowedForWrite(config, `mark run ${status}`);
  const row = await loadRunRowForIdentity({
    adminSupabase,
    config,
    runId,
    context: `mark run ${status}`,
  });

  const { data, error } = await adminSupabase
    .from(TABLE)
    .update({
      status,
      failure_reason: failureReason ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select("*")
    .maybeSingle();

  if (error || !data) {
    throw new PaymentHarnessSafetyError(
      `Failed to mark payment_harness_runs run_id=${runId} as ${status}: ` +
        `${error?.message ?? "unknown error"}`,
      "EVIDENCE_STATUS_UPDATE_FAILED",
    );
  }

  return mapRow(data as Record<string, unknown>);
}

export function markPaymentHarnessRunPassed(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
}): Promise<PaymentHarnessRunRecord> {
  return setPaymentHarnessRunStatus({ ...params, status: "passed", failureReason: null });
}

export function markPaymentHarnessRunFailed(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
  failureReason: string;
}): Promise<PaymentHarnessRunRecord> {
  return setPaymentHarnessRunStatus({ ...params, status: "failed" });
}

export function markPaymentHarnessRunError(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
  failureReason: string;
}): Promise<PaymentHarnessRunRecord> {
  return setPaymentHarnessRunStatus({ ...params, status: "error" });
}

/**
 * Reads a run by its run_id. Returns null if no row exists at all;
 * throws (rather than returning null) if a row exists but belongs to a
 * different studio/client than `config` -- a read that would return
 * another tenant's row is exactly as much a fail-closed condition as a
 * write would be, not something to quietly return null for.
 */
export async function readPaymentHarnessRunById(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  runId: string;
}): Promise<PaymentHarnessRunRecord | null> {
  const { adminSupabase, config, runId } = params;

  const { data, error } = await adminSupabase
    .from(TABLE)
    .select("*")
    .eq("run_id", runId)
    .maybeSingle();

  if (error) {
    throw new PaymentHarnessSafetyError(
      `Failed to read payment_harness_runs row for run_id=${runId}: ${error.message}`,
      "EVIDENCE_LOOKUP_FAILED",
    );
  }

  if (!data) return null;

  const row = data as Record<string, unknown>;
  assertPaymentHarnessStudio(config, row.studio_id as string, "read run");
  assertPaymentHarnessClient(config, row.client_id as string, "read run");

  return mapRow(row);
}
