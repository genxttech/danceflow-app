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

async function syncStudioBillingSnapshot(params: {
  supabase: SupabaseClient;
  studioId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  subscriptionStatus: string;
  trialEndsAt?: string | null;
}) {
  const {
    supabase,
    studioId,
    stripeCustomerId,
    stripeSubscriptionId,
    subscriptionStatus,
    trialEndsAt = null,
  } = params;

  const { error } = await supabase
    .from("studios")
    .update({
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      subscription_status: mapStudioSubscriptionStatus(subscriptionStatus),
      trial_ends_at: trialEndsAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", studioId);

  if (error) {
    throw new Error(error.message);
  }
}

async function getStudioIdFromStripeCustomer(params: {
  supabase: SupabaseClient;
  stripeCustomerId: string | null;
}) {
  const { supabase, stripeCustomerId } = params;

  if (!stripeCustomerId) return null;

  const { data, error } = await supabase
    .from("studio_billing_customers")
    .select("studio_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data?.studio_id ?? null;
}

function getSubscriptionSource(subscription: Stripe.Subscription) {
  const source = getString(subscription.metadata?.source);
  if (source === "studio_subscription" || source === "organizer_subscription") {
    return source;
  }
  return null;
}


const ORGANIZER_SUITE_FEATURE_KEY = "organizer_suite";

function getOrganizerSuiteAddonPriceIds() {
  return new Set(
    [
      process.env.STRIPE_PRICE_ORGANIZER_SUITE_ADDON_STANDARD?.trim() || null,
      process.env.STRIPE_PRICE_ORGANIZER_SUITE_ADDON_FOUNDER?.trim() || null,
    ].filter((value): value is string => Boolean(value)),
  );
}

function isOrganizerSuiteSubscriptionItem(item: Stripe.SubscriptionItem) {
  const priceIds = getOrganizerSuiteAddonPriceIds();
  const priceId = item.price?.id ?? null;
  const featureKey = getString(item.metadata?.featureKey);
  const source = getString(item.metadata?.source);

  return (
    featureKey === ORGANIZER_SUITE_FEATURE_KEY ||
    source === "organizer_suite_addon" ||
    Boolean(priceId && priceIds.has(priceId))
  );
}

async function syncOrganizerSuiteAddonEntitlements(params: {
  supabase: SupabaseClient;
  studioId: string;
  subscription: Stripe.Subscription;
}) {
  const { supabase, studioId, subscription } = params;
  const now = new Date().toISOString();
  const subscriptionIsActive = subscription.status === "active" || subscription.status === "trialing";
  const organizerSuiteItems = subscription.items.data.filter(isOrganizerSuiteSubscriptionItem);
  const activeItemIds = new Set(organizerSuiteItems.map((item) => item.id));

  for (const item of organizerSuiteItems) {
    const { error } = await supabase
      .from("usage_addon_entitlements")
      .upsert(
  {
    studio_id: studioId,
    workspace_type: "studio",
    feature_key: ORGANIZER_SUITE_FEATURE_KEY,
    source: "stripe_subscription_item",
    stripe_subscription_item_id: item.id,
    quantity_included: 1,
    status: subscriptionIsActive ? "active" : "canceled",
    updated_at: now,
  },
  { onConflict: "studio_id,feature_key" },
);

    if (error) {
      throw new Error(error.message);
    }
  }

  const { data: existingEntitlements, error: existingEntitlementsError } = await supabase
    .from("usage_addon_entitlements")
    .select("id, stripe_subscription_item_id, status")
    .eq("studio_id", studioId)
    .eq("feature_key", ORGANIZER_SUITE_FEATURE_KEY)
    .eq("source", "stripe_subscription_item");

  if (existingEntitlementsError) {
    throw new Error(existingEntitlementsError.message);
  }

  const staleEntitlementIds = (existingEntitlements ?? [])
    .filter((row) => {
      const itemId = typeof row.stripe_subscription_item_id === "string" ? row.stripe_subscription_item_id : null;
      return row.status === "active" && (!itemId || !activeItemIds.has(itemId) || !subscriptionIsActive);
    })
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");

  if (staleEntitlementIds.length > 0) {
    const { error } = await supabase
      .from("usage_addon_entitlements")
      .update({ status: "canceled", updated_at: now })
      .in("id", staleEntitlementIds);

    if (error) {
      throw new Error(error.message);
    }
  }
}

async function upsertStudioSubscription(params: {
  supabase: SupabaseClient;
  stripe: Stripe;
  subscription: Stripe.Subscription;
}) {
  const { supabase, subscription } = params;

  const metadata = subscription.metadata ?? {};
  const stripeCustomerId = getString(subscription.customer);
  const source = getSubscriptionSource(subscription);

  if (!source) {
    return false;
  }

  const metadataStudioId = getString(metadata.studioId) ?? getString(metadata.workspaceId);

  const studioId =
    metadataStudioId ??
    (await getStudioIdFromStripeCustomer({
      supabase,
      stripeCustomerId,
    }));

  if (!studioId || !stripeCustomerId) {
    return false;
  }

  const metadataPlanCode = getString(metadata.planCode);
  const stripePriceId = getString(subscription.items.data[0]?.price?.id);

  const currentPeriodStartUnix = getNumber(
    (subscription as unknown as { current_period_start?: number }).current_period_start
  );
  const currentPeriodEndUnix = getNumber(
    (subscription as unknown as { current_period_end?: number }).current_period_end
  );

  const trialEndUnix = getNumber(
  (subscription as unknown as { trial_end?: number | null }).trial_end ?? null
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
      `Could not resolve subscription plan for ${subscription.id}. stripePriceId=${stripePriceId || "null"} metadata.planCode=${metadataPlanCode || "null"}`
    );
  }

  const billingInterval =
    stripePriceId && planRow.stripe_price_id_yearly === stripePriceId ? "year" : "month";

  const mappedStatus = mapStudioSubscriptionStatus(subscription.status);

  const payload = {
    studio_id: studioId,
    subscription_plan_id: planRow.id,
    stripe_subscription_id: subscription.id,
    status: mappedStatus,
    billing_interval: billingInterval,
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

  await upsertStudioBillingCustomer({
    supabase,
    stripeCustomerId,
    studioId,
  });

  await syncStudioBillingSnapshot({
    supabase,
    studioId,
    stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
  });


  if (source === "studio_subscription") {
    await syncOrganizerSuiteAddonEntitlements({
      supabase,
      studioId,
      subscription,
    });
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

  if (source !== "studio_subscription" && source !== "organizer_subscription") {
    return false;
  }

  const studioId = getString(session.metadata?.studioId);
  const stripeCustomerId = getString(session.customer);
  const subscriptionId = getString(session.subscription);
  const planCode = getString(session.metadata?.planCode);

  if (!studioId || !stripeCustomerId || !subscriptionId) {
    throw new Error("Subscription checkout missing required metadata.");
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

  const subscriptionWithMergedMetadata = {
    ...subscription,
    metadata: {
      ...(subscription.metadata ?? {}),
      studioId,
      ...(planCode ? { planCode } : {}),
      source,
    },
  } as Stripe.Subscription;

  await upsertStudioSubscription({
    supabase,
    stripe,
    subscription: subscriptionWithMergedMetadata,
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


type EventRegistrationCrmCaptureRow = {
  id: string;
  event_id: string;
  studio_id: string | null;
  client_id: string | null;
  organizer_contact_id?: string | null;
  order_id?: string | null;
  ticket_type_id?: string | null;
  status?: string | null;
  payment_status?: string | null;
  total_amount?: number | null;
  total_price?: number | null;
  currency?: string | null;
  checked_in_at?: string | null;
  created_at?: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  events:
    | {
        id: string;
        name: string;
        slug: string | null;
        studio_id: string | null;
        organizer_id: string | null;
      }
    | {
        id: string;
        name: string;
        slug: string | null;
        studio_id: string | null;
        organizer_id: string | null;
      }[]
    | null;
};

function getSingleRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalizeEmail(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

async function safeCaptureStudioEventRegistrationLead(params: {
  supabase: SupabaseClient;
  registrationId: string;
}) {
  try {
    const { data: registration, error: registrationError } = await params.supabase
      .from("event_registrations")
      .select(
        `
        id,
        event_id,
        studio_id,
        client_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        events (
          id,
          name,
          slug,
          studio_id,
          organizer_id
        )
      `
      )
      .eq("id", params.registrationId)
      .maybeSingle();

    if (registrationError || !registration) {
      console.error(
        "event registration CRM capture lookup failed:",
        registrationError?.message ?? "Registration not found"
      );
      return;
    }

    const typedRegistration = registration as EventRegistrationCrmCaptureRow;
    const event = getSingleRelation(typedRegistration.events);

    if (!event) {
      console.error("event registration CRM capture missing event");
      return;
    }

    // Organizer-owned events are intentionally not pushed into the linked studio CRM yet.
    // They should remain organizer-scoped until Organizer Contacts/Campaigns is built.
    if (event.organizer_id) {
      return;
    }

    const studioId = event.studio_id ?? typedRegistration.studio_id;
    const email = normalizeEmail(typedRegistration.attendee_email);

    if (!studioId || !email) {
      return;
    }

    const firstName = (typedRegistration.attendee_first_name ?? "").trim() || "Event";
    const lastName = (typedRegistration.attendee_last_name ?? "").trim() || "Registrant";
    const nowIso = new Date().toISOString();

    let clientId = typedRegistration.client_id;

    if (!clientId) {
      const { data: existingClients, error: existingClientError } = await params.supabase
        .from("clients")
        .select("id, referral_source, source_system, status")
        .eq("studio_id", studioId)
        .ilike("email", email)
        .order("created_at", { ascending: true })
        .limit(1);

      if (existingClientError) {
        console.error("event registration CRM capture client lookup failed:", existingClientError.message);
        return;
      }

      const existingClient = existingClients?.[0] ?? null;

      if (existingClient) {
        clientId = existingClient.id;

        const clientUpdatePayload: Record<string, string | null> = {};

        if (!existingClient.referral_source) {
          clientUpdatePayload.referral_source = "Event Registration";
        }

        if (!existingClient.source_system) {
          clientUpdatePayload.source_system = "event_registration";
        }

        if (Object.keys(clientUpdatePayload).length > 0) {
          const { error: clientUpdateError } = await params.supabase
            .from("clients")
            .update(clientUpdatePayload)
            .eq("id", existingClient.id);

          if (clientUpdateError) {
            console.error("event registration CRM capture client update failed:", clientUpdateError.message);
          }
        }
      } else {
        const { data: insertedClient, error: insertClientError } = await params.supabase
          .from("clients")
          .insert({
            studio_id: studioId,
            first_name: firstName,
            last_name: lastName,
            email,
            phone: typedRegistration.attendee_phone || null,
            status: "lead",
            referral_source: "Event Registration",
            source_system: "event_registration",
            notes: `Created from event registration for ${event.name}.`,
          })
          .select("id")
          .single();

        if (insertClientError || !insertedClient) {
          console.error(
            "event registration CRM capture client insert failed:",
            insertClientError?.message ?? "Client not created"
          );
          return;
        }

        clientId = insertedClient.id;
      }
    }

    if (clientId) {
      const { error: registrationClientUpdateError } = await params.supabase
        .from("event_registrations")
        .update({ client_id: clientId })
        .eq("id", typedRegistration.id)
        .is("client_id", null);

      if (registrationClientUpdateError) {
        console.error(
          "event registration CRM capture registration link failed:",
          registrationClientUpdateError.message
        );
      }

      const { error: notificationError } = await params.supabase
        .from("notifications")
        .insert({
          studio_id: studioId,
          client_id: clientId,
          type: "event_registration",
          title: "New event registration",
          body: `${firstName} ${lastName} registered for ${event.name}.`,
        });

      // Keep webhook finalization safe even if notification type constraints need a later schema update.
      if (notificationError) {
        console.error("event registration notification insert failed:", notificationError.message);
      }
    }
  } catch (error) {
    console.error("event registration CRM capture failed:", error);
  }
}


async function safeCaptureOrganizerEventRegistrationContact(params: {
  supabase: SupabaseClient;
  registrationId: string;
}) {
  try {
    const { data: registration, error: registrationError } = await params.supabase
      .from("event_registrations")
      .select(
        `
        id,
        event_id,
        studio_id,
        client_id,
        organizer_contact_id,
        order_id,
        ticket_type_id,
        status,
        payment_status,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        total_amount,
        total_price,
        currency,
        checked_in_at,
        created_at,
        events (
          id,
          name,
          slug,
          studio_id,
          organizer_id
        )
      `
      )
      .eq("id", params.registrationId)
      .maybeSingle();

    if (registrationError || !registration) {
      console.error(
        "organizer contact capture lookup failed:",
        registrationError?.message ?? "Registration not found"
      );
      return;
    }

    const typedRegistration = registration as EventRegistrationCrmCaptureRow;
    const event = getSingleRelation(typedRegistration.events);
    const organizerId = event?.organizer_id ?? null;
    const email = normalizeEmail(typedRegistration.attendee_email);

    if (!event || !organizerId || !email) {
      return;
    }

    const firstName = (typedRegistration.attendee_first_name ?? "").trim() || null;
    const lastName = (typedRegistration.attendee_last_name ?? "").trim() || null;
    const phone = (typedRegistration.attendee_phone ?? "").trim() || null;
    const nowIso = new Date().toISOString();
    const amount = Number(
      typedRegistration.total_amount ?? typedRegistration.total_price ?? 0
    );
    const currency = (typedRegistration.currency || "USD").toUpperCase();

    const { data: existingContacts, error: existingContactError } = await params.supabase
      .from("organizer_contacts")
      .select("id, first_seen_at, first_name, last_name, phone")
      .eq("organizer_id", organizerId)
      .ilike("email", email)
      .order("created_at", { ascending: true })
      .limit(1);

    if (existingContactError) {
      console.error("organizer contact lookup failed:", existingContactError.message);
      return;
    }

    let contactId = existingContacts?.[0]?.id ?? null;

    if (contactId) {
      const existingContact = existingContacts?.[0];
      const { error: contactUpdateError } = await params.supabase
        .from("organizer_contacts")
        .update({
          first_name: existingContact?.first_name || firstName,
          last_name: existingContact?.last_name || lastName,
          phone: existingContact?.phone || phone,
          last_seen_at: nowIso,
          last_event_id: event.id,
          last_registration_id: typedRegistration.id,
          currency,
          updated_at: nowIso,
        })
        .eq("id", contactId);

      if (contactUpdateError) {
        console.error("organizer contact update failed:", contactUpdateError.message);
        return;
      }
    } else {
      const { data: insertedContact, error: contactInsertError } = await params.supabase
        .from("organizer_contacts")
        .insert({
          organizer_id: organizerId,
          email,
          first_name: firstName,
          last_name: lastName,
          phone,
          source: "event_registration",
          first_seen_at: nowIso,
          last_seen_at: nowIso,
          last_event_id: event.id,
          last_registration_id: typedRegistration.id,
          currency,
          metadata: {
            event_name: event.name,
            event_slug: event.slug,
          },
        })
        .select("id")
        .single();

      if (contactInsertError || !insertedContact) {
        console.error(
          "organizer contact insert failed:",
          contactInsertError?.message ?? "Contact not created"
        );
        return;
      }

      contactId = insertedContact.id;
    }

    if (!contactId) {
      return;
    }

    const { error: linkError } = await params.supabase
      .from("organizer_contact_registrations")
      .upsert(
        {
          organizer_contact_id: contactId,
          organizer_id: organizerId,
          event_id: typedRegistration.event_id,
          registration_id: typedRegistration.id,
          order_id: typedRegistration.order_id ?? null,
          ticket_type_id: typedRegistration.ticket_type_id ?? null,
          status: typedRegistration.status ?? null,
          payment_status: typedRegistration.payment_status ?? null,
          total_amount: amount,
          currency,
          checked_in_at: typedRegistration.checked_in_at ?? null,
          registered_at: typedRegistration.created_at ?? nowIso,
          updated_at: nowIso,
        },
        { onConflict: "registration_id" }
      );

    if (linkError) {
      console.error("organizer contact registration link failed:", linkError.message);
    }

    const { error: registrationUpdateError } = await params.supabase
      .from("event_registrations")
      .update({ organizer_contact_id: contactId })
      .eq("id", typedRegistration.id)
      .is("organizer_contact_id", null);

    if (registrationUpdateError) {
      console.error(
        "organizer contact registration update failed:",
        registrationUpdateError.message
      );
    }

    const { data: contactRollupRows, error: rollupError } = await params.supabase
      .from("organizer_contact_registrations")
      .select("payment_status, total_amount, currency")
      .eq("organizer_contact_id", contactId);

    if (rollupError) {
      console.error("organizer contact rollup failed:", rollupError.message);
      return;
    }

    const totalRegistrations = contactRollupRows?.length ?? 0;
    const paidRows = (contactRollupRows ?? []).filter(
      (row) => row.payment_status === "paid" || row.payment_status === "partial"
    );
    const totalPaidRegistrations = paidRows.length;
    const totalSpend = paidRows.reduce(
      (sum, row) => sum + Number(row.total_amount ?? 0),
      0
    );

    const { error: rollupUpdateError } = await params.supabase
      .from("organizer_contacts")
      .update({
        total_registrations: totalRegistrations,
        total_paid_registrations: totalPaidRegistrations,
        total_spend: totalSpend,
        currency,
        last_seen_at: nowIso,
        last_event_id: event.id,
        last_registration_id: typedRegistration.id,
        updated_at: nowIso,
      })
      .eq("id", contactId);

    if (rollupUpdateError) {
      console.error("organizer contact rollup update failed:", rollupUpdateError.message);
    }
  } catch (error) {
    console.error("organizer contact capture failed:", error);
  }
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
        ),
        event_registration_attendees (
          first_name,
          last_name,
          ticket_code
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

    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(
      eventValue.slug
    )}`;

    const attendeeRows = Array.isArray(
      (registration as any).event_registration_attendees
    )
      ? (registration as any).event_registration_attendees
      : [];

    const ticketCodes = attendeeRows
      .map((attendee: any) => {
        const name = `${attendee.first_name ?? ""} ${
          attendee.last_name ?? ""
        }`.trim();

        const code =
          typeof attendee.ticket_code === "string"
            ? attendee.ticket_code.trim()
            : "";

        return code ? { name: name || "Attendee", code } : null;
      })
      .filter(Boolean) as Array<{ name: string; code: string }>;

    const emailTemplate = buildEventConfirmedEmailTemplate({
      eventName: eventValue.name,
      attendeeFirstName: registration.attendee_first_name,
      attendeeLastName: registration.attendee_last_name,
      ticketTypeName: ticketTypeValue?.name ?? "Event ticket",
      quantity: registration.quantity ?? 1,
      totalPrice: Number(registration.total_price ?? 0),
      currency: registration.currency || "USD",
      eventUrl,
      ticketCodes,
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
        bodyHtml: emailTemplate.bodyHtml,
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


type EventOrderItemConfirmationRow = {
  item_type: string | null;
  description: string | null;
  quantity: number | null;
  total_price: number | null;
  currency: string | null;
  attendee_names: unknown;
};

type EventOrderRegistrationConfirmationRow = {
  id: string;
  studio_id: string | null;
  attendee_first_name: string | null;
  attendee_last_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  quantity: number | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
  event_ticket_types:
    | { name: string | null }
    | { name: string | null }[]
    | null;
  event_registration_attendees:
    | Array<{
        first_name: string | null;
        last_name: string | null;
        ticket_code: string | null;
      }>
    | null;
};

async function safeQueuePaidEventCartOrderConfirmation(params: {
  supabase: SupabaseClient;
  orderId: string;
}) {
  try {
    const { data: order, error: orderError } = await params.supabase
      .from("event_orders")
      .select(
        `
        id,
        studio_id,
        buyer_name,
        buyer_email,
        buyer_phone,
        total_amount,
        currency,
        events (
          slug,
          name
        )
      `
      )
      .eq("id", params.orderId)
      .maybeSingle();

    if (orderError || !order) {
      console.error(
        "paid event cart confirmation order lookup failed:",
        orderError?.message ?? "Order not found"
      );
      return;
    }

    const eventValue = Array.isArray(order.events) ? order.events[0] : order.events;

    if (!eventValue) {
      console.error("paid event cart confirmation missing event");
      return;
    }

    const { data: registrations, error: registrationsError } = await params.supabase
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
        total_amount,
        currency,
        event_ticket_types (
          name
        ),
        event_registration_attendees (
          first_name,
          last_name,
          ticket_code
        )
      `
      )
      .eq("order_id", params.orderId)
      .order("created_at", { ascending: true });

    if (registrationsError) {
      console.error("paid event cart confirmation registrations lookup failed:", registrationsError.message);
      return;
    }

    const typedRegistrations = (registrations ?? []) as EventOrderRegistrationConfirmationRow[];
    const primaryRegistration = typedRegistrations[0] ?? null;

    if (!primaryRegistration) {
      console.error("paid event cart confirmation missing registrations");
      return;
    }

    const { data: orderItems, error: orderItemsError } = await params.supabase
      .from("event_order_items")
      .select("item_type, description, quantity, total_price, currency, attendee_names, created_at")
      .eq("order_id", params.orderId)
      .order("created_at", { ascending: true });

    if (orderItemsError) {
      console.error("paid event cart confirmation order items lookup failed:", orderItemsError.message);
      return;
    }

    const typedOrderItems = (orderItems ?? []) as EventOrderItemConfirmationRow[];
    const currency = (order.currency || primaryRegistration.currency || "USD").toUpperCase();
    const eventUrl = `${getAppUrl()}/events/${encodeURIComponent(eventValue.slug)}`;
    const buyerName = String(order.buyer_name || "").trim();
    const firstName = buyerName.split(/\s+/)[0] || primaryRegistration.attendee_first_name || "there";
    const lastName = buyerName.split(/\s+/).slice(1).join(" ") || primaryRegistration.attendee_last_name || "";

    const purchasedItems = typedOrderItems.map((item) => ({
      name: item.description || (item.item_type === "coach_slot" ? "Private lesson" : "Event ticket"),
      quantity: Number(item.quantity ?? 1),
      totalPrice: Number(item.total_price ?? 0),
    }));

    const registrationItems = typedRegistrations.map((registration) => {
      const ticketType = Array.isArray(registration.event_ticket_types)
        ? registration.event_ticket_types[0]
        : registration.event_ticket_types;

      return {
        name: ticketType?.name || "Event ticket",
        quantity: Number(registration.quantity ?? 1),
        totalPrice: Number(registration.total_price ?? registration.total_amount ?? 0),
      };
    });

    const finalPurchasedItems = purchasedItems.length > 0 ? purchasedItems : registrationItems;
    const ticketCodes = typedRegistrations.flatMap((registration) => {
      const attendeeRows = Array.isArray(registration.event_registration_attendees)
        ? registration.event_registration_attendees
        : [];

      return attendeeRows
        .map((attendee) => {
          const code = typeof attendee.ticket_code === "string" ? attendee.ticket_code.trim() : "";
          if (!code) return null;

          const name = `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`.trim();
          return { name: name || "Attendee", code };
        })
        .filter(Boolean) as Array<{ name: string; code: string }>;
    });

    const ticketQuantity = registrationItems.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
    const coachSlotQuantity = typedOrderItems
      .filter((item) => item.item_type === "coach_slot")
      .reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
    const totalQuantity = ticketQuantity + coachSlotQuantity || 1;
    const totalPrice = Number(order.total_amount ?? 0);
    const firstTicketName = registrationItems[0]?.name ?? "Event registration";

    const emailTemplate = buildEventConfirmedEmailTemplate({
      eventName: eventValue.name,
      attendeeFirstName: firstName,
      attendeeLastName: lastName,
      ticketTypeName: firstTicketName,
      quantity: totalQuantity,
      totalPrice,
      currency,
      eventUrl,
      ticketCodes,
      purchasedItems: finalPurchasedItems,
    });

    const smsBody = buildEventConfirmedSmsTemplate({
      eventName: eventValue.name,
      attendeeFirstName: firstName,
      attendeeLastName: lastName,
      ticketTypeName: firstTicketName,
      quantity: totalQuantity,
      totalPrice,
      currency,
      eventUrl,
    });

    await Promise.allSettled([
      queueOutboundDelivery({
        studioId: order.studio_id ?? primaryRegistration.studio_id,
        channel: "email",
        templateKey: "event_registration_confirmed",
        recipientEmail: order.buyer_email ?? primaryRegistration.attendee_email,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        bodyHtml: emailTemplate.bodyHtml,
        relatedTable: "event_registrations",
        relatedId: primaryRegistration.id,
        dedupeKey: `event_cart_order_confirmed:email:${order.id}`,
      }),
      queueOutboundDelivery({
        studioId: order.studio_id ?? primaryRegistration.studio_id,
        channel: "sms",
        templateKey: "event_registration_confirmed",
        recipientPhone: order.buyer_phone ?? primaryRegistration.attendee_phone,
        bodyText: smsBody,
        relatedTable: "event_registrations",
        relatedId: primaryRegistration.id,
        dedupeKey: `event_cart_order_confirmed:sms:${order.id}`,
      }),
    ]);
  } catch (error) {
    console.error("queue paid event cart order confirmation failed:", error);
  }
}

async function handleEventRegistrationCheckoutCompleted(
  supabase: SupabaseClient,
  stripe: Stripe,
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

  if (paymentIntentId) {
    await syncFeeDetailsForPaymentIntent(supabase, stripe, paymentIntentId);
  }

  await safeQueuePaidEventRegistrationConfirmation({
    supabase,
    registrationId,
  });

  await safeCaptureStudioEventRegistrationLead({
    supabase,
    registrationId,
  });

  await safeCaptureOrganizerEventRegistrationContact({
    supabase,
    registrationId,
  });

  return true;
}



async function handleEventCartOrderCheckoutCompleted(
  supabase: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session
) {
  const source = getString(session.metadata?.source);
  if (source !== "event_cart_order") return false;

  const orderId = getString(session.metadata?.order_id);
  if (!orderId) {
    throw new Error("Event cart checkout missing order_id metadata.");
  }

  if (session.payment_status !== "paid") {
    return true;
  }

  const paymentIntentId = getString(session.payment_intent);
  const sessionId = session.id;
  const amountTotal = Number(session.amount_total ?? 0) / 100;
  const currency = (session.currency ?? "usd").toUpperCase();
  const paidAt = new Date().toISOString();

  const { error: orderUpdateError } = await supabase
    .from("event_orders")
    .update({
      status: "confirmed",
      payment_status: "paid",
      stripe_checkout_session_id: sessionId,
      stripe_payment_intent_id: paymentIntentId,
      total_amount: amountTotal,
      currency,
      paid_at: paidAt,
      updated_at: paidAt,
    })
    .eq("id", orderId);

  if (orderUpdateError) {
    throw new Error(orderUpdateError.message);
  }

  const { data: registrations, error: registrationsError } = await supabase
    .from("event_registrations")
    .select("id, total_price, currency, payment_status")
    .eq("order_id", orderId);

  if (registrationsError) {
    throw new Error(registrationsError.message);
  }

  for (const registration of registrations ?? []) {
    const { error: registrationUpdateError } = await supabase
      .from("event_registrations")
      .update({
        status: "confirmed",
        payment_status: "paid",
        stripe_checkout_session_id: sessionId,
        stripe_payment_intent_id: paymentIntentId,
      })
      .eq("id", registration.id);

    if (registrationUpdateError) {
      throw new Error(registrationUpdateError.message);
    }

    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from("event_payments")
      .select("id")
      .eq("registration_id", registration.id)
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();

    if (existingPaymentError) {
      throw new Error(existingPaymentError.message);
    }

    if (!existingPayment) {
      const { error: paymentInsertError } = await supabase
        .from("event_payments")
        .insert({
          registration_id: registration.id,
          amount: Number(registration.total_price ?? 0),
          currency: registration.currency || currency,
          payment_method: "stripe_checkout",
          status: "paid",
          source: "stripe",
          stripe_checkout_session_id: sessionId,
          stripe_payment_intent_id: paymentIntentId,
          external_reference: sessionId,
          notes: "Created by Stripe checkout.session.completed webhook for event cart order.",
        });

      if (paymentInsertError) {
        throw new Error(paymentInsertError.message);
      }
    }

    await safeCaptureStudioEventRegistrationLead({
      supabase,
      registrationId: registration.id,
    });

    await safeCaptureOrganizerEventRegistrationContact({
      supabase,
      registrationId: registration.id,
    });
  }

  if (paymentIntentId) {
    await syncFeeDetailsForPaymentIntent(supabase, stripe, paymentIntentId);
  }

  await safeQueuePaidEventCartOrderConfirmation({
    supabase,
    orderId,
  });

  const { error: slotUpdateError } = await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "booked",
      payment_status: "paid",
      stripe_checkout_session_id: sessionId,
      stripe_payment_intent_id: paymentIntentId,
      booked_at: paidAt,
      held_until: null,
      hold_token: null,
      updated_at: paidAt,
    })
    .eq("order_id", orderId)
    .in("status", ["available", "held"]);

  if (slotUpdateError) {
    throw new Error(slotUpdateError.message);
  }

  return true;
}

async function handleEventPrivateLessonCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session
) {
  const source = getString(session.metadata?.source);
  if (source !== "event_private_lesson_slot") return false;

  const slotId = getString(session.metadata?.slot_id);
  if (!slotId) {
    throw new Error("Private lesson checkout missing slot_id metadata.");
  }

  if (session.payment_status !== "paid") {
    return true;
  }

  const paymentIntentId = getString(session.payment_intent);

  const { error: slotUpdateError } = await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "booked",
      payment_status: "paid",
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: paymentIntentId,
      booked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", slotId)
    .in("status", ["available", "held"]);

  if (slotUpdateError) {
    throw new Error(slotUpdateError.message);
  }

  return true;
}


type StripeFeeDetails = {
  chargeId: string | null;
  balanceTransactionId: string | null;
  stripeProcessingFeeAmount: number;
  stripeApplicationFeeAmount: number;
  platformFeeAmount: number;
};

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function centsToDollars(value: number | null | undefined) {
  return Number(value ?? 0) / 100;
}

function dollarsToCents(value: number | string | null | undefined) {
  return Math.round(Number(value ?? 0) * 100);
}

function prorateCents(totalCents: number, rowAmountCents: number, allRowsAmountCents: number) {
  if (totalCents <= 0 || rowAmountCents <= 0 || allRowsAmountCents <= 0) return 0;
  return Math.round((totalCents * rowAmountCents) / allRowsAmountCents);
}

async function getStripeFeeDetailsFromCharge(
  stripe: Stripe,
  charge: Stripe.Charge
): Promise<StripeFeeDetails> {
  const chargeId = charge.id ?? null;
  const balanceTransactionId = stripeObjectId(charge.balance_transaction);

  let stripeProcessingFeeAmount = 0;
  let stripeApplicationFeeAmount = centsToDollars(charge.application_fee_amount ?? 0);
  let platformFeeAmount = stripeApplicationFeeAmount;

  if (balanceTransactionId) {
    try {
      const balanceTransaction =
        typeof charge.balance_transaction === "object" &&
        charge.balance_transaction &&
        "fee" in charge.balance_transaction
          ? (charge.balance_transaction as Stripe.BalanceTransaction)
          : await stripe.balanceTransactions.retrieve(balanceTransactionId);

      stripeProcessingFeeAmount = centsToDollars(balanceTransaction.fee ?? 0);
    } catch (error) {
      console.warn("Unable to retrieve Stripe balance transaction fees.", error);
    }
  }

  return {
    chargeId,
    balanceTransactionId,
    stripeProcessingFeeAmount,
    stripeApplicationFeeAmount,
    platformFeeAmount,
  };
}

async function getStripeFeeDetailsFromPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string
) {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge", "latest_charge.balance_transaction"],
    });

    const latestCharge = paymentIntent.latest_charge;
    const charge =
      typeof latestCharge === "object" && latestCharge
        ? (latestCharge as Stripe.Charge)
        : null;

    if (!charge) return null;

    return getStripeFeeDetailsFromCharge(stripe, charge);
  } catch (error) {
    console.warn("Unable to retrieve Stripe payment intent fee details.", error);
    return null;
  }
}

async function syncFeeDetailsForPaymentIntent(
  supabase: SupabaseClient,
  stripe: Stripe,
  paymentIntentId: string
) {
  const feeDetails = await getStripeFeeDetailsFromPaymentIntent(stripe, paymentIntentId);
  if (!feeDetails) return false;

  const feePayload = {
    stripe_charge_id: feeDetails.chargeId,
    stripe_balance_transaction_id: feeDetails.balanceTransactionId,
    stripe_processing_fee_amount: feeDetails.stripeProcessingFeeAmount,
    stripe_application_fee_amount: feeDetails.stripeApplicationFeeAmount,
    platform_fee_amount: feeDetails.platformFeeAmount,
  };

  const { error: paymentsError } = await supabase
    .from("payments")
    .update(feePayload)
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (paymentsError) {
    throw new Error(paymentsError.message);
  }

  const { data: eventPayments, error: eventPaymentsLookupError } = await supabase
    .from("event_payments")
    .select("id, amount")
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (eventPaymentsLookupError) {
    throw new Error(eventPaymentsLookupError.message);
  }

  const rows = eventPayments ?? [];
  const totalAmountCents = rows.reduce(
    (sum, row) => sum + dollarsToCents(row.amount),
    0,
  );

  if (rows.length > 0) {
    for (const row of rows) {
      const rowAmountCents = dollarsToCents(row.amount);
      const rowProcessingFee = centsToDollars(
        prorateCents(
          Math.round(feeDetails.stripeProcessingFeeAmount * 100),
          rowAmountCents,
          totalAmountCents,
        ),
      );
      const rowApplicationFee = centsToDollars(
        prorateCents(
          Math.round(feeDetails.stripeApplicationFeeAmount * 100),
          rowAmountCents,
          totalAmountCents,
        ),
      );
      const rowPlatformFee = centsToDollars(
        prorateCents(
          Math.round(feeDetails.platformFeeAmount * 100),
          rowAmountCents,
          totalAmountCents,
        ),
      );

      const { error: eventPaymentUpdateError } = await supabase
        .from("event_payments")
        .update({
          stripe_charge_id: feeDetails.chargeId,
          stripe_balance_transaction_id: feeDetails.balanceTransactionId,
          stripe_processing_fee_amount: rowProcessingFee,
          stripe_application_fee_amount: rowApplicationFee,
          platform_fee_amount: rowPlatformFee,
        })
        .eq("id", row.id);

      if (eventPaymentUpdateError) {
        throw new Error(eventPaymentUpdateError.message);
      }
    }
  }

  return true;
}

async function syncFeeDetailsForCharge(
  supabase: SupabaseClient,
  stripe: Stripe,
  charge: Stripe.Charge
) {
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!paymentIntentId) return false;

  return syncFeeDetailsForPaymentIntent(supabase, stripe, paymentIntentId);
}

async function updatePaymentRefundByPaymentIntent(
  supabase: SupabaseClient,
  paymentIntentId: string,
  refundAmount: number,
  stripeRefundId: string | null
) {
  const { data: payments, error: paymentsLookupError } = await supabase
    .from("payments")
    .select("id, amount")
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (paymentsLookupError) {
    throw new Error(paymentsLookupError.message);
  }

  let updated = false;

  for (const payment of payments ?? []) {
    const totalAmount = Number(payment.amount ?? 0);
    const fullyRefunded = refundAmount >= totalAmount;

    const { error: paymentUpdateError } = await supabase
      .from("payments")
      .update({
        status: fullyRefunded ? "refunded" : "paid",
        refund_amount: refundAmount,
        refunded_at: new Date().toISOString(),
        stripe_refund_id: stripeRefundId,
        notes: fullyRefunded
          ? "Refund synced from Stripe webhook."
          : "Partial refund synced from Stripe webhook.",
      })
      .eq("id", payment.id);

    if (paymentUpdateError) {
      throw new Error(paymentUpdateError.message);
    }

    updated = true;
  }

  return updated;
}

async function updateEventPaymentRefundByPaymentIntent(
  supabase: SupabaseClient,
  paymentIntentId: string,
  refundAmount: number,
  stripeRefundId: string | null
) {
  const { data: eventPayments, error: paymentLookupError } = await supabase
    .from("event_payments")
    .select("id, registration_id, amount, refund_amount, stripe_payment_intent_id")
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (paymentLookupError) {
    throw new Error(paymentLookupError.message);
  }

  const rows = eventPayments ?? [];
  if (rows.length === 0) return false;

  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const fullyRefundedCart = refundAmount >= totalAmount;

  for (const eventPayment of rows) {
    const rowAmount = Number(eventPayment.amount ?? 0);
    const rowRefundAmount = fullyRefundedCart
      ? rowAmount
      : totalAmount > 0
        ? Math.round(((refundAmount * rowAmount) / totalAmount) * 100) / 100
        : refundAmount;

    const fullyRefunded = rowRefundAmount >= rowAmount;

    const { error: paymentUpdateError } = await supabase
      .from("event_payments")
      .update({
        status: fullyRefunded ? "refunded" : "paid",
        refund_amount: rowRefundAmount,
        refunded_at: new Date().toISOString(),
        stripe_refund_id: stripeRefundId,
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
  }

  return true;
}

async function handleStripeRefundUpdated(
  supabase: SupabaseClient,
  stripe: Stripe,
  refund: Stripe.Refund
) {
  const paymentIntentId = stripeObjectId(refund.payment_intent);
  const chargeId = stripeObjectId(refund.charge);
  const stripeRefundId = refund.id ?? null;

  let resolvedPaymentIntentId = paymentIntentId;
  let cumulativeRefundAmount = centsToDollars(refund.amount ?? 0);
  let resolvedCharge: Stripe.Charge | null = null;

  if (chargeId) {
    try {
      resolvedCharge = await stripe.charges.retrieve(chargeId, {
        expand: ["balance_transaction"],
      });
      resolvedPaymentIntentId =
        resolvedPaymentIntentId ?? stripeObjectId(resolvedCharge.payment_intent);

      // Stripe Refund.amount is the amount for this single refund event.
      // Charge.amount_refunded is cumulative across multiple partial refunds,
      // which is what event_payments.refund_amount and accounting_entries need.
      const chargeRefundAmount = centsToDollars(resolvedCharge.amount_refunded ?? 0);
      if (chargeRefundAmount > 0) {
        cumulativeRefundAmount = chargeRefundAmount;
      }
    } catch (error) {
      console.warn("Unable to retrieve Stripe charge for refund sync.", error);
    }
  }

  if (!resolvedPaymentIntentId || cumulativeRefundAmount <= 0) return false;

  const paymentUpdated = await updatePaymentRefundByPaymentIntent(
    supabase,
    resolvedPaymentIntentId,
    cumulativeRefundAmount,
    stripeRefundId,
  );

  const eventPaymentUpdated = await updateEventPaymentRefundByPaymentIntent(
    supabase,
    resolvedPaymentIntentId,
    cumulativeRefundAmount,
    stripeRefundId,
  );

  if (resolvedCharge) {
    await syncFeeDetailsForCharge(supabase, stripe, resolvedCharge);
  } else {
    await syncFeeDetailsForPaymentIntent(supabase, stripe, resolvedPaymentIntentId);
  }

  return paymentUpdated || eventPaymentUpdated;
}

async function handleChargeRefunded(
  supabase: SupabaseClient,
  stripe: Stripe,
  charge: Stripe.Charge
) {
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  const refundAmount = centsToDollars(charge.amount_refunded ?? 0);
  const latestRefundId = charge.refunds?.data?.[0]?.id ?? null;

  if (!paymentIntentId || refundAmount <= 0) return false;

  const paymentUpdated = await updatePaymentRefundByPaymentIntent(
    supabase,
    paymentIntentId,
    refundAmount,
    latestRefundId,
  );

  const eventPaymentUpdated = await updateEventPaymentRefundByPaymentIntent(
    supabase,
    paymentIntentId,
    refundAmount,
    latestRefundId,
  );

  await syncFeeDetailsForCharge(supabase, stripe, charge);

  return paymentUpdated || eventPaymentUpdated;
}

async function handlePortalFloorRentalCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session
) {
  const source = getString(session.metadata?.source);
  if (source !== "portal_floor_rental_balance_payment") return false;

  const studioId = getString(session.metadata?.studioId);
  const clientId = getString(session.metadata?.clientId);
  const appointmentIdsRaw = getString(session.metadata?.appointmentIds);

  if (!studioId || !clientId || !appointmentIdsRaw) {
    throw new Error("Portal floor rental balance checkout missing metadata.");
  }

  if (session.payment_status !== "paid") {
    return true;
  }

  const appointmentIds = appointmentIdsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (appointmentIds.length === 0) {
    throw new Error("Portal floor rental balance checkout missing appointments.");
  }

  const paymentIntentId = getString(session.payment_intent);
  const sessionId = session.id;
  const amountTotal = Number(session.amount_total ?? 0) / 100;

  const { data: existingPayment, error: existingPaymentError } = await supabase
    .from("payments")
    .select("id")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (existingPaymentError) {
    throw new Error(existingPaymentError.message);
  }

  if (existingPayment) {
    return true;
  }

  const { data: appointments, error: appointmentsError } = await supabase
    .from("appointments")
    .select("id, studio_id, client_id, appointment_type, status, payment_status, price_amount")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("appointment_type", "floor_space_rental")
    .in("id", appointmentIds);

  if (appointmentsError) {
    throw new Error(appointmentsError.message);
  }

  const payableAppointments = (appointments ?? []).filter(
    (appointment) =>
      appointment.status !== "cancelled" &&
      (appointment.payment_status === "unpaid" || appointment.payment_status === "partial") &&
      Number(appointment.price_amount ?? 0) > 0
  );

  if (payableAppointments.length === 0) {
    throw new Error("No payable floor rentals were found for the checkout session.");
  }

  const expectedAmount = payableAppointments.reduce(
    (sum, appointment) => sum + Number(appointment.price_amount ?? 0),
    0
  );

  if (Math.abs(expectedAmount - amountTotal) > 0.01) {
    throw new Error(
      `Portal floor rental balance amount mismatch. Expected ${expectedAmount}, received ${amountTotal}.`
    );
  }

  const { error: insertPaymentError } = await supabase
  .from("payments")
  .insert({
    studio_id: studioId,
    client_id: clientId,
    amount: amountTotal,
    payment_method: "card",
    status: "paid",
    external_payment_id: sessionId,
    paid_at: new Date().toISOString(),
    payment_type: "floor_fee",
    source: "floor_rental",
    stripe_payment_intent_id: paymentIntentId,
    notes: `Floor rental payment for appointments: ${appointmentIds.join(", ")}`,
  });

  if (insertPaymentError) {
    throw new Error(insertPaymentError.message);
  }

  const { error: updateAppointmentsError } = await supabase
    .from("appointments")
    .update({
      payment_status: "paid",
      updated_at: new Date().toISOString(),
    })
    .in(
      "id",
      payableAppointments.map((appointment) => appointment.id)
    );

  if (updateAppointmentsError) {
    throw new Error(updateAppointmentsError.message);
  }

  return true;
}

async function handleClientPaymentRequestCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session
) {
  const source = getString(session.metadata?.source);
  if (source !== "client_payment_request") return false;

  const paymentId = getString(session.metadata?.paymentId);
  if (!paymentId) {
    throw new Error("Client payment checkout missing paymentId metadata.");
  }

  if (session.payment_status !== "paid") {
    return true;
  }

  const paymentIntentId = getString(session.payment_intent);
  const sessionId = session.id;
  const amountTotal = Number(session.amount_total ?? 0) / 100;
  const currency = (session.currency ?? "usd").toLowerCase();

  const { data: payment, error: paymentLookupError } = await supabase
    .from("payments")
    .select("id, studio_id, client_id, client_package_id, client_membership_id, amount, status")
    .eq("id", paymentId)
    .maybeSingle();

  if (paymentLookupError) {
    throw new Error(paymentLookupError.message);
  }

  if (!payment) {
    throw new Error("Client payment request not found.");
  }

  const expectedAmount = Number(payment.amount ?? 0);
  if (Math.abs(expectedAmount - amountTotal) > 0.01) {
    throw new Error(
      `Client payment request amount mismatch. Expected ${expectedAmount}, received ${amountTotal}.`
    );
  }

  const { error: paymentUpdateError } = await supabase
    .from("payments")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      source: "stripe",
      payment_method: "card",
      stripe_checkout_session_id: sessionId,
      stripe_payment_intent_id: paymentIntentId,
      external_payment_id: sessionId,
      external_reference: sessionId,
      currency,
    })
    .eq("id", payment.id);

  if (paymentUpdateError) {
    throw new Error(paymentUpdateError.message);
  }

  if (payment.client_package_id) {
    const { error: packageUpdateError } = await supabase
      .from("client_packages")
      .update({
        active: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.client_package_id)
      .eq("studio_id", payment.studio_id);

    if (packageUpdateError) {
      throw new Error(packageUpdateError.message);
    }
  }

  if (payment.client_membership_id) {
    const { error: membershipUpdateError } = await supabase
      .from("client_memberships")
      .update({
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.client_membership_id)
      .eq("studio_id", payment.studio_id);

    if (membershipUpdateError) {
      throw new Error(membershipUpdateError.message);
    }
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


  const handledEventCartOrder = await handleEventCartOrderCheckoutCompleted(
    supabase,
    stripe,
    session
  );

  if (handledEventCartOrder) {
    return;
  }

  const handledPrivateLessonSlot = await handleEventPrivateLessonCheckoutCompleted(
    supabase,
    session
  );

  if (handledPrivateLessonSlot) {
    return;
  }

    const handledEventRegistration = await handleEventRegistrationCheckoutCompleted(
    supabase,
    stripe,
    session
  );

  if (handledEventRegistration) {
    return;
  }

  const handledPortalFloorRental = await handlePortalFloorRentalCheckoutCompleted(
    supabase,
    session
  );

  if (handledPortalFloorRental) {
    return;
  }

  const handledClientPaymentRequest = await handleClientPaymentRequestCheckoutCompleted(
    supabase,
    session
  );

  if (handledClientPaymentRequest) {
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

async function resolveStudioIdForStripeAccount(
  supabase: SupabaseClient,
  stripeAccountId: string | null
) {
  if (!stripeAccountId) return null;

  const { data: studio, error } = await supabase
    .from("studios")
    .select("id")
    .eq("stripe_connected_account_id", stripeAccountId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return studio?.id ?? null;
}

function getStripeBalanceTransactionId(
  value: string | Stripe.BalanceTransaction | null | undefined
) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id ?? null;
}

async function upsertStripePayoutRecord(
  supabase: SupabaseClient,
  event: Stripe.Event,
  payout: Stripe.Payout
) {
  const stripeAccountId = event.account ?? null;
  const studioId = await resolveStudioIdForStripeAccount(supabase, stripeAccountId);
  const stripeBalanceTransactionId = getStripeBalanceTransactionId(
    payout.balance_transaction
  );

  const payload = {
    studio_id: studioId,
    stripe_account_id: stripeAccountId,
    stripe_payout_id: payout.id,
    stripe_balance_transaction_id: stripeBalanceTransactionId,
    amount: Number(payout.amount ?? 0) / 100,
    currency: (payout.currency ?? "usd").toUpperCase(),
    status: payout.status ?? null,
    arrival_date: toDateOnlyOrNull(payout.arrival_date ?? null),
    payout_created_at: toIsoOrNull(payout.created ?? null),
    method: payout.method ?? null,
    type: payout.type ?? null,
    description: payout.description ?? null,
    statement_descriptor: payout.statement_descriptor ?? null,
    failure_code: payout.failure_code ?? null,
    failure_message: payout.failure_message ?? null,
    metadata: payout.metadata ?? {},
    raw_payload: payout as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };

  const { data: existingPayout, error: existingPayoutError } = await supabase
    .from("stripe_payouts")
    .select("id")
    .eq("stripe_payout_id", payout.id)
    .eq("stripe_account_id", stripeAccountId)
    .maybeSingle();

  if (existingPayoutError) {
    throw new Error(existingPayoutError.message);
  }

  if (existingPayout) {
    const { data: updatedPayout, error: updateError } = await supabase
      .from("stripe_payouts")
      .update(payload)
      .eq("id", existingPayout.id)
      .select("id")
      .single();

    if (updateError) {
      throw new Error(updateError.message);
    }

    return {
      payoutRecordId: updatedPayout?.id ?? existingPayout.id,
      studioId,
      stripeAccountId,
    };
  }

  const { data: insertedPayout, error: insertError } = await supabase
    .from("stripe_payouts")
    .insert({
      ...payload,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return {
    payoutRecordId: insertedPayout.id,
    studioId,
    stripeAccountId,
  };
}

function getStripeSourceId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }

  return null;
}

async function findPaymentIdForPayoutItem(params: {
  supabase: SupabaseClient;
  studioId: string | null;
  balanceTransactionId: string;
  sourceId: string | null;
}) {
  const { supabase, studioId, balanceTransactionId, sourceId } = params;

  let paymentQuery = supabase
    .from("payments")
    .select("id")
    .eq("stripe_balance_transaction_id", balanceTransactionId)
    .limit(1);

  if (studioId) {
    paymentQuery = paymentQuery.eq("studio_id", studioId);
  }

  const { data: balanceMatches, error: balanceError } = await paymentQuery;

  if (balanceError) {
    throw new Error(balanceError.message);
  }

  if (balanceMatches?.[0]?.id) {
    return balanceMatches[0].id as string;
  }

  if (!sourceId) return null;

  let sourceQuery = supabase
    .from("payments")
    .select("id")
    .eq("stripe_charge_id", sourceId)
    .limit(1);

  if (studioId) {
    sourceQuery = sourceQuery.eq("studio_id", studioId);
  }

  const { data: sourceMatches, error: sourceError } = await sourceQuery;

  if (sourceError) {
    throw new Error(sourceError.message);
  }

  return (sourceMatches?.[0]?.id as string | undefined) ?? null;
}

async function findEventPaymentIdForPayoutItem(params: {
  supabase: SupabaseClient;
  studioId: string | null;
  balanceTransactionId: string;
  sourceId: string | null;
}) {
  const { supabase, studioId, balanceTransactionId, sourceId } = params;

  let paymentQuery = supabase
    .from("event_payments")
    .select("id")
    .eq("stripe_balance_transaction_id", balanceTransactionId)
    .limit(1);

  if (studioId) {
    paymentQuery = paymentQuery.eq("studio_id", studioId);
  }

  const { data: balanceMatches, error: balanceError } = await paymentQuery;

  if (balanceError) {
    throw new Error(balanceError.message);
  }

  if (balanceMatches?.[0]?.id) {
    return balanceMatches[0].id as string;
  }

  if (!sourceId) return null;

  let sourceQuery = supabase
    .from("event_payments")
    .select("id")
    .eq("stripe_charge_id", sourceId)
    .limit(1);

  if (studioId) {
    sourceQuery = sourceQuery.eq("studio_id", studioId);
  }

  const { data: sourceMatches, error: sourceError } = await sourceQuery;

  if (sourceError) {
    throw new Error(sourceError.message);
  }

  return (sourceMatches?.[0]?.id as string | undefined) ?? null;
}

async function upsertStripePayoutItem(params: {
  supabase: SupabaseClient;
  payoutRecordId: string | null;
  payout: Stripe.Payout;
  stripeAccountId: string | null;
  studioId: string | null;
  balanceTransaction: Stripe.BalanceTransaction;
}) {
  const {
    supabase,
    payoutRecordId,
    payout,
    stripeAccountId,
    studioId,
    balanceTransaction,
  } = params;

  const balanceTransactionId = balanceTransaction.id;
  const sourceId = getStripeSourceId(balanceTransaction.source);
  const paymentId = await findPaymentIdForPayoutItem({
    supabase,
    studioId,
    balanceTransactionId,
    sourceId,
  });
  const eventPaymentId = paymentId
    ? null
    : await findEventPaymentIdForPayoutItem({
        supabase,
        studioId,
        balanceTransactionId,
        sourceId,
      });

  const payload = {
    stripe_payout_record_id: payoutRecordId,
    stripe_payout_id: payout.id,
    stripe_account_id: stripeAccountId,
    stripe_balance_transaction_id: balanceTransactionId,
    stripe_source_id: sourceId,
    stripe_source_type: balanceTransaction.type ?? null,
    studio_id: studioId,
    payment_id: paymentId,
    event_payment_id: eventPaymentId,
    amount: Number(balanceTransaction.amount ?? 0) / 100,
    fee: Number(balanceTransaction.fee ?? 0) / 100,
    net: Number(balanceTransaction.net ?? 0) / 100,
    currency: (balanceTransaction.currency ?? payout.currency ?? "usd").toUpperCase(),
    type: balanceTransaction.type ?? null,
    description: balanceTransaction.description ?? null,
    available_on: toDateOnlyOrNull(balanceTransaction.available_on ?? null),
    balance_transaction_created_at: toIsoOrNull(
      balanceTransaction.created ?? null
    ),
    reporting_category: balanceTransaction.reporting_category ?? null,
    fee_details:
      (balanceTransaction.fee_details as unknown as Record<string, unknown>[]) ??
      [],
    raw_payload:
      balanceTransaction as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };

  const { data: existingItem, error: existingItemError } = await supabase
    .from("stripe_payout_items")
    .select("id")
    .eq("stripe_balance_transaction_id", balanceTransactionId)
    .eq("stripe_account_id", stripeAccountId)
    .maybeSingle();

  if (existingItemError) {
    throw new Error(existingItemError.message);
  }

  if (existingItem) {
    const { error: updateError } = await supabase
      .from("stripe_payout_items")
      .update(payload)
      .eq("id", existingItem.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return;
  }

  const { error: insertError } = await supabase
    .from("stripe_payout_items")
    .insert({
      ...payload,
      created_at: new Date().toISOString(),
    });

  if (insertError) {
    throw new Error(insertError.message);
  }
}

async function syncStripePayoutItems(params: {
  supabase: SupabaseClient;
  stripe: Stripe;
  payout: Stripe.Payout;
  payoutRecordId: string | null;
  stripeAccountId: string | null;
  studioId: string | null;
}) {
  const { supabase, stripe, payout, payoutRecordId, stripeAccountId, studioId } =
    params;

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const listParams: Stripe.BalanceTransactionListParams = {
      payout: payout.id,
      limit: 100,
    };

    if (startingAfter) {
      listParams.starting_after = startingAfter;
    }

    const requestOptions = stripeAccountId
      ? { stripeAccount: stripeAccountId }
      : undefined;

    const balanceTransactions = await stripe.balanceTransactions.list(
      listParams,
      requestOptions
    );

    for (const balanceTransaction of balanceTransactions.data) {
      await upsertStripePayoutItem({
        supabase,
        payoutRecordId,
        payout,
        stripeAccountId,
        studioId,
        balanceTransaction,
      });
    }

    hasMore = balanceTransactions.has_more;
    startingAfter = balanceTransactions.data[balanceTransactions.data.length - 1]?.id;
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

  if (existingEvent?.status === "processed") {
    return new Response("Already processed", { status: 200 });
  }

  if (existingEvent) {
    const { error: retryEventError } = await supabase
      .from("payment_provider_events")
      .update({
        event_type: event.type,
        status: "received",
        payload_hash: payloadHash,
        error_message: null,
        processed_at: null,
      })
      .eq("provider", "stripe")
      .eq("provider_event_id", event.id);

    if (retryEventError) {
      return new Response(`Event retry logging failed: ${retryEventError.message}`, {
        status: 500,
      });
    }
  } else {
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

      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await syncFeeDetailsForPaymentIntent(supabase, stripe, paymentIntent.id);
        break;
      }

      case "charge.succeeded": {
        await syncFeeDetailsForCharge(
          supabase,
          stripe,
          event.data.object as Stripe.Charge
        );
        break;
      }

      case "charge.updated": {
        const charge = event.data.object as Stripe.Charge;
        await syncFeeDetailsForCharge(supabase, stripe, charge);
        if ((charge.amount_refunded ?? 0) > 0) {
          await handleChargeRefunded(supabase, stripe, charge);
        }
        break;
      }

      case "refund.created":
      case "refund.updated":
      case "charge.refund.updated": {
        await handleStripeRefundUpdated(
          supabase,
          stripe,
          event.data.object as Stripe.Refund
        );
        break;
      }

      case "charge.refunded": {
        await handleChargeRefunded(
          supabase,
          stripe,
          event.data.object as Stripe.Charge
        );
        break;
      }

      case "customer.subscription.created":
case "customer.subscription.updated":
case "customer.subscription.deleted": {
  const subscription = event.data.object as Stripe.Subscription;

  const handled = await upsertStudioSubscription({
    supabase,
    stripe,
    subscription,
  });

  if (handled) {
    await upsertStripeSubscriptionRecord(supabase, subscription);
  }

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

      case "payout.created":
      case "payout.updated":
      case "payout.paid":
      case "payout.failed": {
        const payout = event.data.object as Stripe.Payout;
        const payoutSync = await upsertStripePayoutRecord(
          supabase,
          event,
          payout
        );

        await syncStripePayoutItems({
          supabase,
          stripe,
          payout,
          payoutRecordId: payoutSync.payoutRecordId,
          stripeAccountId: payoutSync.stripeAccountId,
          studioId: payoutSync.studioId,
        });

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



