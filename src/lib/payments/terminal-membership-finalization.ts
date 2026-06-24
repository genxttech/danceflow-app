import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe } from "@/lib/payments/stripe";
import {
  createConnectedStripeMembershipSubscription,
  ensureConnectedStripeRecurringPrice,
} from "@/lib/payments/subscriptions";

type FinalizeParams = {
  supabase: SupabaseClient;
  paymentIntentId: string;
};

function getGeneratedCard(paymentIntent: Stripe.PaymentIntent) {
  const charge =
    typeof paymentIntent.latest_charge === "string" ? null : paymentIntent.latest_charge;
  return (
    charge as (Stripe.Charge & {
      payment_method_details?: {
        card_present?: { generated_card?: string | null } | null;
      } | null;
    }) | null
  )?.payment_method_details?.card_present?.generated_card ?? null;
}

export async function finalizeTerminalMembership({
  supabase,
  paymentIntentId,
}: FinalizeParams) {
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("membership_terminal_enrollments")
    .select(`
      id, studio_id, client_id, client_membership_id, payment_id,
      stripe_account_id, stripe_customer_id, stripe_subscription_id,
      renewal_anchor, status,
      client_memberships (
        membership_plan_id, name_snapshot, price_snapshot,
        billing_interval_snapshot, current_period_start, current_period_end
      )
    `)
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (enrollmentError) throw new Error(enrollmentError.message);
  if (!enrollment) return false;
  if (enrollment.status === "subscription_created" && enrollment.stripe_subscription_id) {
    return true;
  }
  if (!enrollment.stripe_account_id || !enrollment.stripe_customer_id) {
    throw new Error("Terminal membership is missing its connected Stripe account or customer.");
  }

  const membership = Array.isArray(enrollment.client_memberships)
    ? enrollment.client_memberships[0]
    : enrollment.client_memberships;
  if (!membership?.membership_plan_id) {
    throw new Error("Terminal membership plan could not be loaded.");
  }

  const stripe = getStripe();
  const paymentIntent = await stripe.paymentIntents.retrieve(
    paymentIntentId,
    { expand: ["latest_charge"] },
    { stripeAccount: enrollment.stripe_account_id }
  );
  if (paymentIntent.status !== "succeeded") return false;

  const generatedCard = getGeneratedCard(paymentIntent);
  if (!generatedCard) {
    await supabase
      .from("membership_terminal_enrollments")
      .update({
        status: "failed",
        error_message: "This card did not provide a reusable payment method.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollment.id);
    throw new Error("The reader payment succeeded, but this card cannot be used for recurring billing.");
  }

  const { stripePriceId } = await ensureConnectedStripeRecurringPrice({
    supabase,
    studioId: enrollment.studio_id,
    membershipPlanId: membership.membership_plan_id,
    planName: membership.name_snapshot,
    price: Number(membership.price_snapshot),
    billingInterval: membership.billing_interval_snapshot,
    stripeAccountId: enrollment.stripe_account_id,
  });

  const renewalAnchor = Math.floor(new Date(enrollment.renewal_anchor).getTime() / 1000);
  if (!Number.isFinite(renewalAnchor) || renewalAnchor <= Math.floor(Date.now() / 1000)) {
    throw new Error("The membership renewal date is no longer in the future.");
  }

  await stripe.customers.update(
    enrollment.stripe_customer_id,
    { invoice_settings: { default_payment_method: generatedCard } },
    { stripeAccount: enrollment.stripe_account_id }
  );

  const subscription = await createConnectedStripeMembershipSubscription({
    stripeCustomerId: enrollment.stripe_customer_id,
    stripePriceId,
    defaultPaymentMethodId: generatedCard,
    localMembershipId: enrollment.client_membership_id,
    studioId: enrollment.studio_id,
    clientId: enrollment.client_id,
    membershipPlanId: membership.membership_plan_id,
    stripeAccountId: enrollment.stripe_account_id,
    renewalAnchor,
    idempotencyKey: `terminal-membership-${enrollment.id}`,
  });

  const item = subscription.items.data[0];
  const periodStart = item?.current_period_start
    ? new Date(item.current_period_start * 1000).toISOString()
    : null;
  const periodEnd = item?.current_period_end
    ? new Date(item.current_period_end * 1000).toISOString()
    : null;

  const { error: subscriptionSaveError } = await supabase
    .from("stripe_subscriptions")
    .upsert(
      {
        studio_id: enrollment.studio_id,
        client_id: enrollment.client_id,
        client_membership_id: enrollment.client_membership_id,
        membership_plan_id: membership.membership_plan_id,
        stripe_account_id: enrollment.stripe_account_id,
        stripe_customer_id: enrollment.stripe_customer_id,
        stripe_subscription_id: subscription.id,
        stripe_price_id: stripePriceId,
        status: subscription.status,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: subscription.cancel_at_period_end,
        default_payment_method_id: generatedCard,
        latest_invoice_id:
          typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_subscription_id" }
    );
  if (subscriptionSaveError) throw new Error(subscriptionSaveError.message);

  const now = new Date().toISOString();
  const [{ error: membershipUpdateError }, { error: enrollmentUpdateError }] =
    await Promise.all([
      supabase
        .from("client_memberships")
        .update({ status: "active", updated_at: now })
        .eq("id", enrollment.client_membership_id)
        .eq("studio_id", enrollment.studio_id),
      supabase
        .from("membership_terminal_enrollments")
        .update({
          status: "subscription_created",
          generated_payment_method_id: generatedCard,
          stripe_subscription_id: subscription.id,
          error_message: null,
          completed_at: now,
          updated_at: now,
        })
        .eq("id", enrollment.id),
    ]);
  if (membershipUpdateError) throw new Error(membershipUpdateError.message);
  if (enrollmentUpdateError) throw new Error(enrollmentUpdateError.message);
  return true;
}
