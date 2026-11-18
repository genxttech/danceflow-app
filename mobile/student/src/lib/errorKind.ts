/*
  Sorts a failure into the few cases a dancer can act on differently. Screens pass whatever
  message they caught; the error state shows wording and an icon for the kind, so "you're
  offline" never looks the same as "this was removed" or "sign in again".
*/

import { isUserFacingError } from "@/lib/userFacingError";

export type ErrorKind = "offline" | "signedOut" | "forbidden" | "notFound" | "unknown";

const PATTERNS: Array<[ErrorKind, RegExp]> = [
  ["offline", /network request failed|failed to fetch|network ?error|offline|timed? ?out|timeout|econn|enotfound|internet/i],
  ["signedOut", /authentication required|not authenticated|jwt expired|session (has )?expired|sign in again|refresh token|\b401\b/i],
  ["forbidden", /not authori[sz]ed|permission|forbidden|access denied|\b403\b|42501/i],
  ["notFound", /not found|could not be found|no longer available|does not exist|\b404\b/i]
];

export function classifyError(error: unknown): ErrorKind {
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : error == null ? "" : String(error);
  if (!message) return "unknown";
  return PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? "unknown";
}

export const ERROR_COPY: Record<Exclude<ErrorKind, "unknown">, { title: string; detail: string }> = {
  offline: { title: "You're offline", detail: "Check your connection, then try again." },
  signedOut: { title: "Sign in again", detail: "Your session ended. Sign in to pick up where you left off." },
  forbidden: { title: "No access", detail: "This account can't open this. If that seems wrong, ask your studio." },
  notFound: { title: "Not available", detail: "This was moved or removed." }
};

/**
 * The auth server's error CODES (and a 429 status) a dancer can act on, as sentences this app wrote. Keyed by
 * `error.code` / `status` only, never by matching the vendor's message text, so provider wording changes cannot
 * leak through and an unknown code still uses the screen's own fallback.
 */
const RATE_LIMITED = "Too many attempts. Wait a minute and try again.";
const LINK_EXPIRED = "That link has expired. Request a new one.";
const AUTH_CODE_COPY: Record<string, string> = {
  weak_password: "Choose a longer password with a mix of letters and numbers.",
  same_password: "Choose a password you have not used before.",
  otp_expired: LINK_EXPIRED,
  flow_state_expired: LINK_EXPIRED,
  over_request_rate_limit: RATE_LIMITED,
  over_email_send_rate_limit: RATE_LIMITED,
  over_sms_send_rate_limit: RATE_LIMITED,
  email_not_confirmed: "Confirm your email first. Check your inbox for the link, or request a new one.",
  invalid_credentials: "That email or password does not look right. Check it and try again.",
  email_address_invalid: "That email address does not look right. Check it and try again."
};

/** App-authored text for a known auth error code or a 429 status; null for anything else. */
export function authErrorCopy(error: unknown): string | null {
  if (error == null || typeof error !== "object") return null;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(AUTH_CODE_COPY, code)) return AUTH_CODE_COPY[code];
  if (status === 429) return RATE_LIMITED;
  return null;
}

/**
 * One-line text for a screen's inline message. Offline and signed-out failures read the same everywhere
 * ("Network request failed" never reaches a dancer). Any other caught text is shown ONLY when the error is a
 * UserFacingError (wording the app or the DanceFlow web API wrote for people, for example "That time was just
 * taken"); a database error, the payment SDK's message or any other raw Error never renders and the screen's
 * own fallback is used instead.
 */
export function friendlyMessage(error: unknown, fallback: string): string {
  const kind = classifyError(error);
  if (kind === "offline" || kind === "signedOut") return `${ERROR_COPY[kind].title}. ${ERROR_COPY[kind].detail}`;
  if (isUserFacingError(error) && error.message) return error.message;
  return authErrorCopy(error) ?? fallback;
}

/**
 * For a screen whose own wording is the message ("Payment requests could not be loaded"): the cause only
 * replaces it when it is something the dancer must act on differently. A phone with no connection, or an ended
 * session, never reads as "not available", "not found" or a bad credential; any other failure keeps the screen's text
 * (the raw message is not shown).
 */
export function failureMessage(error: unknown, fallback: string): string {
  const kind = classifyError(error);
  if (kind === "offline" || kind === "signedOut") return `${ERROR_COPY[kind].title}. ${ERROR_COPY[kind].detail}`;
  return fallback;
}

/** Sending a sign-in link: separates a bad address, too many requests and no connection from a plain failure. */
export function signInLinkErrorMessage(error: unknown): string {
  const kind = classifyError(error);
  if (kind === "offline") return `${ERROR_COPY.offline.title}. ${ERROR_COPY.offline.detail}`;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const status = (error as { status?: number } | null)?.status;
  if (status === 429 || /rate limit|too many|over_email_send_rate_limit|security purposes/i.test(message)) {
    return "Too many link requests. Wait a minute, then try again.";
  }
  if (/unable to validate email|invalid (email|format)|email address.*invalid|is invalid/i.test(message)) {
    return "That email address does not look right. Check it and try again.";
  }
  return "We could not send that link right now. Try again in a moment.";
}
