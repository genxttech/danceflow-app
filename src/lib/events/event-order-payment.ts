import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";

type Surface = "web" | "student_app";
type PaymentMode = "checkout" | "payment_sheet";

type AdminClient = ReturnType<typeof createAdminClient>;

const POSTGRES_UNIQUE_VIOLATION = "23505";

type ReusableOrderRow = {
  id: string;
  event_id: string;
  status: string | null;
  payment_status: string | null;
  metadata: {
    requested_total_cents?: number;
    ticket_selection_signature?: string;
  } | null;
};

export type ResolveEventOrderResult =
  | { ok: true; order: ReusableOrderRow; isNew: boolean }
  | { ok: false; error: string };

export type TicketSelectionForSignature = { ticketTypeId: string; quantity: number };

/**
 * Deterministic signature of a ticket selection, independent of submission
 * order -- sorted by ticketTypeId so `[{A,2},{B,1}]` and `[{B,1},{A,2}]`
 * (the same purchase, listed differently) produce the identical signature,
 * while a genuinely different composition (even at the same total price,
 * e.g. swapping 2x$10 tickets for 1x$20 of a different type) does not.
 * Duplicate ticketTypeId entries are intentionally not merged -- the
 * ticket-registration loop in the checkout route treats each selection
 * entry as its own line item even when a type repeats, so merging here
 * would treat two different submissions as equivalent when they are not.
 */
export function computeTicketSelectionSignature(selections: TicketSelectionForSignature[]): string {
  const normalized = selections
    .map((selection) => ({
      ticketTypeId: selection.ticketTypeId,
      quantity: Math.max(1, selection.quantity),
    }))
    .sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId));
  return JSON.stringify(normalized);
}

function validateReusedEventOrder(
  order: ReusableOrderRow,
  eventId: string,
  requestedTotalCents: number,
  ticketSelectionSignature: string,
): ResolveEventOrderResult {
  if (order.event_id !== eventId) {
    return { ok: false, error: "This request has already been used for a different event checkout." };
  }

  const storedCents = order.metadata?.requested_total_cents;
  if (typeof storedCents === "number" && storedCents !== requestedTotalCents) {
    return { ok: false, error: "This request has already been used for a different checkout amount." };
  }

  const storedSignature = order.metadata?.ticket_selection_signature;
  if (typeof storedSignature === "string" && storedSignature !== ticketSelectionSignature) {
    return { ok: false, error: "This request has already been used for a different ticket selection." };
  }

  return { ok: true, order, isNew: false };
}

/**
 * Resolves the `event_orders` row a student checkout request should operate
 * against, given the client's clientRequestId. Reuses an existing row on
 * retry/double-tap instead of inserting a duplicate order (and therefore
 * duplicate event_registrations + a duplicate Stripe PaymentIntent/
 * Checkout Session downstream) -- same reuse-or-create shape as
 * src/lib/payments/terminal-quick-charge.ts's resolveAdHocPayment (Payments
 * P0.1), adapted for event_orders.
 *
 * The requested total is compared against a value stashed in `metadata` at
 * insert time (`requested_total_cents`), not the row's own `total_amount`
 * column -- `total_amount` is deliberately written as 0 at insert and only
 * updated after ticket/registration creation completes for a brand new
 * order, so comparing against it here would create a race window where a
 * legitimate same-clientRequestId retry landing between those two writes
 * gets rejected. `metadata.requested_total_cents` is set atomically in the
 * same insert as the row itself, so there is no such window.
 *
 * `metadata.ticket_selection_signature` (see computeTicketSelectionSignature
 * below) is checked the same way, so a same-clientRequestId reuse whose
 * ticket-type composition differs from the original attempt is rejected
 * even when the aggregate total happens to match (e.g. swapping 2x$10
 * tickets for 1x$20 of a different type).
 *
 * A concurrent-insert race (two near-simultaneous requests with the same
 * clientRequestId) is resolved by catching the unique-index violation on
 * (studio_id, client_request_id) -- see
 * 20260810100100_event_orders_client_request_id_dedupe_index_concurrent.sql
 * -- and re-selecting the winning row, rather than erroring.
 */
export async function resolveEventOrderForCheckout(params: {
  supabase: AdminClient;
  studioId: string;
  eventId: string;
  clientRequestId: string;
  requestedTotalCents: number;
  ticketSelectionSignature: string;
  insertPayload: Record<string, unknown>;
}): Promise<ResolveEventOrderResult> {
  const { supabase, studioId, eventId, clientRequestId, requestedTotalCents, ticketSelectionSignature, insertPayload } =
    params;

  const GENERIC_ORDER_ERROR = "Could not create the event checkout order.";

  const existing = await supabase
    .from("event_orders")
    .select("id, event_id, status, payment_status, metadata")
    .eq("studio_id", studioId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();

  if (existing.error) {
    // Never surface a raw DB error message to the client -- same
    // generic-message-on-failure behavior as the rest of this route.
    console.error("resolveEventOrderForCheckout lookup failed", existing.error.message);
    return { ok: false, error: GENERIC_ORDER_ERROR };
  }

  if (existing.data) {
    return validateReusedEventOrder(
      existing.data as ReusableOrderRow,
      eventId,
      requestedTotalCents,
      ticketSelectionSignature,
    );
  }

  const inserted = await supabase
    .from("event_orders")
    .insert({
      ...insertPayload,
      studio_id: studioId,
      event_id: eventId,
      client_request_id: clientRequestId,
    })
    .select("id, event_id, status, payment_status, metadata")
    .single();

  if (!inserted.error && inserted.data) {
    return { ok: true, order: inserted.data as ReusableOrderRow, isNew: true };
  }

  if (inserted.error?.code === POSTGRES_UNIQUE_VIOLATION) {
    const winner = await supabase
      .from("event_orders")
      .select("id, event_id, status, payment_status, metadata")
      .eq("studio_id", studioId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();

    if (winner.error || !winner.data) {
      console.error("resolveEventOrderForCheckout race recovery failed", winner.error?.message);
      return { ok: false, error: GENERIC_ORDER_ERROR };
    }

    return validateReusedEventOrder(
      winner.data as ReusableOrderRow,
      eventId,
      requestedTotalCents,
      ticketSelectionSignature,
    );
  }

  console.error("resolveEventOrderForCheckout insert failed", inserted.error?.message);
  return { ok: false, error: GENERIC_ORDER_ERROR };
}

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
  metadata: Record<string, unknown> | null;
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
      stripe_checkout_session_id,stripe_payment_intent_id,metadata,
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

  const feePercent = order.organizer_id
    ? await getOrganizerPlatformFeePercent(order.studio_id)
    : 0;

  if (order.organizer_id && feePercent <= 0) {
    throw new Error("DanceFlow organizer checkout is not enabled for this listing.");
  }

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
      const existing = await stripe.paymentIntents.retrieve(
        order.stripe_payment_intent_id,
        {},
        { stripeAccount: connectedAccountId },
      );
      if (existing.client_secret && !["canceled", "succeeded"].includes(existing.status)) {
        return { clientSecret: existing.client_secret, orderId: order.id, publishableKey: getStripePublishableKey(), registrationIds };
      }
    }

    // Attempt-numbered so a raw network retry of this same sub-attempt is
    // idempotent at Stripe's layer, while a genuinely new sub-attempt (the
    // prior object above was canceled/succeeded/never created) gets a
    // fresh key -- Stripe caches the *response* for a repeated key, so a
    // flat, non-incrementing key here would risk returning the stale
    // canceled PaymentIntent's original response instead of truly creating
    // a new one. Same pattern as
    // src/lib/payments/terminal-quick-charge.ts's attemptNumber.
    const paymentIntentAttempt = Number(order.metadata?.payment_intent_attempt_count ?? 0);

    const intent = await stripe.paymentIntents.create(
      {
        amount: Math.round(totalAmount * 100),
        currency,
        receipt_email: order.buyer_email,
        automatic_payment_methods: { enabled: true },
        ...(applicationFeeAmount > 0
          ? { application_fee_amount: applicationFeeAmount }
          : {}),
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
          charge_model: "direct",
          client_surface: "student_app",
          mobile_return_url: mobileSuccessUrl,
        },
      },
      {
        stripeAccount: connectedAccountId,
        idempotencyKey: `event-order:${order.id}:payment-intent:${paymentIntentAttempt}`,
      },
    );
    if (!intent.client_secret) throw new Error("Stripe did not return a native payment secret.");
    await admin
      .from("event_orders")
      .update({
        stripe_payment_intent_id: intent.id,
        updated_at: new Date().toISOString(),
        // Merge, not replace -- metadata also carries requested_total_cents
        // and ticket_selection_signature, which resolveEventOrderForCheckout
        // depends on for every future reuse check against this order.
        metadata: { ...(order.metadata ?? {}), payment_intent_attempt_count: paymentIntentAttempt + 1 },
      })
      .eq("id", order.id);
    if (registrationIds.length) await admin.from("event_registrations").update({ stripe_payment_intent_id: intent.id }).in("id", registrationIds);
    return { clientSecret: intent.client_secret, orderId: order.id, publishableKey: getStripePublishableKey(), registrationIds };
  }

  if (order.stripe_checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(
      order.stripe_checkout_session_id,
      {},
      { stripeAccount: connectedAccountId },
    );
    if (existing.url && existing.status === "open") {
      return { checkoutUrl: existing.url, orderId: order.id, registrationIds };
    }
  }

  // Same attempt-numbering rationale as the PaymentIntent branch above --
  // a flat idempotency key would risk Stripe replaying a stale/expired
  // Checkout Session's original response on a genuine retry.
  const checkoutSessionAttempt = Number(order.metadata?.checkout_session_attempt_count ?? 0);

  const session = await stripe.checkout.sessions.create(
    {
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
        ...(applicationFeeAmount > 0
          ? { application_fee_amount: applicationFeeAmount }
          : {}),
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
          charge_model: "direct",
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
        charge_model: "direct",
        client_surface: params.surface,
      },
    },
    {
      stripeAccount: connectedAccountId,
      idempotencyKey: `event-order:${order.id}:checkout-session:${checkoutSessionAttempt}`,
    },
  );
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  await admin
    .from("event_orders")
    .update({
      stripe_checkout_session_id: session.id,
      updated_at: new Date().toISOString(),
      metadata: { ...(order.metadata ?? {}), checkout_session_attempt_count: checkoutSessionAttempt + 1 },
    })
    .eq("id", order.id);
  if (registrationIds.length) await admin.from("event_registrations").update({ stripe_checkout_session_id: session.id }).in("id", registrationIds);
  return { checkoutUrl: session.url, orderId: order.id, registrationIds };
}
