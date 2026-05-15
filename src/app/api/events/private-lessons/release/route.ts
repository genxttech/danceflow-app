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

export async function GET(request: NextRequest) {
  const supabase = getSupabaseAdmin();
  const slotId = request.nextUrl.searchParams.get("slotId") || "";
  const eventSlug = request.nextUrl.searchParams.get("eventSlug") || "";

  if (slotId) {
    await supabase
      .from("event_private_lesson_slots")
      .update({
        status: "available",
        payment_status: "unpaid",
        stripe_checkout_session_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", slotId)
      .eq("status", "held")
      .eq("payment_status", "pending");
  }

  const redirectTo = eventSlug
    ? `/events/${encodeURIComponent(eventSlug)}?error=private_lesson_checkout_cancelled`
    : "/discover/events?error=private_lesson_checkout_cancelled";

  return NextResponse.redirect(new URL(redirectTo, request.nextUrl.origin));
}
