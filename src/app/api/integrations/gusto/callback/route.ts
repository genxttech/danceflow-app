import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  encryptIntegrationSecret,
} from "@/lib/integrations/wave/secrets";
import {
  exchangeGustoAuthorizationCode,
  getGustoCompany,
  getGustoTokenInfo,
  gustoCompanyUuid,
  gustoEnvironment,
  normalizedGustoScopes,
} from "@/lib/integrations/gusto/client";
import {
  isValidOAuthState,
  parseOAuthStateCookie,
  safeOAuthErrorCode,
} from "@/lib/security/oauth";

function settingsRedirect(request: NextRequest, code: string) {
  const response = NextResponse.redirect(
    new URL(
      `/app/settings/integrations/gusto?status=${safeOAuthErrorCode(code)}`,
      request.url,
    ),
  );
  response.cookies.delete("gusto_oauth_state");
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  const oauthError = request.nextUrl.searchParams.get("error");
  const saved = parseOAuthStateCookie(
    request.cookies.get("gusto_oauth_state")?.value,
  );

  if (oauthError) return settingsRedirect(request, "oauth_denied");
  if (!code || !returnedState || !saved) {
    return settingsRedirect(request, "invalid_state");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return settingsRedirect(request, "signed_out");

  if (
    !isValidOAuthState({
      expected: saved,
      returnedState,
      studioId: saved.studioId,
      userId: user.id,
    })
  ) {
    return settingsRedirect(request, "invalid_state");
  }

  const { data: mayManage } = await supabase.rpc(
    "can_manage_studio_gusto",
    { target_studio_id: saved.studioId },
  );
  if (!mayManage) return settingsRedirect(request, "forbidden");

  const admin = createAdminClient();
  let auditConnectionId: string | null = null;

  try {
    const tokens = await exchangeGustoAuthorizationCode(code);
    const info = await getGustoTokenInfo(tokens.access_token);
    const companyUuid = gustoCompanyUuid(tokens, info);

    if (!companyUuid) {
      throw new Error(
        "Gusto did not return a single company-scoped access token.",
      );
    }

    const company = await getGustoCompany(
      tokens.access_token,
      companyUuid,
    );
    const now = new Date().toISOString();

    const { data: connection, error: connectionError } = await admin
      .from("studio_gusto_connections")
      .upsert(
        {
          studio_id: saved.studioId,
          status: "connected",
          environment: gustoEnvironment(),
          gusto_company_uuid: companyUuid,
          gusto_company_name: company.trade_name || company.name,
          scopes: normalizedGustoScopes(tokens, info),
          connected_by: user.id,
          connected_at: now,
          disconnected_at: null,
          last_health_check_at: now,
          last_health_status: "healthy",
          last_error: null,
          updated_at: now,
        },
        { onConflict: "studio_id" },
      )
      .select("id")
      .single<{ id: string }>();

    if (connectionError || !connection) {
      throw new Error(
        connectionError?.message ?? "Gusto connection was not saved.",
      );
    }

    auditConnectionId = connection.id;
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const { error: credentialsError } = await admin
      .from("studio_gusto_credentials")
      .upsert(
        {
          connection_id: connection.id,
          encrypted_access_token: encryptIntegrationSecret(
            tokens.access_token,
          ),
          encrypted_refresh_token: tokens.refresh_token
            ? encryptIntegrationSecret(tokens.refresh_token)
            : null,
          token_expires_at: expiresAt,
          updated_at: now,
        },
        { onConflict: "connection_id" },
      );

    if (credentialsError) {
      throw new Error(credentialsError.message);
    }

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: saved.studioId,
      connection_id: connection.id,
      event_type: "oauth_connection",
      outcome: "succeeded",
      actor_user_id: user.id,
      details: {
        environment: gustoEnvironment(),
        companyUuid,
      },
    });

    return settingsRedirect(request, "connected");
  } catch (caught) {
    const message =
      caught instanceof Error
        ? caught.message
        : "Gusto could not be connected.";

    await admin.from("studio_gusto_audit_events").insert({
      studio_id: saved.studioId,
      connection_id: auditConnectionId,
      event_type: "oauth_connection",
      outcome: "failed",
      actor_user_id: user.id,
      details: { error: message },
    });

    console.error("Gusto OAuth callback failed", message);
    return settingsRedirect(request, "connection_failed");
  }
}
