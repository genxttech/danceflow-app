import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
} from "@/lib/integrations/wave/secrets";
import { refreshGustoAccessToken } from "./client";

async function markGustoNeedsReauth(
  connectionId: string,
  message: string,
) {
  const admin = createAdminClient();
  await admin
    .from("studio_gusto_connections")
    .update({
      status: "needs_reauth",
      last_health_status: "failed",
      last_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);
}

export async function getValidGustoAccessToken(connectionId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studio_gusto_credentials")
    .select(
      "encrypted_access_token, encrypted_refresh_token, token_expires_at",
    )
    .eq("connection_id", connectionId)
    .single();

  if (error || !data?.encrypted_access_token) {
    throw new Error("Gusto credentials are unavailable. Reconnect Gusto.");
  }

  const expiresAt = data.token_expires_at
    ? new Date(data.token_expires_at).getTime()
    : Number.POSITIVE_INFINITY;

  if (expiresAt > Date.now() + 60_000) {
    return decryptIntegrationSecret(data.encrypted_access_token);
  }

  if (!data.encrypted_refresh_token) {
    await markGustoNeedsReauth(connectionId, "Refresh token missing.");
    throw new Error("Gusto authorization expired. Reconnect Gusto.");
  }

  try {
    const tokens = await refreshGustoAccessToken(
      decryptIntegrationSecret(data.encrypted_refresh_token),
    );

    const { error: saveError } = await admin
      .from("studio_gusto_credentials")
      .update({
        encrypted_access_token: encryptIntegrationSecret(
          tokens.access_token,
        ),
        encrypted_refresh_token: tokens.refresh_token
          ? encryptIntegrationSecret(tokens.refresh_token)
          : data.encrypted_refresh_token,
        token_expires_at: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      })
      .eq("connection_id", connectionId);

    if (saveError) {
      throw new Error("Refreshed Gusto credentials could not be saved.");
    }

    await admin
      .from("studio_gusto_connections")
      .update({
        status: "connected",
        last_health_check_at: new Date().toISOString(),
        last_health_status: "healthy",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);

    return tokens.access_token;
  } catch {
    await markGustoNeedsReauth(
      connectionId,
      "Gusto authorization expired. Reconnect Gusto.",
    );
    throw new Error("Gusto authorization expired. Reconnect Gusto.");
  }
}
