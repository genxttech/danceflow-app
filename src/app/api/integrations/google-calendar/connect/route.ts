import { NextResponse } from "next/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { googleCalendarScopes } from "@/lib/integrations/google-calendar/client";

function clientId() {
  const value = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  if (!value) throw new Error("Missing GOOGLE_CALENDAR_CLIENT_ID.");
  return value;
}

function callbackUrl(request: Request) {
  return new URL("/api/integrations/google-calendar/callback", request.url).toString();
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const context = await getCurrentStudioContext();
  const state = Buffer.from(
    JSON.stringify({ studioId: context.studioId, userId: user.id, createdAt: Date.now() }),
    "utf8",
  ).toString("base64url");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("redirect_uri", callbackUrl(request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", googleCalendarScopes().join(" "));
  url.searchParams.set("state", state);

  return NextResponse.redirect(url);
}
