import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { getStudentApiUser, normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { finalizeStudentMarketplacePayment } from "@/lib/commerce/studentMarketplace";

type Params = { params: Promise<{ orderId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { orderId } = await params;
  const id = normalizeStudentApiUuid(orderId);
  const user = await getStudentApiUser(request);

  if (!id || !user) {
    return NextResponse.json({ error: "Order was not found." }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: order, error } = await admin
    .from("commerce_orders")
    .select("id, total, currency, status, payment_status, metadata")
    .eq("id", id)
    .maybeSingle();

  if (
    error ||
    !order ||
    order.metadata?.student_user_id !== user.id
  ) {
    return NextResponse.json({ error: "Order was not found." }, { status: 404 });
  }

  if (order.status === "completed" && order.payment_status === "paid") {
    return NextResponse.json({ confirmed: true, orderId: order.id });
  }

  const paymentIntentId = order.metadata?.stripe_payment_intent_id;
  const connectedAccountId = order.metadata?.stripe_connected_account_id;
  if (!paymentIntentId || !connectedAccountId) {
    return NextResponse.json({ error: "Order payment is not ready." }, { status: 409 });
  }

  const stripe = getStripe();
  const paymentIntent = await stripe.paymentIntents.retrieve(
    paymentIntentId,
    {},
    { stripeAccount: connectedAccountId },
  );

  if (paymentIntent.status !== "succeeded") {
    return NextResponse.json({ confirmed: false, orderId: order.id });
  }

  await finalizeStudentMarketplacePayment({
    supabase: admin,
    orderId: order.id,
    paymentIntentId: paymentIntent.id,
    amount: Number(paymentIntent.amount_received ?? paymentIntent.amount ?? 0) / 100,
    currency: paymentIntent.currency,
  });

  return NextResponse.json({ confirmed: true, orderId: order.id });
}
