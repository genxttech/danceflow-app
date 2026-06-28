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
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "DanceFlow request failed.");
  }

  return payload;
}
