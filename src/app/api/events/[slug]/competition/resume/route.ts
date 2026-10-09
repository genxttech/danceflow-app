import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { beginCompetitionPayment } from "@/lib/competition/registrationCheckout";
import { resolveCompetitionOrderByToken } from "@/lib/competition/registrationToken";
import { competitionRegistrationUrls } from "@/lib/competition/registrationUrls";

/*
  Phase 10C: "Continue to payment" from the status page. Re-enters the same idempotent payment
  step: an open bound session is reused, an expired hold is released, a paid order goes to status.
*/

const competitionRegistrationEnabled =
  process.env.NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED === "true";

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!competitionRegistrationEnabled) return NextResponse.json({ error: "Competition registration is not available." }, { status: 404 });
  const { slug } = await params;
  const admin = createAdminClient();
  const resolved = await resolveCompetitionOrderByToken(admin, { token: request.nextUrl.searchParams.get("token"), eventSlug: slug });
  if (!resolved) return NextResponse.redirect(new URL(`/events/${encodeURIComponent(slug)}`, request.nextUrl.origin), { status: 303 });
  const urls = competitionRegistrationUrls(request.nextUrl.origin, resolved.eventSlug, resolved.token);
  try {
    const step = await beginCompetitionPayment({ admin, stripe: getStripe(), orderId: resolved.orderId, eventName: resolved.eventName, urls });
    return NextResponse.redirect(step.url, { status: 303 });
  } catch (error) {
    console.error("comp10c_resume_failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.redirect(urls.statusUrl, { status: 303 });
  }
}
