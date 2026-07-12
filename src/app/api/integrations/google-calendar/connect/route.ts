import { NextResponse } from "next/server";
import { googleCalendarScopes } from "@/lib/integrations/google-calendar/client";
import { getGoogleCalendarAccess, parseGoogleCalendarScope } from "@/lib/integrations/google-calendar/access";
import { createOAuthStateCookieValue, oauthStateCookieOptions } from "@/lib/security/oauth";

function clientId() { const value = process.env.GOOGLE_CALENDAR_CLIENT_ID; if (!value) throw new Error("Missing GOOGLE_CALENDAR_CLIENT_ID."); return value; }
function appOrigin(request: Request) { return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/$/, ""); }
function callbackUrl(request: Request) { return new URL("/api/integrations/google-calendar/callback", appOrigin(request)).toString(); }

export async function GET(request: Request) {
  const scope = parseGoogleCalendarScope(new URL(request.url).searchParams.get("scope"));
  try {
    const access = await getGoogleCalendarAccess(scope);
    const state = createOAuthStateCookieValue({ studioId: access.context.studioId, userId: access.context.userId, connectionScope: scope, instructorId: access.instructorId });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId());
    url.searchParams.set("redirect_uri", callbackUrl(request));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", googleCalendarScopes().join(" "));
    url.searchParams.set("state", state.state);
    const response = NextResponse.redirect(url);
    response.cookies.set("google_calendar_oauth_state", state.cookieValue, oauthStateCookieOptions());
    return response;
  } catch {
    const path = scope === "instructor" ? "/app/settings/integrations/google-calendar/personal?error=not_linked" : "/app/settings/integrations/google-calendar?error=unauthorized";
    return NextResponse.redirect(new URL(path, request.url));
  }
}
