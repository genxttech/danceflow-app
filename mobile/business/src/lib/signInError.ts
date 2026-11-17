/**
 * What a failed password sign-in means to the person. supabase-js reports an unreachable server as AuthRetryableFetchError (status 0) or, from React Native's fetch,
 * "Network request failed"; a refused login is a 400 AuthApiError. Showing "did not match" for the first kind sends someone to retype a correct password
 * (it also hid a dead test server in two device runs).
 */
export type SignInFailure = "unreachable" | "refused";

/** One sentence for every sign-in path (password and email link) when the server cannot be reached. */
export const UNREACHABLE_MESSAGE = "Can't reach DanceFlow. Check your connection and try again.";

export function signInFailureKind(error: unknown): SignInFailure {
  const e = (error ?? {}) as { name?: unknown; status?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  if (e.name === "AuthRetryableFetchError") return "unreachable";
  if (typeof e.status === "number" && (e.status === 0 || e.status >= 500)) return "unreachable";
  if (/network request failed|failed to fetch|network error|timed? ?out|econnrefused/i.test(message)) return "unreachable";
  return "refused";
}
