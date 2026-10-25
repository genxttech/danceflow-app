import { headers } from "next/headers";
import { createHash, randomUUID } from "crypto";
import Stripe from "stripe";
import {
  createClient as createSupabaseClient,
  SupabaseClient,
} from "@supabase/supabase-js";
import { getStripe } from "@/lib/payments/stripe";
import { resolveMembershipStripeAccount } from "@/lib/payments/membershipStripeAccount";
import { verifyStripeWebhook } from "@/lib/payments/webhookVerification";
import { handleSmsCreditStripeEvent } from "@/lib/billing/smsCreditPurchases";
import { resolvePlanCodeFromEnvPriceIds } from "@/lib/billing/subscriptionPlanResolution";

import {
  handleChargeDisputeEvent,
  resolveStudioIdForStripeAccount,
} from "@/lib/payments/paymentDisputes";
import { fulfillTerminalPayment, TerminalEventNotFulfilledError } from "@/lib/payments/terminal-fulfillment";
import {
  reconcilePackageStripeRefund,
  buildPackageRefundReconciliationInput,
  restorePackageRefundReconciliation,
  buildPackageRefundReversalInput,
} from "@/lib/payments/package-refund-reconciliation";
import { PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD } from "@/lib/payments/package-refund-release-hold";
import { finalizeTerminalMembership } from "@/lib/payments/terminal-membership-finalization";
import {
  finalizeStudentMarketplacePayment,
  queueStudentMarketplacePurchaseConfirmationSafely,
} from "@/lib/commerce/studentMarketplace";
import { assertMembershipReferencesBelongToStudio } from "@/lib/payments/membershipReferenceOwnership";
import { handleGroupClassPurchaseCheckout } from "@/lib/payments/groupClassPurchaseWebhook";
import { applyCompetitionCheckoutEvent, COMPETITION_REGISTRATION_SOURCE } from "@/lib/competition/registrationLifecycle";
import {
  centsToDollars,
  stripeObjectId,
  syncFeeDetailsForCharge,
  syncFeeDetailsForPaymentIntent,
} from "@/lib/payments/stripeFeeSync";
import {
  safeCaptureOrganizerEventRegistrationContact,
  safeCaptureStudioEventRegistrationLead,
  safeQueuePaidEventCartOrderConfirmation,
  safeQueuePaidEventRegistrationConfirmation,
} from "@/lib/events/settlementSideEffects";
import {
  handleEventCartCheckoutSessionEvent,
  handleEventCartPaymentIntentEvent,
  type WebhookClaim,
} from "@/lib/events/cartWebhook";

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

function normalizeCurrency(value: string | null | undefined) {
  return (value || "usd").trim().toLowerCase();
}

function amountsMatch(
  expected: number | null | undefined,
  received: number | null | undefined,
) {
  return Math.abs(Number(expected ?? 0) - Number(received ?? 0)) <= 0.01;
}

async function assertEventRegistrationPaymentMatches(params: {
  supabase: SupabaseClient;
  registrationId: string;
  amountTotal: number;
  currency: string;
}) {
  const { data: registration, error } = await params.supabase
    .from("event_registrations")
    .select("id, total_price, total_amount, currency, payment_status")
    .eq("id", params.registrationId)
    .maybeSingle();

  if (error || !registration) {
    throw new Error(
      `Event registration payment validation failed: ${error?.message ?? "registration not found"}`,
    );
  }

  const expectedAmount = Number(
    registration.total_amount ?? registration.total_price ?? 0,
  );
  if (!amountsMatch(expectedAmount, params.amountTotal)) {
    throw new Error(
      `Event registration amount mismatch. Expected ${expectedAmount}, received ${params.amountTotal}.`,
    );
  }

  if (
    normalizeCurrency(registration.currency) !==
    normalizeCurrency(params.currency)
  ) {
    throw new Error("Event registration currency mismatch.");
  }

  return registration;
}

export async function handleStudentMarketplacePaymentIntentSucceeded(
  supabase: SupabaseClient,
  paymentIntent: Stripe.PaymentIntent,
  stripeAccountId?: string | null,
) {
  if (getString(paymentIntent.metadata?.source) !== "commerce_digital_marketplace") {
    return false;
  }

  const orderId = getString(paymentIntent.metadata?.order_id);
  if (!orderId) {
    throw new Error("Marketplace PaymentIntent is missing order_id metadata.");
  }

  // PAY-DC-2B: the order's stored connected account and PaymentIntent are
  // authoritative; the event must come from that account for that PaymentIntent.
  const { data: order, error: orderError } = await supabase
    .from("commerce_orders")
    .select("id, studio_id, metadata")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) {
    throw new Error(orderError.message);
  }

  const orderMetadata = (order?.metadata ?? {}) as Record<string, unknown>;
  const orderAccountId = getString(orderMetadata.stripe_connected_account_id);
  const orderPaymentIntentId = getString(orderMetadata.stripe_payment_intent_id);
  const metadataStudioId = getString(paymentIntent.metadata?.studio_id);

  if (
    !order ||
    !stripeAccountId ||
    orderAccountId !== stripeAccountId ||
    orderPaymentIntentId !== paymentIntent.id ||
    (metadataStudioId && metadataStudioId !== order.studio_id)
  ) {
    throw new Error("marketplace_event_account_mismatch");
  }

  const amount =
    Number(paymentIntent.amount_received ?? paymentIntent.amount ?? 0) / 100;

  const entitlementId = await finalizeStudentMarketplacePayment({
    supabase,
    orderId,
    paymentIntentId: paymentIntent.id,
    amount,
    currency: paymentIntent.currency,
    queueConfirmation: false,
  });

  const { error: ownerError } = await supabase
    .from("payments")
    .update({ stripe_account_id: stripeAccountId })
    .eq("commerce_order_id", order.id)
    .eq("studio_id", order.studio_id)
    .is("stripe_account_id", null);

  if (ownerError) {
    throw new Error(ownerError.message);
  }

  // PAY-DC-3 (D-B): queue only after the trusted owner is stamped, so the merchant line reads it.
  await queueStudentMarketplacePurchaseConfirmationSafely({
    supabase,
    orderId,
    entitlementId,
  });

  return true;
}

// Every PaymentIntent metadata.source value that represents a DanceFlow
// Terminal card-present payment and must be fulfilled through
// fulfillTerminalPayment. "danceflow_terminal" covers the main Take
// Payment -> Card Reader flow; "danceflow_terminal_quick_charge" covers
// both Quick Charge and Quick Pay (both start routes use this same
// source value) so a successfully captured payment is deterministically
// marked paid even if the browser never returns to poll for status.
const TERMINAL_PAYMENT_INTENT_SOURCES = new Set<string | null>([
  "danceflow_terminal",
  "danceflow_terminal_quick_charge",
]);

export async function handleTerminalPaymentIntentSucceeded(
  supabase: SupabaseClient,
  paymentIntent: Stripe.PaymentIntent,
  stripeAccountId?: string | null,
) {
  if (
    !TERMINAL_PAYMENT_INTENT_SOURCES.has(
      getString(paymentIntent.metadata?.source),
    )
  ) {
    return false;
  }

  const studioId = getString(paymentIntent.metadata?.studioId);
  const paymentId = getString(paymentIntent.metadata?.paymentId);

  if (!studioId || !paymentId) {
    throw new Error("Terminal PaymentIntent is missing fulfillment metadata.");
  }

  const { data: session, error: sessionError } = await supabase
    .from("terminal_payment_sessions")
    .select("id, amount_cents, currency, stripe_account_id")
    .eq("studio_id", studioId)
    .eq("payment_id", paymentId)
    .eq("stripe_payment_intent_id", paymentIntent.id)
    .maybeSingle();

  if (sessionError) {
    throw new Error(sessionError.message);
  }

  if (!session) {
    throw new Error("Terminal payment session was not found.");
  }

  // PAY-DC-2B: the event must come from the connected account the Terminal
  // PaymentIntent was created on (stored immutably on the session).
  if (!stripeAccountId || session.stripe_account_id !== stripeAccountId) {
    throw new Error("terminal_event_account_mismatch");
  }

  if (
    Number(session.amount_cents) !== Number(paymentIntent.amount_received) ||
    String(session.currency ?? "usd").toLowerCase() !==
      paymentIntent.currency.toLowerCase()
  ) {
    throw new Error(
      "Terminal payment amount or currency does not match its session.",
    );
  }

  try {
    await fulfillTerminalPayment({
      supabase,
      studioId,
      paymentId,
      sessionId: session.id,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    // PAY-WH-1A: charged but not fulfillable -- the payment exception and staff alert are already durable in the
    // database; acknowledge the delivery instead of having Stripe retry it for days.
    if (error instanceof TerminalEventNotFulfilledError) return true;
    throw error;
  }

  await finalizeTerminalMembership({
    supabase,
    paymentIntentId: paymentIntent.id,
  });

  return true;
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
  status: string,
): "pending" | "active" | "cancelled" | "past_due" | "unpaid" {
  if (status === "active" || status === "trialing") return "active";
  if (status === "canceled") return "cancelled";
  if (status === "past_due") return "past_due";
  if (status === "unpaid") return "unpaid";
  return "pending";
}

function mapStudioSubscriptionStatus(
  status: string,
): "inactive" | "trialing" | "active" | "past_due" | "cancelled" {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled" || status === "incomplete_expired")
    return "cancelled";
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
    : (rawSubscription?.id ?? null);
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
    : (payment.payment_intent?.id ?? null);
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
    : (payment.charge?.id ?? null);
}

async function upsertStripePaymentMethodRecord(
  supabase: SupabaseClient,
  stripe: Stripe,
  input: {
    studioId: string;
    clientId: string;
    customerId: string;
    paymentMethodId: string;
    /** PAY-DC-1: the connected account that owns the customer/payment method. */
    stripeAccountId: string;
  },
) {
  const { studioId, clientId, customerId, paymentMethodId, stripeAccountId } = input;
  const connectedAccountOptions = { stripeAccount: stripeAccountId };

  const paymentMethod = await stripe.paymentMethods.retrieve(
    paymentMethodId,
    {},
    connectedAccountOptions,
  );

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
    await stripe.customers.update(
      customerId,
      {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      },
      connectedAccountOptions,
    );
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

/**
 * PAY-DC-2B: proves a connected event's account belongs to the studio named in
 * subscription metadata. A stored subscription owner is authoritative (it must
 * match both studio and account); only a subscription with no stored owner falls
 * back to the studio's current connected account.
 */
async function verifyConnectedStudio(
  supabase: SupabaseClient,
  studioId: string,
  stripeAccountId: string,
  subscriptionId: string,
) {
  const { data: stored, error: storedError } = await supabase
    .from("stripe_subscriptions")
    .select("studio_id, stripe_account_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (storedError) {
    throw new Error(storedError.message);
  }

  if (stored?.studio_id && stored.studio_id !== studioId) {
    return false;
  }

  if (stored?.stripe_account_id) {
    return stored.stripe_account_id === stripeAccountId;
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("stripe_connected_account_id")
    .eq("id", studioId)
    .maybeSingle();

  if (studioError) {
    throw new Error(studioError.message);
  }

  return studio?.stripe_connected_account_id === stripeAccountId;
}

export async function upsertStripeSubscriptionRecord(
  supabase: SupabaseClient,
  subscription: Stripe.Subscription,
  stripeAccountId?: string | null,
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

  // BILLING-QA-3: a platform subscription that is neither a DanceFlow plan subscription (handled before this) nor a
  // legacy studio membership (studioId metadata), e.g. one created in the Stripe Dashboard, has no tenant: acknowledge
  // it without a write instead of failing on stripe_subscriptions.studio_id and making Stripe retry indefinitely.
  // A DanceFlow plan subscription whose studio is not resolvable yet still fails, so Stripe's retry can settle it.
  if (!stripeAccountId && !studioId) {
    if (getSubscriptionSource(subscription)) throw new Error("subscription_event_studio_unresolved");
    console.error("subscription_event_unowned");
    return;
  }

  // PAY-DC-2B: for connected events, metadata alone never decides the tenant.
  if (stripeAccountId) {
    if (!studioId) {
      // Not a DanceFlow membership subscription (no studio metadata): no tenant, no write.
      console.error("subscription_event_unowned");
      return;
    }

    if (
      !(await verifyConnectedStudio(
        supabase,
        studioId,
        stripeAccountId,
        stripeSubscriptionId,
      ))
    ) {
      throw new Error("subscription_event_studio_mismatch");
    }

    // PAY-DC-4A (G1): metadata client/membership must belong to the verified studio before any write.
    await assertMembershipReferencesBelongToStudio(supabase, {
      studioId,
      clientId,
      membershipId: localMembershipId,
    });
  }

  const currentPeriodStartUnix = getNumber(
    (subscription as unknown as { current_period_start?: number })
      .current_period_start,
  );
  const currentPeriodEndUnix = getNumber(
    (subscription as unknown as { current_period_end?: number })
      .current_period_end,
  );

  const latestInvoiceId =
    typeof subscription.latest_invoice === "string"
      ? subscription.latest_invoice
      : (subscription.latest_invoice?.id ?? null);

  const defaultPaymentMethodId =
    typeof subscription.default_payment_method === "string"
      ? subscription.default_payment_method
      : (subscription.default_payment_method?.id ?? null);

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
    stripe_account_id: stripeAccountId ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: existingSubscription, error: existingSubscriptionError } =
    await supabase
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
        current_period_start:
          toDateOnlyOrNull(currentPeriodStartUnix) ?? undefined,
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
  const {
    supabase,
    stripeCustomerId,
    studioId,
    email = null,
    contactName = null,
  } = params;

  const { data: existingCustomer, error: existingCustomerError } =
    await supabase
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

// Values of the studios.billing_plan enum.
const STUDIO_BILLING_PLAN_VALUES = new Set(["starter", "growth", "pro", "organizer"]);

async function syncStudioBillingSnapshot(params: {
  supabase: SupabaseClient;
  studioId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  subscriptionStatus: string;
  trialEndsAt?: string | null;
  /** BILLING-QA-3: the plan the subscription's Price resolved to; omitted (left unchanged) when it is not a billing_plan value. */
  billingPlan?: string | null;
}) {
  const {
    supabase,
    studioId,
    stripeCustomerId,
    stripeSubscriptionId,
    subscriptionStatus,
    trialEndsAt = null,
    billingPlan = null,
  } = params;

  const { error } = await supabase
    .from("studios")
    .update({
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      subscription_status: mapStudioSubscriptionStatus(subscriptionStatus),
      trial_ends_at: trialEndsAt,
      // Public embed, Discover and calendar pages read studios.billing_plan, so it follows Billing Portal plan changes.
      ...(billingPlan && STUDIO_BILLING_PLAN_VALUES.has(billingPlan) ? { billing_plan: billingPlan } : {}),
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
  const subscriptionIsActive =
    subscription.status === "active" || subscription.status === "trialing";
  const organizerSuiteItems = subscription.items.data.filter(
    isOrganizerSuiteSubscriptionItem,
  );
  const activeItemIds = new Set(organizerSuiteItems.map((item) => item.id));

  for (const item of organizerSuiteItems) {
    const { error } = await supabase.from("usage_addon_entitlements").upsert(
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

  const { data: existingEntitlements, error: existingEntitlementsError } =
    await supabase
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
      const itemId =
        typeof row.stripe_subscription_item_id === "string"
          ? row.stripe_subscription_item_id
          : null;
      return (
        row.status === "active" &&
        (!itemId || !activeItemIds.has(itemId) || !subscriptionIsActive)
      );
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

  const metadataStudioId =
    getString(metadata.studioId) ?? getString(metadata.workspaceId);

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
    (subscription as unknown as { current_period_start?: number })
      .current_period_start,
  );
  const currentPeriodEndUnix = getNumber(
    (subscription as unknown as { current_period_end?: number })
      .current_period_end,
  );

  let planRow: {
    id: string;
    code: string;
    stripe_price_id_monthly: string | null;
    stripe_price_id_yearly: string | null;
  } | null = null;

  if (stripePriceId) {
    const { data, error } = await supabase
      .from("subscription_plans")
      .select("id, code, stripe_price_id_monthly, stripe_price_id_yearly")
      .or(
        `stripe_price_id_monthly.eq.${stripePriceId},stripe_price_id_yearly.eq.${stripePriceId}`,
      )
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    planRow = data;
  }

  // PRICING-P1: the subscription's Price is the authority. Resolve it through the
  // checkout Price ID env vars before trusting metadata.planCode, which is only
  // written at checkout and goes stale after a Billing Portal plan change.
  const envPlanCode = planRow
    ? null
    : resolvePlanCodeFromEnvPriceIds(
        subscription.items.data.map((item) => getString(item.price?.id)),
        process.env,
      );

  if (!planRow && envPlanCode) {
    const { data, error } = await supabase
      .from("subscription_plans")
      .select("id, code, stripe_price_id_monthly, stripe_price_id_yearly")
      .eq("code", envPlanCode)
      .eq("active", true)
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
      `Could not resolve subscription plan for ${subscription.id}. stripePriceId=${stripePriceId || "null"} metadata.planCode=${metadataPlanCode || "null"}`,
    );
  }

  const billingInterval =
    stripePriceId && planRow.stripe_price_id_yearly === stripePriceId
      ? "year"
      : "month";

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

  const { data: existingByStudio, error: existingByStudioError } =
    await supabase
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
    billingPlan: planRow.code,
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
    const { data: studioSubscription, error: studioSubscriptionError } =
      await supabase
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
  session: Stripe.Checkout.Session,
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
    !("deleted" in customer) || customer.deleted !== true
      ? customer.name
      : null;
  const billingEmail =
    !("deleted" in customer) || customer.deleted !== true
      ? customer.email
      : null;

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


/**
 * PAY-DC-2D (M3): an async payment failure may only fail the pending payment
 * whose server-persisted checkout session and Stripe owner are exactly this
 * session and the Stripe-signed event.account. A stale or superseded session,
 * or any other mismatch, is skipped (code-only log, no write) rather than
 * trusting metadata.paymentId.
 */
export async function asyncPaymentFailureMatchesStoredPayment(
  supabase: SupabaseClient,
  params: { paymentId: string; sessionId: string; stripeAccountId: string | null },
) {
  const { data, error } = await supabase
    .from("payments")
    .select("id, status, stripe_checkout_session_id, stripe_account_id")
    .eq("id", params.paymentId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const payment = data as {
    status: string | null;
    stripe_checkout_session_id: string | null;
    stripe_account_id: string | null;
  } | null;

  if (
    !payment ||
    payment.status !== "pending" ||
    !params.sessionId ||
    payment.stripe_checkout_session_id !== params.sessionId ||
    !params.stripeAccountId ||
    payment.stripe_account_id !== params.stripeAccountId
  ) {
    console.error("package_payment_failed_reference_mismatch");
    return false;
  }

  return true;
}

type EventCheckoutBindingTarget =
  | { kind: "registration"; id: string; sessionId: string }
  | { kind: "order_session"; id: string; sessionId: string }
  | { kind: "order_payment_intent"; id: string; paymentIntentId: string }
  | { kind: "private_lesson_slot"; id: string; sessionId: string };

/**
 * PAY-DC-2D (M1): event checkout completions may only mutate the registration,
 * order or slot whose server-persisted Stripe reference is exactly this Stripe
 * object, and only when the Stripe-signed event.account is the owning studio's
 * connected account (studios.stripe_connected_account_id is server-write only).
 * Metadata ids alone never select the row to fulfil. Throws a fixed code
 * before any mutation.
 */
export async function assertEventCheckoutBinding(
  supabase: SupabaseClient,
  target: EventCheckoutBindingTarget,
  stripeAccountId: string | null | undefined,
) {
  if (!stripeAccountId) {
    throw new Error("event_payment_account_mismatch");
  }

  let storedReference: string | null = null;
  let expectedReference: string;
  let studioId: string | null = null;

  if (target.kind === "registration") {
    const { data, error } = await supabase
      .from("event_registrations")
      .select("id, stripe_checkout_session_id, events(studio_id)")
      .eq("id", target.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("event_payment_reference_mismatch");
    const row = data as {
      stripe_checkout_session_id: string | null;
      events: { studio_id: string | null } | { studio_id: string | null }[] | null;
    };
    const event = Array.isArray(row.events) ? row.events[0] : row.events;
    storedReference = row.stripe_checkout_session_id;
    expectedReference = target.sessionId;
    studioId = event?.studio_id ?? null;
  } else if (target.kind === "order_session" || target.kind === "order_payment_intent") {
    const { data, error } = await supabase
      .from("event_orders")
      .select("id, studio_id, stripe_checkout_session_id, stripe_payment_intent_id")
      .eq("id", target.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("event_payment_reference_mismatch");
    const row = data as {
      studio_id: string | null;
      stripe_checkout_session_id: string | null;
      stripe_payment_intent_id: string | null;
    };
    if (target.kind === "order_session") {
      storedReference = row.stripe_checkout_session_id;
      expectedReference = target.sessionId;
    } else {
      storedReference = row.stripe_payment_intent_id;
      expectedReference = target.paymentIntentId;
    }
    studioId = row.studio_id;
  } else {
    const { data, error } = await supabase
      .from("event_private_lesson_slots")
      .select("id, studio_id, stripe_checkout_session_id, events(studio_id)")
      .eq("id", target.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("event_payment_reference_mismatch");
    const row = data as {
      studio_id: string | null;
      stripe_checkout_session_id: string | null;
      events: { studio_id: string | null } | { studio_id: string | null }[] | null;
    };
    const event = Array.isArray(row.events) ? row.events[0] : row.events;
    storedReference = row.stripe_checkout_session_id;
    expectedReference = target.sessionId;
    studioId = event?.studio_id ?? row.studio_id;
  }

  if (!expectedReference || storedReference !== expectedReference) {
    throw new Error("event_payment_reference_mismatch");
  }

  if (!studioId) {
    throw new Error("event_payment_account_mismatch");
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("stripe_connected_account_id")
    .eq("id", studioId)
    .maybeSingle();

  if (studioError) throw new Error(studioError.message);

  if (
    !studio?.stripe_connected_account_id ||
    studio.stripe_connected_account_id !== stripeAccountId
  ) {
    throw new Error("event_payment_account_mismatch");
  }
}

async function handleEventRegistrationCheckoutCompleted(
  supabase: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  stripeAccountId?: string | null,
) {
  const source = getString(session.metadata?.source);
  if (source !== "event_registration") return false;

  const registrationId = getString(session.metadata?.registration_id);
  if (!registrationId) {
    throw new Error(
      "Event registration checkout missing registration_id metadata.",
    );
  }

  if (session.payment_status !== "paid") {
    return true;
  }

  const paymentIntentId = getString(session.payment_intent);
  const sessionId = session.id;
  const amountTotal = Number(session.amount_total ?? 0) / 100;
  const currency = (session.currency ?? "usd").toUpperCase();

  await assertEventCheckoutBinding(
    supabase,
    { kind: "registration", id: registrationId, sessionId },
    stripeAccountId,
  );

  await assertEventRegistrationPaymentMatches({
    supabase,
    registrationId,
    amountTotal,
    currency,
  });

  const { data: settledRegistration, error: registrationUpdateError } = await supabase
    .from("event_registrations")
    .update({
      payment_status: "paid",
      status: "confirmed",
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", registrationId)
    // PAY-WH-1A: never settle an order-backed registration outside settle_event_cart_order.
    .is("order_id", null)
    .select("id")
    .maybeSingle();

  if (registrationUpdateError) {
    throw new Error(registrationUpdateError.message);
  }
  if (!settledRegistration) {
    throw new Error("event_registration_checkout_not_orderless");
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

    await stampEventPaymentOwner(supabase, existingPayment.id, stripeAccountId);
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
        stripe_account_id: stripeAccountId ?? null,
      });

    if (insertPaymentError && insertPaymentError.code !== "23505") {
      throw new Error(insertPaymentError.message);
    }
  }

  if (paymentIntentId) {
    await syncFeeDetailsForPaymentIntent(
      supabase,
      stripe,
      paymentIntentId,
      stripeAccountId,
    );
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

/**
 * Phase 10C: verified Checkout events for competition registrations (Connect events only).
 * completed / async_payment_succeeded -> finalize (exactly once, database-verified binding and
 * amount); expired -> release; async_payment_failed -> release as failed. Card-only sessions never
 * produce a retriable payment_intent.payment_failed that should release the hold.
 */
export async function handleCompetitionRegistrationCheckoutEvent(
  supabase: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  stripeAccountId: string | null | undefined,
  stripeEventType: string,
) {
  if (getString(session.metadata?.source) !== COMPETITION_REGISTRATION_SOURCE) return false;
  const result = await applyCompetitionCheckoutEvent(supabase, {
    eventType: stripeEventType,
    session,
    stripeAccountId,
  });
  const recordedPayment = ["finalized", "late_payment_after_release", "signing_incomplete_payment_recorded"].includes(result.outcome);
  if (recordedPayment && result.paymentIntentId) {
    await syncFeeDetailsForPaymentIntent(supabase, stripe, result.paymentIntentId, stripeAccountId);
  }
  if (result.outcome === "finalized") {
    await safeQueuePaidEventCartOrderConfirmation({ supabase, orderId: result.orderId });
  } else if (result.outcome === "late_payment_after_release" || result.outcome === "signing_incomplete_payment_recorded") {
    console.error("comp10c_payment_needs_review", { orderId: result.orderId, outcome: result.outcome });
  }
  return true;
}

async function handleEventPrivateLessonCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session,
  stripeAccountId?: string | null,
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
  const amountTotal = Number(session.amount_total ?? 0) / 100;

  await assertEventCheckoutBinding(
    supabase,
    { kind: "private_lesson_slot", id: slotId, sessionId: session.id },
    stripeAccountId,
  );

  const { data: privateLessonSlot, error: privateLessonSlotError } =
    await supabase
      .from("event_private_lesson_slots")
      .select("id, price, status, payment_status, stripe_checkout_session_id")
      .eq("id", slotId)
      .maybeSingle();

  if (privateLessonSlotError || !privateLessonSlot) {
    throw new Error(
      `Private lesson slot validation failed: ${privateLessonSlotError?.message ?? "slot not found"}`,
    );
  }

  if (!amountsMatch(Number(privateLessonSlot.price ?? 0), amountTotal)) {
    throw new Error(
      `Private lesson amount mismatch. Expected ${Number(privateLessonSlot.price ?? 0)}, received ${amountTotal}.`,
    );
  }

  // The slot's checkout session id is bound above and never rewritten here.
  const { error: slotUpdateError } = await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "booked",
      payment_status: "paid",
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

function refundEventMatchesStoredOwner(
  storedAccountId: string | null | undefined,
  stripeAccountId: string | null | undefined,
) {
  if (!storedAccountId) return true;
  if (storedAccountId === (stripeAccountId ?? null)) return true;
  console.error("refund_webhook_account_mismatch");
  return false;
}

async function stampEventPaymentOwner(
  supabase: SupabaseClient,
  eventPaymentId: string,
  stripeAccountId: string | null | undefined,
) {
  if (!stripeAccountId) return;

  const { error } = await supabase
    .from("event_payments")
    .update({ stripe_account_id: stripeAccountId })
    .eq("id", eventPaymentId)
    .is("stripe_account_id", null);

  if (error) {
    throw new Error(error.message);
  }
}

async function updatePaymentRefundByPaymentIntent(
  supabase: SupabaseClient,
  paymentIntentId: string,
  refundAmount: number,
  stripeRefundId: string | null,
  stripeAccountId: string | null | undefined,
  stripeEventId?: string,
  stripeEventType?: string,
) {
  const { data: payments, error: paymentsLookupError } = await supabase
    .from("payments")
    .select("id, amount, stripe_account_id")
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (paymentsLookupError) {
    throw new Error(paymentsLookupError.message);
  }

  let updated = false;

  for (const payment of payments ?? []) {
    if (!refundEventMatchesStoredOwner(payment.stripe_account_id, stripeAccountId)) {
      continue;
    }

    const totalAmount = Number(payment.amount ?? 0);
    const fullyRefunded = refundAmount >= totalAmount;

    // PKG-P1: CAS-guarded via _apply_payment_refund_and_reevaluate --
    // legal prior state is 'paid' only (confirmed by direct read: this
    // loop previously had NO status filter at all, so a refund event could
    // silently overwrite an already-voided row). Also atomically
    // re-evaluates and, if needed, deactivates the linked package in the
    // same transaction -- a full refund removing a package's only paid
    // basis must not leave it usable.
    // REFUND-RECON-1: refundAmount is the CUMULATIVE refund; the RPC never
    // lowers it, never erases a stored refund id, and applies the Group Class
    // enrollment effect (GC-3.5) itself -- no per-payment-type branch here.
    const { data: refundResult, error: refundRpcError } = await supabase.rpc(
      "_apply_payment_refund_and_reevaluate",
      {
        p_payment_id: payment.id,
        p_new_status: fullyRefunded ? "refunded" : "paid",
        p_refund_amount: refundAmount,
        p_stripe_refund_id: stripeRefundId,
        p_stripe_event_id: stripeEventId ?? `no_event_id:${paymentIntentId}:${payment.id}`,
        p_stripe_event_type: stripeEventType ?? "charge.refund.updated",
      },
    );

    if (refundRpcError) {
      throw new Error(refundRpcError.message);
    }

    if (refundResult?.[0]?.applied) {
      updated = true;
    }
  }

  return updated;
}

async function updateEventPaymentRefundByPaymentIntent(
  supabase: SupabaseClient,
  paymentIntentId: string,
  refundAmount: number,
  stripeRefundId: string | null,
  stripeAccountId: string | null | undefined,
) {
  const { data: eventPayments, error: paymentLookupError } = await supabase
    .from("event_payments")
    .select(
      "id, registration_id, amount, refund_amount, stripe_payment_intent_id, stripe_account_id",
    )
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (paymentLookupError) {
    throw new Error(paymentLookupError.message);
  }

  const rows = (eventPayments ?? []).filter((row) =>
    refundEventMatchesStoredOwner(row.stripe_account_id, stripeAccountId),
  );
  if (rows.length === 0) return false;

  const totalAmount = rows.reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0,
  );
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

export async function handleStripeRefundUpdated(
  supabase: SupabaseClient,
  stripe: Stripe,
  refund: Stripe.Refund,
  stripeAccountId?: string | null,
  stripeEventId?: string,
  stripeEventType?: string,
) {
  const paymentIntentId = stripeObjectId(refund.payment_intent);
  const chargeId = stripeObjectId(refund.charge);
  const stripeRefundId = refund.id ?? null;
  // Package Refund P0, Slice 2c-1: this single refund event's own amount,
  // in cents (Stripe's native unit) -- deliberately captured before
  // cumulativeRefundAmount below is potentially overridden by the charge's
  // running total. package_refund_reconciliations is an append-only ledger
  // of individual refund objects; feeding it a cumulative amount would
  // double-count once summed.
  const refundEventAmountCents = refund.amount ?? 0;
  const refundEventStatus = refund.status ?? "pending";

  let resolvedPaymentIntentId = paymentIntentId;
  let cumulativeRefundAmount = centsToDollars(refund.amount ?? 0);
  let resolvedCharge: Stripe.Charge | null = null;

  if (chargeId) {
    try {
      resolvedCharge = await stripe.charges.retrieve(
        chargeId,
        {
          expand: ["balance_transaction"],
        },
        stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
      );
      resolvedPaymentIntentId =
        resolvedPaymentIntentId ??
        stripeObjectId(resolvedCharge.payment_intent);

      // Stripe Refund.amount is the amount for this single refund event.
      // Charge.amount_refunded is cumulative across multiple partial refunds,
      // which is what event_payments.refund_amount and accounting_entries need.
      const chargeRefundAmount = centsToDollars(
        resolvedCharge.amount_refunded ?? 0,
      );
      if (chargeRefundAmount > 0) {
        cumulativeRefundAmount = chargeRefundAmount;
      }
    } catch (error) {
      console.warn("Unable to retrieve Stripe charge for refund sync.", error);
    }
  }

  if (!resolvedPaymentIntentId || cumulativeRefundAmount <= 0) return false;

  // REFUND-RECON-1: payment-summary refund state only ever reflects money that
  // was actually returned. A resolved charge's amount_refunded is authoritative
  // (it already excludes failed/canceled refunds, so a reversal is never
  // recorded as a refund). Without the charge, only the refund's own amount for
  // a refund Stripe reports as `succeeded` counts: `pending` and
  // `requires_action` have not returned money yet (their later `succeeded`
  // refund.updated reconciles), `failed`/`canceled` never will, and any other or
  // missing status fails closed. The package ledger/reversal calls below still
  // observe every status.
  const summaryRefundAmount = resolvedCharge
    ? centsToDollars(resolvedCharge.amount_refunded ?? 0)
    : refundEventStatus === "succeeded"
      ? cumulativeRefundAmount
      : 0;

  const paymentUpdated = summaryRefundAmount > 0
    ? await updatePaymentRefundByPaymentIntent(
        supabase,
        resolvedPaymentIntentId,
        summaryRefundAmount,
        stripeRefundId,
        stripeAccountId,
        stripeEventId,
        stripeEventType,
      )
    : false;

  const eventPaymentUpdated = summaryRefundAmount > 0
    ? await updateEventPaymentRefundByPaymentIntent(
        supabase,
        resolvedPaymentIntentId,
        summaryRefundAmount,
        stripeRefundId,
        stripeAccountId,
      )
    : false;

  // Package Refund P0, Slice 2c-1: refund.created/refund.updated (and
  // charge.refund.updated, which also routes through this same handler)
  // are the approved authority for package-credit reconciliation --
  // charge.refunded/charge.updated remain payment-summary-only and do not
  // call this (see handleChargeRefunded below, which never references
  // reconcilePackageStripeRefund). reconcile_package_stripe_refund's own
  // transition gate decides whether this specific observation actually
  // applies anything; buildPackageRefundReconciliationInput's null-check
  // is only about whether there's a well-formed event to hand it at all,
  // not about redelivery -- that's the RPC's job, not a TS-level guess.
  const packageReconciliationInput = buildPackageRefundReconciliationInput({
    stripeRefundId,
    refundEventAmountCents,
    cumulativeRefundAmountCents: resolvedCharge?.amount_refunded ?? refundEventAmountCents,
    refundStatus: refundEventStatus,
    resolvedPaymentIntentId,
    chargeId,
  });

  if (packageReconciliationInput && !PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD) {
    await reconcilePackageStripeRefund(supabase, packageReconciliationInput, stripeAccountId);
  }

  // Package Refund P0, Slice 2c-3: the same refund.updated/charge.refund.updated
  // delivery this handler already receives is also the approved authority for
  // reversal detection -- no new Stripe event type. buildPackageRefundReversalInput
  // only returns non-null for a 'failed'/'canceled' status (the forward
  // 'succeeded' path above is unaffected); restore_package_refund_reconciliation's
  // own eligibility gate decides whether this specific observation actually
  // restores anything (see its Step 4) -- this call site's job, like the
  // reconciliation call above, is only "is there a well-formed reversal
  // observation to hand it at all". Same release hold, same webhook-safety
  // posture: never called while PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD is true.
  const packageReversalInput = buildPackageRefundReversalInput({
    stripeRefundId,
    refundEventAmountCents,
    cumulativeRefundAmountCents: resolvedCharge?.amount_refunded ?? refundEventAmountCents,
    refundStatus: refundEventStatus,
    resolvedPaymentIntentId,
    chargeId,
  });

  if (packageReversalInput && !PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD) {
    await restorePackageRefundReconciliation(
      supabase,
      resolvedPaymentIntentId,
      packageReversalInput,
      stripeAccountId,
    );
  }

  if (resolvedCharge) {
    await syncFeeDetailsForCharge(
      supabase,
      stripe,
      resolvedCharge,
      stripeAccountId,
    );
  } else {
    await syncFeeDetailsForPaymentIntent(
      supabase,
      stripe,
      resolvedPaymentIntentId,
      stripeAccountId,
    );
  }

  return paymentUpdated || eventPaymentUpdated;
}

export async function handleChargeRefunded(
  supabase: SupabaseClient,
  stripe: Stripe,
  charge: Stripe.Charge,
  stripeAccountId?: string | null,
  stripeEventId?: string,
  stripeEventType?: string,
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
    stripeAccountId,
    stripeEventId,
    stripeEventType,
  );

  const eventPaymentUpdated = await updateEventPaymentRefundByPaymentIntent(
    supabase,
    paymentIntentId,
    refundAmount,
    latestRefundId,
    stripeAccountId,
  );

  await syncFeeDetailsForCharge(
    supabase,
    stripe,
    charge,
    stripeAccountId,
  );

  return paymentUpdated || eventPaymentUpdated;
}

/**
 * PAY-DC-2B: a payment with a stored owner (PAY-DC-2A) is only settled by an
 * event from that same account. Returns the owner to stamp on the pending ->
 * paid transition for legacy rows that have none yet.
 */
function assertPaymentEventOwner(
  storedAccountId: string | null | undefined,
  stripeAccountId: string | null | undefined,
) {
  if (storedAccountId) {
    if (storedAccountId !== (stripeAccountId ?? null)) {
      throw new Error("payment_event_account_mismatch");
    }
    return {};
  }

  return stripeAccountId ? { stripe_account_id: stripeAccountId } : {};
}

export async function handlePortalFloorRentalCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session,
  stripeAccountId?: string | null,
) {
  const source = getString(session.metadata?.source);
  if (source !== "portal_floor_rental_balance_payment") return false;

  const studioId = getString(session.metadata?.studioId);
  const clientId = getString(session.metadata?.clientId);
  const appointmentIdsRaw = getString(session.metadata?.appointmentIds);
  const paymentId = getString(session.metadata?.paymentId);

  if (!studioId || !clientId || !appointmentIdsRaw || !paymentId) {
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
    throw new Error(
      "Portal floor rental balance checkout missing appointments.",
    );
  }

  const paymentIntentId = getString(session.payment_intent);
  const sessionId = session.id;
  const amountTotal = Number(session.amount_total ?? 0) / 100;

  // Defense in depth against literal webhook redelivery for the same
  // completed session -- checked first and independent of the pending-row
  // lookup below.
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

  // The route (resolvePortalFloorRentalCheckoutSession) always creates or
  // reuses exactly one pending `payments` row per (studio, client) before
  // ever calling Stripe, and stamps that row's id into this session's
  // metadata. Fulfillment transitions that same row pending -> paid instead
  // of inserting a second row, so two completed sessions for the same
  // floor-rental balance can never produce two payments rows.
  const { data: payment, error: paymentLookupError } = await supabase
    .from("payments")
    .select("id, studio_id, client_id, amount, status, stripe_account_id")
    .eq("id", paymentId)
    .maybeSingle();

  if (paymentLookupError) {
    throw new Error(paymentLookupError.message);
  }

  if (!payment) {
    throw new Error("Portal floor rental balance payment record not found.");
  }

  const ownerStamp = assertPaymentEventOwner(payment.stripe_account_id, stripeAccountId);

  if (payment.status !== "pending") {
    // Already transitioned by a prior delivery of this same event, or
    // superseded (voided) by a later attempt -- either way, there is
    // nothing left for this delivery to do.
    return true;
  }

  if (payment.studio_id !== studioId || payment.client_id !== clientId) {
    throw new Error(
      "Portal floor rental balance payment studio/client mismatch.",
    );
  }

  const expectedAmount = Number(payment.amount ?? 0);
  if (Math.abs(expectedAmount - amountTotal) > 0.01) {
    throw new Error(
      `Portal floor rental balance amount mismatch. Expected ${expectedAmount}, received ${amountTotal}.`,
    );
  }

  const { data: appointments, error: appointmentsError } = await supabase
    .from("appointments")
    .select(
      "id, studio_id, client_id, appointment_type, status, payment_status, price_amount",
    )
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
      (appointment.payment_status === "unpaid" ||
        appointment.payment_status === "partial") &&
      Number(appointment.price_amount ?? 0) > 0,
  );

  if (payableAppointments.length === 0) {
    throw new Error(
      "No payable floor rentals were found for the checkout session.",
    );
  }

  const { data: updatedPayment, error: updatePaymentError } = await supabase
    .from("payments")
    .update({
      status: "paid",
      payment_method: "card",
      external_payment_id: sessionId,
      external_reference: sessionId,
      stripe_checkout_session_id: sessionId,
      stripe_payment_intent_id: paymentIntentId,
      paid_at: new Date().toISOString(),
      notes: `Floor rental payment for appointments: ${appointmentIds.join(", ")}`,
      ...ownerStamp,
    })
    .eq("id", payment.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (updatePaymentError) {
    throw new Error(updatePaymentError.message);
  }

  if (!updatedPayment) {
    // Lost a race to another concurrent delivery of this same event, which
    // already transitioned this row -- nothing left to do.
    return true;
  }

  const { error: updateAppointmentsError } = await supabase
    .from("appointments")
    .update({
      payment_status: "paid",
      updated_at: new Date().toISOString(),
    })
    .in(
      "id",
      payableAppointments.map((appointment) => appointment.id),
    );

  if (updateAppointmentsError) {
    throw new Error(updateAppointmentsError.message);
  }

  return true;
}

export async function handleClientPaymentRequestCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session,
  stripeEventId?: string,
  stripeEventType?: string,
  stripeAccountId?: string | null,
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
    .select(
      "id, studio_id, client_id, client_package_id, client_membership_id, amount, status, stripe_account_id",
    )
    .eq("id", paymentId)
    .maybeSingle();

  if (paymentLookupError) {
    throw new Error(paymentLookupError.message);
  }

  if (!payment) {
    throw new Error("Client payment request not found.");
  }

  const ownerStamp = assertPaymentEventOwner(payment.stripe_account_id, stripeAccountId);

  const expectedAmount = Number(payment.amount ?? 0);
  if (Math.abs(expectedAmount - amountTotal) > 0.01) {
    throw new Error(
      `Client payment request amount mismatch. Expected ${expectedAmount}, received ${amountTotal}.`,
    );
  }

  // PKG-P1: CAS-guarded -- only transitions FROM 'pending'. Previously this
  // update had no status filter at all, so a stale/redelivered event could
  // silently un-void a payment DanceFlow had already explicitly voided (or
  // re-pay an already-refunded/failed one) and re-activate its package. On
  // 0 rows affected, record_stale_payment_success_conflict makes its own
  // determination (duplicate delivery of an already-'paid' row is a safe
  // no-op; anything else -- voided/failed/refunded -- is a genuine
  // financial mismatch, recorded for staff review, idempotent by
  // stripeEventId). No mutation of entitlement ever happens on this path --
  // the CAS above is the gate.
  const { data: updatedPayment, error: paymentUpdateError } = await supabase
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
      ...ownerStamp,
    })
    .eq("id", payment.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (paymentUpdateError) {
    throw new Error(paymentUpdateError.message);
  }

  if (!updatedPayment) {
    if (stripeEventId) {
      const { error: conflictError } = await supabase.rpc("record_stale_payment_success_conflict", {
        p_payment_id: payment.id,
        p_stripe_event_id: stripeEventId,
        p_stripe_event_type: stripeEventType ?? "checkout.session.completed",
        p_stripe_session_id: sessionId,
      });
      if (conflictError) {
        throw new Error(conflictError.message);
      }
    }
    return true;
  }

  if (payment.client_package_id) {
    // Package Refund P0, Slice 2b: single atomic guarded update -- no
    // separate read of package state, so there's no read-then-write race
    // window. The NULL-safe predicate is the live, sole authority on
    // whether activation is allowed; a refunded package's row simply
    // doesn't match and is left untouched (not an error).
    const { error: packageUpdateError } = await supabase
      .from("client_packages")
      .update({
        active: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.client_package_id)
      .eq("studio_id", payment.studio_id)
      .or("refund_status.is.null,refund_status.neq.full")
      .select("id");

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

export async function handleCheckoutSessionCompleted(
  supabase: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  stripeAccountId?: string | null,
  stripeEventId?: string,
  stripeEventType?: string,
  claim?: WebhookClaim | null,
) {
  // PAY-DC-1: DanceFlow SaaS billing sessions live on the platform account and
  // never carry event.account; connected (studio) sessions are never treated as SaaS.
  const handledStudioSubscription = stripeAccountId
    ? false
    : await handleStudioCheckoutCompleted(supabase, stripe, session);

  if (handledStudioSubscription) {
    return;
  }

  // Phase 10C: competition registrations are finalized only by finalize_competition_registration.
  const handledCompetitionRegistration = await handleCompetitionRegistrationCheckoutEvent(
    supabase,
    stripe,
    session,
    stripeAccountId,
    stripeEventType ?? "checkout.session.completed",
  );

  if (handledCompetitionRegistration) {
    return;
  }

  // PAY-WH-1: ordinary event cart orders settle only through the locked database lifecycle.
  const handledEventCartOrder = await handleEventCartCheckoutSessionEvent({
    admin: supabase,
    stripe,
    session,
    eventType: stripeEventType ?? "checkout.session.completed",
    stripeAccountId,
    claim: claim ?? null,
  });

  if (handledEventCartOrder) {
    return;
  }

  const handledPrivateLessonSlot =
    await handleEventPrivateLessonCheckoutCompleted(supabase, session, stripeAccountId);

  if (handledPrivateLessonSlot) {
    return;
  }

  const handledEventRegistration =
    await handleEventRegistrationCheckoutCompleted(
      supabase,
      stripe,
      session,
      stripeAccountId,
    );

  if (handledEventRegistration) {
    return;
  }

  const handledPortalFloorRental =
    await handlePortalFloorRentalCheckoutCompleted(supabase, session, stripeAccountId);

  if (handledPortalFloorRental) {
    return;
  }

  const handledClientPaymentRequest =
    await handleClientPaymentRequestCheckoutCompleted(
      supabase,
      session,
      stripeEventId,
      stripeEventType,
      stripeAccountId,
    );

  if (handledClientPaymentRequest) {
    return;
  }

  // GC-3.5-3: public paid Group Class registration (metadata.source "group_class_direct_payment").
  // Settled only from this verified, connected-account-scoped session via finalize_public_class_purchase.
  const handledGroupClassPurchase = await handleGroupClassPurchaseCheckout({
    supabase,
    stripe,
    session,
    stripeAccountId,
    eventId: stripeEventId ?? "",
    eventType: stripeEventType ?? "",
  });

  if (handledGroupClassPurchase) {
    return;
  }

  const studioId = getString(session.metadata?.studioId);
  const clientId = getString(session.metadata?.clientId);
  const customerId = getString(session.customer);

  if (!studioId || !clientId || !customerId) {
    throw new Error("Missing checkout session metadata.");
  }

  if (session.mode === "setup" || session.mode === "subscription") {
    // PAY-DC-1: membership setup/subscription sessions are created on the studio's
    // connected account. Require event.account and verify it is the studio's
    // connected account before any Stripe call; never read them on the platform.
    const verifiedAccount = await resolveMembershipStripeAccount({
      supabase,
      studioId,
      stripeAccountId,
    });

    if (!verifiedAccount.ok) {
      throw new Error(verifiedAccount.code);
    }

    const connectedAccountOptions = { stripeAccount: verifiedAccount.stripeAccount };

    if (session.mode === "setup") {
      const setupIntentId = getString(session.setup_intent);

      if (!setupIntentId) {
        throw new Error("Setup session missing setup intent.");
      }

      const setupIntent = await stripe.setupIntents.retrieve(
        setupIntentId,
        {},
        connectedAccountOptions,
      );
      const paymentMethodId = getString(setupIntent.payment_method);

      if (!paymentMethodId) {
        throw new Error("Setup intent missing payment method.");
      }

      await upsertStripePaymentMethodRecord(supabase, stripe, {
        studioId,
        clientId,
        customerId,
        paymentMethodId,
        stripeAccountId: verifiedAccount.stripeAccount,
      });

      return;
    }

    const subscriptionId = getString(session.subscription);

    if (!subscriptionId) {
      throw new Error("Subscription checkout session missing subscription id.");
    }

    const subscription = await stripe.subscriptions.retrieve(
      subscriptionId,
      { expand: ["default_payment_method", "customer"] },
      connectedAccountOptions,
    );

    const defaultPaymentMethodId =
      typeof subscription.default_payment_method === "string"
        ? subscription.default_payment_method
        : (subscription.default_payment_method?.id ?? null);

    let paymentMethodId = defaultPaymentMethodId;

    if (!paymentMethodId) {
      const customer = await stripe.customers.retrieve(
        customerId,
        { expand: ["invoice_settings.default_payment_method"] },
        connectedAccountOptions,
      );

      if (!("deleted" in customer) || customer.deleted !== true) {
        paymentMethodId =
          typeof customer.invoice_settings?.default_payment_method === "string"
            ? customer.invoice_settings.default_payment_method
            : (customer.invoice_settings?.default_payment_method?.id ?? null);
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
      stripeAccountId: verifiedAccount.stripeAccount,
    });
  }
}

export async function handleInvoicePaid(
  supabase: SupabaseClient,
  stripe: Stripe,
  invoice: Stripe.Invoice,
  stripeAccountId?: string | null,
) {
  // PAY-DC-1: DanceFlow SaaS invoices are platform-scoped (no event.account);
  // connected studio invoices are never processed as SaaS billing.
  const studioInvoiceHandled = stripeAccountId
    ? false
    : await upsertStudioInvoice({
        supabase,
        invoice,
      });

  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);

  if (studioInvoiceHandled && stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
      {},
      stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
    );
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
    const {
      data: localStripeSubscription,
      error: localStripeSubscriptionError,
    } = await supabase
      .from("stripe_subscriptions")
      .select("studio_id, client_id, client_membership_id, stripe_account_id")
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();

    if (localStripeSubscriptionError) {
      throw new Error(localStripeSubscriptionError.message);
    }

    // PAY-DC-2B: a subscription with a stored owner only accepts invoices from
    // that same account.
    if (
      localStripeSubscription?.stripe_account_id &&
      localStripeSubscription.stripe_account_id !== (stripeAccountId ?? null)
    ) {
      console.error("membership_invoice_account_mismatch");
      return;
    }

    if (localStripeSubscription) {
      resolvedStudioId = localStripeSubscription.studio_id;
      resolvedClientId = localStripeSubscription.client_id;
      resolvedClientMembershipId = localStripeSubscription.client_membership_id;
    }
  }

  if ((!resolvedStudioId || !resolvedClientId) && stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
      {},
      stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
    );

    const studioIdFromMetadata = getString(subscription.metadata?.studioId);
    const clientIdFromMetadata = getString(subscription.metadata?.clientId);
    const localMembershipIdFromMetadata = getString(
      subscription.metadata?.localMembershipId,
    );

    // PAY-DC-2B: a connected event may only resolve the studio named in
    // subscription metadata when that studio is proven to own this account.
    if (
      stripeAccountId &&
      studioIdFromMetadata &&
      !(await verifyConnectedStudio(
        supabase,
        studioIdFromMetadata,
        stripeAccountId,
        stripeSubscriptionId,
      ))
    ) {
      throw new Error("subscription_event_studio_mismatch");
    }

    if (studioIdFromMetadata && clientIdFromMetadata) {
      // PAY-DC-4A (G1): prove the metadata client/membership before the stripe_subscriptions write.
      if (stripeAccountId) {
        await assertMembershipReferencesBelongToStudio(supabase, {
          studioId: studioIdFromMetadata,
          clientId: clientIdFromMetadata,
          membershipId: localMembershipIdFromMetadata ?? resolvedClientMembershipId,
        });
      }

      resolvedStudioId = studioIdFromMetadata;
      resolvedClientId = clientIdFromMetadata;
      resolvedClientMembershipId =
        localMembershipIdFromMetadata ?? resolvedClientMembershipId;

      const currentPeriodStartUnix = getNumber(
        (subscription as unknown as { current_period_start?: number })
          .current_period_start,
      );
      const currentPeriodEndUnix = getNumber(
        (subscription as unknown as { current_period_end?: number })
          .current_period_end,
      );

      const latestInvoiceId =
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : (subscription.latest_invoice?.id ?? null);

      const defaultPaymentMethodId =
        typeof subscription.default_payment_method === "string"
          ? subscription.default_payment_method
          : (subscription.default_payment_method?.id ?? null);

      const {
        data: existingStripeSubscription,
        error: existingStripeSubscriptionError,
      } = await supabase
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
        stripe_price_id:
          getString(subscription.items.data[0]?.price?.id) ?? null,
        status: subscription.status,
        current_period_start: toIsoOrNull(currentPeriodStartUnix),
        current_period_end: toIsoOrNull(currentPeriodEndUnix),
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        default_payment_method_id: defaultPaymentMethodId,
        latest_invoice_id: latestInvoiceId,
        // PAY-DC-1: record the Stripe-provided owning account (null only for
        // platform-scoped legacy events), so membership actions can verify it.
        stripe_account_id: stripeAccountId ?? null,
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

  // PAY-DC-1: the legacy platform-only `stripe_customers` table is consulted only for
  // platform-scoped (legacy) invoices. Connected-account invoices never use it; their
  // customer ids belong to the studio's account, not the platform.
  if ((!resolvedStudioId || !resolvedClientId) && stripeCustomerId && !stripeAccountId) {
    const { data: stripeCustomerRow, error: stripeCustomerRowError } =
      await supabase
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

  // PAY-DC-4A (G1): a connected invoice may only book against a client and membership of the resolved
  // studio (covers both the stored-row and metadata paths). Platform-scoped legacy invoices unchanged.
  if (stripeAccountId) {
    await assertMembershipReferencesBelongToStudio(supabase, {
      studioId: resolvedStudioId,
      clientId: resolvedClientId,
      membershipId: resolvedClientMembershipId,
    });
  }

  const amountPaid = Number(invoice.amount_paid ?? 0) / 100;
  const currency = (invoice.currency ?? "usd").toLowerCase();
  const invoiceNumber = getString(invoice.number);
  const notes = invoiceNumber
    ? `Stripe invoice ${invoiceNumber}`
    : "Stripe invoice payment";

  const { data: insertedPayment, error: paymentInsertError } = await supabase
    .from("payments")
    .insert({
      studio_id: resolvedStudioId,
      client_id: resolvedClientId,
      client_membership_id: resolvedClientMembershipId,
      amount: amountPaid,
      payment_method: "card",
      status: "paid",
      paid_at: new Date().toISOString(),
      notes,
      source: "stripe",
      payment_channel: "online",
      payment_type: "membership",
      stripe_payment_intent_id: paymentIntentId,
      stripe_invoice_id: stripeInvoiceId,
      stripe_charge_id: chargeId,
      currency,
      // PAY-DC-2A: Stripe-signed event.account owns the charge; NULL = platform-scoped legacy event.
      stripe_account_id: stripeAccountId ?? null,
    })
    .select("id")
    .single();

  if (paymentInsertError || !insertedPayment) {
    throw new Error(paymentInsertError?.message ?? "Membership payment was not created.");
  }

  if (resolvedClientMembershipId) {
    const currentPeriodStartUnix = getNumber(
      invoice.lines?.data?.[0]?.period?.start ?? null,
    );
    const currentPeriodEndUnix = getNumber(
      invoice.lines?.data?.[0]?.period?.end ?? null,
    );
    const periodStart = toDateOnlyOrNull(currentPeriodStartUnix);
    const periodEnd = toDateOnlyOrNull(currentPeriodEndUnix);

    if (periodStart && periodEnd) {
      const { error: periodError } = await supabase
        .from("client_membership_periods")
        .upsert(
          {
            studio_id: resolvedStudioId,
            client_id: resolvedClientId,
            client_membership_id: resolvedClientMembershipId,
            period_start: periodStart,
            period_end: periodEnd,
            amount_due: amountPaid,
            amount_paid: amountPaid,
            currency,
            payment_status: "paid",
            payment_id: insertedPayment.id,
            payment_due_at: toIsoOrNull(currentPeriodStartUnix),
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "client_membership_id,period_start,period_end" },
        );
      if (periodError) throw new Error(periodError.message);
    }

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

export async function handleInvoicePaymentFailed(
  supabase: SupabaseClient,
  stripe: Stripe,
  invoice: Stripe.Invoice,
  stripeAccountId?: string | null,
) {
  // PAY-DC-2B: DanceFlow SaaS invoices are platform-scoped (no event.account);
  // connected (studio) invoices are never treated as SaaS billing.
  const studioInvoiceHandled = stripeAccountId
    ? false
    : await upsertStudioInvoice({
        supabase,
        invoice,
      });

  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);

  if (studioInvoiceHandled && stripeSubscriptionId) {
    const subscription =
      await stripe.subscriptions.retrieve(stripeSubscriptionId);
    await upsertStudioSubscription({
      supabase,
      stripe,
      subscription,
    });
  }

  if (!stripeSubscriptionId) return;

  const { data: stripeSubscription, error: stripeSubscriptionError } =
    await supabase
      .from("stripe_subscriptions")
      .select("studio_id, client_id, client_membership_id, stripe_account_id")
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();

  if (stripeSubscriptionError) {
    throw new Error(stripeSubscriptionError.message);
  }

  if (
    !stripeSubscription?.studio_id ||
    !stripeSubscription?.client_membership_id
  ) {
    return;
  }

  // PAY-DC-2B: a connected event may only mark a membership past due when the
  // subscription's stored account is exactly that account; a platform event
  // only applies to legacy platform subscriptions (no stored account).
  const storedAccountId = stripeSubscription.stripe_account_id ?? null;
  if ((stripeAccountId ?? null) !== storedAccountId) {
    console.error("membership_invoice_account_unverified");
    return;
  }

  const periodStart = toDateOnlyOrNull(
    getNumber(invoice.lines?.data?.[0]?.period?.start ?? null),
  );
  const periodEnd = toDateOnlyOrNull(
    getNumber(invoice.lines?.data?.[0]?.period?.end ?? null),
  );
  if (periodStart && periodEnd && stripeSubscription.client_id) {
    const { error: periodError } = await supabase
      .from("client_membership_periods")
      .upsert(
        {
          studio_id: stripeSubscription.studio_id,
          client_id: stripeSubscription.client_id,
          client_membership_id: stripeSubscription.client_membership_id,
          period_start: periodStart,
          period_end: periodEnd,
          amount_due: Number(invoice.amount_due ?? 0) / 100,
          amount_paid: Number(invoice.amount_paid ?? 0) / 100,
          currency: (invoice.currency ?? "usd").toLowerCase(),
          payment_status: "past_due",
          payment_due_at: toIsoOrNull(getNumber(invoice.due_date)),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_membership_id,period_start,period_end" },
      );
    if (periodError) throw new Error(periodError.message);
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

function getStripeBalanceTransactionId(
  value: string | Stripe.BalanceTransaction | null | undefined,
) {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

async function upsertStripePayoutRecord(
  supabase: SupabaseClient,
  event: Stripe.Event,
  payout: Stripe.Payout,
) {
  const stripeAccountId = event.account ?? null;
  const studioId = await resolveStudioIdForStripeAccount(
    supabase,
    stripeAccountId,
  );
  const stripeBalanceTransactionId = getStripeBalanceTransactionId(
    payout.balance_transaction,
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
    currency: (
      balanceTransaction.currency ??
      payout.currency ??
      "usd"
    ).toUpperCase(),
    type: balanceTransaction.type ?? null,
    description: balanceTransaction.description ?? null,
    available_on: toDateOnlyOrNull(balanceTransaction.available_on ?? null),
    balance_transaction_created_at: toIsoOrNull(
      balanceTransaction.created ?? null,
    ),
    reporting_category: balanceTransaction.reporting_category ?? null,
    fee_details:
      (balanceTransaction.fee_details as unknown as Record<
        string,
        unknown
      >[]) ?? [],
    raw_payload: balanceTransaction as unknown as Record<string, unknown>,
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
  const {
    supabase,
    stripe,
    payout,
    payoutRecordId,
    stripeAccountId,
    studioId,
  } = params;

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
      requestOptions,
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
    startingAfter =
      balanceTransactions.data[balanceTransactions.data.length - 1]?.id;
  }
}

function webhookResponse(message: string, status = 200) {
  return new Response(message, { status });
}

function logWebhookError(message: string, error: unknown) {
  console.error(
    message,
    error instanceof Error ? error.message : error,
  );
}

export async function POST(request: Request) {
  const stripe = getStripe();
  const body = await request.text();
  const headerList = await headers();
  const signature = headerList.get("stripe-signature");

  // PAY-DC-2B: the verifying secret determines the event's scope; platform
  // events never carry event.account and Connect events always do.
  const verification = verifyStripeWebhook({
    body,
    signature,
    platformSecret: process.env.STRIPE_WEBHOOK_SECRET,
    connectSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    stripe,
  });

  if (!verification.ok) {
    if (verification.reason === "not_configured") {
      console.error("Stripe webhook secret is not configured.");
      return webhookResponse("Webhook is not configured.", 503);
    }

    if (verification.reason === "missing_signature") {
      return webhookResponse("Invalid webhook request.", 400);
    }

    if (verification.reason === "scope_mismatch") {
      console.error("webhook_scope_mismatch");
      return webhookResponse("Invalid webhook scope.", 400);
    }

    console.error("Stripe webhook signature verification failed");
    return webhookResponse("Invalid webhook signature.", 400);
  }

  const event = verification.event;

  const supabase = getSupabaseAdmin();
  const payloadHash = createHash("sha256").update(body).digest("hex");

  // PAY-WH-1: one atomic, leased claim per delivery. Concurrent duplicates of the same event cannot both process it,
  // a processed event is acknowledged idempotently, and only the claim owner can finalize it.
  const claimOwner = randomUUID();
  const { data: claimData, error: claimError } = await supabase.rpc("claim_payment_provider_event", {
    p_provider: "stripe",
    p_provider_event_id: event.id,
    p_event_type: event.type,
    p_payload_hash: payloadHash,
    p_owner: claimOwner,
    p_lease_seconds: 120,
  });

  if (claimError) {
    logWebhookError("Stripe webhook event claim failed", claimError);
    return webhookResponse("Webhook event logging failed.", 500);
  }

  const claimOutcome = (claimData as { outcome?: string } | null)?.outcome;
  if (claimOutcome === "already_processed") {
    return new Response("Already processed", { status: 200 });
  }
  if (claimOutcome !== "claimed") {
    // Another delivery of this event holds a live claim; Stripe retries this one later.
    return webhookResponse("Webhook event is being processed.", 409);
  }
  const claim: WebhookClaim = { eventId: event.id, owner: claimOwner };

  try {
    // TW-4F-3b-pay: events about prepaid SMS credit purchases (our own Checkout Sessions / PaymentIntents, platform-scoped only) are handled exclusively here;
    // the database decides what is ours. Anything else falls through to the handlers below unchanged.
    const smsCredit = await handleSmsCreditStripeEvent({ admin: supabase, event });
    switch (smsCredit.handled ? "sms_credit_handled" : event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        // PKG-P1: async_payment_succeeded (delayed-settlement methods, e.g.
        // ACH) routes through the identical handler -- its internal logic
        // already branches on session.payment_status==='paid' rather than
        // the event name, and every write path it reaches is now
        // CAS-guarded (see handleClientPaymentRequestCheckoutCompleted), so
        // no new business logic is needed here, only this dispatch entry.
        await handleCheckoutSessionCompleted(
          supabase,
          stripe,
          event.data.object as Stripe.Checkout.Session,
          event.account,
          event.id,
          event.type,
          claim,
        );
        break;
      }

      case "checkout.session.expired": {
        // Phase 10C: an expired competition Checkout Session releases its pending registration.
        const handledCompetitionExpiry = await handleCompetitionRegistrationCheckoutEvent(
          supabase,
          stripe,
          event.data.object as Stripe.Checkout.Session,
          event.account,
          event.type,
        );
        if (!handledCompetitionExpiry) {
          // PAY-WH-1: an expired event cart Session closes its attempt (and releases the order if nothing else can pay).
          await handleEventCartCheckoutSessionEvent({
            admin: supabase,
            stripe,
            session: event.data.object as Stripe.Checkout.Session,
            eventType: event.type,
            stripeAccountId: event.account,
            claim,
          });
        }
        break;
      }

      case "checkout.session.async_payment_failed": {
        // PKG-P1: a failure event carries no money -- CAS-guarded
        // 'pending' -> 'failed' only, then the same atomic re-evaluation
        // every payment-state transition that can invalidate entitlement
        // uses. Never a financial mismatch, so never a conflict row.
        const session = event.data.object as Stripe.Checkout.Session;
        // Phase 10C: a failed delayed payment on a competition session releases that registration.
        const handledCompetitionFailure = await handleCompetitionRegistrationCheckoutEvent(
          supabase,
          stripe,
          session,
          event.account,
          event.type,
        );
        // PAY-WH-1: a failed delayed payment on an event cart Session releases that order (never a paid one).
        const handledCartFailure = handledCompetitionFailure
          ? null
          : await handleEventCartCheckoutSessionEvent({
              admin: supabase,
              stripe,
              session,
              eventType: event.type,
              stripeAccountId: event.account,
              claim,
            });
        const paymentId = handledCompetitionFailure || handledCartFailure ? null : getString(session.metadata?.paymentId);
        if (
          paymentId &&
          (await asyncPaymentFailureMatchesStoredPayment(supabase, {
            paymentId,
            sessionId: session.id,
            stripeAccountId: event.account ?? null,
          }))
        ) {
          const { error: failError } = await supabase.rpc(
            "_mark_package_payment_failed_and_reevaluate",
            { p_payment_id: paymentId, p_stripe_event_id: event.id },
          );
          if (failError) {
            throw new Error(failError.message);
          }
        }
        break;
      }

      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const handledMarketplace =
          await handleStudentMarketplacePaymentIntentSucceeded(
            supabase,
            paymentIntent,
            event.account,
          );
        const handledTerminal = handledMarketplace
          ? false
          : await handleTerminalPaymentIntentSucceeded(
              supabase,
              paymentIntent,
              event.account,
            );
        const handledEventCart = handledMarketplace || handledTerminal
          ? false
          : Boolean(await handleEventCartPaymentIntentEvent({
              admin: supabase,
              stripe,
              paymentIntent,
              eventType: event.type,
              stripeAccountId: event.account,
              claim,
            }));
        if (!handledMarketplace && !handledTerminal && !handledEventCart) {
          await syncFeeDetailsForPaymentIntent(
            supabase,
            stripe,
            paymentIntent.id,
            event.account,
          );
        }
        break;
      }

      case "payment_intent.processing":
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        // PAY-WH-1: delayed / failed / canceled event cart PaymentIntents (other flows ignore these events).
        await handleEventCartPaymentIntentEvent({
          admin: supabase,
          stripe,
          paymentIntent: event.data.object as Stripe.PaymentIntent,
          eventType: event.type,
          stripeAccountId: event.account,
          claim,
        });
        break;
      }

      case "charge.succeeded": {
        await syncFeeDetailsForCharge(
          supabase,
          stripe,
          event.data.object as Stripe.Charge,
          event.account,
        );
        break;
      }

      case "charge.updated": {
        const charge = event.data.object as Stripe.Charge;
        await syncFeeDetailsForCharge(
          supabase,
          stripe,
          charge,
          event.account,
        );
        if ((charge.amount_refunded ?? 0) > 0) {
          await handleChargeRefunded(
            supabase,
            stripe,
            charge,
            event.account,
            event.id,
            event.type,
          );
        }
        break;
      }

      case "refund.created":
      case "refund.updated":
      case "charge.refund.updated": {
        await handleStripeRefundUpdated(
          supabase,
          stripe,
          event.data.object as Stripe.Refund,
          event.account,
          event.id,
          event.type,
        );
        break;
      }

      case "charge.refunded": {
        await handleChargeRefunded(
          supabase,
          stripe,
          event.data.object as Stripe.Charge,
          event.account,
          event.id,
          event.type,
        );
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;

        // PAY-DC-1: only platform-scoped events can be DanceFlow SaaS subscriptions.
        const handled = event.account
          ? false
          : await upsertStudioSubscription({
              supabase,
              stripe,
              subscription,
            });

        if (!handled) {
          await upsertStripeSubscriptionRecord(
            supabase,
            subscription,
            event.account,
          );
        }

        break;
      }

      case "invoice.paid": {
        await handleInvoicePaid(
          supabase,
          stripe,
          event.data.object as Stripe.Invoice,
          event.account,
        );
        break;
      }

      case "invoice.payment_failed": {
        await handleInvoicePaymentFailed(
          supabase,
          stripe,
          event.data.object as Stripe.Invoice,
          event.account,
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
          payout,
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

      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated": {
        // PAY-DC-2C: record the dispute for the proven studio and notify on creation.
        await handleChargeDisputeEvent({ supabase, event });
        break;
      }

      default:
        break;
    }

    const { data: completed, error: processedError } = await supabase.rpc("complete_payment_provider_event", {
      p_provider: "stripe",
      p_provider_event_id: event.id,
      p_owner: claimOwner,
      p_status: "processed",
      p_outcome: null,
      p_error: null,
    });

    if (processedError || completed !== true) {
      // The lease was lost (another delivery reclaimed it) or finalization failed: never report success.
      logWebhookError("Stripe webhook event finalization failed", processedError ?? new Error("claim lease lost"));
      return webhookResponse("Webhook event finalization failed.", 500);
    }

    return webhookResponse("Webhook processed.", 200);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown webhook error";

    await supabase.rpc("complete_payment_provider_event", {
      p_provider: "stripe",
      p_provider_event_id: event.id,
      p_owner: claimOwner,
      p_status: "failed",
      p_outcome: null,
      p_error: errorMessage,
    });

    logWebhookError("Stripe webhook processing failed", error);
    return webhookResponse("Webhook processing failed.", 500);
  }
}
