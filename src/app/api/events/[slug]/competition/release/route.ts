import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { abandonCompetitionRegistration } from "@/lib/competition/registrationCheckout";
import { resolveCompetitionOrderByToken } from "@/lib/competition/registrationToken";
import { competitionRegistrationUrls } from "@/lib/competition/registrationUrls";

/*
  Phase 10C: Stripe Checkout cancel_url. Expires the still-open session (so it can no longer be
  paid), then releases the pending registration through release_competition_registration. A
  session that was already paid is left for the webhook to finalize. The buyer always lands on
  the server-rendered status page.
*/

const competitionRegistrationEnabled =
  process.env.NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED === "true";

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!competitionRegistrationEnabled) return NextResponse.json({ error: "Competition registration is not available." }, { status: 404 });
  const { slug } = await params;
  const admin = createAdminClient();
  const resolved = await resolveCompetitionOrderByToken(admin, { token: request.nextUrl.searchParams.get("token"), eventSlug: slug });
  if (!resolved) return NextResponse.redirect(new URL(`/events/${encodeURIComponent(slug)}`, request.nextUrl.origin), { status: 303 });
  try {
    await abandonCompetitionRegistration({ admin, stripe: getStripe(), orderId: resolved.orderId });
  } catch (error) {
    console.error("comp10c_release_failed", error instanceof Error ? error.message : "unknown");
  }
  const urls = competitionRegistrationUrls(request.nextUrl.origin, resolved.eventSlug, resolved.token);
  return NextResponse.redirect(urls.statusUrl, { status: 303 });
}
