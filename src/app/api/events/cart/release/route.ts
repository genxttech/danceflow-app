import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { normalizeOptionalUuid, normalizeRequiredSlug } from "@/lib/validation/forms";
import { normalizePublicToken, safeTokenEquals } from "@/lib/security/tokens";

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

type EventOrderRow = {
  id: string;
  payment_status: string | null;
  metadata: Record<string, unknown> | null;
};

function eventUrl(request: NextRequest, eventSlug: string, query: string) {
  return new URL(`/events/${encodeURIComponent(eventSlug)}${query}`, request.nextUrl.origin);
}

function fallbackUrl(request: NextRequest, eventSlug: string, query: string) {
  return eventSlug
    ? eventUrl(request, eventSlug, query)
    : new URL(`/discover/events${query}`, request.nextUrl.origin);
}

function getOrderHoldToken(order: EventOrderRow | null) {
  const value = order?.metadata?.holdToken;
  return typeof value === "string" ? value : null;
}

export async function GET(request: NextRequest) {
  const supabase = getSupabaseAdmin();
  const orderIdResult = normalizeOptionalUuid(
    request.nextUrl.searchParams.get("orderId"),
    "Event order",
  );
  const eventSlugResult = normalizeRequiredSlug(
    request.nextUrl.searchParams.get("eventSlug"),
    "Event",
  );
  const holdToken = normalizePublicToken(request.nextUrl.searchParams.get("holdToken"), {
    minLength: 16,
    maxLength: 128,
  });

  const orderId = orderIdResult.ok ? orderIdResult.value : null;
  const eventSlug = eventSlugResult.ok ? eventSlugResult.value : "";

  if (!orderId || !eventSlug || !holdToken) {
    return NextResponse.redirect(fallbackUrl(request, eventSlug, "?error=cart_release_failed"));
  }

  const { data: order } = await supabase
    .from("event_orders")
    .select("id, payment_status, metadata")
    .eq("id", orderId)
    .maybeSingle<EventOrderRow>();

  if (!order || !safeTokenEquals(getOrderHoldToken(order), holdToken)) {
    return NextResponse.redirect(fallbackUrl(request, eventSlug, "?error=cart_release_failed"));
  }

  const { data: competitionCart } = await supabase
    .from("event_competition_registration_carts")
    .select("id")
    .eq("order_id", orderId)
    .maybeSingle();

  const returnPath = competitionCart
    ? `/events/${encodeURIComponent(eventSlug)}/competition/register`
    : `/events/${encodeURIComponent(eventSlug)}`;

  if (order.payment_status === "paid") {
    return NextResponse.redirect(
      new URL(`${returnPath}?success=paid`, request.nextUrl.origin),
    );
  }

  await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "available",
      payment_status: "unpaid",
      buyer_name: null,
      buyer_email: null,
      buyer_phone: null,
      buyer_notes: null,
      order_id: null,
      held_until: null,
      hold_token: null,
      stripe_checkout_session_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("order_id", orderId)
    .eq("hold_token", holdToken)
    .in("status", ["held", "available"]);

  await supabase
    .from("event_registrations")
    .update({
      status: "cancelled",
      payment_status: "failed",
      cancelled_at: new Date().toISOString(),
    })
    .eq("order_id", orderId)
    .eq("status", "pending");

  await supabase
    .from("event_orders")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .neq("payment_status", "paid");

  return NextResponse.redirect(
    new URL(`${returnPath}?error=checkout_cancelled`, request.nextUrl.origin),
  );
}
