import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentApiUser, normalizeStudentApiUuid, sameStudentEmail } from "@/lib/auth/studentApiAuth";
import { getEventSigningCheckpointByOrder } from "@/lib/documents/event-signing";
import { startEventOrderPayment } from "@/lib/events/event-order-payment";

export async function POST(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const normalizedOrderId = normalizeStudentApiUuid(orderId);
  if (!normalizedOrderId) return NextResponse.json({ error: "Event order was not found." }, { status: 404 });

  const user = await getStudentApiUser(request);
  if (!user?.email) return NextResponse.json({ error: "Sign in to continue checkout." }, { status: 401 });

  const admin = createAdminClient();
  const [{ data: order }, checkpoint] = await Promise.all([
    admin.from("event_orders").select("id,buyer_email").eq("id", normalizedOrderId).maybeSingle(),
    getEventSigningCheckpointByOrder(normalizedOrderId),
  ]);

  if (!order || !sameStudentEmail(user, order.buyer_email) || !checkpoint || checkpoint.user_id !== user.id) {
    return NextResponse.json({ error: "Event order was not found." }, { status: 404 });
  }
  if (!["ready_for_payment", "payment_started"].includes(checkpoint.status)) {
    return NextResponse.json({ error: "Required documents are not complete yet." }, { status: 409 });
  }
  if (new Date(checkpoint.expires_at).getTime() <= Date.now()) {
    await admin.from("event_signing_checkpoints").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", checkpoint.id);
    return NextResponse.json({ error: "This event checkout has expired." }, { status: 410 });
  }

  try {
    await admin.from("event_signing_checkpoints").update({
      status: "payment_started",
      payment_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", checkpoint.id).in("status", ["ready_for_payment", "payment_started"]);

    const result = await startEventOrderPayment({
      request,
      orderId: normalizedOrderId,
      surface: "student_app",
      paymentMode: checkpoint.payment_mode,
      mobileReturnUrl: checkpoint.mobile_return_url,
    });

    if (result.completed) {
      await admin.from("event_signing_checkpoints").update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", checkpoint.id);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Student event checkout resume failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Checkout could not be resumed. Please try again." }, { status: 400 });
  }
}
