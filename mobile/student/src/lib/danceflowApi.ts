import { supabase } from "@/lib/supabase";

const webUrl = process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL;

if (!webUrl) {
  throw new Error("Missing EXPO_PUBLIC_DANCEFLOW_WEB_URL");
}

function buildUrl(path: string, params?: Record<string, string | null | undefined>) {
  const url = new URL(path, webUrl);

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Sign in again to continue.";

/** A network failure is not an expired session: only a refusal from the auth server ends the session. */
function isRefreshRefusal(error: { status?: number; name?: string; message?: string } | null) {
  if (!error) return true;
  if (error.name === "AuthRetryableFetchError") return false;
  if (typeof error.status === "number") return error.status >= 400 && error.status < 500;

  return !/network|fetch|timeout/i.test(error.message ?? "");
}

/**
 * Ends a session the server no longer accepts. Clearing it makes AuthProvider's state change
 * (SIGNED_OUT) send the dancer to sign-in, instead of leaving every screen showing an error.
 */
async function endExpiredSession(): Promise<never> {
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  throw new Error(SESSION_EXPIRED_MESSAGE);
}

async function getAccessToken(forceRefresh = false) {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) throw error;

  const expiresSoon =
    !session?.expires_at || session.expires_at * 1000 <= Date.now() + 60_000;

  if (session?.access_token && !expiresSoon && !forceRefresh) {
    return session.access_token;
  }

  const {
    data: { session: refreshedSession },
    error: refreshError,
  } = await supabase.auth.refreshSession();

  if (refreshError && !isRefreshRefusal(refreshError)) {
    throw new Error("We could not reach DanceFlow. Check your connection and try again.");
  }
  if (refreshError || !refreshedSession?.access_token) {
    return endExpiredSession();
  }

  return refreshedSession.access_token;
}

export async function danceflowApiFetch<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | null | undefined> },
) {
  const send = (token: string) => {
    const headers = new Headers(options?.headers);

    if (options?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-DanceFlow-Access-Token", token);

    return fetch(buildUrl(path, options?.params), { ...options, headers });
  };

  let response = await send(await getAccessToken());

  // The server refused a token the device still believed was valid (revoked, rotated, clock skew):
  // refresh once and retry, then treat a second refusal as an expired session.
  if (response.status === 401) {
    response = await send(await getAccessToken(true));
    if (response.status === 401) return endExpiredSession();
  }

  const responseText = await response.text();
  let payload: (T & { error?: string }) | null = null;

  if (responseText) {
    try {
      payload = JSON.parse(responseText) as T & { error?: string };
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error ?? "DanceFlow request failed. Please try again.");
  }

  if (!payload) {
    throw new Error("DanceFlow returned an unexpected response. Please try again.");
  }

  return payload;
}