import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { getStudentApiUser, normalizeStudentApiUuid } from "@/lib/auth/studentApiAuth";
import { finalizeStudentMarketplacePayment } from "@/lib/commerce/studentMarketplace";
import {
  checkRateLimit,
  getIpFromRequest,
  rateLimitKey,
  rateLimitedJson,
} from "@/lib/security/rate-limit";

type Params = { params: Promise<{ orderId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const ipRateLimit = checkRateLimit(
    rateLimitKey("student-commerce-confirm:ip", getIpFromRequest(request)),
    { limit: 60, windowMs: 15 * 60 * 1000 },
  );
  if (!ipRateLimit.allowed) return rateLimitedJson(ipRateLimit);

  const { orderId } = await params;
  const id = normalizeStudentApiUuid(orderId);
  const user = await getStudentApiUser(request);

  if (!id || !user) {
    return NextResponse.json({ error: "Order was not found." }, { status: 404 });
  }

  const userRateLimit = checkRateLimit(
    rateLimitKey("student-commerce-confirm:user", user.id, id),
    { limit: 20, windowMs: 15 * 60 * 1000 },
  );
  if (!userRateLimit.allowed) return rateLimitedJson(userRateLimit);

  const admin = createAdminClient();
  const { data: order, error } = await admin
    .from("commerce_orders")
    .select("id, studio_id, total, currency, status, payment_status, metadata")
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

  const expectedAmount = Math.round(Number(order.total ?? 0) * 100);
  const expectedCurrency = String(order.currency ?? "usd").toLowerCase();
  const receivedAmount = Number(
    paymentIntent.amount_received ?? paymentIntent.amount ?? 0,
  );
  const metadata = paymentIntent.metadata ?? {};

  const paymentMatchesOrder =
    receivedAmount === expectedAmount &&
    paymentIntent.currency.toLowerCase() === expectedCurrency &&
    metadata.order_id === order.id &&
    metadata.user_id === user.id &&
    metadata.studio_id === order.studio_id &&
    metadata.catalog_item_id === order.metadata?.catalog_item_id &&
    metadata.connected_account_id === connectedAccountId;

  if (!paymentMatchesOrder) {
    console.error("Marketplace payment confirmation mismatch", {
      orderId: order.id,
      paymentIntentId: paymentIntent.id,
    });
    return NextResponse.json(
      { error: "Order payment could not be verified." },
      { status: 409 },
    );
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
