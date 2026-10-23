/**
 * T2 (transactional dispatcher reliability): pure helpers that decide what happens to an `outbound_deliveries` row after
 * a send attempt, and what may be stored about it.
 *
 * Outcomes:
 *  - terminal: the row is finished (`failed`), and only a fixed reason code is stored;
 *  - retry: a transient or unknown outcome. Either the provider may have accepted the message (timeout, network
 *    error, 5xx, a concurrent request with the same idempotency key, an acceptance we could not record), or it
 *    definitely refused it (not configured, rejected API key, rate limit or quota). The row stays `queued`, its lease is
 *    left to expire, and the next claim re-sends with the SAME provider idempotency key, so a message the provider
 *    already accepted is not sent again. The retry marker keeps the time of the first recorded attempt (normally when
 *    the first outcome is recorded; the attempt-started marker written just before each provider call sets it if that
 *    outcome is lost) and whether every attempt so far was definitely refused. Retries are bounded by RETRY_WINDOW_MS
 *    from that time (half the provider's 24-hour idempotency window). The row then ends as an unknown outcome
 *    (`provider_retry_window_exhausted`), or as definitely not sent (`provider_retry_window_exhausted_unsent`) when every
 *    attempt was refused.
 *  - A failed row is set back to `queued` (ARIA requeue paths, staff "Retry now") only for failures that prove
 *    non-delivery; see isRequeueSafeFailure. A requeue clears the marker, which restarts the window; that is safe only
 *    because nothing earlier could have been accepted. A T4 attempt/first-attempt column would make this durable.
 *  - Retried email is re-rendered from current studio data. If branding, sender or Reply-To changed between attempts the
 *    provider rejects the reused key (`invalid_idempotent_request`) and the row ends as `provider_idempotency_mismatch`
 *    (outcome unknown: the first attempt may have been delivered). It is never re-sent with a new key automatically.
 *
 * Nothing here stores provider message text: it can echo request values (addresses, content).
 */

export const DISPATCH_LEASE_SECONDS = 300;
/**
 * A dispatcher run stops starting new rows after half the lease. This bounds the run's own loop only: each row's
 * database lookups and the SMS provider call have no timeout of their own, and the platform may stop the function at its
 * configured maximum duration. A row cut off that way stays claimed until its lease expires and is then retried (email
 * with the same idempotency key; SMS has none, so a send cut off after the provider accepted it can repeat).
 */
export const DISPATCH_RUN_BUDGET_MS = 150_000;
/** Upper bound on one provider call; a hung request counts as an unknown outcome and is retried idempotently. */
export const PROVIDER_CALL_TIMEOUT_MS = 30_000;
/** Half of the provider's 24-hour idempotency-key retention. */
export const RETRY_WINDOW_MS = 12 * 60 * 60 * 1000;

export type ProviderErrorLike = { name?: unknown; statusCode?: unknown } | null | undefined;

export type ProviderOutcome = { kind: "retry"; code: string } | { kind: "terminal"; code: string };

/** Marks our own timeout so it is classified separately from a provider-reported network failure. */
export const DISPATCHER_TIMEOUT_ERROR_NAME = "dispatcher_timeout";

const SAFE_PROVIDER_NAME = /^[a-z_]{1,40}$/;

/**
 * Classifies an email provider (Resend) error. The SDK never throws for HTTP or network failures: it returns
 * `{ name, statusCode, message }`, with `statusCode: null` when no response was received.
 */
export function classifyEmailProviderError(error: ProviderErrorLike): ProviderOutcome {
  const name = typeof error?.name === "string" ? error.name : "";
  const statusCode = typeof error?.statusCode === "number" ? error.statusCode : null;

  if (name === DISPATCHER_TIMEOUT_ERROR_NAME) return { kind: "retry", code: "provider_timeout" };
  // The provider may have accepted the message before the connection failed: unknown outcome, retry idempotently.
  if (statusCode === null) return { kind: "retry", code: "provider_unreachable" };
  // Same key, request still in flight at the provider: safe to retry later with the same key.
  if (name === "concurrent_idempotent_requests") return { kind: "retry", code: "provider_concurrent_request" };
  // Same key, different payload: an earlier attempt may have been delivered with other content. Never resend.
  if (name === "invalid_idempotent_request") return { kind: "terminal", code: "provider_idempotency_mismatch" };
  if (
    statusCode === 429 ||
    name === "rate_limit_exceeded" ||
    name === "daily_quota_exceeded" ||
    name === "monthly_quota_exceeded"
  ) {
    return { kind: "retry", code: "provider_rate_limited" };
  }
  if (
    statusCode === 401 ||
    name === "missing_api_key" ||
    name === "invalid_api_key" ||
    name === "restricted_api_key"
  ) {
    // Configuration problem; nothing was sent. Retried until fixed or until the retry window ends.
    return { kind: "retry", code: "provider_auth_error" };
  }
  if (statusCode >= 500 || name === "application_error" || name === "internal_server_error") {
    return { kind: "retry", code: "provider_unavailable" };
  }
  return { kind: "terminal", code: SAFE_PROVIDER_NAME.test(name) ? `provider_rejected:${name}` : "provider_rejected" };
}

const SAFE_REASON_CODE = /^[a-z0-9_]{1,60}(?::[a-z0-9_]{1,40})?$/;

/** Only fixed, bounded reason codes are stored in `outbound_deliveries.error_message`; anything else is replaced. */
export function sanitizeDeliveryErrorCode(value: unknown): string {
  return typeof value === "string" && SAFE_REASON_CODE.test(value) ? value : "dispatch_error";
}

const RETRY_MARKER = /^retry:([a-z0-9_]{1,60}):(\d{13})(:n)?$/;

/**
 * Retryable codes that prove the provider did not accept the message on that attempt (the request was refused before
 * processing, or never made). Every other retryable code (timeout, no response, 5xx, a concurrent request with the same
 * key, an acceptance we could not record) may hide an accepted message.
 */
// TW-4F billed SMS: the database refused or could not be reached before any provider call (sms_billing_unavailable), or the attempt never reached its dispatch
// marker (sms_not_dispatched), or the usage reconciler was not ready (sms_billing_paused, 20261218): nothing was sent
const DEFINITELY_UNSENT_RETRY_CODES = new Set(["provider_not_configured", "provider_auth_error", "provider_rate_limited", "sms_billing_unavailable", "sms_not_dispatched", "sms_billing_paused"]);

/**
 * Written just before an email is handed to the provider. It is not a definitely-unsent code, so if the run stops or the
 * outcome cannot be recorded, the row is treated as possibly accepted from then on (fail closed).
 */
export const PROVIDER_ATTEMPT_STARTED = "provider_attempt_started";

export type RetryMarker = {
  code: string;
  firstAttemptMs: number;
  /** True only while EVERY attempt so far was definitely not sent. Absent (fail closed) means one may have been. */
  unsentOnly: boolean;
};

/**
 * Stored on a still-queued row after a retryable attempt: the latest reason, the time of the first recorded attempt, and
 * the `:n` flag when no attempt so far could have been accepted.
 */
export function buildRetryMarker(code: string, firstAttemptMs: number, unsentOnly = false): string {
  return `retry:${sanitizeDeliveryErrorCode(code).replace(/:.*/, "")}:${String(Math.trunc(firstAttemptMs)).padStart(13, "0")}${
    unsentOnly ? ":n" : ""
  }`;
}

export function parseRetryMarker(value: unknown): RetryMarker | null {
  if (typeof value !== "string") return null;
  const match = RETRY_MARKER.exec(value);
  if (!match) return null;
  return { code: match[1], firstAttemptMs: Number(match[2]), unsentOnly: match[3] === ":n" };
}

/** The marker to store after another retryable attempt: keeps the first-attempt time and the attempt history. */
export function nextRetryMarker(previousNote: string | null | undefined, code: string, nowMs: number): string {
  const previous = parseRetryMarker(previousNote);
  const unsentOnly = (previous ? previous.unsentOnly : true) && DEFINITELY_UNSENT_RETRY_CODES.has(code);
  return buildRetryMarker(code, previous?.firstAttemptMs ?? nowMs, unsentOnly);
}

/**
 * The code to store when a row that has been retrying ends. M1: a failure that would otherwise prove non-delivery (for
 * example a provider rejection) does not, if an earlier attempt of this row may have been accepted, so it is recorded
 * as `failed_after_uncertain_attempt` (uncertain; never requeued). Other codes are unchanged.
 */
export function terminalCodeAfterRetries(
  previousNote: string | null | undefined,
  code: string,
  channel: string | null | undefined,
): string {
  const marker = parseRetryMarker(previousNote);
  if (marker && !marker.unsentOnly && isRequeueSafeFailure(code, channel)) return "failed_after_uncertain_attempt";
  return code;
}

/**
 * The code for a row whose retry window ended. MINOR 2: when no attempt could have been accepted, the message was
 * definitely not delivered (`provider_retry_window_exhausted_unsent`, retryable); otherwise the outcome is unknown.
 */
export function retryWindowExhaustedCode(marker: RetryMarker): string {
  return marker.unsentOnly ? "provider_retry_window_exhausted_unsent" : "provider_retry_window_exhausted";
}

export function isRetryWindowExhausted(marker: { firstAttemptMs: number } | null, nowMs: number): boolean {
  return marker !== null && nowMs - marker.firstAttemptMs > RETRY_WINDOW_MS;
}

/** Failure codes recorded before any provider call: nothing was handed to the provider. */
const PRE_PROVIDER_FAILURE_CODES = new Set([
  "missing_recipient_email",
  "missing_sender_address",
  "marketing_studio_lookup_failed",
  "marketing_sender_not_configured",
  "marketing_suppression_unavailable",
  "marketing_unsubscribe_token_unavailable",
  // Every attempt was refused before processing or never made (see retryWindowExhaustedCode).
  "provider_retry_window_exhausted_unsent",
]);

/**
 * Whether a `failed` delivery may be set back to `queued`: by the automatic ARIA digest/action requeue paths AND by a
 * staff "Retry now" (enforced on the server; a requeue reuses the same provider idempotency key). Only
 * failures that prove the message was NOT delivered qualify: a pre-provider failure, a definite provider rejection of
 * an email, or a retry window in which every attempt was refused. A rejection proves only that THAT attempt was not
 * accepted, not that an earlier one was not: the dispatcher therefore records any failure that follows a possibly-accepted
 * attempt as `failed_after_uncertain_attempt` (see terminalCodeAfterRetries) before this check ever sees it.
 *
 * Everything else fails closed and is never requeued, automatically or by staff: an unknown outcome
 * (`provider_retry_window_exhausted`), a failure after an earlier attempt that may have been accepted
 * (`failed_after_uncertain_attempt`), a payload mismatch on the reused key (`provider_idempotency_mismatch`), any SMS
 * failure after the provider call, the sanitizer's `dispatch_error`, a missing note, and free text written by
 * application versions before T2 (it cannot be classified). Without a durable first-attempt column (T4), a requeue
 * clears the dispatcher's retry marker and would restart its retry window, so uncertain outcomes must stop here.
 */
export function isRequeueSafeFailure(code: string | null | undefined, channel: string | null | undefined): boolean {
  if (typeof code !== "string") return false;
  if (PRE_PROVIDER_FAILURE_CODES.has(code)) return true;
  if (channel !== "email") return false;
  // Email only: the email provider call is classified inside sendEmail, so an exception is a lookup/render failure.
  if (code === "dispatch_exception") return true;
  return code === "provider_rejected" || /^provider_rejected:[a-z_]{1,40}$/.test(code);
}

/**
 * The stored note when it records a problem, or null. A retry marker is not a failure: the row is still queued and in
 * flight, so staff screens must not show it as failed or invite a resend (a resend is a new delivery with a new
 * idempotency key, and could duplicate a message the provider already accepted).
 */
export function deliveryFailureNote(value: string | null | undefined): string | null {
  if (!value || parseRetryMarker(value)) return null;
  return value;
}

/** Failures where the provider may have delivered the message: shown to staff as "delivery uncertain", not "failed". */
const UNCERTAIN_OUTCOME_CODES = new Set([
  "provider_retry_window_exhausted",
  "provider_idempotency_mismatch",
  "sms_sent_outcome_unrecorded",
  "failed_after_uncertain_attempt",
  "sms_outcome_unknown",
]);

export function isUncertainDeliveryOutcome(value: string | null | undefined): boolean {
  return typeof value === "string" && UNCERTAIN_OUTCOME_CODES.has(value);
}

export const UNCERTAIN_DELIVERY_STAFF_TEXT =
  "Delivery uncertain: the provider may already have delivered this message. Check with the recipient before sending it again.";

/** Staff-facing text for a stored delivery note. Retry markers and uncertain outcomes are explained, never shown raw. */
export function describeDeliveryNoteForStaff(value: string | null | undefined): string | null {
  if (!value) return null;
  const marker = parseRetryMarker(value);
  if (marker?.code === PROVIDER_ATTEMPT_STARTED) return "Sending in progress.";
  if (marker) return "Temporary delivery problem. DanceFlow is retrying automatically.";
  if (isUncertainDeliveryOutcome(value)) return UNCERTAIN_DELIVERY_STAFF_TEXT;
  if (value === "provider_retry_window_exhausted_unsent") {
    return "Not delivered: every attempt was refused or never reached the email provider (email sending not configured, credentials rejected, or rate limit reached). It can be retried.";
  }
  return value;
}
