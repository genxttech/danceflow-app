/*
  Sorts a failure into the few cases a dancer can act on differently. Screens pass whatever
  message they caught; the error state shows wording and an icon for the kind, so "you're
  offline" never looks the same as "this was removed" or "sign in again".
*/

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
 * One-line text for a screen's inline message. Offline and signed-out failures read the same everywhere
 * ("Network request failed" never reaches a dancer); any other caught message is kept, since the server's
 * own wording (for example "That time was just taken") is meaningful; no message falls back to the screen's text.
 */
export function friendlyMessage(error: unknown, fallback: string): string {
  const kind = classifyError(error);
  if (kind === "offline" || kind === "signedOut") return `${ERROR_COPY[kind].title}. ${ERROR_COPY[kind].detail}`;
  return error instanceof Error && error.message ? error.message : fallback;
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
