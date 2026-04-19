import { headers } from "next/headers";
import { createHash } from "crypto";
import Stripe from "stripe";
import {
  createClient as createSupabaseClient,
  SupabaseClient,
} from "@supabase/supabase-js";
import { getStripe } from "@/lib/payments/stripe";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import {
  buildEventConfirmedEmailTemplate,
  buildEventConfirmedSmsTemplate,
} from "@/lib/notifications/templates";

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

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function toIsoOrNull(unixSeconds: number | null): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function toDateOnlyOrNull(unixSeconds: number | null): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function mapStripeSubscriptionStatusToLocal(
  status: string
): "pending" | "active" | "cancelled" | "past_due" | "unpaid" {
  if (status === "active" || status === "trialing") return "active";
  if (status === "canceled") return "cancelled";
  if (status === "past_due") return "past_due";
  if (status === "unpaid") return "unpaid";
  return "pending";
}

function mapStudioSubscriptionStatus(
  status: string
): "inactive" | "trialing" | "active" | "past_due" | "cancelled" {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled" || status === "incomplete_expired") return "cancelled";
  return "inactive";
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const rawSubscription = (
    invoice as Stripe.Invoice & {
      subscription?: string | Stripe.Subscription | null;
    }
  ).subscription;

  return typeof rawSubscription === "string"
    ? rawSubscription
    : rawSubscription?.id ?? null;
}

function getInvoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  const rawPayments = (
    invoice as Stripe.Invoice & {
      payments?: {
        data?: Array<{
          payment?: {
            type?: string | null;
            payment_intent?: string | Stripe.PaymentIntent | null;
          } | null;
        }> | null;
      } | null;
    }
  ).payments;

  const payment = rawPayments?.data?.[0]?.payment;

  if (!payment || payment.type !== "payment_intent") {
    return null;
  }

  return typeof payment.payment_intent === "string"
    ? payment.payment_intent
    : payment.payment_intent?.id ?? null;
}

function getInvoiceChargeId(invoice: Stripe.Invoice): string | null {
  const rawPayments = (
    invoice as Stripe.Invoice & {
      payments?: {
        data?: Array<{
          payment?: {
            type?: string | null;
            charge?: string | Stripe.Charge | null;
          } | null;
        }> | null;
      } | null;
    }
  ).payments;

  const payment = rawPayments?.data?.[0]?.payment;

  if (!payment || payment.type !== "charge") {
    return null;
  }

  return typeof payment.charge === "string"
    ? payment.charge
    : payment.charge?.id ?? null;
}

async function upsertStripePaymentMethodRecord(
  supabase: SupabaseClient,
  stripe: Stripe,
  input: {
    studioId: string;
    clientId: string;
    customerId: string;
    paymentMethodId: string;
  }
) {
  const { studioId, clientId, customerId, paymentMethodId } = input;

  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

  const type = paymentMethod.type ?? null;
  const brand = paymentMethod.card?.brand ?? null;
  const last4 = paymentMethod.card?.last4 ?? null;
  const expMonth = paymentMethod.card?.exp_month ?? null;
  const expYear = paymentMethod.card?.exp_year ?? null;

  const { data: existingMethod, error: existingMethodError } = await supabase
    .from("stripe_payment_methods")
    .select("id, is_default")
    .eq("stripe_payment_method_id", paymentMethodId)
    .maybeSingle();

  if (existingMethodError) {
    throw new Error(existingMethodError.message);
  }

  if (existingMethod) {
    const { error: updateMethodError } = await supabase
      .from("stripe_payment_methods")
      .update({
        type,
        brand,
        last4,
        exp_month: expMonth,
        exp_year: expYear,
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingMethod.id);

    if (updateMethodError) {
      throw new Error(updateMethodError.message);
    }

    return;
  }

  const { data: currentDefaults, error: currentDefaultsError } = await supabase
    .from("stripe_payment_methods")
    .select("id")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("is_default", true);

  if (currentDefaultsError) {
    throw new Error(currentDefaultsError.message);
  }

  const isDefault = !currentDefaults || currentDefaults.length === 0;

  if (isDefault) {
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });
  }

  const { error: insertMethodError } = await supabase
    .from("stripe_payment_methods")
    .insert({
      studio_id: studioId,
      client_id: clientId,
      stripe_customer_id: customerId,
      stripe_payment_method_id: paymentMethodId,
      type,
      brand,
      last4,
      exp_month: expMonth,
      exp_year: expYear,
      is_default: isDefault,
      status: "active",
    });

  if (insertMethodError) {
    throw new Error(insertMethodError.message);
  }
}

async function upsertStripeSubscriptionRecord(
  supabase: SupabaseClient,
  subscription: Stripe.Subscription
) {
  const stripeSubscriptionId = subscription.id;
  const stripeCustomerId = getString(subscription.customer);

  if (!stripeCustomerId) {
    throw new Error("Subscription missing customer id.");
  }

  const metadata = subscription.metadata ?? {};
  const localMembershipId = metadata.localMembershipId || null;
  const studioId = metadata.studioId || null;
  const clientId = metadata.clientId || null;
  const membershipPlanId = metadata.membershipPlanId || null;

  const currentPeriodStartUnix = getNumber(
    (subscription as unknown as { current_period_start?: number }).current_period_start
  );
  const currentPeriodEndUnix = getNumber(
    (subscription as unknown as { current_period_end?: number }).current_period_end
  );

  const latestInvoiceId =
    typeof subscription.latest_invoice === "string"
      ? subscription.latest_invoice
      : subscription.latest_invoice?.id ?? null;

  const defaultPaymentMethodId =
    typeof subscription.default_payment_method === "string"
      ? subscription.default_payment_method
      : subscription.default_payment_method?.id ?? null;

  const payload = {
    studio_id: studioId,
    client_id: clientId,
    client_membership_id: localMembershipId,
    membership_plan_id: membershipPlanId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_price_id: getString(subscription.items.data[0]?.price?.id) ?? null,
    status: subscription.status,
    current_period_start: toIsoOrNull(currentPeriodStartUnix),
    current_period_end: toIsoOrNull(currentPeriodEndUnix),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    default_payment_method_id: defaultPaymentMethodId,
    latest_invoice_id: latestInvoiceId,
    updated_at: new Date().toISOString(),
  };

  const { data: existingSubscription, error: existingSubscriptionError } = await supabase
    .from("stripe_subscriptions")
    .select("id")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();

  if (existingSubscriptionError) {
    throw new Error(existingSubscriptionError.message);
  }

  if (existingSubscription) {
    const { error: updateError } = await supabase
      .from("stripe_subscriptions")
      .update(payload)
      .eq("id", existingSubscription.id);

    if (updateError) {
      throw new Error(updateError.message);
    }
  } else {
    const { error: insertError } = await supabase
      .from("stripe_subscriptions")
      .insert({
        ...payload,
        created_at: new Date().toISOString(),
      });

    if (insertError) {
      throw new Error(insertError.message);
    }
  }

  if (localMembershipId && studioId) {
    const { error: membershipUpdateError } = await supabase
      .from("client_memberships")
      .update({
        status: mapStripeSubscriptionStatusToLocal(subscription.status),
        current_period_start: toDateOnlyOrNull(currentPeriodStartUnix) ?? undefined,
        current_period_end: toDateOnlyOrNull(currentPeriodEndUnix) ?? undefined,
        ends_on: subscription.cancel_at_period_end
          ? toDateOnlyOrNull(currentPeriodEndUnix)
          : null,
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        auto_renew: !subscription.cancel_at_period_end,
      })
      .eq("id", localMembershipId)
      .eq("studio_id", studioId);

    if (membershipUpdateError) {
      throw new Error(membershipUpdateError.message);
    }
  }
}

async function upsertStudioBillingCustomer(params: {
  supabase: SupabaseClient;
  stripeCustomerId: string;
  studioId: string;
  email?: string | null;
  contactName?: string | null;
}) {
  const { supabase, stripeCustomerId, studioId, email = null, contactName = null } =
    params;

  const { data: existingCustomer, error: existingCustomerError } = await supabase
    .from("studio_billing_customers")
    .select("id")
    .eq("studio_id", studioId)
    .maybeSingle();

  if (existingCustomerError) {
    throw new Error(existingCustomerError.message);
  }

  if (existingCustomer) {
    const { error: updateError } = await supabase
      .from("studio_billing_customers")
      .update({
        stripe_customer_id: stripeCustomerId,
        billing_email: email,
        contact_name: contactName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingCustomer.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return;
  }

  const { error: insertError } = await supabase
    .from("studio_billing_customers")
    .insert({
      studio_id: studioId,
      stripe_customer_id: stripeCustomerId,
      billing_email: email,
      contact_name: contactName,
    });

  if (insertError) {
    throw new Error(insertError.message);
  }
}

async function upsertStudioSubscription(params: {
  supabase: SupabaseClient;
  stripe: Stripe;
  subscription: Stripe.Subscription;
}) {
  const { supabase, subscription } = params;

  const stripeCustomerId = getString(subscription.customer);
  if (!stripeCustomerId) {
    throw new Error("Studio subscription missing customer id.");
  }

  const metadata = subscription.metadata ?? {};
  const studioId = getString(metadata.studioId);
  const metadataPlanCode = getString(metadata.planCode);

  if (!studioId) {
    return false;
  }

  const stripePriceId = getString(subscription.items.data[0]?.price?.id);
  const currentPeriodStartUnix = getNumber(
    (subscription as unknown as { current_period_start?: number }).current_period_start
  );
  const currentPeriodEndUnix = getNumber(
    (subscription as unknown as { current_period_end?: number }).current_period_end
  );

  let planRow:
    | {
        id: string;
        code: string;
        stripe_price_id_monthly: string | null;
        stripe_price_id_yearly: string | null;
      }
    | null = null;

  if (stripePriceId) {
    const { data, error } = await supabase
      .from("subscription_plans")
      .select("id, code, stripe_price_id_monthly, stripe_price_id_yearly")
      .or(
        `stripe_price_id_monthly.eq.${stripePriceId},stripe_price_id_yearly.eq.${stripePriceId}`
      )
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    planRow = data;
  }

  if (!planRow && metadataPlanCode) {
    const { data, error } = await supabase
      .from("subscription_plans")
      .select("id, code, stripe_price_id_monthly, stripe_price_id_yearly")
      .eq("code", metadataPlanCode)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    planRow = data;
  }

  if (!planRow) {
    throw new Error(
      `Could not resolve subscription plan for studio subscription ${subscription.id}. ` +
        `stripePriceId=${stripePriceId || "null"} metadata.planCode=${metadataPlanCode || "null"}`
    );
  }

  const billingInterval =
    stripePriceId && planRow.stripe_price_id_yearly === stripePriceId ? "year" : "month";

  const mappedStatus = mapStudioSubscriptionStatus(subscription.status);

  const payload = {
    studio_id: studioId,
    subscription_plan_id: planRow.id,
    status: mappedStatus,
    billing_interval: billingInterval,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    stripe_price_id: stripePriceId || null,
    current_period_start: toIsoOrNull(currentPeriodStartUnix),
    current_period_end: toIsoOrNull(currentPeriodEndUnix),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    cancelled_at: toIsoOrNull(getNumber(subscription.canceled_at)),
    ended_at: toIsoOrNull(getNumber(subscription.ended_at)),
    updated_at: new Date().toISOString(),
  };

  const { data: existingByStudio, error: existingByStudioError } = await supabase
    .from("studio_subscriptions")
    .select("id")
    .eq("studio_id", studioId)
    .maybeSingle();

  if (existingByStudioError) {
    throw new Error(existingByStudioError.message);
  }

  if (existingByStudio) {
    const { error: updateError } = await supabase
      .from("studio_subscriptions")
      .update(payload)
      .eq("id", existingByStudio.id);

    if (updateError) {
      throw new Error(updateError.message);
    }
  } else {
    const { error: insertError } = await supabase
      .from("studio_subscriptions")
      .insert({
        ...payload,
        created_at: new Date().toISOString(),
      });

    if (insertError) {
      throw new Error(insertError.message);
    }
  }

  const { data: existingCustomer, error: existingCustomerError } = await supabase
    .from("studio_billing_customers")
    .select("id")
    .eq("studio_id", studioId)
    .maybeSingle();

  if (existingCustomerError) {
    throw new Error(existingCustomerError.message);
  }

  const customerPayload = {
    studio_id: studioId,
    stripe_customer_id: stripeCustomerId,
    updated_at: new Date().toISOString(),
  };

  if (existingCustomer) {
    const { error: updateCustomerError } = await supabase
      .from("studio_billing_customers")
      .update(customerPayload)
      .eq("id", existingCustomer.id);

    if (updateCustomerError) {
      throw new Error(updateCustomerError.message);
    }
  } else {
    const { error: insertCustomerError } = await supabase
      .from("studio_billing_customers")
      .insert({
        ...customerPayload,
        created_at: new Date().toISOString(),
      });

    if (insertCustomerError) {
      throw new Error(insertCustomerError.message);
    }
  }

  return true;
}

async function upsertStudioInvoice(params: {
  supabase: SupabaseClient;
  invoice: Stripe.Invoice;
}) {
  const { supabase, invoice } = params;

  const stripeCustomerId = getString(invoice.customer);
  if (!stripeCustomerId) {
    return false;
  }

  const { data: billingCustomer, error: billingCustomerError } = await supabase
    .from("studio_billing_customers")
    .select("studio_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();

  if (billingCustomerError) {
    throw new Error(billingCustomerError.message);
  }

  if (!billingCustomer?.studio_id) {
    return false;
  }

  const studioId = billingCustomer.studio_id as string;

  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
  let studioSubscriptionId: string | null = null;

  if (stripeSubscriptionId) {
    const { data: studioSubscription, error: studioSubscriptionError } = await supabase
      .from("studio_subscriptions")
      .select("id")
      .eq("studio_id", studioId)
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();

    if (studioSubscriptionError) {
      throw new Error(studioSubscriptionError.message);
    }

    studioSubscriptionId = studioSubscription?.id ?? null;
  }

  const periodStart = invoice.lines?.data?.[0]?.period?.start ?? null;
  const periodEnd = invoice.lines?.data?.[0]?.period?.end ?? null;

  const payload = {
    studio_id: studioId,
    studio_subscription_id: studioSubscriptionId,
    stripe_invoice_id: invoice.id,
    amount_due: Number(invoice.amount_due ?? 0) / 100,
    amount_paid: Number(invoice.amount_paid ?? 0) / 100,
    currency: (invoice.currency ?? "usd").toLowerCase(),
    status: invoice.status ?? "draft",
    invoice_pdf_url: invoice.invoice_pdf ?? null,
    hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    period_start: toIsoOrNull(getNumber(periodStart)),
    period_end: toIsoOrNull(getNumber(periodEnd)),
    updated_at: new Date().toISOString(),
  };

  const { data: existingInvoice, error: existingInvoiceError } = await supabase
    .from("studio_invoices")
    .select("id")
    .eq("stripe_invoice_id", invoice.id)
    .maybeSingle();

  if (existingInvoiceError) {
    throw new Error(existingInvoiceError.message);
  }

  if (existingInvoice) {
    const { error: updateError } = await supabase
      .from("studio_invoices")
      .update(payload)
      .eq("id", existingInvoice.id);

    if (updateError) {
      throw new Error(updateError.message);
    }
  } else {
    const { error: insertError } = await supabase
      .from("studio_invoices")
      .insert(payload);

    if (insertError) {
      throw new Error(insertError.message);
    }
  }

  return true;
}

async function handleStudioCheckoutCompleted(
  supabase: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session
) {
  const source = getString(session.metadata?.source);
  if (source !== "studio_subscription") return false;

  const studioId = getString(session.metadata?.studioId);
  const stripeCustomerId = getString(session.customer);
  const subscriptionId = getString(session.subscription);

  if (!studioId || !stripeCustomerId || !subscriptionId) {
    throw new Error("Studio subscription checkout missing required metadata.");
  }

  const customer = await stripe.customers.retrieve(stripeCustomerId);
  const contactName =
    !("deleted" in customer) || customer.deleted !== true ? customer.name : null;
  const billingEmail =
    !("deleted" in customer) || customer.deleted !== true ? customer.email : null;

  await upsertStudioBillingCustomer({
    supabase,
    stripeCustomerId,
    studioId,
    email: billingEmail,
    contactName,
  });

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await upsertStudioSubscription({
    supabase,
    stripe,
    subscription,
  });

  return true;
}

function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  );
}

async function safeQueuePaidEventRegistrationConfirmation(params: {
  supabase: SupabaseClient;
  registrationId: string;
}) {
  try {
    const { data: registration, error } = await params.supabase
      .from("event_registrations")
      .select(
        `
        id,
        studio_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        quantity,
        total_price,
        currency,
        events (
          slug,
          name
        ),
        event_ticket_types (
          name
        )
      `
      )
      .eq("id", params.registrationId)
      .single();

    if (error || !registration) {
      console.error(
        "paid event confirmation lookup failed:",
        error?.message ?? "Registration not found"
      );
      return;
    }

    const eventValue = Array.isArray(registration.events)
      ? registration.events[0]
      : registration.events;

    const ticketTypeValue = Array.isArray(registration.event_ticket_types)
      ? registration.event_ticket_types[0]
      : registration.event_ticket_types;

    if (!eventValue) {
      console.error("paid event confirmation lookup missing event");
      return;
    }

    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(eventValue.slug)}`;

    const emailTemplate = buildEventConfirmedEmailTemplate({
      eventName: eventValue.name,
      attendeeFirstName: registration.attendee_first_name,
      attendeeLastName: registration.attendee_last_name,
      ticketTypeName: ticketTypeValue?.name ?? "Event ticket",
      quantity: registration.quantity ?? 1,
      totalPrice: Number(registration.total_price ?? 0),
      currency: registration.currency || "USD",
      eventUrl,
    });

    const smsBody = buildEventConfirmedSmsTemplate({
      eventName: eventValue.name,
      attendeeFirstName: registration.attendee_first_name,
      attendeeLastName: registration.attendee_last_name,
      ticketTypeName: ticketTypeValue?.name ?? "Event ticket",
      quantity: registration.quantity ?? 1,
      totalPrice: Number(registration.total_price ?? 0),
      currency: registration.currency || "USD",
      eventUrl,
    });

    await Promise.allSettled([
      queueOutboundDelivery({
        studioId: registration.studio_id,
        channel: "email",
        templateKey: "event_registration_confirmed",
        recipientEmail: registration.attendee_email,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        relatedTable: "event_registrations",
        relatedId: registration.id,
        dedupeKey: `event_registration_confirmed:email:${registration.id}`,
      }),
      queueOutboundDelivery({
        studioId: registration.studio_id,
        channel: "sms",
        templateKey: "event_registration_confirmed",
        recipientPhone: registration.attendee_phone,
        bodyText: smsBody,
        relatedTable: "event_registrations",
        relatedId: registration.id,
        dedupeKey: `event_registration_confirmed:sms:${registration.id}`,
      }),
    ]);
  } catch (error) {
    console.error("queue paid event confirmation failed:", error);
  }
}

async function handleEventRegistrationCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session
) {
  const source = getString(session.metadata?.source);
  if (source !== "event_registration") return false;

  const registrationId = getString(session.metadata?.registration_id);
  if (!registrationId) {
    throw new Error("Event registration checkout missing registration_id metadata.");
  }

  if (session.payment_status !== "paid") {
    return true;
  }

  const paymentIntentId = getString(session.payment_intent);
  const sessionId = session.id;
  const amountTotal = Number(session.amount_total ?? 0) / 100;
  const currency = (session.currency ?? "usd").toUpperCase();

  const { error: registrationUpdateError } = await supabase
    .from("event_registrations")
    .update({
      payment_status: "paid",
      status: "confirmed",
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", registrationId);

  if (registrationUpdateError) {
    throw new Error(registrationUpdateError.message);
  }

  const { data: existingPayment, error: existingPaymentError } = await supabase
    .from("event_payments")
    .select("id")
    .eq("registration_id", registrationId)
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();

  if (existingPaymentError) {
    throw new Error(existingPaymentError.message);
  }

  if (existingPayment) {
    const { error: updatePaymentError } = await supabase
      .from("event_payments")
      .update({
        status: "paid",
        amount: amountTotal,
        currency,
        stripe_payment_intent_id: paymentIntentId,
        external_reference: sessionId,
        notes: "Completed by Stripe checkout.session.completed webhook.",
      })
      .eq("id", existingPayment.id);

    if (updatePaymentError) {
      throw new Error(updatePaymentError.message);
    }
  } else {
    const { error: insertPaymentError } = await supabase
      .from("event_payments")
      .insert({
        registration_id: registrationId,
        amount: amountTotal,
        currency,
        payment_method: "stripe_checkout",
        status: "paid",
        source: "stripe",
        stripe_checkout_session_id: sessionId,
        stripe_payment_intent_id: paymentIntentId,
        external_reference: sessionId,
        notes: "Created by Stripe checkout.session.completed webhook.",
      });

    if (insertPaymentError) {
      throw new Error(insertPaymentError.message);
    }
  }

  await safeQueuePaidEventRegistrationConfirmation({
    supabase,
    registrationId,
  });

  return true;
}

async function handleEventRegistrationRefundUpdated(
  supabase: SupabaseClient,
  refund: Stripe.Refund
) {
  const paymentIntentId = getString(refund.payment_intent);
  if (!paymentIntentId) return false;

  const amountRefunded = Number(refund.amount ?? 0) / 100;

  const { data: eventPayment, error: paymentLookupError } = await supabase
    .from("event_payments")
    .select(
      `
      id,
      registration_id,
      amount,
      refund_amount,
      stripe_payment_intent_id
    `
    )
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (paymentLookupError) {
    throw new Error(paymentLookupError.message);
  }

  if (!eventPayment) {
    return false;
  }

  const totalAmount = Number(eventPayment.amount ?? 0);
  const fullyRefunded = amountRefunded >= totalAmount;

  const { error: paymentUpdateError } = await supabase
    .from("event_payments")
    .update({
      status: fullyRefunded ? "refunded" : "partial",
      refund_amount: amountRefunded,
      refunded_at: new Date().toISOString(),
      notes: fullyRefunded
        ? "Refund synced from Stripe webhook."
        : "Partial refund synced from Stripe webhook.",
    })
    .eq("id", eventPayment.id);

  if (paymentUpdateError) {
    throw new Error(paymentUpdateError.message);
  }

  const registrationPayload: {
    payment_status: string;
    status?: string;
  } = {
    payment_status: fullyRefunded ? "refunded" : "partial",
  };

  if (fullyRefunded) {
    registrationPayload.status = "refunded";
  }

  const { error: registrationUpdateError } = await supabase
    .from("event_registrations")
    .update(registrationPayload)
    .eq("id", eventPayment.registration_id);

  if (registrationUpdateError) {
    throw new Error(registrationUpdateError.message);
  }

  return true;
}

async function handleCheckoutSessionCompleted(
  supabase: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session
) {
  const handledStudioSubscription = await handleStudioCheckoutCompleted(
    supabase,
    stripe,
    session
  );

  if (handledStudioSubscription) {
    return;
  }

  const handledEventRegistration = await handleEventRegistrationCheckoutCompleted(
    supabase,
    session
  );

  if (handledEventRegistration) {
    return;
  }

  const studioId = getString(session.metadata?.studioId);
  const clientId = getString(session.metadata?.clientId);
  const customerId = getString(session.customer);

  if (!studioId || !clientId || !customerId) {
    throw new Error("Missing checkout session metadata.");
  }

  if (session.mode === "setup") {
    const setupIntentId = getString(session.setup_intent);

    if (!setupIntentId) {
      throw new Error("Setup session missing setup intent.");
    }

    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const paymentMethodId = getString(setupIntent.payment_method);

    if (!paymentMethodId) {
      throw new Error("Setup intent missing payment method.");
    }

    await upsertStripePaymentMethodRecord(supabase, stripe, {
      studioId,
      clientId,
      customerId,
      paymentMethodId,
    });

    return;
  }

  if (session.mode === "subscription") {
    const subscriptionId = getString(session.subscription);

    if (!subscriptionId) {
      throw new Error("Subscription checkout session missing subscription id.");
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["default_payment_method", "customer"],
    });

    const defaultPaymentMethodId =
      typeof subscription.default_payment_method === "string"
        ? subscription.default_payment_method
        : subscription.default_payment_method?.id ?? null;

    let paymentMethodId = defaultPaymentMethodId;

    if (!paymentMethodId) {
      const customer = await stripe.customers.retrieve(customerId, {
        expand: ["invoice_settings.default_payment_method"],
      });

      if (!("deleted" in customer) || customer.deleted !== true) {
        paymentMethodId =
          typeof customer.invoice_settings?.default_payment_method === "string"
            ? customer.invoice_settings.default_payment_method
            : customer.invoice_settings?.default_payment_method?.id ?? null;
      }
    }

    if (!paymentMethodId) {
      return;
    }

    await upsertStripePaymentMethodRecord(supabase, stripe, {
      studioId,
      clientId,
      customerId,
      paymentMethodId,
    });
  }
}

async function handleInvoicePaid(
  supabase: SupabaseClient,
  stripe: Stripe,
  invoice: Stripe.Invoice
) {
  const studioInvoiceHandled = await upsertStudioInvoice({
    supabase,
    invoice,
  });

  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);

  if (studioInvoiceHandled && stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    await upsertStudioSubscription({
      supabase,
      stripe,
      subscription,
    });
  }

  const stripeInvoiceId = invoice.id;
  const stripeCustomerId = getString(invoice.customer);
  const paymentIntentId = getInvoicePaymentIntentId(invoice);
  const chargeId = getInvoiceChargeId(invoice);

  if (!stripeCustomerId) {
    throw new Error("Invoice missing customer id.");
  }

  const { data: existingPayment, error: existingPaymentError } = await supabase
    .from("payments")
    .select("id")
    .eq("stripe_invoice_id", stripeInvoiceId)
    .maybeSingle();

  if (existingPaymentError) {
    throw new Error(existingPaymentError.message);
  }

  if (existingPayment) {
    return;
  }

  let resolvedStudioId: string | null = null;
  let resolvedClientId: string | null = null;
  let resolvedClientMembershipId: string | null = null;

  if (stripeSubscriptionId) {
    const { data: localStripeSubscription, error: localStripeSubscriptionError } =
      await supabase
        .from("stripe_subscriptions")
        .select("studio_id, client_id, client_membership_id")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

    if (localStripeSubscriptionError) {
      throw new Error(localStripeSubscriptionError.message);
    }

    if (localStripeSubscription) {
      resolvedStudioId = localStripeSubscription.studio_id;
      resolvedClientId = localStripeSubscription.client_id;
      resolvedClientMembershipId = localStripeSubscription.client_membership_id;
    }
  }

  if ((!resolvedStudioId || !resolvedClientId) && stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);

    const studioIdFromMetadata = getString(subscription.metadata?.studioId);
    const clientIdFromMetadata = getString(subscription.metadata?.clientId);
    const localMembershipIdFromMetadata = getString(
      subscription.metadata?.localMembershipId
    );

    if (studioIdFromMetadata && clientIdFromMetadata) {
      resolvedStudioId = studioIdFromMetadata;
      resolvedClientId = clientIdFromMetadata;
      resolvedClientMembershipId =
        localMembershipIdFromMetadata ?? resolvedClientMembershipId;

      const currentPeriodStartUnix = getNumber(
        (subscription as unknown as { current_period_start?: number }).current_period_start
      );
      const currentPeriodEndUnix = getNumber(
        (subscription as unknown as { current_period_end?: number }).current_period_end
      );

      const latestInvoiceId =
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id ?? null;

      const defaultPaymentMethodId =
        typeof subscription.default_payment_method === "string"
          ? subscription.default_payment_method
          : subscription.default_payment_method?.id ?? null;

      const { data: existingStripeSubscription, error: existingStripeSubscriptionError } =
        await supabase
          .from("stripe_subscriptions")
          .select("id")
          .eq("stripe_subscription_id", stripeSubscriptionId)
          .maybeSingle();

      if (existingStripeSubscriptionError) {
        throw new Error(existingStripeSubscriptionError.message);
      }

      const subscriptionPayload = {
        studio_id: resolvedStudioId,
        client_id: resolvedClientId,
        client_membership_id: resolvedClientMembershipId,
        membership_plan_id: getString(subscription.metadata?.membershipPlanId),
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_price_id: getString(subscription.items.data[0]?.price?.id) ?? null,
        status: subscription.status,
        current_period_start: toIsoOrNull(currentPeriodStartUnix),
        current_period_end: toIsoOrNull(currentPeriodEndUnix),
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        default_payment_method_id: defaultPaymentMethodId,
        latest_invoice_id: latestInvoiceId,
        updated_at: new Date().toISOString(),
      };

      if (existingStripeSubscription) {
        const { error: updateStripeSubscriptionError } = await supabase
          .from("stripe_subscriptions")
          .update(subscriptionPayload)
          .eq("id", existingStripeSubscription.id);

        if (updateStripeSubscriptionError) {
          throw new Error(updateStripeSubscriptionError.message);
        }
      } else {
        const { error: insertStripeSubscriptionError } = await supabase
          .from("stripe_subscriptions")
          .insert({
            ...subscriptionPayload,
            created_at: new Date().toISOString(),
          });

        if (insertStripeSubscriptionError) {
          throw new Error(insertStripeSubscriptionError.message);
        }
      }
    }
  }

  if ((!resolvedStudioId || !resolvedClientId) && stripeCustomerId) {
    const { data: stripeCustomerRow, error: stripeCustomerRowError } = await supabase
      .from("stripe_customers")
      .select("studio_id, client_id")
      .eq("stripe_customer_id", stripeCustomerId)
      .maybeSingle();

    if (stripeCustomerRowError) {
      throw new Error(stripeCustomerRowError.message);
    }

    if (stripeCustomerRow) {
      resolvedStudioId = stripeCustomerRow.studio_id;
      resolvedClientId = stripeCustomerRow.client_id;
    }
  }

  if (!resolvedStudioId || !resolvedClientId) {
    return;
  }

  const amountPaid = Number(invoice.amount_paid ?? 0) / 100;
  const currency = (invoice.currency ?? "usd").toLowerCase();
  const invoiceNumber = getString(invoice.number);
  const notes = invoiceNumber
    ? `Stripe invoice ${invoiceNumber}`
    : "Stripe invoice payment";

  const { error: paymentInsertError } = await supabase.from("payments").insert({
    studio_id: resolvedStudioId,
    client_id: resolvedClientId,
    client_membership_id: resolvedClientMembershipId,
    amount: amountPaid,
    payment_method: "card",
    status: "paid",
    notes,
    source: "stripe",
    payment_type: "membership",
    stripe_payment_intent_id: paymentIntentId,
    stripe_invoice_id: stripeInvoiceId,
    stripe_charge_id: chargeId,
    currency,
  });

  if (paymentInsertError) {
    throw new Error(paymentInsertError.message);
  }

  if (resolvedClientMembershipId) {
    const currentPeriodEndUnix = getNumber(
      invoice.lines?.data?.[0]?.period?.end ?? null
    );

    const { error: membershipUpdateError } = await supabase
      .from("client_memberships")
      .update({
        status: "active",
        current_period_end: toDateOnlyOrNull(currentPeriodEndUnix) ?? undefined,
      })
      .eq("id", resolvedClientMembershipId)
      .eq("studio_id", resolvedStudioId);

    if (membershipUpdateError) {
      throw new Error(membershipUpdateError.message);
    }
  }
}

async function handleInvoicePaymentFailed(
  supabase: SupabaseClient,
  stripe: Stripe,
  invoice: Stripe.Invoice
) {
  const studioInvoiceHandled = await upsertStudioInvoice({
    supabase,
    invoice,
  });

  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);

  if (studioInvoiceHandled && stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    await upsertStudioSubscription({
      supabase,
      stripe,
      subscription,
    });
  }

  if (!stripeSubscriptionId) return;

  const { data: stripeSubscription, error: stripeSubscriptionError } = await supabase
    .from("stripe_subscriptions")
    .select("studio_id, client_id, client_membership_id")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();

  if (stripeSubscriptionError) {
    throw new Error(stripeSubscriptionError.message);
  }

  if (!stripeSubscription?.studio_id || !stripeSubscription?.client_membership_id) {
    return;
  }

  const { error: membershipUpdateError } = await supabase
    .from("client_memberships")
    .update({
      status: "past_due",
    })
    .eq("id", stripeSubscription.client_membership_id)
    .eq("studio_id", stripeSubscription.studio_id);

  if (membershipUpdateError) {
    throw new Error(membershipUpdateError.message);
  }
}

export async function POST(request: Request) {
  const stripe = getStripe();
  const body = await request.text();
  const headerList = await headers();
  const signature = headerList.get("stripe-signature");
  const webhookSecrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  if (webhookSecrets.length === 0) {
    return new Response(
      "Missing STRIPE_WEBHOOK_SECRET or STRIPE_CONNECT_WEBHOOK_SECRET",
      { status: 400 }
    );
  }

  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event | null = null;
  let lastSignatureError: unknown = null;

  for (const webhookSecret of webhookSecrets) {
    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
      break;
    } catch (error) {
      lastSignatureError = error;
    }
  }

  if (!event) {
    const message =
      lastSignatureError instanceof Error
        ? lastSignatureError.message
        : "Unknown signature error";
    return new Response(`Invalid signature: ${message}`, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const payloadHash = createHash("sha256").update(body).digest("hex");

  const { data: existingEvent, error: existingEventError } = await supabase
    .from("payment_provider_events")
    .select("id, status")
    .eq("provider", "stripe")
    .eq("provider_event_id", event.id)
    .maybeSingle();

  if (existingEventError) {
    return new Response("Event lookup failed", { status: 500 });
  }

  if (existingEvent) {
    return new Response("Already processed", { status: 200 });
  }

  const { error: insertEventError } = await supabase
    .from("payment_provider_events")
    .insert({
      provider: "stripe",
      provider_event_id: event.id,
      event_type: event.type,
      status: "received",
      payload_hash: payloadHash,
    });

  if (insertEventError) {
    return new Response(`Event logging failed: ${insertEventError.message}`, {
      status: 500,
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutSessionCompleted(
          supabase,
          stripe,
          event.data.object as Stripe.Checkout.Session
        );
        break;
      }

      case "refund.created":
      case "refund.updated": {
        await handleEventRegistrationRefundUpdated(
          supabase,
          event.data.object as Stripe.Refund
        );
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        if (charge.payment_intent) {
          await handleEventRegistrationRefundUpdated(supabase, {
            id: charge.id,
            object: "refund",
            amount: charge.amount_refunded,
            payment_intent:
              typeof charge.payment_intent === "string"
                ? charge.payment_intent
                : charge.payment_intent.id,
          } as Stripe.Refund);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;

        await upsertStudioSubscription({
          supabase,
          stripe,
          subscription,
        });

        await upsertStripeSubscriptionRecord(supabase, subscription);
        break;
      }

      case "invoice.paid": {
        await handleInvoicePaid(
          supabase,
          stripe,
          event.data.object as Stripe.Invoice
        );
        break;
      }

      case "invoice.payment_failed": {
        await handleInvoicePaymentFailed(
          supabase,
          stripe,
          event.data.object as Stripe.Invoice
        );
        break;
      }

      default:
        break;
    }

    const { error: processedError } = await supabase
      .from("payment_provider_events")
      .update({
        status: "processed",
        processed_at: new Date().toISOString(),
      })
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id);

    if (processedError) {
      return new Response(`Event finalization failed: ${processedError.message}`, {
        status: 500,
      });
    }

    return new Response(`Webhook processed: ${event.type}`, { status: 200 });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown webhook error";

    await supabase
      .from("payment_provider_events")
      .update({
        status: "failed",
        error_message: errorMessage,
      })
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id);

    return new Response(`Webhook processing failed: ${errorMessage}`, {
      status: 500,
    });
  }
}