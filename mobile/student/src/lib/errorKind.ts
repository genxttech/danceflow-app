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
