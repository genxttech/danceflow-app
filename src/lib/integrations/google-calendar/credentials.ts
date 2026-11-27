import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Google Calendar OAuth token storage (S0-a). Tokens live in studio_google_calendar_credentials (RLS on, no policy, service role only).
 * Requires migration 20270223091000 applied first (SQL before app). Expand phase: reads fall back to the legacy columns on the connections row so a deploy before/without the backfill keeps working;
 * writes go to the credentials table only. After promote, reconcile rows written by the old app in the overlap window (a legacy token that differs from
 * the credentials token is the newer one; a disconnected connection with a null legacy token must not keep a credentials row). The contract migration (clearing legacy columns) is a later, separate step.
 */
export type GoogleCredentialRow = {
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
};

export async function loadGoogleCredentials(admin: SupabaseClient, connectionId: string): Promise<GoogleCredentialRow | null> {
  const { data, error } = await admin
    .from("studio_google_calendar_credentials")
    .select("encrypted_access_token, encrypted_refresh_token, token_expires_at")
    .eq("connection_id", connectionId)
    .maybeSingle<GoogleCredentialRow>();
  if (error) throw new Error(`Failed to load Google Calendar credentials: ${error.message}`);
  if (data?.encrypted_access_token) return data;

  const { data: legacy, error: legacyError } = await admin
    .from("studio_google_calendar_connections")
    .select("encrypted_access_token, encrypted_refresh_token, token_expires_at")
    .eq("id", connectionId)
    .maybeSingle<{ encrypted_access_token: string | null; encrypted_refresh_token: string | null; token_expires_at: string | null }>();
  if (legacyError) throw new Error(`Failed to load Google Calendar credentials: ${legacyError.message}`);
  if (!legacy?.encrypted_access_token) return null;
  return { encrypted_access_token: legacy.encrypted_access_token, encrypted_refresh_token: legacy.encrypted_refresh_token, token_expires_at: legacy.token_expires_at };
}

/** Upsert; a null/undefined refresh token keeps whatever refresh token is already stored (Google omits it on re-consent). */
export async function saveGoogleCredentials(
  admin: SupabaseClient,
  connectionId: string,
  values: { encrypted_access_token: string; encrypted_refresh_token?: string | null; token_expires_at: string | null },
) {
  const row: Record<string, unknown> = {
    connection_id: connectionId,
    encrypted_access_token: values.encrypted_access_token,
    token_expires_at: values.token_expires_at,
  };
  if (values.encrypted_refresh_token) row.encrypted_refresh_token = values.encrypted_refresh_token;
  const { error } = await admin.from("studio_google_calendar_credentials").upsert(row, { onConflict: "connection_id" });
  if (error) throw new Error(`Google Calendar credentials could not be saved: ${error.message}`);
}

/** Removes the credentials row AND clears the legacy columns (disconnect must leave no token anywhere). */
export async function deleteGoogleCredentials(admin: SupabaseClient, connectionId: string) {
  const { error } = await admin.from("studio_google_calendar_credentials").delete().eq("connection_id", connectionId);
  if (error) throw new Error(`Failed to remove Google Calendar credentials: ${error.message}`);
  const { error: legacyError } = await admin
    .from("studio_google_calendar_connections")
    .update({ encrypted_access_token: null, encrypted_refresh_token: null, token_expires_at: null })
    .eq("id", connectionId);
  if (legacyError) throw new Error(`Failed to clear Google Calendar credentials: ${legacyError.message}`);
}
