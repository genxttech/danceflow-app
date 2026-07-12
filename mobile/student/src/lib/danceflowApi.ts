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

async function getAccessToken() {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) throw error;

  const expiresSoon =
    !session?.expires_at || session.expires_at * 1000 <= Date.now() + 60_000;

  if (session?.access_token && !expiresSoon) {
    return session.access_token;
  }

  const {
    data: { session: refreshedSession },
    error: refreshError,
  } = await supabase.auth.refreshSession();

  if (refreshError || !refreshedSession?.access_token) {
    throw new Error("Your session has expired. Please sign out and sign back in.");
  }

  return refreshedSession.access_token;
}

export async function danceflowApiFetch<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | null | undefined> },
) {
  const token = await getAccessToken();
  const headers = new Headers(options?.headers);

  if (options?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-DanceFlow-Access-Token", token);

  const response = await fetch(buildUrl(path, options?.params), {
    ...options,
    headers,
  });

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