import Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { getStripe } from "@/lib/payments/stripe";

type AdminClient = ReturnType<typeof createAdminClient>;
type StripeClient = ReturnType<typeof getStripe>;

const POSTGRES_UNIQUE_VIOLATION = "23505";
const AMOUNT_EPSILON = 0.01;
const GENERIC_CHECKOUT_ERROR = "Checkout could not be started. Please try again.";

export type ResolvePortalFloorRentalCheckoutResult =
  | { kind: "reuse"; url: string }
  | { kind: "created"; url: string; sessionId: string; paymentId: string }
  | { kind: "already_processed" }
  | { kind: "retry_needed" }
  | { kind: "error"; message: string };

type PendingPaymentRow = {
  id: string;
  status: string;
  amount: number;
  stripe_checkout_session_id: string | null;
  checkout_session_attempt_count: number;
};

const PENDING_ROW_COLUMNS =
  "id, status, amount, stripe_checkout_session_id, checkout_session_attempt_count";

function selectPendingRow(adminSupabase: AdminClient, studioId: string, clientId: string) {
  return adminSupabase
    .from("payments")
    .select(PENDING_ROW_COLUMNS)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("source", "floor_rental")
    .eq("status", "pending")
    .maybeSingle();
}

function insertPendingRow(adminSupabase: AdminClient, studioId: string, clientId: string, amount: number) {
  return adminSupabase
    .from("payments")
    .insert({
      studio_id: studioId,
      client_id: clientId,
      amount,
      status: "pending",
      source: "floor_rental",
      payment_type: "floor_fee",
      payment_method: "card",
      checkout_session_attempt_count: 0,
    })
    .select(PENDING_ROW_COLUMNS)
    .single();
}

/** `paid` genuinely means the webhook already completed this row -- any
 * other non-pending status (most realistically `voided`, since amount
 * mismatches are the only thing that transitions this row away from
 * pending outside of the webhook) means the caller should retry rather
 * than being told their payment already went through. */
function alreadyHandledResult(status: string | null | undefined): ResolvePortalFloorRentalCheckoutResult {
  return status === "paid" ? { kind: "already_processed" } : { kind: "retry_needed" };
}

type ResolvePendingRowResult =
  | { ok: true; row: PendingPaymentRow }
  | { ok: false; result: ResolvePortalFloorRentalCheckoutResult };

/**
 * Resolves the single pending `payments` row a portal floor-rental balance
 * checkout attempt should operate against, reusing one already in flight
 * for this (studio, client) pair instead of creating a duplicate -- unlike
 * `client-checkout-session.ts`, no such row exists until the customer's own
 * POST creates one, so this also has to solve the first-creation race that
 * tranche never had to.
 *
 * Amount is the deciding factor for reuse vs. supersede: if the freshly
 * computed payable balance matches the existing pending row's stored
 * `amount` (within a cent), that row is reused as-is. If it doesn't -- the
 * payable set changed since the last attempt (a rental was added,
 * cancelled, or repriced) -- reusing its Stripe session would risk charging
 * the wrong amount, so the stale row is marked `voided` (approved
 * superseded-attempt semantic; the accounting sync trigger already treats
 * any non-paid/refunded `payments.status` identically, so this has no
 * revenue/accounting effect) and a fresh pending row is inserted in its
 * place.
 *
 * The first-insert race (two concurrent requests, neither with a pending
 * row yet) is closed by
 * payments_floor_rental_pending_studio_client_key (a partial unique index
 * on (studio_id, client_id) where status='pending' and source='floor_rental')
 * plus 23505 recovery here -- same shape as
 * `resolveEventOrderForCheckout` in src/lib/events/event-order-payment.ts.
 * If the concurrent winner's row was itself created for a different amount
 * than this request computed, this does not loop to void-and-retry again
 * (that would itself race against the winner) -- it asks the caller to
 * retry, and a fresh request will resolve cleanly against whatever the
 * balance has settled to.
 */
async function resolvePendingPaymentRow(params: {
  adminSupabase: AdminClient;
  studioId: string;
  clientId: string;
  amount: number;
}): Promise<ResolvePendingRowResult> {
  const { adminSupabase, studioId, clientId, amount } = params;

  const existing = await selectPendingRow(adminSupabase, studioId, clientId);
  if (existing.error) {
    console.error(
      "portal-floor-rental-checkout: pending row lookup failed",
      existing.error.message,
    );
    return { ok: false, result: { kind: "error", message: GENERIC_CHECKOUT_ERROR } };
  }

  if (existing.data) {
    const row = existing.data as PendingPaymentRow;
    if (Math.abs(Number(row.amount) - amount) <= AMOUNT_EPSILON) {
      return { ok: true, row };
    }

    const voided = await adminSupabase
      .from("payments")
      .update({ status: "voided" })
      .eq("id", row.id)
      .eq("status", "pending");

    if (voided.error) {
      console.error(
        "portal-floor-rental-checkout: voiding stale pending row failed",
        voided.error.message,
      );
      return { ok: false, result: { kind: "error", message: GENERIC_CHECKOUT_ERROR } };
    }
    // Falls through to insert-fresh below -- whether this request's own
    // void just succeeded or a concurrent request already voided the same
    // row first, the row is no longer 'pending' either way, so the insert
    // below cannot conflict with it.
  }

  const inserted = await insertPendingRow(adminSupabase, studioId, clientId, amount);
  if (!inserted.error && inserted.data) {
    return { ok: true, row: inserted.data as PendingPaymentRow };
  }

  if (inserted.error?.code === POSTGRES_UNIQUE_VIOLATION) {
    const winner = await selectPendingRow(adminSupabase, studioId, clientId);
    if (winner.error || !winner.data) {
      console.error(
        "portal-floor-rental-checkout: pending row race recovery failed",
        winner.error?.message,
      );
      return { ok: false, result: { kind: "error", message: GENERIC_CHECKOUT_ERROR } };
    }

    const winnerRow = winner.data as PendingPaymentRow;
    if (Math.abs(Number(winnerRow.amount) - amount) <= AMOUNT_EPSILON) {
      return { ok: true, row: winnerRow };
    }

    return { ok: false, result: { kind: "retry_needed" } };
  }

  console.error(
    "portal-floor-rental-checkout: pending row insert failed",
    inserted.error?.message,
  );
  return { ok: false, result: { kind: "error", message: GENERIC_CHECKOUT_ERROR } };
}

/** Same retrieve-and-classify shape as
 * `client-checkout-session.ts`'s `evaluateExistingSession` -- only a
 * confirmed "this session does not exist" response
 * (`Stripe.errors.StripeInvalidRequestError`) is treated as unusable and
 * falls through to creating a replacement. Any other failure (connection
 * error, rate limit, 5xx) fails closed by throwing, which the caller
 * converts into a generic error result rather than risking a duplicate
 * session for one that simply couldn't be reached this instant. */
async function evaluateExistingSession(
  stripe: StripeClient,
  connectedAccountId: string,
  sessionId: string,
): Promise<ResolvePortalFloorRentalCheckoutResult | null> {
  let existing: Stripe.Checkout.Session;
  try {
    existing = await stripe.checkout.sessions.retrieve(
      sessionId,
      {},
      { stripeAccount: connectedAccountId },
    );
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      console.error(
        "portal-floor-rental-checkout: existing session is invalid/missing, treating as unusable",
        error.message,
      );
      return null;
    }

    console.error(
      "portal-floor-rental-checkout: transient failure retrieving existing session, failing closed",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }

  if (existing.status === "open" && existing.url) {
    return { kind: "reuse", url: existing.url };
  }

  if (existing.status === "complete") {
    return { kind: "already_processed" };
  }

  return null;
}

/**
 * Re-reads whether this exact payment row is still `pending` -- and if so,
 * its *current* `stripe_checkout_session_id` -- immediately before it is
 * trusted for session reuse. `resolvePendingPaymentRow`'s own row snapshot
 * is not safe to use for this directly: a concurrent request for the same
 * (studio, client) pair can void this row (amount-mismatch supersede,
 * `resolvePendingPaymentRow` above) in the window between that snapshot
 * being read and `evaluateExistingSession`'s Stripe network round-trip
 * completing, which is easily long enough for a second request's full DB
 * round-trip to land. Without this re-check, a caller could be handed a
 * still-genuinely-payable Stripe Checkout Session URL for a row that is no
 * longer `pending` -- the webhook would then find `status !== "pending"` on
 * completion and silently no-op, discarding a real charge. Scoped to the
 * same (id, studio_id, client_id, source, status='pending') tuple the row
 * was originally resolved under, so this can never read across a different
 * payment. A genuine DB error here fails closed (caller returns a generic
 * error) rather than falling through to create a second, redundant live
 * session on top of one that might still be perfectly valid.
 */
async function refetchPendingSessionId(
  adminSupabase: AdminClient,
  studioId: string,
  clientId: string,
  paymentId: string,
): Promise<{ ok: true; sessionId: string | null } | { ok: false }> {
  const { data, error } = await adminSupabase
    .from("payments")
    .select("stripe_checkout_session_id")
    .eq("id", paymentId)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("source", "floor_rental")
    .eq("status", "pending")
    .maybeSingle();

  if (error) {
    console.error(
      "portal-floor-rental-checkout: fresh pending-row read failed",
      error.message,
    );
    return { ok: false };
  }

  // No row means this id is no longer pending (voided/paid since the
  // earlier snapshot) -- same "nothing safe to reuse, fall through to the
  // CAS claim" outcome as a pending row whose session id happens to be
  // null. The CAS below re-guards on status='pending' on its own, so
  // either case is handled correctly without needing to distinguish them
  // here.
  return { ok: true, sessionId: data ? ((data.stripe_checkout_session_id as string | null) ?? null) : null };
}

/** Atomically claims the next checkout-session attempt number via a
 * compare-and-swap update -- same shape as
 * `client-checkout-session.ts`'s `claimCheckoutSessionAttempt`, reusing the
 * same `payments.checkout_session_attempt_count` column (not floor-rental
 * specific). */
async function claimCheckoutSessionAttempt(
  adminSupabase: AdminClient,
  paymentId: string,
  currentAttemptCount: number,
): Promise<{ ok: true; attemptNumber: number } | { ok: false }> {
  const { data, error } = await adminSupabase
    .from("payments")
    .update({ checkout_session_attempt_count: currentAttemptCount + 1 })
    .eq("id", paymentId)
    .eq("status", "pending")
    .eq("checkout_session_attempt_count", currentAttemptCount)
    .select("checkout_session_attempt_count")
    .maybeSingle();

  if (error || !data) return { ok: false };
  return { ok: true, attemptNumber: currentAttemptCount };
}

/** Reached only when this request lost the attempt-claim race. Re-reads
 * the row once (no retry loop) and resolves against whatever the
 * concurrent winner (or a concurrent amount-mismatch voider) has done so
 * far, rather than proceeding to create a second Stripe session. */
async function resolveAfterLostClaim(params: {
  adminSupabase: AdminClient;
  stripe: StripeClient;
  connectedAccountId: string;
  paymentId: string;
}): Promise<ResolvePortalFloorRentalCheckoutResult> {
  const { data: fresh, error } = await params.adminSupabase
    .from("payments")
    .select("status, stripe_checkout_session_id")
    .eq("id", params.paymentId)
    .maybeSingle();

  if (error || !fresh) {
    console.error(
      "portal-floor-rental-checkout: re-read after lost claim failed",
      error?.message,
    );
    return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
  }

  if (fresh.status !== "pending") {
    return alreadyHandledResult(fresh.status);
  }

  if (fresh.stripe_checkout_session_id) {
    try {
      const outcome = await evaluateExistingSession(
        params.stripe,
        params.connectedAccountId,
        fresh.stripe_checkout_session_id,
      );
      if (outcome) return outcome;
    } catch {
      return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
    }
  }

  return { kind: "retry_needed" };
}

/**
 * Resolves the Checkout Session a portal floor-rental "Pay Open Balance"
 * submit should redirect to, reusing a still-open session (or a still-valid
 * pending row) instead of creating a duplicate, and closing the
 * concurrent-first-request race via the reuse-or-create step above plus the
 * attempt-count CAS below -- rather than letting two nearly-simultaneous
 * submissions both reach `stripe.checkout.sessions.create` independently.
 *
 * The caller is responsible for every authorization/eligibility check
 * (billing relationship, independent-instructor validation, payable-
 * appointment lookup, studio Stripe readiness) using its own user-scoped
 * client BEFORE calling this. `adminSupabase` must be a service-role
 * client, passed in only after that authorization has already succeeded --
 * the RLS policies on `appointments`/`client_account_links`-based portal
 * billing viewers do not cover the writes this function performs (same
 * reasoning as the client-checkout-session.ts admin-client fix), and every
 * write here remains narrowly scoped by the resolved payment row's id and
 * expected status, so this does not widen who can reach or affect a
 * payment.
 */
export async function resolvePortalFloorRentalCheckoutSession(params: {
  adminSupabase: AdminClient;
  stripe: StripeClient;
  studioId: string;
  clientId: string;
  amount: number;
  connectedAccountId: string;
  buildCreateSessionParams: (paymentId: string) => Stripe.Checkout.SessionCreateParams;
}): Promise<ResolvePortalFloorRentalCheckoutResult> {
  const { adminSupabase, stripe, studioId, clientId, amount, connectedAccountId, buildCreateSessionParams } = params;

  const resolved = await resolvePendingPaymentRow({ adminSupabase, studioId, clientId, amount });
  if (!resolved.ok) return resolved.result;

  const { row } = resolved;

  if (row.stripe_checkout_session_id) {
    const fresh = await refetchPendingSessionId(adminSupabase, studioId, clientId, row.id);
    if (!fresh.ok) {
      return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
    }

    if (fresh.sessionId) {
      try {
        const outcome = await evaluateExistingSession(stripe, connectedAccountId, fresh.sessionId);
        if (outcome) return outcome;
      } catch {
        return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
      }
    }
    // fresh.sessionId is null either because this row is no longer pending
    // (a concurrent void landed between the earlier snapshot and this
    // re-check) or because it never had a session id to begin with -- both
    // fall through to the CAS claim below, which re-guards on
    // status='pending' on its own and safely resolves to `resolveAfterLostClaim`
    // if the row has since been superseded.
  }

  const claim = await claimCheckoutSessionAttempt(adminSupabase, row.id, row.checkout_session_attempt_count);

  if (!claim.ok) {
    return resolveAfterLostClaim({ adminSupabase, stripe, connectedAccountId, paymentId: row.id });
  }

  const idempotencyKey = `portal-floor-rental:${row.id}:checkout-session:${claim.attemptNumber}`;

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(buildCreateSessionParams(row.id), {
      stripeAccount: connectedAccountId,
      idempotencyKey,
    });
  } catch (error) {
    console.error(
      "portal-floor-rental-checkout: session creation failed",
      error instanceof Error ? error.message : error,
    );
    return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
  }

  const { data: updated, error: updateError } = await adminSupabase
    .from("payments")
    .update({
      stripe_checkout_session_id: session.id,
      external_reference: session.id,
    })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (updateError) {
    console.error("portal-floor-rental-checkout: session persist failed", updateError.message);
    return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
  }

  if (!updated) {
    const { data: fresh } = await adminSupabase
      .from("payments")
      .select("status")
      .eq("id", row.id)
      .maybeSingle();
    return alreadyHandledResult(fresh?.status);
  }

  if (!session.url) {
    console.error("portal-floor-rental-checkout: Stripe did not return a Checkout URL", session.id);
    return { kind: "error", message: "Stripe did not return a Checkout URL." };
  }

  return { kind: "created", url: session.url, sessionId: session.id, paymentId: row.id };
}
