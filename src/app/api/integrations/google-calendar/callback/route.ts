import { NextRequest, NextResponse } from "next/server";
import { encryptIntegrationSecret } from "@/lib/integrations/wave/secrets";
import { exchangeGoogleCalendarCode, getGoogleAccountEmail, listGoogleCalendars } from "@/lib/integrations/google-calendar/client";
import { getGoogleCalendarAccess, googleCalendarReturnPath } from "@/lib/integrations/google-calendar/access";
import { isValidOAuthState, parseOAuthStateCookie, safeOAuthErrorCode } from "@/lib/security/oauth";

function appOrigin(request: Request) { return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, ""); }
function callbackUrl(request: Request) { return new URL("/api/integrations/google-calendar/callback", appOrigin(request)).toString(); }
function redirectWithClearedState(request: Request, path: string) { const response = NextResponse.redirect(new URL(path, request.url)); response.cookies.delete("google_calendar_oauth_state"); return response; }

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const savedState = parseOAuthStateCookie(request.cookies.get("google_calendar_oauth_state")?.value);
  const scope = savedState?.connectionScope ?? "studio";
  const returnPath = googleCalendarReturnPath(scope);
  const providerError = url.searchParams.get("error");
  if (providerError) return redirectWithClearedState(request, `${returnPath}?error=${encodeURIComponent(safeOAuthErrorCode(providerError))}`);
  if (!code || !returnedState || !savedState) return redirectWithClearedState(request, `${returnPath}?error=invalid_callback`);

  try {
    const access = await getGoogleCalendarAccess(scope);
    if (!isValidOAuthState({ expected: savedState, returnedState, studioId: access.context.studioId, userId: access.context.userId })) {
      return redirectWithClearedState(request, `${returnPath}?error=state_mismatch`);
    }
    if (scope === "instructor" && savedState.instructorId !== access.instructorId) {
      return redirectWithClearedState(request, `${returnPath}?error=instructor_mismatch`);
    }
    const tokens = await exchangeGoogleCalendarCode({ code, redirectUri: callbackUrl(request) });
    const accountEmail = await getGoogleAccountEmail(tokens.access_token);
    const calendars = await listGoogleCalendars(tokens.access_token);
    const primaryCalendar = calendars.find((calendar) => calendar.primary) ?? calendars[0] ?? null;
    const payload: Record<string, unknown> = {
      studio_id: access.context.studioId,
      connection_scope: scope,
      instructor_id: access.instructorId,
      connected_user_id: access.context.userId,
      status: "connected",
      google_account_email: accountEmail,
      calendar_id: primaryCalendar?.id ?? "primary",
      calendar_summary: primaryCalendar?.summary ?? "Primary calendar",
      scopes: tokens.scope ? tokens.scope.split(" ").filter(Boolean) : [],
      encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
      token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
      updated_by: access.context.userId,
      created_by: access.context.userId,
      last_sync_error: null,
    };
    if (tokens.refresh_token) payload.encrypted_refresh_token = encryptIntegrationSecret(tokens.refresh_token);

    let existingQuery = access.supabase
      .from("studio_google_calendar_connections")
      .select("id")
      .eq("studio_id", access.context.studioId)
      .eq("connection_scope", scope);
    existingQuery = scope === "instructor"
      ? existingQuery.eq("instructor_id", access.instructorId)
      : existingQuery.is("instructor_id", null);
    const { data: existing, error: existingError } = await existingQuery.maybeSingle<{ id: string }>();
    if (existingError) throw new Error(existingError.message);

    const { error } = existing
      ? await access.supabase
          .from("studio_google_calendar_connections")
          .update(payload)
          .eq("id", existing.id)
      : await access.supabase
          .from("studio_google_calendar_connections")
          .insert(payload);
    if (error) throw new Error(error.message);
    return redirectWithClearedState(request, `${returnPath}?connected=1`);
  } catch (error) {
    console.error("Google Calendar OAuth callback failed", error instanceof Error ? error.message : error);
    return redirectWithClearedState(request, `${returnPath}?error=connection_failed`);
  }
}
