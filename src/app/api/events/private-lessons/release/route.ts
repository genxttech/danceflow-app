import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { normalizeOptionalUuid, normalizeRequiredSlug } from "@/lib/validation/forms";
import { normalizePublicToken } from "@/lib/security/tokens";

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
  const slotIdResult = normalizeOptionalUuid(request.nextUrl.searchParams.get("slotId"), "Private lesson slot");
  const eventSlugResult = normalizeRequiredSlug(request.nextUrl.searchParams.get("eventSlug"), "Event");
  const holdToken = normalizePublicToken(request.nextUrl.searchParams.get("holdToken"), {
    minLength: 16,
    maxLength: 128,
  });

  const slotId = slotIdResult.ok ? slotIdResult.value : null;
  const eventSlug = eventSlugResult.ok ? eventSlugResult.value : null;

  if (slotId && holdToken) {
    await supabase
      .from("event_private_lesson_slots")
      .update({
        status: "available",
        payment_status: "unpaid",
        stripe_checkout_session_id: null,
        buyer_name: null,
        buyer_email: null,
        buyer_phone: null,
        buyer_notes: null,
        order_id: null,
        held_until: null,
        hold_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", slotId)
      .eq("hold_token", holdToken)
      .eq("status", "held")
      .eq("payment_status", "pending");
  }

  const redirectTo = eventSlug
    ? `/events/${encodeURIComponent(eventSlug)}?error=private_lesson_checkout_cancelled`
    : "/discover/events?error=private_lesson_checkout_cancelled";

  return NextResponse.redirect(new URL(redirectTo, request.nextUrl.origin));
}
