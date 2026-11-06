// Secret redaction for everything the proof prints or records (plan section 9). Applied to every transcript line and error message.

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, "[REDACTED_KEY]"],
  [/\bwhsec_[A-Za-z0-9]+/g, "[REDACTED_WHSEC]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bAuthorization\s*[:=]\s*\S+(?:\s+\S+)?/gi, "Authorization: [REDACTED]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
];

export function redactText(s: string): string {
  return PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

/** Idempotency keys are masked to their first 12 characters in shared copies. */
export function maskIdempotencyKey(k: string | undefined): string {
  if (!k) return "-";
  return k.length <= 12 ? k : `${k.slice(0, 12)}…(${k.length})`;
}

/** The only response fields that ever reach the transcript; everything else in a Stripe body is dropped. */
export function summarizeBody(json: Record<string, unknown> | null): Record<string, unknown> {
  if (!json) return {};
  const out: Record<string, unknown> = {};
  for (const k of ["id", "object", "livemode", "status", "total", "deleted"] as const) {
    if (k in json) out[k] = json[k];
  }
  const err = json.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    out.error = { type: e.type, code: e.code };
  }
  if (Array.isArray(json.data)) out.data_count = json.data.length;
  return out;
}

/** True when any env value looks like a live key; used by the environment check without ever printing the value. */
export function looksLikeLiveSecret(v: string): boolean {
  return /\b(?:sk|rk)_live_[A-Za-z0-9]+/.test(v);
}
