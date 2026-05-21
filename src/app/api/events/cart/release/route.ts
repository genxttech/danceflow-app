import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";

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

function eventUrl(request: NextRequest, eventSlug: string, query: string) {
  return new URL(`/events/${encodeURIComponent(eventSlug)}${query}`, request.nextUrl.origin);
}

export async function GET(request: NextRequest) {
  const supabase = getSupabaseAdmin();
  const orderId = request.nextUrl.searchParams.get("orderId") ?? "";
  const eventSlug = request.nextUrl.searchParams.get("eventSlug") ?? "";

  if (!orderId || !eventSlug) {
    return NextResponse.redirect(eventUrl(request, eventSlug, "?error=cart_release_failed"));
  }

  const { data: order } = await supabase
    .from("event_orders")
    .select("id, payment_status")
    .eq("id", orderId)
    .maybeSingle();

  if (!order || order.payment_status === "paid") {
    return NextResponse.redirect(eventUrl(request, eventSlug, order?.payment_status === "paid" ? "?success=cart_paid" : "?error=cart_release_failed"));
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
      payment_status: "failed",
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .neq("payment_status", "paid");

  return NextResponse.redirect(eventUrl(request, eventSlug, "?error=checkout_cancelled"));
}
