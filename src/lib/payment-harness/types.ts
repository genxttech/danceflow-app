/**
 * Payment Harness (dev/QA Stripe test-mode) — shared types.
 *
 * Deliberately independent of src/lib/synthetic/types.ts. The Production
 * Synthetic Harness's non-capturing guarantee rests on being structurally
 * incapable of creating payments; the Payment Harness's whole purpose is
 * the opposite (real Stripe test-mode sessions in dev/QA only). Sharing a
 * types/config/guards module between the two would let a future change
 * made for this harness silently affect the other's safety posture. Only
 * *patterns* are reused (see guards.ts/deployment.ts doc comments), never
 * runtime imports across the two module trees.
 *
 * Slice 1 scope only: the environment/tenant-identity types this slice's
 * config and guards actually need. No browser, Stripe, evidence, or
 * fixture types here yet -- those are added in the slices that need them.
 */

/**
 * Environments the Payment Harness is allowed to run in at all. This is a
 * positive allowlist, not a "not production" negative check -- an
 * environment value that isn't literally one of these two is rejected by
 * default, including values nobody has thought of yet.
 */
export const PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS = ["development", "preview"] as const;

export type PaymentHarnessEnvironment = (typeof PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS)[number];

/**
 * The harness's fully-resolved, validated configuration. Every field here
 * has already passed its own fail-closed check by the time this type is
 * constructed -- there is no "config with some fields possibly missing"
 * intermediate state exposed to callers.
 */
export type PaymentHarnessConfig = {
  readonly studioId: string;
  readonly clientId: string;
  readonly environment: PaymentHarnessEnvironment;
};

/**
 * Slice 2 additions: evidence-run status, redelivery result, and the
 * checkpoint/run-record payload shapes `evidence.ts` reads and writes.
 * Still no browser/fixture/Checkout types here -- those belong to the
 * slices that actually add those capabilities.
 */

export const PAYMENT_HARNESS_RUN_STATUSES = ["running", "passed", "failed", "error"] as const;
export type PaymentHarnessRunStatus = (typeof PAYMENT_HARNESS_RUN_STATUSES)[number];

/**
 * Distinguishes "we triggered a redelivery and it was safe" from "there
 * was nothing to trigger yet" -- collapsing `not_available` into `passed`
 * would misreport an unproven property as a proven one, which is exactly
 * what the approved design's redelivery-trigger correction exists to
 * prevent. See src/lib/payment-harness's design notes: the trigger
 * mechanism itself is a later slice's problem; this type only has to make
 * sure "unavailable" and "passed" can never be confused once it exists.
 */
export const PAYMENT_HARNESS_REDELIVERY_RESULTS = [
  "not_run",
  "not_available",
  "not_verified",
  "passed",
  "failed",
] as const;
export type PaymentHarnessRedeliveryResult = (typeof PAYMENT_HARNESS_REDELIVERY_RESULTS)[number];

export type PaymentHarnessCheckpoint = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly at: string;
  readonly detail?: string;
};

/**
 * The fully-resolved shape of one `payment_harness_runs` row, as read back
 * from the database. Every field mirrors a column 1:1 (camelCase here,
 * snake_case in the table) -- see the
 * `..._payment_harness_runs.sql` migration for the authoritative column
 * list this type must stay in sync with.
 */
export type PaymentHarnessRunRecord = {
  readonly id: string;
  readonly runId: string;
  readonly scenario: string;
  readonly environment: PaymentHarnessEnvironment;
  readonly deploymentSha: string;
  readonly studioId: string;
  readonly clientId: string;
  readonly expectedBalanceCents: number;
  readonly paymentId: string | null;
  readonly stripeCheckoutSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly firstSessionId: string | null;
  readonly reusedSessionId: string | null;
  readonly stripeWebhookEventId: string | null;
  readonly stripeConnectedAccountId: string | null;
  readonly appointmentIdsBefore: Readonly<Record<string, string>> | null;
  readonly appointmentIdsAfter: Readonly<Record<string, string>> | null;
  readonly redeliveryTriggerMechanism: string | null;
  readonly redeliveryCheckResult: PaymentHarnessRedeliveryResult;
  readonly status: PaymentHarnessRunStatus;
  readonly failureReason: string | null;
  readonly checkpoints: readonly PaymentHarnessCheckpoint[];
  readonly createdRecordRefs: Readonly<Record<string, readonly string[]>>;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly triggeredByActor: string | null;
};

/**
 * Fields a later slice is allowed to update on an existing run, once
 * real Stripe/appointment/webhook facts become available to record.
 * Deliberately excludes `studioId`/`clientId`/`runId`/`environment`/
 * `status` -- identity and lifecycle-status fields are never part of this
 * patch shape, so a caller cannot even attempt to change them through this
 * path; identity is fixed at `startPaymentHarnessRun` time and status has
 * its own dedicated transition functions.
 */
export type PaymentHarnessRunEvidencePatch = {
  paymentId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  firstSessionId?: string | null;
  reusedSessionId?: string | null;
  stripeWebhookEventId?: string | null;
  stripeConnectedAccountId?: string | null;
  appointmentIdsBefore?: Record<string, string> | null;
  appointmentIdsAfter?: Record<string, string> | null;
  redeliveryTriggerMechanism?: string | null;
  redeliveryCheckResult?: PaymentHarnessRedeliveryResult;
};
