import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";

type Surface = "web" | "student_app";
type PaymentMode = "checkout" | "payment_sheet";

type OrderRow = {
  id: string;
  event_id: string;
  studio_id: string;
  organizer_id: string | null;
  buyer_email: string;
  total_amount: number | null;
  currency: string | null;
  status: string | null;
  payment_status: string | null;
  expires_at: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  events: { id: string; slug: string; name: string } | { id: string; slug: string; name: string }[] | null;
  studios: {
    stripe_connected_account_id: string | null;
    stripe_connect_charges_enabled: boolean | null;
    stripe_connect_payouts_enabled: boolean | null;
    stripe_connect_onboarding_complete: boolean | null;
  } | {
    stripe_connected_account_id: string | null;
    stripe_connect_charges_enabled: boolean | null;
    stripe_connect_payouts_enabled: boolean | null;
    stripe_connect_onboarding_complete: boolean | null;
  }[] | null;
};

type ItemRow = {
  quantity: number;
  unit_price: number;
  description: string;
};

function pickOne<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function appBaseUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  ).replace(/\/$/, "");
}

function calculateApplicationFeeAmount(amount: number, feePercent: number) {
  return Math.round(Math.max(0, Math.round(amount * 100)) * Math.max(0, feePercent));
}

function getStripePublishableKey() {
  return (
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    process.env.STRIPE_PUBLISHABLE_KEY ||
    ""
  ).trim();
}

async function getOrganizerPlatformFeePercent(studioId: string) {
  const admin = createAdminClient();
  const { data: subscription } = await admin
    .from("studio_subscriptions")
    .select("status, subscription_plans ( code )")
    .eq("studio_id", studioId)
    .maybeSingle();

  if (!subscription || !["active", "trialing"].includes(subscription.status ?? "")) return 0;
  const plan = pickOne(subscription.subscription_plans as { code: string | null } | { code: string | null }[] | null);
  const code = (plan?.code ?? "").trim().toLowerCase();
  if (code === "organizer") return 0.035;
  if (!["starter", "growth", "pro"].includes(code)) return 0;

  const { data: addOns } = await admin
    .from("usage_addon_entitlements")
    .select("id")
    .eq("studio_id", studioId)
    .eq("feature_key", "organizer_suite")
    .in("source", ["stripe_subscription_item", "manual_grant"])
    .eq("status", "active")
    .limit(1);
  if (!addOns?.length) return 0;
  return code === "pro" ? 0.03 : 0.0325;
}

export type EventOrderPaymentResult = {
  completed?: boolean;
  checkoutUrl?: string;
  clientSecret?: string;
  orderId: string;
  publishableKey?: string;
  registrationIds: string[];
};

export async function startEventOrderPayment(params: {
  request: NextRequest;
  orderId: string;
  surface: Surface;
  paymentMode: PaymentMode;
  mobileReturnUrl?: string | null;
}) : Promise<EventOrderPaymentResult> {
  const admin = createAdminClient();
  const stripe = getStripe();
  const { data: orderData, error: orderError } = await admin
    .from("event_orders")
    .select(`
      id,event_id,studio_id,organizer_id,buyer_email,total_amount,currency,status,payment_status,expires_at,
      stripe_checkout_session_id,stripe_payment_intent_id,
      events:event_id(id,slug,name),
      studios:studio_id(stripe_connected_account_id,stripe_connect_charges_enabled,stripe_connect_payouts_enabled,stripe_connect_onboarding_complete)
    `)
    .eq("id", params.orderId)
    .maybeSingle();
  const order = orderData as unknown as OrderRow | null;
  if (orderError || !order) throw new Error("Event order was not found.");
  if (order.payment_status === "paid" || order.status === "confirmed") {
    const { data: registrations } = await admin.from("event_registrations").select("id").eq("order_id", order.id);
    return { completed: true, orderId: order.id, registrationIds: (registrations ?? []).map((row) => row.id) };
  }
  if (order.status !== "pending" || order.payment_status !== "pending") throw new Error("This event order is no longer available for payment.");
  if (order.expires_at && new Date(order.expires_at).getTime() <= Date.now()) throw new Error("This event checkout has expired.");

  const event = pickOne(order.events);
  const studio = pickOne(order.studios);
  if (!event || !studio?.stripe_connected_account_id || !studio.stripe_connect_onboarding_complete || !studio.stripe_connect_charges_enabled || !studio.stripe_connect_payouts_enabled) {
    throw new Error("Online ticket checkout is not ready for this event.");
  }

  const [{ data: items }, { data: registrations }] = await Promise.all([
    admin.from("event_order_items").select("quantity,unit_price,description").eq("order_id", order.id).order("id"),
    admin.from("event_registrations").select("id").eq("order_id", order.id).order("id"),
  ]);
  const orderItems = (items ?? []) as ItemRow[];
  const registrationIds = (registrations ?? []).map((row) => row.id);
  const totalAmount = Number(order.total_amount ?? 0);
  const currency = (order.currency || "USD").toLowerCase();

  if (totalAmount <= 0) {
    const now = new Date().toISOString();
    await admin.from("event_orders").update({ status: "confirmed", payment_status: "paid", paid_at: now, updated_at: now }).eq("id", order.id).eq("status", "pending");
    if (registrationIds.length) {
      await admin.from("event_registrations").update({ status: "confirmed", payment_status: "paid" }).in("id", registrationIds);
    }
    return { completed: true, orderId: order.id, registrationIds };
  }

  const feePercent = await getOrganizerPlatformFeePercent(order.studio_id);
  if (feePercent <= 0) throw new Error("DanceFlow event checkout is not enabled for this listing.");
  const applicationFeeAmount = calculateApplicationFeeAmount(totalAmount, feePercent);
  const connectedAccountId = studio.stripe_connected_account_id;
  const baseUrl = appBaseUrl(params.request);
  const webSuccessUrl = `${baseUrl}/events/${encodeURIComponent(event.slug)}?success=cart_paid&order=${encodeURIComponent(order.id)}`;
  const mobileSuccessUrl = params.mobileReturnUrl?.startsWith("danceflow://")
    ? params.mobileReturnUrl
    : `danceflow://events/orders/${encodeURIComponent(order.id)}?checkout=event`;
  const successUrl = params.surface === "student_app" ? mobileSuccessUrl : webSuccessUrl;
  const releaseUrl = `${baseUrl}/api/events/cart/release?orderId=${encodeURIComponent(order.id)}&eventSlug=${encodeURIComponent(event.slug)}`;

  if (params.paymentMode === "payment_sheet" && params.surface === "student_app") {
    if (order.stripe_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      if (existing.client_secret && !["canceled", "succeeded"].includes(existing.status)) {
        return { clientSecret: existing.client_secret, orderId: order.id, publishableKey: getStripePublishableKey(), registrationIds };
      }
    }

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100),
      currency,
      receipt_email: order.buyer_email,
      automatic_payment_methods: { enabled: true },
      ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
      transfer_data: { destination: connectedAccountId },
      metadata: {
        source: "event_cart_order",
        studio_id: order.studio_id,
        event_id: order.event_id,
        event_slug: event.slug,
        order_id: order.id,
        registration_id: registrationIds[0] ?? "",
        registration_ids: registrationIds.join(","),
        buyer_email: order.buyer_email,
        connected_account_id: connectedAccountId,
        client_surface: "student_app",
        mobile_return_url: mobileSuccessUrl,
      },
    }, { idempotencyKey: `event-order:${order.id}:payment-intent` });
    if (!intent.client_secret) throw new Error("Stripe did not return a native payment secret.");
    await admin.from("event_orders").update({ stripe_payment_intent_id: intent.id, updated_at: new Date().toISOString() }).eq("id", order.id);
    if (registrationIds.length) await admin.from("event_registrations").update({ stripe_payment_intent_id: intent.id }).in("id", registrationIds);
    return { clientSecret: intent.client_secret, orderId: order.id, publishableKey: getStripePublishableKey(), registrationIds };
  }

  if (order.stripe_checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
    if (existing.url && existing.status === "open") {
      return { checkoutUrl: existing.url, orderId: order.id, registrationIds };
    }
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: order.buyer_email,
    success_url: successUrl,
    cancel_url: releaseUrl,
    line_items: orderItems.map((item) => ({
      quantity: Math.max(1, Number(item.quantity ?? 1)),
      price_data: {
        currency,
        unit_amount: Math.round(Number(item.unit_price ?? 0) * 100),
        product_data: { name: item.description || "Event registration" },
      },
    })),
    payment_intent_data: {
      ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
      transfer_data: { destination: connectedAccountId },
      metadata: {
        source: "event_cart_order",
        studio_id: order.studio_id,
        event_id: order.event_id,
        event_slug: event.slug,
        order_id: order.id,
        registration_id: registrationIds[0] ?? "",
        registration_ids: registrationIds.join(","),
        buyer_email: order.buyer_email,
        connected_account_id: connectedAccountId,
      },
    },
    metadata: {
      source: "event_cart_order",
      studio_id: order.studio_id,
      event_id: order.event_id,
      event_slug: event.slug,
      order_id: order.id,
      registration_id: registrationIds[0] ?? "",
      registration_ids: registrationIds.join(","),
      buyer_email: order.buyer_email,
      connected_account_id: connectedAccountId,
      client_surface: params.surface,
    },
  }, { idempotencyKey: `event-order:${order.id}:checkout-session` });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  await admin.from("event_orders").update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() }).eq("id", order.id);
  if (registrationIds.length) await admin.from("event_registrations").update({ stripe_checkout_session_id: session.id }).in("id", registrationIds);
  return { checkoutUrl: session.url, orderId: order.id, registrationIds };
}
