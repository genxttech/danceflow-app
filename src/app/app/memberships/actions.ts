"use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { ensureStripeCustomer } from "@/lib/payments/customer";
import { getStripe } from "@/lib/payments/stripe";
import { ensureStripeRecurringPrice } from "@/lib/payments/subscriptions";

type CreateState = {
  error: string;
};

type BenefitInput = {
  benefitType?: string;
  quantity?: string;
  discountPercent?: string;
  discountAmount?: string;
  usagePeriod?: string;
  appliesTo?: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getNumberOrNull(value: string) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseBenefits(raw: string): BenefitInput[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function calculateMembershipPeriod(
  billingInterval: string,
  startsOn: string
) {
  const start = new Date(`${startsOn}T00:00:00`);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const periodStart = new Date(start);
  const periodEnd = new Date(start);

  if (billingInterval === "monthly") {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  } else if (billingInterval === "quarterly") {
    periodEnd.setMonth(periodEnd.getMonth() + 3);
  } else if (billingInterval === "yearly") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  periodEnd.setDate(periodEnd.getDate() - 1);

  const toDate = (value: Date) => {
    const yyyy = value.getFullYear();
    const mm = `${value.getMonth() + 1}`.padStart(2, "0");
    const dd = `${value.getDate()}`.padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  return {
    currentPeriodStart: toDate(periodStart),
    currentPeriodEnd: toDate(periodEnd),
  };
}

function getAppUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("Missing NEXT_PUBLIC_APP_URL");
  }
  return appUrl.replace(/\/$/, "");
}

function getFutureAnchorOrNull(startsOn: string) {
  const start = new Date(`${startsOn}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const now = new Date();
  if (start.getTime() <= now.getTime()) {
    return null;
  }

  return Math.floor(start.getTime() / 1000);
}

async function requireStudioConnectReadyForMemberships(studioId: string) {
  const supabase = await createClient();

  const { data: studio, error } = await supabase
    .from("studios")
    .select(
      `
      stripe_connected_account_id,
      stripe_connect_onboarding_complete,
      stripe_connect_payouts_enabled
    `
    )
    .eq("id", studioId)
    .single();

  if (error || !studio) {
    throw new Error("Could not load studio payment settings.");
  }

  if (!studio.stripe_connected_account_id) {
    throw new Error(
      "This studio has not connected Stripe yet. Membership checkout is not available."
    );
  }

  if (
    !studio.stripe_connect_onboarding_complete ||
    !studio.stripe_connect_payouts_enabled
  ) {
    throw new Error(
      "This studio has not completed Stripe payout setup yet. Membership checkout is not available."
    );
  }

  return {
    connectedAccountId: studio.stripe_connected_account_id,
  };
}

function mapStripeStatusToLocalMembershipStatus(
  status: string
): "pending" | "active" | "cancelled" | "past_due" | "unpaid" {
  if (status === "active" || status === "trialing") return "active";
  if (status === "canceled") return "cancelled";
  if (status === "past_due") return "past_due";
  if (status === "unpaid") return "unpaid";
  return "pending";
}

function getClientReturnUrl(clientId: string) {
  return `/app/clients/${clientId}`;
}

export async function createMembershipPlanAction(
  _prevState: CreateState,
  formData: FormData
): Promise<CreateState> {
  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;
    const userId = context.userId;

    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const billingInterval = getString(formData, "billingInterval") || "monthly";
    const priceRaw = getString(formData, "price");
    const signupFeeRaw = getString(formData, "signupFee");
    const visibility = getString(formData, "visibility") || "public";
    const sortOrderRaw = getString(formData, "sortOrder");
    const active = formData.get("active") === "on";
    const autoRenewDefault = formData.get("autoRenewDefault") === "on";
    const benefitsJson = getString(formData, "benefitsJson");

    if (!name) {
      return { error: "Membership plan name is required." };
    }

    const price = Number(priceRaw);
    if (Number.isNaN(price) || price < 0) {
      return { error: "Price must be a valid number." };
    }

    const signupFee = getNumberOrNull(signupFeeRaw);
    const sortOrder = getNumberOrNull(sortOrderRaw) ?? 0;

    const benefits = parseBenefits(benefitsJson).filter(
      (benefit) => benefit.benefitType
    );

    const { data: plan, error: planError } = await supabase
      .from("membership_plans")
      .insert({
        studio_id: studioId,
        name,
        description: description || null,
        active,
        billing_interval: billingInterval,
        price,
        signup_fee: signupFee,
        auto_renew_default: autoRenewDefault,
        visibility,
        sort_order: sortOrder,
        created_by: userId,
      })
      .select("id")
      .single();

    if (planError || !plan) {
      return {
        error: `Could not create membership plan: ${
          planError?.message ?? "Unknown error."
        }`,
      };
    }

    if (benefits.length > 0) {
      const rows = benefits.map((benefit, index) => ({
        membership_plan_id: plan.id,
        benefit_type: benefit.benefitType,
        quantity: getNumberOrNull(benefit.quantity ?? ""),
        discount_percent: getNumberOrNull(benefit.discountPercent ?? ""),
        discount_amount: getNumberOrNull(benefit.discountAmount ?? ""),
        usage_period: benefit.usagePeriod || "billing_cycle",
        applies_to: (benefit.appliesTo ?? "").trim() || null,
        sort_order: index,
      }));

      const { error: benefitsError } = await supabase
        .from("membership_plan_benefits")
        .insert(rows);

      if (benefitsError) {
        return {
          error: `Membership plan was created, but benefits failed to save: ${benefitsError.message}`,
        };
      }
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/memberships");
}

export async function updateMembershipPlanAction(
  _prevState: CreateState,
  formData: FormData
): Promise<CreateState> {
  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    const id = getString(formData, "id");
    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const billingInterval = getString(formData, "billingInterval") || "monthly";
    const priceRaw = getString(formData, "price");
    const signupFeeRaw = getString(formData, "signupFee");
    const visibility = getString(formData, "visibility") || "public";
    const sortOrderRaw = getString(formData, "sortOrder");
    const active = formData.get("active") === "on";
    const autoRenewDefault = formData.get("autoRenewDefault") === "on";
    const benefitsJson = getString(formData, "benefitsJson");

    if (!id) {
      return { error: "Missing membership plan id." };
    }

    if (!name) {
      return { error: "Membership plan name is required." };
    }

    const price = Number(priceRaw);
    if (Number.isNaN(price) || price < 0) {
      return { error: "Price must be a valid number." };
    }

    const signupFee = getNumberOrNull(signupFeeRaw);
    const sortOrder = getNumberOrNull(sortOrderRaw) ?? 0;

    const { data: existingPlan, error: existingPlanError } = await supabase
      .from("membership_plans")
      .select("id")
      .eq("id", id)
      .eq("studio_id", studioId)
      .single();

    if (existingPlanError || !existingPlan) {
      return { error: "Membership plan not found." };
    }

    const { error: updateError } = await supabase
      .from("membership_plans")
      .update({
        name,
        description: description || null,
        active,
        billing_interval: billingInterval,
        price,
        signup_fee: signupFee,
        auto_renew_default: autoRenewDefault,
        visibility,
        sort_order: sortOrder,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("studio_id", studioId);

    if (updateError) {
      return {
        error: `Could not update membership plan: ${updateError.message}`,
      };
    }

    const benefits = parseBenefits(benefitsJson).filter(
      (benefit) => benefit.benefitType
    );

    const { error: deleteBenefitsError } = await supabase
      .from("membership_plan_benefits")
      .delete()
      .eq("membership_plan_id", id);

    if (deleteBenefitsError) {
      return {
        error: `Plan updated, but old benefits could not be cleared: ${deleteBenefitsError.message}`,
      };
    }

    if (benefits.length > 0) {
      const rows = benefits.map((benefit, index) => ({
        membership_plan_id: id,
        benefit_type: benefit.benefitType,
        quantity: getNumberOrNull(benefit.quantity ?? ""),
        discount_percent: getNumberOrNull(benefit.discountPercent ?? ""),
        discount_amount: getNumberOrNull(benefit.discountAmount ?? ""),
        usage_period: benefit.usagePeriod || "billing_cycle",
        applies_to: (benefit.appliesTo ?? "").trim() || null,
        sort_order: index,
      }));

      const { error: insertBenefitsError } = await supabase
        .from("membership_plan_benefits")
        .insert(rows);

      if (insertBenefitsError) {
        return {
          error: `Plan updated, but benefits could not be saved: ${insertBenefitsError.message}`,
        };
      }
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  const id = getString(formData, "id");
  redirect(`/app/memberships/${id}`);
}

export async function assignMembershipToClientAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/memberships/sell";

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;
    const userId = context.userId;

    const clientId = getString(formData, "clientId");
    const membershipPlanId = getString(formData, "membershipPlanId");
    const startsOn = getString(formData, "startsOn");
    const autoRenew = formData.get("autoRenew") === "on";

    if (!clientId) {
      redirect(addQueryParam(returnTo, "error", "missing_client"));
    }

    if (!membershipPlanId) {
      redirect(addQueryParam(returnTo, "error", "missing_plan"));
    }

    if (!startsOn) {
      redirect(addQueryParam(returnTo, "error", "missing_start"));
    }

    const [{ data: client, error: clientError }, { data: plan, error: planError }] =
      await Promise.all([
        supabase
          .from("clients")
          .select("id, studio_id")
          .eq("id", clientId)
          .eq("studio_id", studioId)
          .single(),
        supabase
          .from("membership_plans")
          .select("id, studio_id, name, active, billing_interval, price")
          .eq("id", membershipPlanId)
          .eq("studio_id", studioId)
          .single(),
      ]);

    if (clientError || !client) {
      redirect(addQueryParam(returnTo, "error", "client_not_found"));
    }

    if (planError || !plan) {
      redirect(addQueryParam(returnTo, "error", "plan_not_found"));
    }

    if (!plan.active) {
      redirect(addQueryParam(returnTo, "error", "plan_inactive"));
    }

    const { data: existingMembership, error: existingMembershipError } = await supabase
      .from("client_memberships")
      .select("id")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .in("status", ["active", "pending", "past_due", "unpaid"])
      .maybeSingle();

    if (existingMembershipError) {
      redirect(addQueryParam(returnTo, "error", "membership_lookup_failed"));
    }

    if (existingMembership) {
      redirect(addQueryParam(returnTo, "error", "active_membership_exists"));
    }

    const period = calculateMembershipPeriod(plan.billing_interval, startsOn);
    if (!period) {
      redirect(addQueryParam(returnTo, "error", "invalid_start"));
    }

    const { error: createMembershipError } = await supabase
      .from("client_memberships")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        membership_plan_id: plan.id,
        status: "active",
        starts_on: startsOn,
        ends_on: null,
        current_period_start: period.currentPeriodStart,
        current_period_end: period.currentPeriodEnd,
        auto_renew: autoRenew,
        cancel_at_period_end: false,
        name_snapshot: plan.name,
        price_snapshot: plan.price,
        billing_interval_snapshot: plan.billing_interval,
        created_by: userId,
      });

    if (createMembershipError) {
      redirect(addQueryParam(returnTo, "error", "assign_failed"));
    }

    redirect(
      addQueryParam(`/app/clients/${clientId}`, "success", "membership_assigned")
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(addQueryParam(returnTo, "error", "assign_failed"));
  }
}

export async function startMembershipPaymentMethodSetupAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/memberships/sell";

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    const clientId = getString(formData, "clientId");
    if (!clientId) {
      redirect(addQueryParam(returnTo, "error", "missing_client"));
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .single();

    if (clientError || !client) {
      redirect(addQueryParam(returnTo, "error", "client_not_found"));
    }

    const fullName = `${client.first_name} ${client.last_name}`.trim();
    const stripeCustomerId = await ensureStripeCustomer({
      supabase,
      studioId,
      clientId: client.id,
      email: client.email ?? null,
      name: fullName || null,
    });

    const stripe = getStripe();
    const appUrl = getAppUrl();

    const successUrl = `${appUrl}/app/memberships/sell?success=membership_payment_method_saved`;
    const cancelUrl = `${appUrl}${returnTo}`;

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      currency: "usd",
      customer: stripeCustomerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        studioId,
        clientId: client.id,
        source: "membership_payment_method_setup",
      },
    });

    if (!session.url) {
      throw new Error("Payment method setup session was created without a url.");
    }

    redirect(session.url);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    const message =
      error instanceof Error ? error.message : "stripe_session_failed";
    redirect(addQueryParam(returnTo, "error", message));
  }
}

export async function sellMembershipAction(formData: FormData) {
  const returnTo = getString(formData, "returnTo") || "/app/memberships/sell";

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;
    const userId = context.userId;

    const clientId = getString(formData, "clientId");
    const membershipPlanId = getString(formData, "membershipPlanId");
    const startsOn = getString(formData, "startsOn");
    const autoRenew = formData.get("autoRenew") === "on";

    if (!clientId) {
      redirect(addQueryParam(returnTo, "error", "missing_client"));
    }

    if (!membershipPlanId) {
      redirect(addQueryParam(returnTo, "error", "missing_plan"));
    }

    if (!startsOn) {
      redirect(addQueryParam(returnTo, "error", "missing_start"));
    }

    const [{ data: client, error: clientError }, { data: plan, error: planError }] =
      await Promise.all([
        supabase
          .from("clients")
          .select("id, studio_id, first_name, last_name, email")
          .eq("id", clientId)
          .eq("studio_id", studioId)
          .single(),
        supabase
          .from("membership_plans")
          .select(`
            id,
            studio_id,
            name,
            active,
            billing_interval,
            price,
            stripe_product_id,
            stripe_price_id
          `)
          .eq("id", membershipPlanId)
          .eq("studio_id", studioId)
          .single(),
      ]);

    if (clientError || !client) {
      redirect(addQueryParam(returnTo, "error", "client_not_found"));
    }

    if (planError || !plan) {
      redirect(addQueryParam(returnTo, "error", "plan_not_found"));
    }

    if (!plan.active) {
      redirect(addQueryParam(returnTo, "error", "plan_inactive"));
    }

    const { data: existingMembership, error: existingMembershipError } = await supabase
      .from("client_memberships")
      .select("id")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .in("status", ["active", "pending", "past_due", "unpaid"])
      .maybeSingle();

    if (existingMembershipError) {
      redirect(addQueryParam(returnTo, "error", "membership_lookup_failed"));
    }

    if (existingMembership) {
      redirect(addQueryParam(returnTo, "error", "active_membership_exists"));
    }

    const period = calculateMembershipPeriod(plan.billing_interval, startsOn);
    if (!period) {
      redirect(addQueryParam(returnTo, "error", "invalid_start"));
    }

    const fullName = `${client.first_name} ${client.last_name}`.trim();
    const stripeCustomerId = await ensureStripeCustomer({
      supabase,
      studioId,
      clientId: client.id,
      email: client.email ?? null,
      name: fullName || null,
    });

    const { stripePriceId } = await ensureStripeRecurringPrice({
      supabase,
      membershipPlanId: plan.id,
      planName: plan.name,
      price: Number(plan.price ?? 0),
      billingInterval: plan.billing_interval,
      stripeProductId: plan.stripe_product_id ?? null,
      stripePriceId: plan.stripe_price_id ?? null,
    });

    const { data: localMembership, error: membershipInsertError } = await supabase
      .from("client_memberships")
      .insert({
        studio_id: studioId,
        client_id: client.id,
        membership_plan_id: plan.id,
        status: "pending",
        starts_on: startsOn,
        ends_on: null,
        current_period_start: period.currentPeriodStart,
        current_period_end: period.currentPeriodEnd,
        auto_renew: autoRenew,
        cancel_at_period_end: false,
        name_snapshot: plan.name,
        price_snapshot: plan.price,
        billing_interval_snapshot: plan.billing_interval,
        created_by: userId,
      })
      .select("id")
      .single();

    if (membershipInsertError || !localMembership) {
      throw new Error(
        `Local membership creation failed: ${
          membershipInsertError?.message ?? "Unknown error"
        }`
      );
    }

    const stripe = getStripe();
    const appUrl = getAppUrl();
    const anchor = getFutureAnchorOrNull(startsOn);
    const connectStatus = await requireStudioConnectReadyForMemberships(studioId);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      success_url: `${appUrl}/app/clients/${client.id}?success=membership_subscription_created`,
      cancel_url: `${appUrl}${returnTo}`,
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        ...(anchor ? { billing_cycle_anchor: anchor } : {}),
        transfer_data: {
          destination: connectStatus.connectedAccountId,
        },
        metadata: {
          localMembershipId: localMembership.id,
          studioId,
          clientId: client.id,
          membershipPlanId: plan.id,
          source: "membership_sale",
        },
      },
      metadata: {
        localMembershipId: localMembership.id,
        studioId,
        clientId: client.id,
        membershipPlanId: plan.id,
        source: "membership_sale",
      },
      client_reference_id: client.id,
    });

    if (!session.url) {
      throw new Error("Membership checkout session was created without a url.");
    }

    redirect(session.url);
  } catch (error) {
    if (isRedirectError(error)) throw error;

    const message =
      error instanceof Error ? error.message : "membership_sale_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}

export async function cancelMembershipAtPeriodEndAction(formData: FormData) {
  const clientMembershipId = getString(formData, "clientMembershipId");
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || getClientReturnUrl(clientId);

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientMembershipId) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: membership, error: membershipError } = await supabase
      .from("client_memberships")
      .select(`
        id,
        client_id,
        studio_id,
        status,
        current_period_end,
        cancel_at_period_end,
        auto_renew
      `)
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId)
      .single();

    if (membershipError || !membership) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: stripeSubscriptionRow, error: stripeSubscriptionError } =
      await supabase
        .from("stripe_subscriptions")
        .select("id, stripe_subscription_id, status")
        .eq("client_membership_id", clientMembershipId)
        .eq("studio_id", studioId)
        .maybeSingle();

    if (stripeSubscriptionError) {
      throw new Error(stripeSubscriptionError.message);
    }

    if (!stripeSubscriptionRow?.stripe_subscription_id) {
      redirect(addQueryParam(returnTo, "error", "stripe_subscription_not_found"));
    }

    const stripe = getStripe();

    const updatedSubscription = await stripe.subscriptions.update(
      stripeSubscriptionRow.stripe_subscription_id,
      {
        cancel_at_period_end: true,
      }
    );

    const currentPeriodEndUnix =
      typeof (updatedSubscription as { current_period_end?: unknown }).current_period_end ===
      "number"
        ? (updatedSubscription as { current_period_end: number }).current_period_end
        : null;

    const { error: updateStripeSubscriptionError } = await supabase
      .from("stripe_subscriptions")
      .update({
        status: updatedSubscription.status,
        cancel_at_period_end: true,
        current_period_end: currentPeriodEndUnix
          ? new Date(currentPeriodEndUnix * 1000).toISOString()
          : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", stripeSubscriptionRow.id);

    if (updateStripeSubscriptionError) {
      throw new Error(updateStripeSubscriptionError.message);
    }

    const { error: updateMembershipError } = await supabase
      .from("client_memberships")
      .update({
        status: mapStripeStatusToLocalMembershipStatus(updatedSubscription.status),
        cancel_at_period_end: true,
        auto_renew: false,
        ends_on: currentPeriodEndUnix
          ? new Date(currentPeriodEndUnix * 1000).toISOString().slice(0, 10)
          : membership.current_period_end,
      })
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId);

    if (updateMembershipError) {
      throw new Error(updateMembershipError.message);
    }

    redirect(addQueryParam(returnTo, "success", "membership_cancel_at_period_end"));
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "membership_cancel_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}

export async function reactivateMembershipAutoRenewAction(formData: FormData) {
  const clientMembershipId = getString(formData, "clientMembershipId");
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || getClientReturnUrl(clientId);

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientMembershipId) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: membership, error: membershipError } = await supabase
      .from("client_memberships")
      .select(`
        id,
        client_id,
        studio_id,
        status,
        cancel_at_period_end,
        auto_renew
      `)
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId)
      .single();

    if (membershipError || !membership) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: stripeSubscriptionRow, error: stripeSubscriptionError } =
      await supabase
        .from("stripe_subscriptions")
        .select("id, stripe_subscription_id, status")
        .eq("client_membership_id", clientMembershipId)
        .eq("studio_id", studioId)
        .maybeSingle();

    if (stripeSubscriptionError) {
      throw new Error(stripeSubscriptionError.message);
    }

    if (!stripeSubscriptionRow?.stripe_subscription_id) {
      redirect(addQueryParam(returnTo, "error", "stripe_subscription_not_found"));
    }

    const stripe = getStripe();

    const updatedSubscription = await stripe.subscriptions.update(
      stripeSubscriptionRow.stripe_subscription_id,
      {
        cancel_at_period_end: false,
      }
    );

    const currentPeriodEndUnix =
      typeof (updatedSubscription as { current_period_end?: unknown }).current_period_end ===
      "number"
        ? (updatedSubscription as { current_period_end: number }).current_period_end
        : null;

    const { error: updateStripeSubscriptionError } = await supabase
      .from("stripe_subscriptions")
      .update({
        status: updatedSubscription.status,
        cancel_at_period_end: false,
        current_period_end: currentPeriodEndUnix
          ? new Date(currentPeriodEndUnix * 1000).toISOString()
          : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", stripeSubscriptionRow.id);

    if (updateStripeSubscriptionError) {
      throw new Error(updateStripeSubscriptionError.message);
    }

    const { error: updateMembershipError } = await supabase
      .from("client_memberships")
      .update({
        status: mapStripeStatusToLocalMembershipStatus(updatedSubscription.status),
        cancel_at_period_end: false,
        auto_renew: true,
        ends_on: null,
      })
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId);

    if (updateMembershipError) {
      throw new Error(updateMembershipError.message);
    }

    redirect(addQueryParam(returnTo, "success", "membership_auto_renew_restored"));
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "membership_reactivate_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}

export async function collectReplacementPaymentMethodAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || getClientReturnUrl(clientId);

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientId) {
      redirect(addQueryParam(returnTo, "error", "missing_client"));
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .single();

    if (clientError || !client) {
      redirect(addQueryParam(returnTo, "error", "client_not_found"));
    }

    const fullName = `${client.first_name} ${client.last_name}`.trim();

    const stripeCustomerId = await ensureStripeCustomer({
      supabase,
      studioId,
      clientId: client.id,
      email: client.email ?? null,
      name: fullName || null,
    });

    const stripe = getStripe();
    const appUrl = getAppUrl();

    const successUrl = `${appUrl}/app/clients/${client.id}?success=membership_payment_method_updated`;
    const cancelUrl = `${appUrl}${returnTo}`;

    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      currency: "usd",
      customer: stripeCustomerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        studioId,
        clientId: client.id,
        source: "delinquent_membership_payment_method_update",
      },
    });

    if (!session.url) {
      throw new Error("Payment method update session was created without a url.");
    }

    redirect(session.url);
  } catch (error) {
    if (isRedirectError(error)) throw error;

    const message =
      error instanceof Error ? error.message : "membership_payment_method_update_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}

export async function retryDelinquentMembershipBillingAction(formData: FormData) {
  const clientMembershipId = getString(formData, "clientMembershipId");
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || getClientReturnUrl(clientId);

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientMembershipId) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: membership, error: membershipError } = await supabase
      .from("client_memberships")
      .select("id, studio_id, client_id, status")
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId)
      .single();

    if (membershipError || !membership) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    if (!["past_due", "unpaid", "active"].includes(membership.status)) {
      redirect(addQueryParam(returnTo, "error", "membership_retry_not_allowed"));
    }

    const { data: stripeSubscriptionRow, error: stripeSubscriptionError } =
      await supabase
        .from("stripe_subscriptions")
        .select(
          "id, stripe_subscription_id, stripe_customer_id, default_payment_method_id"
        )
        .eq("client_membership_id", clientMembershipId)
        .eq("studio_id", studioId)
        .maybeSingle();

    if (stripeSubscriptionError) {
      throw new Error(stripeSubscriptionError.message);
    }

    if (!stripeSubscriptionRow?.stripe_subscription_id) {
      redirect(addQueryParam(returnTo, "error", "stripe_subscription_not_found"));
    }

    let defaultPaymentMethodId = stripeSubscriptionRow.default_payment_method_id ?? null;

    if (!defaultPaymentMethodId && stripeSubscriptionRow.stripe_customer_id) {
      const { data: defaultMethodRow, error: defaultMethodError } = await supabase
        .from("stripe_payment_methods")
        .select("stripe_payment_method_id")
        .eq("studio_id", studioId)
        .eq("client_id", membership.client_id)
        .eq("stripe_customer_id", stripeSubscriptionRow.stripe_customer_id)
        .eq("is_default", true)
        .eq("status", "active")
        .maybeSingle();

      if (defaultMethodError) {
        throw new Error(defaultMethodError.message);
      }

      defaultPaymentMethodId = defaultMethodRow?.stripe_payment_method_id ?? null;
    }

    if (!defaultPaymentMethodId) {
      redirect(addQueryParam(returnTo, "error", "missing_default_payment_method"));
    }

    const stripe = getStripe();

    await stripe.subscriptions.update(stripeSubscriptionRow.stripe_subscription_id, {
      default_payment_method: defaultPaymentMethodId,
      cancel_at_period_end: false,
      collection_method: "charge_automatically",
    });

    const invoices = await stripe.invoices.list({
      subscription: stripeSubscriptionRow.stripe_subscription_id,
      status: "open",
      limit: 10,
    });

    const payableInvoice = invoices.data.find(
      (invoice) => invoice.collection_method === "charge_automatically"
    );

    if (!payableInvoice) {
      redirect(addQueryParam(returnTo, "success", "membership_retry_submitted"));
    }

    await stripe.invoices.pay(payableInvoice.id, {
      payment_method: defaultPaymentMethodId,
    });

    redirect(addQueryParam(returnTo, "success", "membership_retry_submitted"));
  } catch (error) {
    if (isRedirectError(error)) throw error;

    const message =
      error instanceof Error ? error.message : "membership_retry_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}