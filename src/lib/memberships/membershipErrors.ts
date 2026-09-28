/**
 * PAY-DC-2C: membership actions redirect with fixed error codes only. Raw Stripe,
 * database or configuration text never reaches a URL or the UI; server logs carry
 * the code plus a safe classifier (provider error type/code), never the message.
 */

/**
 * A known, user-safe membership failure. `code` is what membership redirects carry;
 * `message` is fixed, human-readable app text (never provider or database text) for
 * callers that surface form-state messages.
 */
export class MembershipActionError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "MembershipActionError";
    this.code = code;
  }
}

export function membershipErrorCode(error: unknown, fallback: string) {
  return error instanceof MembershipActionError ? error.code : fallback;
}

function safeClassifier(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const value = error as { type?: unknown; code?: unknown };
  const type = typeof value.type === "string" ? value.type : null;
  const code = typeof value.code === "string" ? value.code : null;
  return type || code ? { type, code } : null;
}

export function logMembershipActionError(code: string, error: unknown) {
  const classifier = safeClassifier(error);
  if (classifier) {
    console.error(code, classifier);
  } else {
    console.error(code);
  }
}
