import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { studioHasFeature } from "@/lib/billing/access";
import { buildWaveAuthorizationUrl } from "@/lib/integrations/wave/client";

export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) return NextResponse.redirect(new URL("/app", appUrl));
  if (!(await studioHasFeature("wave_accounting"))) return NextResponse.redirect(new URL("/app/settings/billing?feature=wave_accounting", appUrl));

  const state = randomBytes(32).toString("base64url");
  const response = NextResponse.redirect(buildWaveAuthorizationUrl(state));
  response.cookies.set("wave_oauth_state", JSON.stringify({ state, studioId: context.studioId }), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600,
  });
  return response;
}
