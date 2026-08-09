import type { SupabaseClient } from "@supabase/supabase-js";

export type AriaDigestType = "morning" | "end_of_day";

export type AriaDigestLifecycleStage =
  | "run_started"
  | "run_duplicate"
  | "run_skipped"
  | "run_prepared"
  | "run_queued"
  | "run_sent"
  | "run_retry_scheduled"
  | "run_terminal";

export interface AriaDigestLifecycleEvent {
  stage: AriaDigestLifecycleStage;
  studioId: string;
  digestType: AriaDigestType;
  digestDate: string;
  runId?: string | null;
  deliveryChannel?: "email" | "in_app" | null;
  retryCount?: number | null;
}

/**
 * Structured, redacted lifecycle logging for the ARIA digest pipeline.
 * Only identifiers and counters are logged — never recipient emails,
 * digest bodies, or delivery payloads.
 */
export function logAriaDigestLifecycleEvent(event: AriaDigestLifecycleEvent): void {
  console.log("[aria_digest]", {
    stage: event.stage,
    studio_id: event.studioId,
    digest_type: event.digestType,
    digest_date: event.digestDate,
    run_id: event.runId ?? null,
    delivery_channel: event.deliveryChannel ?? null,
    retry_count: event.retryCount ?? null,
  });
}

const MIN_GENERIC_SECRET_LENGTH = 20;

function isHighEntropySecretCandidate(token: string): boolean {
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

type RedactionReplacement = string | ((match: string) => string);

const REDACTION_PATTERNS: Array<[RegExp, RedactionReplacement]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  [/\b(bearer|basic)\s+[a-z0-9._-]+/gi, "[redacted-authorization]"],
  [/\b(sk|pk|re|rk)_[a-z0-9]{10,}\b/gi, "[redacted-api-key]"],
  // JWT-shaped: header.payload.signature, each segment base64url.
  [/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]"],
  [/\b[a-f0-9]{32,}\b/gi, "[redacted-token]"],
  // Generic high-entropy base64/base64url-looking secret: long enough that
  // it's unlikely to be ordinary prose, and only redacted when it mixes
  // letters and digits so plain words/short identifiers are left alone.
  [
    new RegExp(`\\b[A-Za-z0-9+/_-]{${MIN_GENERIC_SECRET_LENGTH},}={0,2}\\b`, "g"),
    (match) => (isHighEntropySecretCandidate(match) ? "[redacted-secret]" : match),
  ],
];

/** Strips emails, auth headers, API keys, JWTs, and high-entropy secrets from free-text error messages. */
export function redactSensitiveText(value: string): string {
  return REDACTION_PATTERNS.reduce((text, [pattern, replacement]) => {
    if (typeof replacement === "string") {
      return text.replace(pattern, replacement);
    }
    return text.replace(pattern, (match) => replacement(match));
  }, value);
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

export function sanitizeAriaDigestError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitiveText(rawMessage);

  return {
    name,
    message:
      redacted.length > MAX_ERROR_MESSAGE_LENGTH
        ? `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
        : redacted,
  };
}

/** Logs a digest failure with a sanitized error message — never the raw error/payload. */
export function logAriaDigestError(
  context: Omit<AriaDigestLifecycleEvent, "stage">,
  error: unknown,
): void {
  const sanitized = sanitizeAriaDigestError(error);
  console.error("[aria_digest]", {
    stage: "run_failed",
    studio_id: context.studioId,
    digest_type: context.digestType,
    digest_date: context.digestDate,
    run_id: context.runId ?? null,
    delivery_channel: context.deliveryChannel ?? null,
    retry_count: context.retryCount ?? null,
    error_name: sanitized.name,
    error_message: sanitized.message,
  });
}

export type AriaDigestFailureClassification = "retry" | "terminal";

export const MAX_ARIA_DIGEST_RETRY_ATTEMPTS = 3;

/**
 * Mirrors the eligibility rule used by requeueFailedAriaDigestDeliveries:
 * a run can only ever be retried once it has a delivery_id, and only while
 * retry_count is below the max. Anything else is terminal.
 */
export function classifyAriaDigestFailure(params: {
  retryCount: number;
  hasDeliveryId: boolean;
}): AriaDigestFailureClassification {
  if (!params.hasDeliveryId) return "terminal";
  return params.retryCount >= MAX_ARIA_DIGEST_RETRY_ATTEMPTS ? "terminal" : "retry";
}

const ARIA_DIGEST_ALERT_SOURCE = "aria_digest";

function buildTerminalAlertDedupeKey(runId: string): string {
  return `aria_digest_terminal:${runId}`;
}

export interface TerminalAriaDigestAlertParams {
  runId: string;
  studioId: string;
  digestType: AriaDigestType;
  digestDate: string;
  deliveryId?: string | null;
  retryCount: number;
  error: unknown;
}

export interface TerminalAriaDigestAlertResult {
  alerted: boolean;
  deduped: boolean;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * Records a terminal ARIA digest failure through platform_error_logs.
 *
 * Deduplication is enforced by a partial unique index on
 * platform_error_logs (source = 'aria_digest', details->>'dedupe_key') —
 * see migration 20260808060000_aria_digest_terminal_alert_dedupe.sql — not
 * by an application-level check-then-insert, which would be race-prone
 * under concurrent cron/dispatch workers. A 23505 unique-violation on
 * insert is therefore an expected, successful dedup outcome, not an
 * operational error. The index is not conditioned on resolved_at, so a
 * later alert for the same run is blocked even after the original alert
 * has been resolved.
 */
export async function recordTerminalAriaDigestFailure(
  supabase: SupabaseClient,
  params: TerminalAriaDigestAlertParams,
): Promise<TerminalAriaDigestAlertResult> {
  const dedupeKey = buildTerminalAlertDedupeKey(params.runId);
  const sanitized = sanitizeAriaDigestError(params.error);

  const { error: insertError } = await supabase.from("platform_error_logs").insert({
    severity: "critical",
    source: ARIA_DIGEST_ALERT_SOURCE,
    message: `ARIA digest delivery failed permanently after ${params.retryCount} retries (${sanitized.message})`,
    details: {
      dedupe_key: dedupeKey,
      studio_id: params.studioId,
      digest_type: params.digestType,
      digest_date: params.digestDate,
      run_id: params.runId,
      delivery_id: params.deliveryId ?? null,
      retry_count: params.retryCount,
      error_name: sanitized.name,
      error_message: sanitized.message,
    },
  });

  if (!insertError) {
    return { alerted: true, deduped: false };
  }

  if (insertError.code === POSTGRES_UNIQUE_VIOLATION) {
    return { alerted: false, deduped: true };
  }

  console.warn("[aria_digest] Failed to record a terminal digest alert", {
    run_id: params.runId,
    error: insertError.message,
  });
  return { alerted: false, deduped: false };
}
