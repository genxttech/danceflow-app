import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { beginEventSigningCheckpoint } from "@/lib/documents/event-signing";
import {
  beginCompetitionPayment,
  CompetitionRegistrationError,
  isUuid,
  quoteCompetitionRegistration,
  startCompetitionRegistration,
} from "@/lib/competition/registrationCheckout";
import { competitionRegistrationUrls } from "@/lib/competition/registrationUrls";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

/*
  Phase 10C: public competition registration checkout.

  This route only gates (feature flag, rate limit), identifies the caller from the server-verified
  session and sequences the lifecycle. Everything that decides WHAT is registered and WHAT it costs
  happens inside start_competition_registration (one transaction, idempotent per clientRequestId,
  database-computed price). No registration row is written here; no client total is read; required
  documents go through the Phase 8 signing checkpoint before payment.
*/

const competitionRegistrationEnabled =
  process.env.NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED === "true";

function errorJson(error: unknown) {
  if (error instanceof CompetitionRegistrationError) {
    return NextResponse.json({ error: error.message, code: error.code, errors: error.details }, { status: error.status });
  }
  console.error("comp10c_checkout_failed", error instanceof Error ? error.message : "unknown");
  return NextResponse.json({ error: "Competition checkout could not be started.", code: "checkout_failed" }, { status: 500 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!competitionRegistrationEnabled) {
    return NextResponse.json({ error: "Competition registration is not available." }, { status: 404 });
  }

  const rateLimit = checkRateLimit(rateLimitKey("checkout:competition", getIpFromRequest(request)), { limit: 10, windowMs: 15 * 60 * 1000 });
  if (!rateLimit.allowed) return rateLimitedJson(rateLimit);

  const { slug } = await params;
  let body: { clientRequestId?: unknown; draft?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Registration details are required." }, { status: 400 });
  }
  if (!isUuid(body.clientRequestId)) return NextResponse.json({ error: "A registration request id is required.", code: "invalid" }, { status: 400 });
  if (!body.draft || typeof body.draft !== "object" || Array.isArray(body.draft)) {
    return NextResponse.json({ error: "Registration details are required.", code: "invalid" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const { data: event } = await admin
      .from("events")
      .select("id, slug, name, studio_id, organizer_id")
      .eq("slug", slug)
      .maybeSingle();
    if (!event) return NextResponse.json({ error: "Competition registration is unavailable." }, { status: 404 });

    // Server-verified actor (never a client-supplied id). Anonymous is allowed where the event allows it;
    // the database refuses account-required events and "this is me" without a verified account.
    const sessionClient = await createClient();
    const { data: { user } } = await sessionClient.auth.getUser();

    // UX pre-check only: never create a paid hold that cannot be paid. start re-prices authoritatively.
    const preview = await quoteCompetitionRegistration(admin, { eventId: event.id, draft: body.draft });
    if (preview?.valid && Number(preview.total_cents) > 0) {
      const { data: studio } = await admin
        .from("studios")
        .select("stripe_connected_account_id, stripe_connect_onboarding_complete, stripe_connect_charges_enabled, stripe_connect_payouts_enabled")
        .eq("id", event.studio_id)
        .maybeSingle();
      if (!studio?.stripe_connected_account_id || !studio.stripe_connect_onboarding_complete || !studio.stripe_connect_charges_enabled || !studio.stripe_connect_payouts_enabled) {
        return NextResponse.json({ error: "Online payments are not enabled for this event.", code: "payment_not_ready" }, { status: 409 });
      }
    }

    const started = await startCompetitionRegistration(admin, {
      eventId: event.id,
      clientRequestId: body.clientRequestId,
      draft: body.draft,
      actorUserId: user?.id ?? null,
    });
    const urls = competitionRegistrationUrls(request.nextUrl.origin, event.slug, started.cart_token);

    if (started.order_status === "confirmed" || ["expired", "cancelled"].includes(started.order_status)) {
      return NextResponse.json({ url: urls.statusUrl, orderId: started.order_id });
    }

    if (started.requires_signing) {
      const { data: checkpoint } = await admin
        .from("event_signing_checkpoints")
        .select("status")
        .eq("order_id", started.order_id)
        .maybeSingle();
      if (!checkpoint) {
        const { data: requirements, error: requirementError } = await admin
          .from("event_document_requirements")
          .select("id")
          .eq("event_id", event.id)
          .eq("active", true)
          .eq("is_required", true)
          .order("created_at");
        if (requirementError) throw new Error("Required documents could not be loaded.");
        const signing = await beginEventSigningCheckpoint({
          orderId: started.order_id,
          eventId: event.id,
          studioId: event.studio_id,
          organizerId: event.organizer_id,
          userId: user?.id ?? null,
          buyerEmail: String((body.draft as { buyerEmail?: unknown }).buyerEmail ?? "").trim().toLowerCase(),
          requirementIds: (requirements ?? []).map((row) => row.id as string),
          registrationIds: [started.registration_id],
          surface: "web",
          paymentMode: "checkout",
        });
        if (signing?.signingUrl) return NextResponse.json({ url: signing.signingUrl, orderId: started.order_id, signing: true });
      } else if (checkpoint.status === "signing") {
        return NextResponse.json({
          error: "Signing has already started for this registration. Continue in the secure signing link, or start a new registration.",
          code: "signing_in_progress",
        }, { status: 409 });
      }
    }

    const step = await beginCompetitionPayment({
      admin,
      stripe: getStripe(),
      orderId: started.order_id,
      eventName: event.name,
      urls,
    });
    return NextResponse.json({ url: step.url, orderId: started.order_id });
  } catch (error) {
    return errorJson(error);
  }
}
