import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/payments/stripe";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { getStudentApiUser, normalizeStudentApiUuid, sameStudentEmail } from "@/lib/auth/studentApiAuth";

type Params = {
  params: Promise<{ orderId: string }>;
};

type EventOrderRow = {
  id: string;
  buyer_email: string | null;
  currency: string | null;
  event_id: string | null;
  payment_status: string | null;
  status: string | null;
  stripe_payment_intent_id: string | null;
  total_amount: number | null;
};

type RegistrationRow = {
  id: string;
  currency: string | null;
  total_price: number | null;
};

type EventRow = {
  id: string;
  name: string | null;
  slug: string | null;
};

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

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { orderId } = await params;
  const normalizedOrderId = normalizeStudentApiUuid(orderId);

  if (!normalizedOrderId) {
    return jsonError("Event order was not found.", 404);
  }

  const supabase = getSupabaseAdmin();
  const stripe = getStripe();
  const user = await getStudentApiUser(request);

  if (!user?.email) {
    return jsonError("Sign in to confirm this event order.", 401);
  }

  const { data: order, error: orderError } = await supabase
    .from("event_orders")
    .select("id, buyer_email, currency, event_id, payment_status, status, stripe_payment_intent_id, total_amount")
    .eq("id", normalizedOrderId)
    .maybeSingle();

  if (orderError) {
    return jsonError("Event order could not be loaded.", 500);
  }

  const orderRow = order as unknown as EventOrderRow | null;
  const buyerEmail = orderRow?.buyer_email?.trim().toLowerCase();

  if (!orderRow || !sameStudentEmail(user, buyerEmail)) {
    return jsonError("Event order was not found.", 404);
  }

  if (orderRow.payment_status === "paid" && orderRow.status === "confirmed") {
    return NextResponse.json({ confirmed: true, orderId: orderRow.id });
  }

  if (!orderRow.stripe_payment_intent_id) {
    return jsonError("Payment confirmation is not ready for this order.", 409);
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(orderRow.stripe_payment_intent_id);

  if (paymentIntent.status !== "succeeded") {
    return jsonError("Stripe has not confirmed this payment yet.", 409);
  }

  if (paymentIntent.metadata?.source !== "event_cart_order" || paymentIntent.metadata?.order_id !== orderRow.id) {
    return jsonError("Stripe payment metadata does not match this event order.", 409);
  }

  if (paymentIntent.metadata?.buyer_email && !sameStudentEmail(user, paymentIntent.metadata.buyer_email)) {
    return jsonError("Stripe payment metadata does not match this event order.", 409);
  }

  const expectedAmount = Number(orderRow.total_amount ?? 0);
  const receivedAmount = Number(paymentIntent.amount_received || paymentIntent.amount || 0) / 100;
  if (expectedAmount > 0 && Math.abs(receivedAmount - expectedAmount) > 0.01) {
    return jsonError("Stripe payment amount does not match this event order.", 409);
  }

  const paidAt = new Date().toISOString();
  const currency = (paymentIntent.currency || orderRow.currency || "usd").toUpperCase();
  const amountTotal = receivedAmount;

  const { error: orderUpdateError } = await supabase
    .from("event_orders")
    .update({
      currency,
      paid_at: paidAt,
      payment_status: "paid",
      status: "confirmed",
      total_amount: amountTotal,
      updated_at: paidAt,
    })
    .eq("id", orderRow.id);

  if (orderUpdateError) {
    return jsonError(orderUpdateError.message, 500);
  }

  const { data: registrations, error: registrationsError } = await supabase
    .from("event_registrations")
    .select("id, currency, total_price")
    .eq("order_id", orderRow.id);

  if (registrationsError) {
    return jsonError(registrationsError.message, 500);
  }

  const registrationRows = (registrations ?? []) as unknown as RegistrationRow[];
  const registrationIds = registrationRows.map((registration) => registration.id);

  if (registrationIds.length > 0) {
    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        payment_status: "paid",
        status: "confirmed",
        stripe_payment_intent_id: paymentIntent.id,
      })
      .in("id", registrationIds);

    if (registrationUpdateError) {
      return jsonError(registrationUpdateError.message, 500);
    }
  }

  for (const registration of registrationRows) {
    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from("event_payments")
      .select("id")
      .eq("registration_id", registration.id)
      .eq("stripe_payment_intent_id", paymentIntent.id)
      .maybeSingle();

    if (existingPaymentError) {
      return jsonError(existingPaymentError.message, 500);
    }

    if (!existingPayment) {
      const { error: paymentInsertError } = await supabase
        .from("event_payments")
        .insert({
          amount: Number(registration.total_price ?? 0),
          currency: registration.currency || currency,
          external_reference: paymentIntent.id,
          notes: "Created by student app native payment confirmation.",
          payment_method: "stripe_payment_sheet",
          registration_id: registration.id,
          source: "stripe",
          status: "paid",
          stripe_payment_intent_id: paymentIntent.id,
        });

      if (paymentInsertError) {
        return jsonError(paymentInsertError.message, 500);
      }
    }
  }

  if (orderRow.event_id) {
    try {
      const { data: event } = await supabase
        .from("events")
        .select("id, name, slug")
        .eq("id", orderRow.event_id)
        .maybeSingle<EventRow>();

      await sendMobilePushToUser({
        userId: user.id,
        category: "event",
        title: "Tickets confirmed",
        body: event?.name
          ? `Your tickets for ${event.name} are ready.`
          : "Your event tickets are ready.",
        data: {
          source: "student_event_order_confirmed",
          orderId: orderRow.id,
          eventId: orderRow.event_id,
          eventSlug: event?.slug ?? null,
          registrationIds,
        },
      });
    } catch (pushError) {
      console.error(
        "Failed to send event confirmation mobile push",
        pushError instanceof Error ? pushError.message : pushError
      );
    }
  }

  return NextResponse.json({
    confirmed: true,
    orderId: orderRow.id,
    registrationIds,
  });
}
