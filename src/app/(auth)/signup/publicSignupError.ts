/**
 * Public (dancer) signup failures travel back to the form as a fixed code, never as raw error
 * text, so the URL cannot inject a message into the page.
 */
export type PublicSignupErrorCode = "rate_limited" | "send_failed";

const MESSAGES: Record<PublicSignupErrorCode, string> = {
  rate_limited:
    "Too many sign-up attempts for this email. Please wait about 15 minutes and try again.",
  send_failed:
    "We could not send your secure link. Check your name and email, then try again in a moment.",
};

/** Maps a `signupAction` error message to a code (its rate-limit text starts "Too many requests"). */
export function publicSignupErrorCode(message: string): PublicSignupErrorCode {
  return /^too many requests/i.test(message) ? "rate_limited" : "send_failed";
}

/** The message for a code from the URL; unknown values render nothing. */
export function publicSignupErrorMessage(code: string | undefined): string | null {
  return code === "rate_limited" || code === "send_failed" ? MESSAGES[code] : null;
}

/** Where a failed public signup returns: the same form, keeping `next` and `email`. */
export function buildPublicSignupErrorHref(params: {
  code: PublicSignupErrorCode;
  nextPath?: string;
  email?: string;
}) {
  const search = new URLSearchParams({ intent: "public" });
  if (params.nextPath) search.set("next", params.nextPath);
  if (params.email) search.set("email", params.email);
  search.set("error", params.code);
  return `/signup?${search.toString()}`;
}
