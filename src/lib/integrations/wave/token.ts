import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "./secrets";
import { refreshWaveAccessToken } from "./client";

async function markWaveConnectionNeedsReauth(connectionId: string, message: string) {
  const admin = createAdminClient();
  await admin.from("studio_wave_connections").update({
    status: "needs_reauth",
    posting_enabled: false,
    last_error: message,
    updated_at: new Date().toISOString(),
  }).eq("id", connectionId);
}

export async function getValidWaveAccessToken(connectionId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("studio_wave_credentials")
    .select("encrypted_access_token, encrypted_refresh_token, token_expires_at")
    .eq("connection_id", connectionId).single();
  if (error || !data?.encrypted_access_token) throw new Error("Wave credentials are unavailable. Reconnect Wave.");

  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + 60_000) return decryptIntegrationSecret(data.encrypted_access_token);

  if (!data.encrypted_refresh_token) {
    await markWaveConnectionNeedsReauth(connectionId, "Refresh token missing.");
    throw new Error("Wave authorization expired. Reconnect Wave.");
  }

  let tokens: Awaited<ReturnType<typeof refreshWaveAccessToken>>;
  try {
    tokens = await refreshWaveAccessToken(decryptIntegrationSecret(data.encrypted_refresh_token));
  } catch {
    await markWaveConnectionNeedsReauth(connectionId, "Wave authorization expired. Reconnect Wave.");
    throw new Error("Wave authorization expired. Reconnect Wave.");
  }

  const { error: saveError } = await admin.from("studio_wave_credentials").update({
    encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
    encrypted_refresh_token: tokens.refresh_token ? encryptIntegrationSecret(tokens.refresh_token) : data.encrypted_refresh_token,
    token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("connection_id", connectionId);
  if (saveError) throw new Error("Refreshed Wave credentials could not be saved.");

  await admin.from("studio_wave_connections").update({
    status: "connected",
    last_error: null,
    last_refreshed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", connectionId);

  return tokens.access_token;
}
