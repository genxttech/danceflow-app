import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "./secrets";
import { refreshWaveAccessToken } from "./client";

export async function getValidWaveAccessToken(connectionId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("studio_wave_credentials")
    .select("encrypted_access_token, encrypted_refresh_token, token_expires_at")
    .eq("connection_id", connectionId).single();
  if (error || !data) throw new Error("Wave credentials are unavailable. Reconnect Wave.");

  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + 60_000) return decryptIntegrationSecret(data.encrypted_access_token);
  if (!data.encrypted_refresh_token) throw new Error("Wave authorization expired. Reconnect Wave.");

  const tokens = await refreshWaveAccessToken(decryptIntegrationSecret(data.encrypted_refresh_token));
  const { error: saveError } = await admin.from("studio_wave_credentials").update({
    encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
    encrypted_refresh_token: tokens.refresh_token ? encryptIntegrationSecret(tokens.refresh_token) : data.encrypted_refresh_token,
    token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("connection_id", connectionId);
  if (saveError) throw new Error("Refreshed Wave credentials could not be saved.");
  return tokens.access_token;
}
