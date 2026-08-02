import { NextResponse } from "next/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { buildGustoAuthorizationUrl } from "@/lib/integrations/gusto/client";
import {
  createOAuthStateCookieValue,
  oauthStateCookieOptions,
} from "@/lib/security/oauth";

export async function GET(request: Request) {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", appUrl));
  }

  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) {
    return NextResponse.redirect(new URL("/app", appUrl));
  }

  const state = createOAuthStateCookieValue({
    studioId: context.studioId,
    userId: user.id,
  });
  const response = NextResponse.redirect(
    buildGustoAuthorizationUrl(state.state),
  );
  response.cookies.set(
    "gusto_oauth_state",
    state.cookieValue,
    oauthStateCookieOptions(),
  );
  return response;
}
