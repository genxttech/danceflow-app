import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { encryptIntegrationSecret } from "@/lib/integrations/wave/secrets";
import { exchangeWaveAuthorizationCode, getWaveUserAndBusinesses } from "@/lib/integrations/wave/client";

function settingsRedirect(request: NextRequest, code: string) {
  return NextResponse.redirect(new URL(`/app/settings/integrations/wave?status=${code}`, request.url));
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");
  const rawState = request.cookies.get("wave_oauth_state")?.value;
  let saved: { state: string; studioId: string } | null = null;
  try { saved = rawState ? JSON.parse(rawState) : null; } catch { saved = null; }
  if (error) return settingsRedirect(request, "oauth_denied");
  if (!code || !returnedState || !saved || saved.state !== returnedState || !saved.studioId) return settingsRedirect(request, "invalid_state");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return settingsRedirect(request, "signed_out");
  const { data: mayManage } = await supabase.rpc("can_manage_studio_wave", { target_studio_id: saved.studioId });
  if (!mayManage) return settingsRedirect(request, "forbidden");

  try {
    const tokens = await exchangeWaveAuthorizationCode(code);
    const wave = await getWaveUserAndBusinesses(tokens.access_token);
    const businesses = wave.businesses.edges.map(({ node }) => node);
    const selected = businesses.length === 1 ? businesses[0] : null;
    const admin = createAdminClient();
    const { data: connection, error: connectionError } = await admin.from("studio_wave_connections").upsert({
      studio_id: saved.studioId,
      status: "connected",
      wave_user_id: wave.user.id,
      wave_business_id: selected?.id ?? null,
      wave_business_name: selected?.name ?? null,
      business_currency: selected?.currency?.code ?? null,
      is_classic_accounting: selected?.isClassicAccounting ?? null,
      scopes: tokens.scope?.split(" ").filter(Boolean) ?? [],
      connected_by: user.id,
      connected_at: new Date().toISOString(),
      last_refreshed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "studio_id" }).select("id").single();
    if (connectionError || !connection) throw new Error(connectionError?.message ?? "Connection was not saved.");

    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
    const { error: credentialsError } = await admin.from("studio_wave_credentials").upsert({
      connection_id: connection.id,
      encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
      encrypted_refresh_token: tokens.refresh_token ? encryptIntegrationSecret(tokens.refresh_token) : null,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "connection_id" });
    if (credentialsError) throw new Error(credentialsError.message);

    await admin.from("studio_wave_businesses").delete().eq("connection_id", connection.id);
    if (businesses.length) {
      const { error: businessesError } = await admin.from("studio_wave_businesses").insert(businesses.map((business) => ({
        connection_id: connection.id, studio_id: saved!.studioId, wave_business_id: business.id,
        name: business.name, currency: business.currency?.code ?? null, is_personal: business.isPersonal,
        is_classic_accounting: business.isClassicAccounting, refreshed_at: new Date().toISOString(),
      })));
      if (businessesError) throw new Error(businessesError.message);
    }
    const response = settingsRedirect(request, selected ? "connected" : "select_business");
    response.cookies.delete("wave_oauth_state");
    return response;
  } catch (caught) {
    console.error("Wave OAuth callback failed", caught);
    return settingsRedirect(request, "connection_failed");
  }
}
