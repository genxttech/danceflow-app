import { NextResponse } from "next/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { studioHasFeature } from "@/lib/billing/access";
import { createClient } from "@/lib/supabase/server";
import { buildWaveAuthorizationUrl } from "@/lib/integrations/wave/client";
import { createOAuthStateCookieValue, oauthStateCookieOptions } from "@/lib/security/oauth";

export async function GET(request: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL("/login", appUrl));

  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) return NextResponse.redirect(new URL("/app", appUrl));
  if (!(await studioHasFeature("wave_accounting"))) return NextResponse.redirect(new URL("/app/settings/billing?feature=wave_accounting", appUrl));

  const state = createOAuthStateCookieValue({ studioId: context.studioId, userId: user.id });
  const response = NextResponse.redirect(buildWaveAuthorizationUrl(state.state));
  response.cookies.set("wave_oauth_state", state.cookieValue, oauthStateCookieOptions());
  return response;
}
