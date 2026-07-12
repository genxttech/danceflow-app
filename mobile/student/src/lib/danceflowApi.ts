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

  if (session?.access_token) {
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
  options?: RequestInit & { params?: Record<string, string | null | undefined> }
) {
  const token = await getAccessToken();
  const response = await fetch(buildUrl(path, options?.params), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-DanceFlow-Access-Token": token,
      ...options?.headers,
    },
  });

  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "DanceFlow request failed.");
  }

  return payload;
}
