import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { startEventOrderPayment } from "@/lib/events/event-order-payment";
import { verifyEventCheckoutProof } from "@/lib/documents/event-signing";

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
