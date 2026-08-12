import Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { getStripe } from "@/lib/payments/stripe";

type AdminClient = ReturnType<typeof createAdminClient>;
type StripeClient = ReturnType<typeof getStripe>;

export type ResolveClientCheckoutSessionResult =
  | { kind: "reuse"; url: string }
  | { kind: "created"; url: string; sessionId: string }
  | { kind: "already_processed" }
  | { kind: "retry_needed" }
  | { kind: "error"; message: string };

const GENERIC_CHECKOUT_ERROR = "Checkout could not be started. Please try again.";

/**
 * Checks a previously-recorded Checkout Session and reports what to do
 * with it, or `null` if a new one should be created, or throws if the
 * retrieval failed for a reason that does NOT justify creating a
 * replacement.
 *
 * "complete" is treated as `already_processed` rather than reused --
 * visiting a completed session's own URL is not a meaningful redirect
 * target, and the local `payments.status` may not have caught up yet if a
 * webhook is still in flight.
 *
 * Only a confirmed "this session does not exist" response
 * (`Stripe.errors.StripeInvalidRequestError` -- Stripe's own class for a
 * 404/invalid-resource response, e.g. `code: "resource_missing"`) is
 * treated as "unusable, fall through to create a replacement." Any other
 * failure (connection error, rate limit, Stripe 5xx, auth/permission
 * error) is a TRANSIENT failure to determine the session's real status,
 * not evidence the session is gone -- treating it the same as "gone"
 * would risk creating a second session for a still-open, still-payable
 * one that simply couldn't be reached this instant. Those failures fail
 * closed by throwing, which the caller converts into a generic error
 * result rather than proceeding to create().
 */
async function evaluateExistingSession(
  stripe: StripeClient,
  connectedAccountId: string,
  sessionId: string,
): Promise<ResolveClientCheckoutSessionResult | null> {
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
        "client-checkout: existing session is invalid/missing, treating as unusable",
        error.message,
      );
      return null;
    }

    console.error(
      "client-checkout: transient failure retrieving existing session, failing closed",
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
 * Atomically claims the next checkout-session attempt number for this
 * payment via a compare-and-swap update -- the same
 * `.eq(currentValue)` shape already used by this route's own
 * `.eq("status", "pending")` post-create guard, and by
 * `event_private_lesson_slots`' hold pattern. A single UPDATE statement
 * is inherently atomic per-row in Postgres: if two requests race with the
 * same `currentAttemptCount`, only one UPDATE can match and succeed: the
 * other's WHERE clause no longer matches once the winner's write
 * commits, no explicit row lock or RPC required.
 *
 * Uses the admin (service-role) client -- see the module-level note on
 * `resolveClientCheckoutSession` for why, and why that's safe here.
 */
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

/**
 * Reached only when this request lost the attempt-claim race above --
 * either the payment stopped being "pending", or a concurrent request for
 * the same paymentId already claimed the next attempt. Re-reads the
 * current row once (no retry loop, no artificial delay) and resolves
 * against whatever that concurrent winner has done so far, rather than
 * proceeding to create a second Stripe session of its own:
 *   - status no longer pending -> already_processed;
 *   - a session id is now recorded -> evaluate it exactly like the
 *     up-front existing-session check (reuse if open, already_processed
 *     if complete, fall through if still unusable, fail closed on a
 *     transient retrieval error);
 *   - neither -> the winner is still mid-flight (Stripe call not back
 *     yet); ask the caller to retry rather than racing it.
 */
async function resolveAfterLostClaim(params: {
  adminSupabase: AdminClient;
  stripe: StripeClient;
  connectedAccountId: string;
  paymentId: string;
}): Promise<ResolveClientCheckoutSessionResult> {
  const { data: fresh, error } = await params.adminSupabase
    .from("payments")
    .select("status, stripe_checkout_session_id")
    .eq("id", params.paymentId)
    .maybeSingle();

  if (error || !fresh) {
    console.error(
      "client-checkout: re-read after lost claim failed",
      error?.message,
    );
    return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
  }

  if (fresh.status !== "pending") {
    return { kind: "already_processed" };
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
 * Resolves the Checkout Session a "pay this invoice" link should send the
 * caller to for one `payments` row, reusing a still-open session instead
 * of creating a duplicate, and closing the concurrent-first-request race
 * (two nearly-simultaneous requests for the same paymentId, neither with
 * an existing session yet) via the attempt-count CAS above rather than
 * letting both reach `stripe.checkout.sessions.create` independently.
 *
 * The caller is responsible for every authorization/eligibility check
 * (role, billing-relationship, studio Stripe readiness) using its own
 * user-scoped client BEFORE calling this -- it assumes the payment is
 * already known to belong to `connectedAccountId`, already known to be
 * safe to charge, and that the caller is already authorized to pay it.
 *
 * `adminSupabase` must be a service-role client, passed in only after
 * that authorization has already succeeded. This function's own writes
 * (the attempt-count CAS claim and the final session-id persist) are not
 * covered by any RLS policy for a client-portal billing viewer authorized
 * only via `client_account_links` -- `payments` has no UPDATE policy for
 * that relationship, only for studio staff (`user_studio_roles`). Using
 * the user's own session client for these specific writes would silently
 * fail under RLS for that caller population on every attempt, turning a
 * legitimate retry into a permanent `retry_needed` loop. Every write here
 * remains narrowly scoped by `paymentId`, the expected `status='pending'`,
 * and (for the claim) the expected prior attempt count, so this does not
 * widen who can reach or affect a payment -- it only lets an already-
 * authorized caller's own idempotency bookkeeping succeed.
 */
export async function resolveClientCheckoutSession(params: {
  adminSupabase: AdminClient;
  stripe: StripeClient;
  paymentId: string;
  currentAttemptCount: number;
  existingSessionId: string | null;
  connectedAccountId: string;
  createSessionParams: Stripe.Checkout.SessionCreateParams;
}): Promise<ResolveClientCheckoutSessionResult> {
  const {
    adminSupabase,
    stripe,
    paymentId,
    currentAttemptCount,
    existingSessionId,
    connectedAccountId,
    createSessionParams,
  } = params;

  if (existingSessionId) {
    try {
      const outcome = await evaluateExistingSession(stripe, connectedAccountId, existingSessionId);
      if (outcome) return outcome;
    } catch {
      return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
    }
  }

  const claim = await claimCheckoutSessionAttempt(adminSupabase, paymentId, currentAttemptCount);

  if (!claim.ok) {
    return resolveAfterLostClaim({ adminSupabase, stripe, connectedAccountId, paymentId });
  }

  const idempotencyKey = `client-payment:${paymentId}:checkout-session:${claim.attemptNumber}`;

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(createSessionParams, {
      stripeAccount: connectedAccountId,
      idempotencyKey,
    });
  } catch (error) {
    console.error(
      "client-checkout: session creation failed",
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
    .eq("id", paymentId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (updateError) {
    console.error("client-checkout: session persist failed", updateError.message);
    return { kind: "error", message: GENERIC_CHECKOUT_ERROR };
  }

  if (!updated) {
    return { kind: "already_processed" };
  }

  if (!session.url) {
    console.error("client-checkout: Stripe did not return a Checkout URL", session.id);
    return { kind: "error", message: "Stripe did not return a Checkout URL." };
  }

  return { kind: "created", url: session.url, sessionId: session.id };
}
