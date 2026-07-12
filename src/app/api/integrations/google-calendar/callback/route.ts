import { NextRequest, NextResponse } from "next/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { encryptIntegrationSecret } from "@/lib/integrations/wave/secrets";
import {
  exchangeGoogleCalendarCode,
  getGoogleAccountEmail,
  listGoogleCalendars,
} from "@/lib/integrations/google-calendar/client";
import { isValidOAuthState, parseOAuthStateCookie, safeOAuthErrorCode } from "@/lib/security/oauth";

function appOrigin(request: Request) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    new URL(request.url).origin
  ).replace(/\/$/, "");
}

function callbackUrl(request: Request) {
  return new URL("/api/integrations/google-calendar/callback", appOrigin(request)).toString();
}

function redirectWithClearedState(request: Request, path: string) {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.cookies.delete("google_calendar_oauth_state");
  return response;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirectWithClearedState(
      request,
      `/app/settings/integrations/google-calendar?error=${encodeURIComponent(safeOAuthErrorCode(error))}`,
    );
  }

  if (!code || !returnedState) {
    return redirectWithClearedState(request, "/app/settings/integrations/google-calendar?error=invalid_callback");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return redirectWithClearedState(request, "/login");

  const context = await getCurrentStudioContext();
  const savedState = parseOAuthStateCookie(request.cookies.get("google_calendar_oauth_state")?.value);

  if (!isValidOAuthState({
    expected: savedState,
    returnedState,
    studioId: context.studioId,
    userId: user.id,
  })) {
    return redirectWithClearedState(request, "/app/settings/integrations/google-calendar?error=state_mismatch");
  }

  try {
    const tokens = await exchangeGoogleCalendarCode({ code, redirectUri: callbackUrl(request) });
    const accountEmail = await getGoogleAccountEmail(tokens.access_token);
    const calendars = await listGoogleCalendars(tokens.access_token);
    const primaryCalendar = calendars.find((calendar) => calendar.primary) ?? calendars[0] ?? null;

    const scopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : [];
    const tokenExpiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const payload: Record<string, unknown> = {
      studio_id: context.studioId,
      status: "connected",
      google_account_email: accountEmail,
      calendar_id: primaryCalendar?.id ?? "primary",
      calendar_summary: primaryCalendar?.summary ?? "Primary calendar",
      scopes,
      encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
      token_expires_at: tokenExpiresAt,
      updated_by: user.id,
      created_by: user.id,
      last_sync_error: null,
      updated_at: new Date().toISOString(),
    };

    if (tokens.refresh_token) {
      payload.encrypted_refresh_token = encryptIntegrationSecret(tokens.refresh_token);
    }

    const { error: upsertError } = await supabase.from("studio_google_calendar_connections").upsert(
      payload,
      { onConflict: "studio_id" },
    );

    if (upsertError) {
      throw new Error(upsertError.message);
    }

    return redirectWithClearedState(request, "/app/settings/integrations/google-calendar?connected=1");
  } catch (caught) {
    console.error(
      "Google Calendar OAuth callback failed",
      caught instanceof Error ? caught.message : caught,
    );
    return redirectWithClearedState(request, "/app/settings/integrations/google-calendar?error=connection_failed");
  }
}
