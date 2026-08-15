import type { createAdminClient } from "@/lib/supabase/admin";
import { PaymentHarnessSafetyError, assertPaymentHarnessEnvironmentAllowed } from "@/lib/payment-harness/guards";
import type {
  PaymentHarnessCheckpoint,
  PaymentHarnessConfig,
  PaymentHarnessRedeliveryAppointmentSnapshotEntry,
  PaymentHarnessRedeliveryBaselineSnapshot,
  PaymentHarnessRedeliveryMismatch,
  PaymentHarnessRedeliveryPaymentSnapshotEntry,
  PaymentHarnessRedeliveryResult,
  PaymentHarnessRedeliverySnapshot,
  PaymentHarnessRedeliveryStateComparison,
  PaymentHarnessRedeliveryTriggerStatus,
  PaymentHarnessRedeliveryVerificationOutcome,
} from "@/lib/payment-harness/types";

/**
 * Payment Harness Slice 6 -- mechanism-agnostic redelivery-idempotency
 * verification for the completed floor-rental payment.
 *
 * This module proves one specific property: "a second delivery of the
 * same logical webhook event did not produce an additional
 * financial/application state transition." It does this by capturing an
 * authoritative before/after snapshot and comparing them exactly --
 * nothing here triggers, simulates, replays, or resends a webhook, and
 * nothing here knows or cares *how* a second delivery might occur. That
 * trigger problem (there is currently no known, safe way to force Stripe
 * to redeliver a specific already-processed event into this app's real
 * webhook route without either using Stripe's own resend/replay tooling
 * against a live event, or fabricating a payload) is explicitly out of
 * scope for this slice and remains unresolved -- see the module's own
 * doc history for why `stripe events resend`, Dashboard "Resend", a raw
 * payload replay, `stripe trigger checkout.session.completed`, and a
 * webhook proxy were all ruled out as this slice's concern.
 *
 * The intended usage, once a future slice solves the trigger problem:
 *   1. `captureFloorRentalRedeliveryBaseline` right after the original
 *      payment is confirmed fulfilled (Stage B) -- validates the expected
 *      payment actually exists, is `paid`, matches the expected id/session,
 *      and has a PaymentIntent, then returns it as a
 *      `PaymentHarnessRedeliveryBaselineSnapshot`. Fails closed rather than
 *      producing a hollow baseline if any of that isn't true yet.
 *   2. some separately-validated mechanism causes the same logical webhook
 *      event to be delivered a second time.
 *   3. `captureFloorRentalRedeliverySnapshot` again -- the after-state.
 *      Unlike the baseline, this plain read is allowed to come back with
 *      `payment: null`: the payment having disappeared *since* a valid
 *      baseline was established is itself one of the mismatches step 4
 *      exists to detect, not a reason to throw.
 *   4. `compareFloorRentalRedeliverySnapshots(baseline, after)`.
 *   5. `resolveFloorRentalRedeliveryCheckResult` combines that comparison
 *      with the caller's own proof (or lack of proof) that step 2 actually
 *      happened, into the final, honest result.
 *
 * Both capture and comparison are strictly read-only: every DB call this
 * file makes is a `.select()`; there is no `.insert()`, `.update()`, or
 * `.delete()` anywhere in this module, and no Stripe API call at all.
 *
 * Capture never interpolates a raw Supabase/PostgREST `error.message` into
 * a thrown `PaymentHarnessSafetyError` -- only the fact that a read
 * failed. The final release review for the two-stage manual-payment
 * workflow flagged that pattern elsewhere in this module tree
 * (`evidence.ts`, `fixture.ts`) as a non-blocking hardening gap; this new
 * module does not repeat it.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

function nowIso(): string {
  return new Date().toISOString();
}

function checkpoint(name: string, status: "passed" | "failed", detail?: string): PaymentHarnessCheckpoint {
  return Object.freeze({ name, status, at: nowIso(), ...(detail ? { detail } : {}) });
}

/**
 * Captures a read-only, immutable snapshot of the floor-rental payment and
 * appointment state needed to later prove redelivery idempotency. Called
 * twice by a caller (once as the "before" baseline, once as the "after"
 * state) -- this function itself has no notion of "which call this is",
 * since it never triggers or waits for anything; it only reads what is
 * true right now.
 *
 * The payment row is scoped to `checkoutSessionId` (not just
 * studio/client/source) so that unrelated, historical floor-rental
 * payments for the same client -- different transactions entirely -- can
 * never affect `relatedPaymentRowCount` or be mistaken for this
 * transaction's row. The expected payment row not being found among those
 * is captured as `payment: null` rather than thrown: "the row is now
 * gone" is itself one of the mismatches `compareFloorRentalRedeliverySnapshots`
 * exists to detect, so losing that information to an exception here would
 * defeat the point. A genuine DB error is still a fail-closed thrown
 * `PaymentHarnessSafetyError`.
 */
export async function captureFloorRentalRedeliverySnapshot(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  paymentId: string;
  checkoutSessionId: string;
}): Promise<PaymentHarnessRedeliverySnapshot> {
  const { adminSupabase, config, paymentId, checkoutSessionId } = params;
  const context = "captureFloorRentalRedeliverySnapshot";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  const { data: paymentRows, error: paymentError } = await adminSupabase
    .from("payments")
    .select("id, status, amount, stripe_checkout_session_id, stripe_payment_intent_id, paid_at")
    .eq("studio_id", config.studioId)
    .eq("client_id", config.clientId)
    .eq("source", "floor_rental")
    .eq("stripe_checkout_session_id", checkoutSessionId);

  if (paymentError) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to capture the payment row for this transaction's redelivery snapshot.`,
      "REDELIVERY_PAYMENT_LOOKUP_FAILED",
    );
  }

  const rows = paymentRows ?? [];
  const targetRow = rows.find((row) => row.id === paymentId) ?? null;

  const payment: PaymentHarnessRedeliveryPaymentSnapshotEntry | null = targetRow
    ? Object.freeze({
        paymentId: targetRow.id as string,
        relatedPaymentRowCount: rows.length,
        status: targetRow.status as string,
        amount: Number(targetRow.amount),
        stripeCheckoutSessionId: (targetRow.stripe_checkout_session_id as string | null) ?? null,
        stripePaymentIntentId: (targetRow.stripe_payment_intent_id as string | null) ?? null,
        paidAt: (targetRow.paid_at as string | null) ?? null,
      })
    : null;

  const { data: appointmentRows, error: appointmentError } = await adminSupabase
    .from("appointments")
    .select("id, status, payment_status")
    .eq("studio_id", config.studioId)
    .eq("client_id", config.clientId)
    .eq("appointment_type", "floor_space_rental");

  if (appointmentError) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to capture appointment state for this transaction's redelivery snapshot.`,
      "REDELIVERY_APPOINTMENTS_LOOKUP_FAILED",
    );
  }

  const appointments: readonly PaymentHarnessRedeliveryAppointmentSnapshotEntry[] = Object.freeze(
    (appointmentRows ?? []).map((row) =>
      Object.freeze({
        id: row.id as string,
        status: row.status as string,
        paymentStatus: row.payment_status as string,
      }),
    ),
  );

  return Object.freeze({
    payment,
    appointments,
    capturedAt: nowIso(),
  });
}

/**
 * Captures and validates a redelivery *baseline* -- the authoritative
 * "post-first-fulfillment" state a later `after` read and comparison will
 * be judged against. Reuses `captureFloorRentalRedeliverySnapshot` for the
 * actual read, then requires all of the following before returning a
 * `PaymentHarnessRedeliveryBaselineSnapshot` (never a plain snapshot with
 * a possibly-null `payment`):
 *
 *   - the expected payment row exists at all;
 *   - its id and Checkout Session id exactly match what the caller expects;
 *   - its status is already `"paid"` (a baseline can only describe a
 *     transaction that has actually completed);
 *   - it has a populated PaymentIntent id;
 *   - if the caller supplies `expectedAmount`, it matches exactly -- never
 *     invented when omitted, since the snapshot already preserves the
 *     real captured amount for the later exact-match comparison.
 *
 * Fails closed with a specific, sanitized `PaymentHarnessSafetyError` (no
 * raw Supabase/PostgREST error text) the instant any of these don't hold,
 * rather than returning a hollow/partial baseline a caller might
 * accidentally treat as valid. This is the only function in this module
 * that can produce a `PaymentHarnessRedeliveryBaselineSnapshot` --
 * `compareFloorRentalRedeliverySnapshots`'s `baseline` parameter is typed
 * to require one, so there is no code path by which an unvalidated,
 * `payment: null` snapshot can ever be compared as a baseline.
 */
export async function captureFloorRentalRedeliveryBaseline(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  paymentId: string;
  checkoutSessionId: string;
  expectedAmount?: number;
}): Promise<PaymentHarnessRedeliveryBaselineSnapshot> {
  const { adminSupabase, config, paymentId, checkoutSessionId, expectedAmount } = params;
  const context = "captureFloorRentalRedeliveryBaseline";

  const snapshot = await captureFloorRentalRedeliverySnapshot({
    adminSupabase,
    config,
    paymentId,
    checkoutSessionId,
  });

  if (!snapshot.payment) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the expected completed payment was not found. Refusing to ` +
        `establish a redelivery baseline without the payment this check exists to verify.`,
      "REDELIVERY_BASELINE_PAYMENT_MISSING",
    );
  }

  const payment = snapshot.payment;

  if (payment.paymentId !== paymentId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the captured payment id does not match the expected payment id.`,
      "REDELIVERY_BASELINE_PAYMENT_ID_MISMATCH",
    );
  }

  if (payment.stripeCheckoutSessionId !== checkoutSessionId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the captured payment's Checkout Session id does not match the ` +
        `expected session.`,
      "REDELIVERY_BASELINE_SESSION_MISMATCH",
    );
  }

  if (payment.status !== "paid") {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the expected payment is not yet paid. Refusing to establish a ` +
        `redelivery baseline before the original payment has actually completed.`,
      "REDELIVERY_BASELINE_NOT_PAID",
    );
  }

  if (!payment.stripePaymentIntentId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the expected payment has no PaymentIntent id recorded.`,
      "REDELIVERY_BASELINE_PAYMENT_INTENT_MISSING",
    );
  }

  if (expectedAmount !== undefined && payment.amount !== expectedAmount) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the expected payment's amount does not match the caller-supplied ` +
        `expected amount.`,
      "REDELIVERY_BASELINE_AMOUNT_MISMATCH",
    );
  }

  return Object.freeze({ ...snapshot, payment }) as PaymentHarnessRedeliveryBaselineSnapshot;
}

/**
 * Pure, synchronous comparison of an already-validated baseline against a
 * later read -- no I/O, so this never needs a DB fake to exercise, only
 * two frozen snapshot values. Deliberately does not throw for a detected
 * mismatch: a duplicate delivery changing state is an expected,
 * meaningful *result* this function exists to report, not a usage error.
 *
 * `baseline`'s type (`PaymentHarnessRedeliveryBaselineSnapshot`) already
 * guarantees `payment` is present -- only `captureFloorRentalRedeliveryBaseline`
 * can produce one, so a "payment missing" baseline cannot reach this
 * function through normal, type-checked usage. The runtime check below is
 * defense-in-depth only (the same "can't happen with valid input, but
 * check anyway" discipline the rest of this module tree uses), not the
 * primary safety mechanism.
 *
 * Every appointment observed in `baseline` -- paid, cancelled, voided,
 * whatever its status already was -- is expected to still be present in
 * `after`, unchanged. Unlike Stage B's verification there is no
 * "payable set" distinction here: by the time a redelivery baseline is
 * captured, the original payment has already fully completed, so nothing
 * should be transitioning at all. This compares exact recorded state,
 * never a freshly-derived "should be" expectation, and never assumes a
 * historical paid/voided record is itself contamination -- only a
 * *change* between the two snapshots counts.
 */
export function compareFloorRentalRedeliverySnapshots(params: {
  baseline: PaymentHarnessRedeliveryBaselineSnapshot;
  after: PaymentHarnessRedeliverySnapshot;
}): PaymentHarnessRedeliveryStateComparison {
  const { baseline, after } = params;
  const context = "compareFloorRentalRedeliverySnapshots";

  if (!baseline.payment) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the baseline snapshot never captured the expected payment row. ` +
        `Refusing to compare against a malformed baseline.`,
      "REDELIVERY_MALFORMED_BASELINE",
    );
  }

  const basePayment = baseline.payment;
  const mismatches: PaymentHarnessRedeliveryMismatch[] = [];

  if (!after.payment) {
    mismatches.push({
      code: "REDELIVERY_PAYMENT_MISSING",
      detail: `Expected payment ${basePayment.paymentId} was present in the baseline snapshot but is no longer found.`,
    });
  } else {
    const afterPayment = after.payment;

    if (afterPayment.paymentId !== basePayment.paymentId) {
      mismatches.push({
        code: "REDELIVERY_PAYMENT_ID_CHANGED",
        detail: `Payment id changed from ${basePayment.paymentId} to ${afterPayment.paymentId}.`,
      });
    }
    if (afterPayment.relatedPaymentRowCount !== basePayment.relatedPaymentRowCount) {
      mismatches.push({
        code: "REDELIVERY_PAYMENT_ROW_COUNT_CHANGED",
        detail:
          `Payment row count for this transaction changed from ${basePayment.relatedPaymentRowCount} ` +
          `to ${afterPayment.relatedPaymentRowCount}.`,
      });
    }
    if (afterPayment.status !== basePayment.status) {
      mismatches.push({
        code: "REDELIVERY_PAYMENT_STATUS_CHANGED",
        detail: `Payment status changed from ${basePayment.status} to ${afterPayment.status}.`,
      });
    }
    if (afterPayment.amount !== basePayment.amount) {
      mismatches.push({
        code: "REDELIVERY_PAYMENT_AMOUNT_CHANGED",
        detail: `Payment amount changed from ${basePayment.amount} to ${afterPayment.amount}.`,
      });
    }
    if (afterPayment.stripeCheckoutSessionId !== basePayment.stripeCheckoutSessionId) {
      mismatches.push({
        code: "REDELIVERY_CHECKOUT_SESSION_CHANGED",
        detail:
          `Checkout Session id changed from ${basePayment.stripeCheckoutSessionId} ` +
          `to ${afterPayment.stripeCheckoutSessionId}.`,
      });
    }
    if (afterPayment.stripePaymentIntentId !== basePayment.stripePaymentIntentId) {
      mismatches.push({
        code: "REDELIVERY_PAYMENT_INTENT_CHANGED",
        detail:
          `PaymentIntent id changed from ${basePayment.stripePaymentIntentId} ` +
          `to ${afterPayment.stripePaymentIntentId}.`,
      });
    }
  }

  const baselineById = new Map(baseline.appointments.map((entry) => [entry.id, entry] as const));
  const afterById = new Map(after.appointments.map((entry) => [entry.id, entry] as const));

  for (const [id, before] of baselineById) {
    const now = afterById.get(id);
    if (!now) {
      mismatches.push({
        code: "REDELIVERY_APPOINTMENT_MISSING",
        detail: `Appointment ${id} was present in the baseline snapshot but is no longer present.`,
      });
      continue;
    }
    if (now.status !== before.status || now.paymentStatus !== before.paymentStatus) {
      mismatches.push({
        code: "REDELIVERY_APPOINTMENT_CHANGED",
        detail:
          `Appointment ${id} changed (was status=${before.status}/payment_status=${before.paymentStatus}, ` +
          `now status=${now.status}/payment_status=${now.paymentStatus}).`,
      });
    }
  }

  for (const id of afterById.keys()) {
    if (!baselineById.has(id)) {
      mismatches.push({
        code: "REDELIVERY_UNEXPECTED_APPOINTMENT",
        detail: `Appointment ${id} appeared in the after snapshot but was not present in the baseline.`,
      });
    }
  }

  return Object.freeze({
    outcome: mismatches.length === 0 ? ("unchanged" as const) : ("changed" as const),
    mismatches: Object.freeze(mismatches),
  });
}

/**
 * The one place allowed to say a redelivery check `"passed"` -- and it
 * deliberately cannot do so from `comparison` alone. `triggerStatus` must
 * independently be `"confirmed"` (proof a caller obtained from whatever
 * redelivery mechanism it used -- the separate, unresolved trigger
 * problem this module's doc comment describes) before an `"unchanged"`
 * comparison becomes `"passed"`. An identical-looking baseline/after pair
 * captured with `triggerStatus: "not_available"` or `"unverified"` can
 * never become `"passed"` here, no matter what the comparison says --
 * "no trigger happened" (or "we can't tell if it did") must never be
 * reported the same as "we proved it happened and nothing changed."
 *
 * Reuses the existing `PaymentHarnessRedeliveryResult` enum (the same one
 * `payment_harness_runs.redelivery_check_result` is already constrained
 * to) but never returns `"not_run"` -- that value is the column's own
 * pre-call default, not something a completed check reports.
 */
export function resolveFloorRentalRedeliveryCheckResult(params: {
  triggerStatus: PaymentHarnessRedeliveryTriggerStatus;
  comparison: PaymentHarnessRedeliveryStateComparison;
}): PaymentHarnessRedeliveryVerificationOutcome {
  const { triggerStatus, comparison } = params;

  if (triggerStatus === "not_available") {
    return Object.freeze({
      result: "not_available" as PaymentHarnessRedeliveryResult,
      comparison,
      checkpoint: checkpoint(
        "redeliveryVerification",
        "failed",
        "No redelivery trigger was available -- idempotency not exercised.",
      ),
    });
  }

  if (triggerStatus === "unverified") {
    return Object.freeze({
      result: "not_verified" as PaymentHarnessRedeliveryResult,
      comparison,
      checkpoint: checkpoint(
        "redeliveryVerification",
        "failed",
        "A redelivery trigger was attempted but could not be independently verified.",
      ),
    });
  }

  const passed = comparison.outcome === "unchanged";

  return Object.freeze({
    result: (passed ? "passed" : "failed") as PaymentHarnessRedeliveryResult,
    comparison,
    checkpoint: checkpoint(
      "redeliveryVerification",
      passed ? "passed" : "failed",
      passed
        ? "Confirmed redelivery produced no additional state transition."
        : `Confirmed redelivery produced ${comparison.mismatches.length} unexpected state change(s).`,
    ),
  });
}
