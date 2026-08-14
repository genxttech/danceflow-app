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
  /** Slice 4 addition: the application origin the browser wrapper navigates to. */
  readonly baseUrl: string;
  /** Slice 4 addition: email of the Supabase Auth user linked to the configured client. */
  readonly portalLoginEmail: string;
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

/**
 * Slice 3 addition: the result of establishing the configured Payment
 * Harness client's floor-rental fixture data (fixture.ts). Deliberately
 * says nothing about Stripe, Checkout, or browser automation -- this is
 * purely "does the configured client already have a payable floor rental,
 * or did we just create exactly one," expressed in the same
 * canonical-payable-set terms `getPayableFloorRentalAppointments` returns.
 */
export type PaymentHarnessFixtureResult = {
  /** True when at least one payable rental already existed and nothing was created. */
  readonly reusedExisting: boolean;
  /** True when this call created exactly one new fixture appointment. */
  readonly created: boolean;
  /**
   * Every payable floor-rental appointment id for the configured client,
   * as re-read through the canonical `getPayableFloorRentalAppointments`
   * helper -- never hand-computed, so this can never drift from what the
   * portal page/checkout route would themselves see.
   */
  readonly payableAppointmentIds: readonly string[];
  /** Sum of the payable set's price_amount (dollars), converted to cents. */
  readonly expectedBalanceCents: number;
  /**
   * Records this call itself created, keyed by table name -- empty when
   * `reusedExisting` is true. Never includes a pre-existing record, even
   * one that's part of `payableAppointmentIds`.
   */
  readonly createdRecordRefs: Readonly<Record<string, readonly string[]>>;
};

/**
 * Slice 4 addition: what the browser wrapper captured about one Stripe
 * hosted Checkout navigation. `url` is the full navigated-to URL --
 * captured only in this structured value, per the Slice 4 design, and
 * never interpolated into a thrown error message, since its fragment
 * functions like a single-use capability token for that one pending
 * Checkout Session. `sessionId` is parsed from the URL path
 * (`parseStripeCheckoutSessionId` in browser.ts); `null` only if the URL
 * shape couldn't be parsed -- callers that require a session id fail
 * closed on that `null` themselves rather than this type forbidding it.
 */
export type PaymentHarnessCheckoutCapture = {
  readonly url: string;
  readonly sessionId: string | null;
};

/**
 * Slice 4 addition: the outcome of running the floor-rental browser
 * scenario's phases 1-3 (fixture/portal state, first Checkout submit,
 * reuse verification). Says nothing about payment completion -- this
 * slice never gets past a hosted Checkout page. Reuses the existing
 * `PaymentHarnessCheckpoint` shape (from the Slice 2 evidence types) for
 * per-phase results rather than introducing a parallel one.
 */
export type PaymentHarnessBrowserScenarioResult = {
  /** The balance the portal page displayed before checkout, in cents. */
  readonly displayedBalanceCents: number | null;
  readonly firstCheckout: PaymentHarnessCheckoutCapture | null;
  readonly secondCheckout: PaymentHarnessCheckoutCapture | null;
  /** True only when both captures parsed and their session ids matched. */
  readonly checkoutReused: boolean;
  readonly checkpoints: readonly PaymentHarnessCheckpoint[];
  /**
   * Slice 5 addition: `null` when payment completion was not requested
   * (the default -- see `runPaymentHarnessFloorRentalBrowserScenario`'s
   * `executionMode`) or not reached; populated only when phases 4-5
   * actually ran (`executionMode: "complete_payment"`).
   */
  readonly fulfillment: PaymentHarnessFulfillmentOutcome | null;
  /**
   * Slice 6 addition: populated once `runPrePaymentReadinessPhase` has run
   * (`executionMode: "pre_payment_readiness"` or `"complete_payment"`);
   * `null` for `"checkout_reuse_only"` (the default), where phase 4 never
   * runs at all.
   */
  readonly prePaymentReadiness: PaymentHarnessPrePaymentReadinessResult | null;
};

/**
 * Slice 6 addition: explicit, mutually exclusive execution modes for
 * `runPaymentHarnessFloorRentalBrowserScenario` -- replaces the prior
 * `completePayment: boolean` flag, which could only express two of the
 * three scopes this scenario now supports and left "ran pre-payment
 * readiness but did not complete payment" unrepresentable by any boolean
 * value. A positive, explicit allowlist (the same pattern
 * `PAYMENT_HARNESS_ALLOWED_ENVIRONMENTS` already uses), not a boolean
 * combination -- there is exactly one way to ask for each scope.
 *
 *   - `checkout_reuse_only` (default): phases 1-3 only -- fixture, first
 *     Checkout submit, reuse verification. Never touches Stripe payment
 *     completion or the Connect-listener readiness gate. Identical to the
 *     prior `completePayment: false` behavior.
 *   - `pre_payment_readiness`: phases 1-3, then
 *     `runPrePaymentReadinessPhase` (app-route readiness, Checkout Session
 *     test-mode verification, the real Connect-listener readiness gate) --
 *     then stops. Never calls `page.completeTestPayment()`, never enters
 *     card data. Safe to run on its own during manual QA against a real
 *     dev environment.
 *   - `complete_payment`: phases 1-5 -- pre-payment readiness, then real
 *     card entry via `page.completeTestPayment()`, then fulfillment
 *     verification. Identical to the prior `completePayment: true`
 *     behavior.
 */
export const PAYMENT_HARNESS_EXECUTION_MODES = [
  "checkout_reuse_only",
  "pre_payment_readiness",
  "complete_payment",
] as const;
export type PaymentHarnessExecutionMode = (typeof PAYMENT_HARNESS_EXECUTION_MODES)[number];

/**
 * Slice 6 addition: safe evidence proving the real, deterministic
 * Connect-listener readiness gate passed -- structurally incapable of
 * carrying a Stripe secret or card data, since every field here is a
 * Stripe id, a DB status string, a literal `false`, or a timestamp. Mirrors
 * `connectListenerReadiness.ts`'s own `ConnectListenerReadinessResult`
 * (kept as a separate, structurally-identical type here rather than
 * imported, so this leaf types module never depends on that one).
 */
export type PaymentHarnessConnectReadinessEvidence = {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly dbStatus: "processed";
  readonly stripeEventAccount: string;
  readonly livemode: false;
  readonly verifiedAt: string;
};

/**
 * Slice 6 addition: the result of `runPrePaymentReadinessPhase` --
 * app-route readiness, Checkout Session test-mode verification, and the
 * real Connect-listener readiness gate, all independently confirmed
 * *before* any card data is ever entered. Structurally cannot include
 * card details or a Stripe secret -- every field here is an id, a status
 * string, a boolean, a timestamp, or a `PaymentHarnessCheckpoint`.
 */
export type PaymentHarnessPrePaymentReadinessResult = {
  readonly paymentId: string;
  readonly connectedAccountId: string;
  readonly checkoutSessionId: string;
  readonly connectReadiness: PaymentHarnessConnectReadinessEvidence;
  readonly checkpoint: PaymentHarnessCheckpoint;
};

/**
 * Slice 5 addition: the three, deliberately distinguishable outcomes of
 * bounded post-payment DB polling -- never collapsed into a boolean, the
 * same "absence of proof is not proof of success" discipline the Slice 2
 * redelivery design already established for a related concern.
 *
 *   - `fulfilled`: the payment row transitioned to `paid` (with every
 *     expected field matching) within the bounded poll.
 *   - `not_fulfilled_within_timeout`: Stripe confirmed the payment (the
 *     harness reached the real success redirect), but the payment row was
 *     still `pending` when the bounded poll ran out -- a real, reportable
 *     problem (the exact "payment completed at Stripe but webhook not
 *     fulfilled" operational failure this slice exists to catch), not
 *     something to retry or paper over.
 *   - `verification_error`: the poll itself could not produce a reliable
 *     read (a DB error, or the row transitioned to something other than
 *     `paid`/`pending`) -- genuinely ambiguous, distinct from a confident
 *     "still pending" read.
 */
export const PAYMENT_HARNESS_FULFILLMENT_RESULTS = [
  "fulfilled",
  "not_fulfilled_within_timeout",
  "verification_error",
] as const;
export type PaymentHarnessFulfillmentResult = (typeof PAYMENT_HARNESS_FULFILLMENT_RESULTS)[number];

export type PaymentHarnessFulfillmentOutcome = {
  readonly result: PaymentHarnessFulfillmentResult;
  readonly paymentId: string;
  readonly paymentIntentId: string | null;
  readonly checkpoint: PaymentHarnessCheckpoint;
};
