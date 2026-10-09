import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startEventOrderPayment } from "@/lib/events/event-order-payment";
import { verifyEventCheckoutProof } from "@/lib/documents/event-signing";
import { getStripe } from "@/lib/payments/stripe";
import { beginCompetitionPayment } from "@/lib/competition/registrationCheckout";
import { competitionRegistrationUrls } from "@/lib/competition/registrationUrls";

export async function GET(request: NextRequest) {
  const checkpointId = request.nextUrl.searchParams.get("checkpointId")?.trim() ?? "";
  const orderId = request.nextUrl.searchParams.get("orderId")?.trim() ?? "";
  const proof = request.nextUrl.searchParams.get("proof")?.trim() ?? "";

  if (!checkpointId || !orderId || !verifyEventCheckoutProof(checkpointId, orderId, proof)) {
    return NextResponse.redirect(new URL("/events?error=invalid_signing_resume", request.nextUrl.origin));
  }

  const admin = createAdminClient();
  const { data: checkpoint } = await admin
    .from("event_signing_checkpoints")
    .select("id,order_id,status,expires_at")
    .eq("id", checkpointId)
    .eq("order_id", orderId)
    .maybeSingle();

  if (!checkpoint || !["ready_for_payment", "payment_started"].includes(checkpoint.status)) {
    return NextResponse.redirect(new URL("/events?error=signing_incomplete", request.nextUrl.origin));
  }
  if (new Date(checkpoint.expires_at).getTime() <= Date.now()) {
    await admin.from("event_signing_checkpoints").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", checkpoint.id);
    return NextResponse.redirect(new URL("/events?error=checkout_expired", request.nextUrl.origin));
  }

  // Phase 10C: a competition registration continues through its own database lifecycle
  // (prepare re-verifies the signed documents; attach binds the session). Never the generic path.
  const { data: order } = await admin
    .from("event_orders")
    .select("id, metadata, events:event_id(slug, name)")
    .eq("id", orderId)
    .maybeSingle();
  if ((order?.metadata as { source?: unknown } | null)?.source === "competition_registration") {
    const event = Array.isArray(order?.events) ? order?.events[0] : order?.events;
    const { data: cart } = await admin
      .from("event_competition_registration_carts")
      .select("public_token")
      .eq("order_id", orderId)
      .maybeSingle();
    if (!event || !cart?.public_token) {
      return NextResponse.redirect(new URL("/events?error=checkout_resume_failed", request.nextUrl.origin));
    }
    const urls = competitionRegistrationUrls(request.nextUrl.origin, event.slug, cart.public_token);
    try {
      const step = await beginCompetitionPayment({ admin, stripe: getStripe(), orderId, eventName: event.name, urls });
      return NextResponse.redirect(step.url, { status: 303 });
    } catch (error) {
      console.error("Competition checkout resume failed", error instanceof Error ? error.message : error);
      return NextResponse.redirect(urls.statusUrl, { status: 303 });
    }
  }

  try {
    await admin.from("event_signing_checkpoints").update({
      status: "payment_started",
      payment_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", checkpoint.id).in("status", ["ready_for_payment", "payment_started"]);

    const result = await startEventOrderPayment({
      request,
      orderId,
      surface: "web",
      paymentMode: "checkout",
    });

    if (result.completed) {
      await admin.from("event_signing_checkpoints").update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", checkpoint.id);
      return NextResponse.redirect(new URL(`/events?success=registration_complete&order=${encodeURIComponent(orderId)}`, request.nextUrl.origin));
    }

    if (!result.checkoutUrl) throw new Error("Checkout URL was not created.");
    return NextResponse.redirect(result.checkoutUrl, { status: 303 });
  } catch (error) {
    console.error("Event checkout resume failed", error instanceof Error ? error.message : error);
    return NextResponse.redirect(new URL("/events?error=checkout_resume_failed", request.nextUrl.origin));
  }
}
