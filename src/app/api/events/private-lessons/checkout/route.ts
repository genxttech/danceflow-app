import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  createClient as createSupabaseClient,
  SupabaseClient,
} from "@supabase/supabase-js";
import { getStripe } from "@/lib/payments/stripe";
import {
  checkRateLimit,
  getIpFromRequest,
  rateLimitKey,
  rateLimitedJson,
} from "@/lib/security/rate-limit";

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function absoluteEventUrl(
  request: NextRequest,
  eventSlug: string,
  query: string,
) {
  return new URL(
    `/events/${encodeURIComponent(eventSlug)}${query}`,
    request.nextUrl.origin,
  ).toString();
}

const ORGANIZER_SUITE_STANDARD_FEE_PERCENT = 0.035;
const ORGANIZER_SUITE_STUDIO_ADDON_FEE_PERCENT = 0.0325;
const ORGANIZER_SUITE_PRO_ADDON_FEE_PERCENT = 0.03;

function normalizePlanCode(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function isActiveBillingStatus(value: string | null | undefined) {
  return value === "active" || value === "trialing";
}

async function studioHasActiveOrganizerSuiteAddOn(
  supabase: SupabaseClient,
  studioId: string,
) {
  const { data, error } = await supabase
    .from("usage_addon_entitlements")
    .select("id")
    .eq("studio_id", studioId)
    .eq("feature_key", "organizer_suite")
    .in("source", ["stripe_subscription_item", "manual_grant"])
    .eq("status", "active")
    .limit(1);

  if (error) {
    console.error("Failed to read Organizer Suite add-on entitlement", error);
    return false;
  }

  return Boolean(data?.length);
}

async function getOrganizerPlatformFeePercent(
  supabase: SupabaseClient,
  studioId: string,
) {
  const { data: subscription, error } = await supabase
    .from("studio_subscriptions")
    .select(
      `
      status,
      subscription_plans (
        code,
        name
      )
    `,
    )
    .eq("studio_id", studioId)
    .maybeSingle();

  if (error) {
    console.error(
      "Failed to read studio subscription for event platform fee",
      error,
    );
    return 0;
  }

  if (!subscription || !isActiveBillingStatus(subscription.status ?? null)) {
    return 0;
  }

  const rawPlan = subscription.subscription_plans;
  const plan = Array.isArray(rawPlan) ? rawPlan[0] : rawPlan;
  const planCode = normalizePlanCode(plan?.code ?? null);

  if (planCode === "organizer") {
    return ORGANIZER_SUITE_STANDARD_FEE_PERCENT;
  }

  if (!["starter", "growth", "pro"].includes(planCode)) {
    return 0;
  }

  const hasOrganizerSuiteAddOn = await studioHasActiveOrganizerSuiteAddOn(
    supabase,
    studioId,
  );
  if (!hasOrganizerSuiteAddOn) {
    return 0;
  }

  return planCode === "pro"
    ? ORGANIZER_SUITE_PRO_ADDON_FEE_PERCENT
    : ORGANIZER_SUITE_STUDIO_ADDON_FEE_PERCENT;
}
function calculateApplicationFeeAmount(amount: number, feePercent: number) {
  return Math.round(
    Math.max(0, Math.round(amount * 100)) * Math.max(0, feePercent),
  );
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("checkout:private-lesson", getIpFromRequest(request)),
    { limit: 6, windowMs: 15 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  const supabase = getSupabaseAdmin();
  const stripe = getStripe();
  const formData = await request.formData();

  const slotId = getString(formData, "slotId");
  const eventSlug = getString(formData, "eventSlug");
  const buyerName = getString(formData, "buyerName");
  const buyerEmail = getString(formData, "buyerEmail").toLowerCase();
  const buyerPhone = getString(formData, "buyerPhone");
  const buyerNotes = getString(formData, "buyerNotes");

  if (!slotId || !eventSlug) {
    return NextResponse.redirect(
      absoluteEventUrl(
        request,
        eventSlug || "",
        "?error=missing_private_lesson_slot",
      ),
    );
  }

  if (!buyerName || !buyerEmail) {
    return NextResponse.redirect(
      absoluteEventUrl(
        request,
        eventSlug,
        "?error=private_lesson_contact_required",
      ),
    );
  }

  const { data: slot, error: slotError } = await supabase
    .from("event_private_lesson_slots")
    .select(
      `
      id,
      event_id,
      coach_id,
      studio_id,
      organizer_id,
      starts_at,
      ends_at,
      price,
      location_label,
      status,
      payment_status,
      events:event_id (
        id,
        name,
        slug,
        status,
        visibility,
        public_directory_enabled,
        studio_id,
        studios:studio_id (
          id,
          name,
          subscription_status,
          stripe_connected_account_id,
          stripe_connect_charges_enabled,
          stripe_connect_payouts_enabled,
          stripe_connect_onboarding_complete
        )
      ),
      event_guest_coaches:coach_id (
        id,
        name
      )
    `,
    )
    .eq("id", slotId)
    .maybeSingle();

  if (slotError || !slot) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=private_lesson_not_found"),
    );
  }

  const event = Array.isArray(slot.events) ? slot.events[0] : slot.events;
  const studio = Array.isArray(event?.studios)
    ? event?.studios[0]
    : event?.studios;
  const coach = Array.isArray(slot.event_guest_coaches)
    ? slot.event_guest_coaches[0]
    : slot.event_guest_coaches;

  const eventIsPublic =
    event?.status === "published" &&
    (event?.visibility === "public" ||
      event?.visibility === "unlisted" ||
      event?.public_directory_enabled === true);
  const studioHasAccess = ["active", "trialing"].includes(
    studio?.subscription_status ?? "",
  );

  if (
    !event ||
    event.slug !== eventSlug ||
    !eventIsPublic ||
    !studioHasAccess
  ) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=private_lesson_unavailable"),
    );
  }

  if (slot.status !== "available" || slot.payment_status !== "unpaid") {
    return NextResponse.redirect(
      absoluteEventUrl(
        request,
        eventSlug,
        "?error=private_lesson_already_booked",
      ),
    );
  }

  const amount = Number(slot.price ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.redirect(
      absoluteEventUrl(
        request,
        eventSlug,
        "?error=private_lesson_invalid_price",
      ),
    );
  }

  if (
    !studio?.stripe_connected_account_id ||
    !studio.stripe_connect_onboarding_complete ||
    !studio.stripe_connect_payouts_enabled ||
    !studio.stripe_connect_charges_enabled
  ) {
    return NextResponse.redirect(
      absoluteEventUrl(request, eventSlug, "?error=studio_payouts_not_ready"),
    );
  }

  const holdToken = randomUUID();
  const holdUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { data: heldSlot, error: holdError } = await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "held",
      payment_status: "pending",
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      buyer_phone: buyerPhone || null,
      buyer_notes: buyerNotes || null,
      held_until: holdUntil,
      hold_token: holdToken,
      updated_at: new Date().toISOString(),
    })
    .eq("id", slot.id)
    .eq("status", "available")
    .eq("payment_status", "unpaid")
    .select("id")
    .maybeSingle();

  if (holdError || !heldSlot) {
    return NextResponse.redirect(
      absoluteEventUrl(
        request,
        eventSlug,
        "?error=private_lesson_already_booked",
      ),
    );
  }

  const feePercent = await getOrganizerPlatformFeePercent(
    supabase,
    slot.studio_id,
  );
  const applicationFeeAmount = calculateApplicationFeeAmount(
    amount,
    feePercent,
  );
  const successUrl = absoluteEventUrl(
    request,
    eventSlug,
    `?success=coach_lesson_booked&slot=${encodeURIComponent(slot.id)}`,
  );
  const cancelUrl = new URL(
    "/api/events/private-lessons/release",
    request.nextUrl.origin,
  );
  cancelUrl.searchParams.set("slotId", slot.id);
  cancelUrl.searchParams.set("eventSlug", eventSlug);
  cancelUrl.searchParams.set("holdToken", holdToken);

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: buyerEmail,
        success_url: successUrl,
        cancel_url: cancelUrl.toString(),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: Math.round(amount * 100),
              product_data: {
                name: `${event.name} — Private Lesson with ${coach?.name ?? "Guest Coach"}`,
                description:
                  slot.location_label || "Guest coach private lesson slot",
              },
            },
          },
        ],
        payment_intent_data: {
          ...(applicationFeeAmount > 0
            ? { application_fee_amount: applicationFeeAmount }
            : {}),
          metadata: {
            source: "event_private_lesson_slot",
            studio_id: slot.studio_id,
            event_id: slot.event_id,
            event_slug: eventSlug,
            slot_id: slot.id,
            coach_id: slot.coach_id,
          },
        },
        metadata: {
          source: "event_private_lesson_slot",
          studio_id: slot.studio_id,
          event_id: slot.event_id,
          event_slug: eventSlug,
          slot_id: slot.id,
          coach_id: slot.coach_id,
          buyer_email: buyerEmail,
        },
      },
      {
        stripeAccount: studio.stripe_connected_account_id,
      },
    );

    const { error: sessionUpdateError } = await supabase
      .from("event_private_lesson_slots")
      .update({
        stripe_checkout_session_id: session.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", slot.id)
      .eq("hold_token", holdToken);

    if (sessionUpdateError) {
      throw new Error(sessionUpdateError.message);
    }

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL.");
    }

    return NextResponse.redirect(session.url, { status: 303 });
  } catch (error) {
    await supabase
      .from("event_private_lesson_slots")
      .update({
        status: "available",
        payment_status: "unpaid",
        stripe_checkout_session_id: null,
        held_until: null,
        hold_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", slot.id)
      .eq("status", "held")
      .eq("hold_token", holdToken);

    const message =
      error instanceof Error ? error.message : "Unknown checkout error";
    console.error("Private lesson checkout failed:", message);
    return NextResponse.redirect(
      absoluteEventUrl(
        request,
        eventSlug,
        "?error=private_lesson_checkout_failed",
      ),
    );
  }
}
