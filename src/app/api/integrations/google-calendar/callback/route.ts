import { NextResponse } from "next/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { encryptIntegrationSecret } from "@/lib/integrations/wave/secrets";
import {
  exchangeGoogleCalendarCode,
  getGoogleAccountEmail,
  listGoogleCalendars,
} from "@/lib/integrations/google-calendar/client";

function callbackUrl(request: Request) {
  return new URL("/api/integrations/google-calendar/callback", request.url).toString();
}

function decodeState(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      studioId?: string;
      userId?: string;
      createdAt?: number;
    };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = decodeState(url.searchParams.get("state"));

  if (error) {
    return NextResponse.redirect(new URL(`/app/settings/integrations/google-calendar?error=${encodeURIComponent(error)}`, request.url));
  }

  if (!code || !state?.studioId || !state?.userId) {
    return NextResponse.redirect(new URL("/app/settings/integrations/google-calendar?error=invalid_callback", request.url));
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const context = await getCurrentStudioContext();
  if (context.studioId !== state.studioId || user.id !== state.userId) {
    return NextResponse.redirect(new URL("/app/settings/integrations/google-calendar?error=state_mismatch", request.url));
  }

  const tokens = await exchangeGoogleCalendarCode({ code, redirectUri: callbackUrl(request) });
  const accountEmail = await getGoogleAccountEmail(tokens.access_token);
  const calendars = await listGoogleCalendars(tokens.access_token);
  const primaryCalendar = calendars.find((calendar) => calendar.primary) ?? calendars[0] ?? null;

  const scopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : [];
  const tokenExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const { error: upsertError } = await supabase.from("studio_google_calendar_connections").upsert(
    {
      studio_id: context.studioId,
      status: "connected",
      google_account_email: accountEmail,
      calendar_id: primaryCalendar?.id ?? "primary",
      calendar_summary: primaryCalendar?.summary ?? "Primary calendar",
      scopes,
      encrypted_access_token: encryptIntegrationSecret(tokens.access_token),
      encrypted_refresh_token: tokens.refresh_token ? encryptIntegrationSecret(tokens.refresh_token) : undefined,
      token_expires_at: tokenExpiresAt,
      updated_by: user.id,
      created_by: user.id,
      last_sync_error: null,
    },
    { onConflict: "studio_id" },
  );

  if (upsertError) {
    throw new Error(`Failed to save Google Calendar connection: ${upsertError.message}`);
  }

  return NextResponse.redirect(new URL("/app/settings/integrations/google-calendar?connected=1", request.url));
}
