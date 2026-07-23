"use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { ensureConnectedStripeCustomer } from "@/lib/payments/customer";
import { getStripe } from "@/lib/payments/stripe";
import { ensureConnectedStripeRecurringPrice } from "@/lib/payments/subscriptions";
import { recordManualMembershipPayment } from "@/lib/memberships/manual-payment";

type CreateState = {
  error: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BILLING_INTERVALS = new Set(["monthly", "quarterly", "yearly"]);
const PLAN_VISIBILITIES = new Set(["public", "private", "hidden"]);
const BENEFIT_TYPES = new Set([
  "included_private_lessons",
  "included_group_classes",
  "discount_percent",
  "discount_amount",
  "floor_rental_discount_percent",
  "floor_rental_discount_amount",
  "other",
]);
const USAGE_PERIODS = new Set(["billing_cycle", "month", "quarter", "year", "lifetime"]);

type BenefitInput = {
  benefitType?: string;
  quantity?: string;
  discountPercent?: string;
  discountAmount?: string;
  usagePeriod?: string;
  appliesTo?: string;
};

function cleanText(value: string, maxLength = 800) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, maxLength);
}

function getString(formData: FormData, key: string, maxLength = 800) {
  const value = formData.get(key);
  return typeof value === "string" ? cleanText(value, maxLength) : "";
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function safeReturnTo(value: string, fallback: string) {
  const cleaned = cleanText(value, 400);
  if (!cleaned || !cleaned.startsWith("/") || cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getNumberOrNull(value: string) {
  if (!value) return null;
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) return null;
  return Math.round(parsed * 100) / 100;
}

function parseBenefits(raw: string): BenefitInput[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 30).map((benefit) => {
      const row = benefit as BenefitInput;
      const benefitType = cleanText(String(row.benefitType ?? ""), 80);
      const usagePeriod = cleanText(String(row.usagePeriod ?? "billing_cycle"), 80);
      return {
        benefitType: BENEFIT_TYPES.has(benefitType) ? benefitType : "",
        quantity: cleanText(String(row.quantity ?? ""), 20),
        discountPercent: cleanText(String(row.discountPercent ?? ""), 20),
        discountAmount: cleanText(String(row.discountAmount ?? ""), 20),
        usagePeriod: USAGE_PERIODS.has(usagePeriod) ? usagePeriod : "billing_cycle",
        appliesTo: cleanText(String(row.appliesTo ?? ""), 120),
      };
    });
  } catch {
    return [];
  }
}

function addQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function calculateMembershipPeriod(billingInterval: string, startsOn: string) {
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
    `,
    )
    .eq("id", studioId)
    .single();

  if (error || !studio) {
    throw new Error("Could not load studio payment settings.");
  }

  if (!studio.stripe_connected_account_id) {
    throw new Error(
      "This studio has not connected Stripe yet. Membership checkout is not available.",
    );
  }

  if (
    !studio.stripe_connect_onboarding_complete ||
    !studio.stripe_connect_payouts_enabled
  ) {
    throw new Error(
      "This studio has not completed Stripe payout setup yet. Membership checkout is not available.",
    );
  }

  return {
    connectedAccountId: studio.stripe_connected_account_id,
  };
}

function mapStripeStatusToLocalMembershipStatus(
  status: string,
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
  formData: FormData,
): Promise<CreateState> {
  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;
    const userId = context.userId;

    const name = getString(formData, "name", 120);
    const description = getString(formData, "description", 1000);
    const requestedBillingInterval = getString(formData, "billingInterval", 40) || "monthly";
    const billingInterval = BILLING_INTERVALS.has(requestedBillingInterval) ? requestedBillingInterval : "monthly";
    const priceRaw = getString(formData, "price", 40);
    const signupFeeRaw = getString(formData, "signupFee");
    const requestedVisibility = getString(formData, "visibility", 40) || "public";
    const visibility = PLAN_VISIBILITIES.has(requestedVisibility) ? requestedVisibility : "public";
    const sortOrderRaw = getString(formData, "sortOrder");
    const active = formData.get("active") === "on";
    const autoRenewDefault = formData.get("autoRenewDefault") === "on";
    const benefitsJson = getString(formData, "benefitsJson");

    if (!name) {
      return { error: "Membership plan name is required." };
    }

    const price = getNumberOrNull(priceRaw);
    if (price === null) {
      return { error: "Price must be a valid number." };
    }

    const signupFee = getNumberOrNull(signupFeeRaw);
    const sortOrder = getNumberOrNull(sortOrderRaw) ?? 0;

    const benefits = parseBenefits(benefitsJson).filter(
      (benefit) => benefit.benefitType,
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
  formData: FormData,
): Promise<CreateState> {
  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    const id = getString(formData, "id");
    const name = getString(formData, "name", 120);
    const description = getString(formData, "description", 1000);
    const requestedBillingInterval = getString(formData, "billingInterval", 40) || "monthly";
    const billingInterval = BILLING_INTERVALS.has(requestedBillingInterval) ? requestedBillingInterval : "monthly";
    const priceRaw = getString(formData, "price", 40);
    const signupFeeRaw = getString(formData, "signupFee");
    const requestedVisibility = getString(formData, "visibility", 40) || "public";
    const visibility = PLAN_VISIBILITIES.has(requestedVisibility) ? requestedVisibility : "public";
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

    const price = getNumberOrNull(priceRaw);
    if (price === null) {
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
      (benefit) => benefit.benefitType,
    );

    const { data: deletedBenefits, error: deleteBenefitsError } = await supabase
      .from("membership_plan_benefits")
      .delete()
      .eq("membership_plan_id", id)
      .select("id");

    void deletedBenefits;

    if (deleteBenefitsError) {
      return {
        error: `Plan updated, but old benefits could not be cleared: ${deleteBenefitsError.message}`,
      };
    }

    const { data: remainingBenefits, error: remainingBenefitsError } =
      await supabase
        .from("membership_plan_benefits")
        .select("id")
        .eq("membership_plan_id", id);

    if (remainingBenefitsError) {
      return {
        error: `Plan updated, but benefits could not be verified: ${remainingBenefitsError.message}`,
      };
    }

    if ((remainingBenefits ?? []).length > 0) {
      return {
        error:
          "Plan updated, but old benefits were not removed. Run the membership benefits RLS cleanup migration and try again.",
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
  const returnTo = safeReturnTo(getString(formData, "returnTo"), "/app/memberships/sell");

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

    if (!isUuid(clientId)) {
      redirect(addQueryParam(returnTo, "error", "invalid_client"));
    }

    if (!membershipPlanId) {
      redirect(addQueryParam(returnTo, "error", "missing_plan"));
    }

    if (!isUuid(membershipPlanId)) {
      redirect(addQueryParam(returnTo, "error", "invalid_plan"));
    }

    if (!startsOn) {
      redirect(addQueryParam(returnTo, "error", "missing_start"));
    }

    if (!isDateOnly(startsOn)) {
      redirect(addQueryParam(returnTo, "error", "invalid_start"));
    }

    const [
      { data: client, error: clientError },
      { data: plan, error: planError },
    ] = await Promise.all([
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

    const { data: existingMembership, error: existingMembershipError } =
      await supabase
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
      addQueryParam(
        `/app/clients/${clientId}`,
        "success",
        "membership_assigned",
      ),
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(addQueryParam(returnTo, "error", "assign_failed"));
  }
}

export async function startMembershipPaymentMethodSetupAction(
  formData: FormData,
) {
  const returnTo = safeReturnTo(getString(formData, "returnTo"), "/app/memberships/sell");

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    const clientId = getString(formData, "clientId");
    if (!clientId) {
      redirect(addQueryParam(returnTo, "error", "missing_client"));
    }

    if (!isUuid(clientId)) {
      redirect(addQueryParam(returnTo, "error", "invalid_client"));
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

    const connectStatus =
      await requireStudioConnectReadyForMemberships(studioId);
    const fullName = `${client.first_name} ${client.last_name}`.trim();
    const stripeCustomerId = await ensureConnectedStripeCustomer({
      supabase,
      studioId,
      clientId: client.id,
      email: client.email ?? null,
      name: fullName || null,
      stripeAccountId: connectStatus.connectedAccountId,
    });

    const stripe = getStripe();
    const appUrl = getAppUrl();

    const successUrl = `${appUrl}${addQueryParam(returnTo, "success", "membership_payment_method_saved")}`;
    const cancelUrl = `${appUrl}${returnTo}`;

    const session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        currency: "usd",
        customer: stripeCustomerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          studioId,
          clientId: client.id,
          source: "membership_payment_method_setup",
          connectedAccountId: connectStatus.connectedAccountId,
          chargeModel: "direct",
        },
      },
      {
        stripeAccount: connectStatus.connectedAccountId,
      },
    );

    if (!session.url) {
      throw new Error(
        "Payment method setup session was created without a url.",
      );
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
  const returnTo = safeReturnTo(getString(formData, "returnTo"), "/app/memberships/sell");

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

    if (!isUuid(clientId)) {
      redirect(addQueryParam(returnTo, "error", "invalid_client"));
    }

    if (!membershipPlanId) {
      redirect(addQueryParam(returnTo, "error", "missing_plan"));
    }

    if (!isUuid(membershipPlanId)) {
      redirect(addQueryParam(returnTo, "error", "invalid_plan"));
    }

    if (!startsOn) {
      redirect(addQueryParam(returnTo, "error", "missing_start"));
    }

    if (!isDateOnly(startsOn)) {
      redirect(addQueryParam(returnTo, "error", "invalid_start"));
    }

    const [
      { data: client, error: clientError },
      { data: plan, error: planError },
    ] = await Promise.all([
      supabase
        .from("clients")
        .select("id, studio_id, first_name, last_name, email")
        .eq("id", clientId)
        .eq("studio_id", studioId)
        .single(),
      supabase
        .from("membership_plans")
        .select(
          `
            id,
            studio_id,
            name,
            active,
            billing_interval,
            price,
            stripe_product_id,
            stripe_price_id
          `,
        )
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

    const { data: existingMembership, error: existingMembershipError } =
      await supabase
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

    const connectStatus =
      await requireStudioConnectReadyForMemberships(studioId);
    const fullName = `${client.first_name} ${client.last_name}`.trim();
    const stripeCustomerId = await ensureConnectedStripeCustomer({
      supabase,
      studioId,
      clientId: client.id,
      email: client.email ?? null,
      name: fullName || null,
      stripeAccountId: connectStatus.connectedAccountId,
    });

    const { stripePriceId } = await ensureConnectedStripeRecurringPrice({
      supabase,
      studioId,
      membershipPlanId: plan.id,
      planName: plan.name,
      price: Number(plan.price ?? 0),
      billingInterval: plan.billing_interval,
      stripeAccountId: connectStatus.connectedAccountId,
    });

    const { data: localMembership, error: membershipInsertError } =
      await supabase
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
        }`,
      );
    }

    const stripe = getStripe();
    const appUrl = getAppUrl();
    const anchor = getFutureAnchorOrNull(startsOn);

    const session = await stripe.checkout.sessions.create(
      {
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
          metadata: {
            localMembershipId: localMembership.id,
            studioId,
            clientId: client.id,
            membershipPlanId: plan.id,
            source: "membership_sale",
            connectedAccountId: connectStatus.connectedAccountId,
            chargeModel: "direct",
          },
        },
        metadata: {
          localMembershipId: localMembership.id,
          studioId,
          clientId: client.id,
          membershipPlanId: plan.id,
          source: "membership_sale",
          connectedAccountId: connectStatus.connectedAccountId,
          chargeModel: "direct",
        },
        client_reference_id: client.id,
      },
      {
        stripeAccount: connectStatus.connectedAccountId,
      },
    );

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

export async function startTerminalMembershipEnrollmentAction(formData: FormData) {
  const returnTo = safeReturnTo(getString(formData, "returnTo"), "/app/memberships/sell");

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;
    const userId = context.userId;
    const clientId = getString(formData, "clientId");
    const membershipPlanId = getString(formData, "membershipPlanId");
    const startsOn = getString(formData, "startsOn");
    const consentAccepted = formData.get("recurringConsent") === "on";

    if (!clientId || !membershipPlanId || !startsOn) {
      redirect(addQueryParam(returnTo, "error", "missing_membership_details"));
    }
    if (!consentAccepted) {
      redirect(addQueryParam(returnTo, "error", "recurring_consent_required"));
    }

    const [{ data: client }, { data: plan }, { data: existingMembership }] =
      await Promise.all([
        supabase
          .from("clients")
          .select("id")
          .eq("id", clientId)
          .eq("studio_id", studioId)
          .single(),
        supabase
          .from("membership_plans")
          .select("id, name, description, active, billing_interval, price, signup_fee")
          .eq("id", membershipPlanId)
          .eq("studio_id", studioId)
          .single(),
        supabase
          .from("client_memberships")
          .select("id")
          .eq("studio_id", studioId)
          .eq("client_id", clientId)
          .in("status", ["active", "pending", "past_due", "unpaid"])
          .limit(1)
          .maybeSingle(),
      ]);

    if (!client) redirect(addQueryParam(returnTo, "error", "client_not_found"));
    if (!plan || !plan.active) redirect(addQueryParam(returnTo, "error", "plan_not_found"));
    if (existingMembership) {
      redirect(addQueryParam(returnTo, "error", "active_membership_exists"));
    }

    const period = calculateMembershipPeriod(plan.billing_interval, startsOn);
    if (!period) redirect(addQueryParam(returnTo, "error", "invalid_start"));

    const initialAmount = Number(plan.price ?? 0) + Number(plan.signup_fee ?? 0);
    if (!Number.isFinite(initialAmount) || initialAmount <= 0) {
      redirect(addQueryParam(returnTo, "error", "terminal_membership_amount_required"));
    }

    const renewalDate = new Date(`${period.currentPeriodEnd}T12:00:00Z`);
    renewalDate.setUTCDate(renewalDate.getUTCDate() + 1);
    const consentText = `I authorize recurring ${plan.billing_interval} charges of ${Number(
      plan.price
    ).toFixed(2)} USD beginning ${renewalDate.toISOString().slice(0, 10)} until cancelled under the studio's membership terms.`;

    const { data: membership, error: membershipError } = await supabase
      .from("client_memberships")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        membership_plan_id: membershipPlanId,
        status: "pending",
        starts_on: startsOn,
        current_period_start: period.currentPeriodStart,
        current_period_end: period.currentPeriodEnd,
        auto_renew: true,
        cancel_at_period_end: false,
        name_snapshot: plan.name,
        description_snapshot: plan.description,
        price_snapshot: plan.price,
        signup_fee_snapshot: plan.signup_fee,
        billing_interval_snapshot: plan.billing_interval,
        created_by: userId,
      })
      .select("id")
      .single();

    if (membershipError || !membership) {
      throw new Error(membershipError?.message ?? "Membership creation failed.");
    }

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        client_membership_id: membership.id,
        amount: Number(initialAmount.toFixed(2)),
        payment_method: "card",
        status: "pending",
        notes: `Initial reader payment for ${plan.name}.`,
        created_by: userId,
        payment_type: "membership",
        fulfillment_type: "activate_membership",
        source: "stripe",
        payment_channel: "terminal",
        currency: "usd",
      })
      .select("id")
      .single();

    if (paymentError || !payment) {
      await supabase.from("client_memberships").delete().eq("id", membership.id);
      throw new Error(paymentError?.message ?? "Payment creation failed.");
    }

    const { error: enrollmentError } = await supabase
      .from("membership_terminal_enrollments")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        client_membership_id: membership.id,
        payment_id: payment.id,
        initial_amount: Number(initialAmount.toFixed(2)),
        renewal_anchor: renewalDate.toISOString(),
        consent_text: consentText,
        consent_version: "terminal_membership_v1",
        consented_at: new Date().toISOString(),
        consented_by: userId,
      });

    if (enrollmentError) {
      await supabase.from("payments").delete().eq("id", payment.id);
      await supabase.from("client_memberships").delete().eq("id", membership.id);
      throw new Error(enrollmentError.message);
    }

    redirect(`/app/payments/terminal/${payment.id}?success=terminal_payment_ready`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(
      addQueryParam(
        returnTo,
        "error",
        error instanceof Error ? error.message : "terminal_membership_failed"
      )
    );
  }
}

export async function cancelMembershipAtPeriodEndAction(formData: FormData) {
  const clientMembershipId = getString(formData, "clientMembershipId");
  const clientId = getString(formData, "clientId");
  const returnTo = safeReturnTo(getString(formData, "returnTo"), getClientReturnUrl(clientId));

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientMembershipId) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    if (!isUuid(clientMembershipId)) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: membership, error: membershipError } = await supabase
      .from("client_memberships")
      .select(
        `
        id,
        client_id,
        studio_id,
        status,
        current_period_end,
        cancel_at_period_end,
        auto_renew
      `,
      )
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId)
      .single();

    if (membershipError || !membership) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: stripeSubscriptionRow, error: stripeSubscriptionError } =
      await supabase
        .from("stripe_subscriptions")
        .select("id, stripe_subscription_id, stripe_account_id, status")
        .eq("client_membership_id", clientMembershipId)
        .eq("studio_id", studioId)
        .maybeSingle();

    if (stripeSubscriptionError) {
      throw new Error(stripeSubscriptionError.message);
    }

    if (!stripeSubscriptionRow?.stripe_subscription_id) {
      redirect(
        addQueryParam(returnTo, "error", "stripe_subscription_not_found"),
      );
    }

    const stripe = getStripe();

    const updatedSubscription = await stripe.subscriptions.update(
      stripeSubscriptionRow.stripe_subscription_id,
      {
        cancel_at_period_end: true,
      },
      stripeSubscriptionRow.stripe_account_id
        ? { stripeAccount: stripeSubscriptionRow.stripe_account_id }
        : undefined,
    );

    const primaryItem = updatedSubscription.items?.data?.[0] ?? null;

    const currentPeriodEndUnix =
      typeof primaryItem?.current_period_end === "number"
        ? primaryItem.current_period_end
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
        status: mapStripeStatusToLocalMembershipStatus(
          updatedSubscription.status,
        ),
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

    redirect(
      addQueryParam(returnTo, "success", "membership_cancel_at_period_end"),
    );
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
  const returnTo = safeReturnTo(getString(formData, "returnTo"), getClientReturnUrl(clientId));

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientMembershipId) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    if (!isUuid(clientMembershipId)) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: membership, error: membershipError } = await supabase
      .from("client_memberships")
      .select(
        `
        id,
        client_id,
        studio_id,
        status,
        cancel_at_period_end,
        auto_renew
      `,
      )
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId)
      .single();

    if (membershipError || !membership) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const { data: stripeSubscriptionRow, error: stripeSubscriptionError } =
      await supabase
        .from("stripe_subscriptions")
        .select("id, stripe_subscription_id, stripe_account_id, status")
        .eq("client_membership_id", clientMembershipId)
        .eq("studio_id", studioId)
        .maybeSingle();

    if (stripeSubscriptionError) {
      throw new Error(stripeSubscriptionError.message);
    }

    if (!stripeSubscriptionRow?.stripe_subscription_id) {
      redirect(
        addQueryParam(returnTo, "error", "stripe_subscription_not_found"),
      );
    }

    const stripe = getStripe();

    const updatedSubscription = await stripe.subscriptions.update(
      stripeSubscriptionRow.stripe_subscription_id,
      {
        cancel_at_period_end: false,
      },
      stripeSubscriptionRow.stripe_account_id
        ? { stripeAccount: stripeSubscriptionRow.stripe_account_id }
        : undefined,
    );

    const primaryItem = updatedSubscription.items?.data?.[0] ?? null;

    const currentPeriodEndUnix =
      typeof primaryItem?.current_period_end === "number"
        ? primaryItem.current_period_end
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
        status: mapStripeStatusToLocalMembershipStatus(
          updatedSubscription.status,
        ),
        cancel_at_period_end: false,
        auto_renew: true,
        ends_on: null,
      })
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId);

    if (updateMembershipError) {
      throw new Error(updateMembershipError.message);
    }

    redirect(
      addQueryParam(returnTo, "success", "membership_auto_renew_restored"),
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "membership_reactivate_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}

export async function collectReplacementPaymentMethodAction(
  formData: FormData,
) {
  const clientId = getString(formData, "clientId");
  const returnTo = safeReturnTo(getString(formData, "returnTo"), getClientReturnUrl(clientId));

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientId) {
      redirect(addQueryParam(returnTo, "error", "missing_client"));
    }

    if (!isUuid(clientId)) {
      redirect(addQueryParam(returnTo, "error", "invalid_client"));
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

    const connectStatus =
      await requireStudioConnectReadyForMemberships(studioId);
    const fullName = `${client.first_name} ${client.last_name}`.trim();

    const stripeCustomerId = await ensureConnectedStripeCustomer({
      supabase,
      studioId,
      clientId: client.id,
      email: client.email ?? null,
      name: fullName || null,
      stripeAccountId: connectStatus.connectedAccountId,
    });

    const stripe = getStripe();
    const appUrl = getAppUrl();

    const successUrl = `${appUrl}/app/clients/${client.id}?success=membership_payment_method_updated`;
    const cancelUrl = `${appUrl}${returnTo}`;

    const session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        currency: "usd",
        customer: stripeCustomerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          studioId,
          clientId: client.id,
          source: "delinquent_membership_payment_method_update",
          connectedAccountId: connectStatus.connectedAccountId,
          chargeModel: "direct",
        },
      },
      {
        stripeAccount: connectStatus.connectedAccountId,
      },
    );

    if (!session.url) {
      throw new Error(
        "Payment method update session was created without a url.",
      );
    }

    redirect(session.url);
  } catch (error) {
    if (isRedirectError(error)) throw error;

    const message =
      error instanceof Error
        ? error.message
        : "membership_payment_method_update_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}

export async function retryDelinquentMembershipBillingAction(
  formData: FormData,
) {
  const clientMembershipId = getString(formData, "clientMembershipId");
  const clientId = getString(formData, "clientId");
  const returnTo = safeReturnTo(getString(formData, "returnTo"), getClientReturnUrl(clientId));

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;

    if (!clientMembershipId) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    if (!isUuid(clientMembershipId)) {
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
      redirect(
        addQueryParam(returnTo, "error", "membership_retry_not_allowed"),
      );
    }

    const { data: stripeSubscriptionRow, error: stripeSubscriptionError } =
      await supabase
        .from("stripe_subscriptions")
        .select(
          "id, stripe_subscription_id, stripe_account_id, stripe_customer_id, default_payment_method_id",
        )
        .eq("client_membership_id", clientMembershipId)
        .eq("studio_id", studioId)
        .maybeSingle();

    if (stripeSubscriptionError) {
      throw new Error(stripeSubscriptionError.message);
    }

    if (!stripeSubscriptionRow?.stripe_subscription_id) {
      redirect(
        addQueryParam(returnTo, "error", "stripe_subscription_not_found"),
      );
    }

    let defaultPaymentMethodId =
      stripeSubscriptionRow.default_payment_method_id ?? null;

    if (!defaultPaymentMethodId && stripeSubscriptionRow.stripe_customer_id) {
      const { data: defaultMethodRow, error: defaultMethodError } =
        await supabase
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

      defaultPaymentMethodId =
        defaultMethodRow?.stripe_payment_method_id ?? null;
    }

    if (!defaultPaymentMethodId) {
      redirect(
        addQueryParam(returnTo, "error", "missing_default_payment_method"),
      );
    }

    const stripe = getStripe();

    await stripe.subscriptions.update(
      stripeSubscriptionRow.stripe_subscription_id,
      {
        default_payment_method: defaultPaymentMethodId,
        cancel_at_period_end: false,
        collection_method: "charge_automatically",
      },
      stripeSubscriptionRow.stripe_account_id
        ? { stripeAccount: stripeSubscriptionRow.stripe_account_id }
        : undefined,
    );

    const invoices = await stripe.invoices.list(
      {
        subscription: stripeSubscriptionRow.stripe_subscription_id,
        status: "open",
        limit: 10,
      },
      stripeSubscriptionRow.stripe_account_id
        ? { stripeAccount: stripeSubscriptionRow.stripe_account_id }
        : undefined,
    );

    const payableInvoice = invoices.data.find(
      (invoice) => invoice.collection_method === "charge_automatically",
    );

    if (!payableInvoice) {
      redirect(
        addQueryParam(returnTo, "success", "membership_retry_submitted"),
      );
    }

    await stripe.invoices.pay(
      payableInvoice.id,
      { payment_method: defaultPaymentMethodId },
      stripeSubscriptionRow.stripe_account_id
        ? { stripeAccount: stripeSubscriptionRow.stripe_account_id }
        : undefined,
    );

    redirect(addQueryParam(returnTo, "success", "membership_retry_submitted"));
  } catch (error) {
    if (isRedirectError(error)) throw error;

    const message =
      error instanceof Error ? error.message : "membership_retry_failed";

    redirect(addQueryParam(returnTo, "error", message));
  }
}


export async function archiveMembershipPlanAction(formData: FormData) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const membershipPlanId = getString(formData, "membershipPlanId");
  const returnTo = safeReturnTo(getString(formData, "returnTo"), "/app/memberships");

  if (!membershipPlanId || !isUuid(membershipPlanId)) {
    throw new Error("Missing or invalid membership plan ID.");
  }

  const { error } = await supabase
    .from("membership_plans")
    .update({
      active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", membershipPlanId)
    .eq("studio_id", studioId);

  if (error) {
    throw new Error(`Archive membership plan failed: ${error.message}`);
  }

  redirect(returnTo);
}

export async function reactivateMembershipPlanAction(formData: FormData) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const membershipPlanId = getString(formData, "membershipPlanId");
  const returnTo = safeReturnTo(getString(formData, "returnTo"), "/app/memberships");

  if (!membershipPlanId || !isUuid(membershipPlanId)) {
    throw new Error("Missing or invalid membership plan ID.");
  }

  const { error } = await supabase
    .from("membership_plans")
    .update({
      active: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", membershipPlanId)
    .eq("studio_id", studioId);

  if (error) {
    throw new Error(`Restore membership plan failed: ${error.message}`);
  }

  redirect(returnTo);
}

export async function deleteMembershipPlanAction(formData: FormData) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const membershipPlanId = getString(formData, "membershipPlanId");

  if (!membershipPlanId || !isUuid(membershipPlanId)) {
    throw new Error("Missing or invalid membership plan ID.");
  }

  const { data: usedMemberships, error: usedMembershipsError } = await supabase
    .from("client_memberships")
    .select("id")
    .eq("studio_id", studioId)
    .eq("membership_plan_id", membershipPlanId)
    .limit(1);

  if (usedMembershipsError) {
    throw new Error(`Membership usage check failed: ${usedMembershipsError.message}`);
  }

  if ((usedMemberships ?? []).length > 0) {
    const { error: archiveError } = await supabase
      .from("membership_plans")
      .update({
        active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", membershipPlanId)
      .eq("studio_id", studioId);

    if (archiveError) {
      throw new Error(`Membership plan archive failed: ${archiveError.message}`);
    }

    redirect("/app/memberships");
  }

  const { error: benefitsError } = await supabase
    .from("membership_plan_benefits")
    .delete()
    .eq("membership_plan_id", membershipPlanId);

  if (benefitsError) {
    throw new Error(`Membership benefits delete failed: ${benefitsError.message}`);
  }

  const { error: deleteError } = await supabase
    .from("membership_plans")
    .delete()
    .eq("id", membershipPlanId)
    .eq("studio_id", studioId);

  if (deleteError) {
    throw new Error(`Membership plan delete failed: ${deleteError.message}`);
  }

  redirect("/app/memberships");
}
const EXTERNAL_MEMBERSHIP_PAYMENT_METHODS = new Set([
  "cash",
  "check",
  "ach",
  "venmo",
  "zelle",
  "card",
  "other",
]);

export async function recordExternalMembershipPaymentAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const clientMembershipId = getString(formData, "clientMembershipId");
  const amount = getNumberOrNull(getString(formData, "amount"));
  const paymentMethod = getString(formData, "paymentMethod", 40).toLowerCase();
  const externalReference = getString(formData, "externalReference", 180) || null;
  const notes = getString(formData, "notes", 500) || null;
  const returnTo = safeReturnTo(
    getString(formData, "returnTo"),
    clientId ? `/app/clients/${clientId}` : "/app/clients",
  );

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;
    const role = context.studioRole ?? "";

    if (!["studio_owner", "studio_admin", "front_desk"].includes(role)) {
      redirect(addQueryParam(returnTo, "error", "membership_payment_unauthorized"));
    }
    if (!isUuid(clientId) || !isUuid(clientMembershipId)) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }
    if (amount == null || amount <= 0) {
      redirect(addQueryParam(returnTo, "error", "membership_payment_invalid_amount"));
    }
    if (!EXTERNAL_MEMBERSHIP_PAYMENT_METHODS.has(paymentMethod)) {
      redirect(addQueryParam(returnTo, "error", "membership_payment_invalid_method"));
    }

    if (externalReference) {
      const { data: duplicate, error: duplicateError } = await supabase
        .from("payments")
        .select("id")
        .eq("studio_id", studioId)
        .eq("external_reference", externalReference)
        .eq("payment_channel", "manual")
        .limit(1)
        .maybeSingle();
      if (duplicateError) throw new Error(duplicateError.message);
      if (duplicate) redirect(addQueryParam(returnTo, "error", "membership_payment_duplicate_reference"));
    }

    await recordManualMembershipPayment({
      supabase,
      studioId,
      userId: context.userId,
      clientId,
      clientMembershipId,
      amount,
      paymentMethod,
      paidAtIso: new Date().toISOString(),
      externalReference,
      notes,
    });

    redirect(addQueryParam(returnTo, "success", "membership_external_payment_recorded"));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(
      addQueryParam(
        returnTo,
        "error",
        error instanceof Error ? error.message : "membership_payment_failed",
      ),
    );
  }
}

export async function waiveMembershipPeriodAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const clientMembershipId = getString(formData, "clientMembershipId");
  const reason = getString(formData, "reason", 500);
  const returnTo = safeReturnTo(
    getString(formData, "returnTo"),
    clientId ? `/app/clients/${clientId}` : "/app/clients",
  );

  try {
    const supabase = await createClient();
    const context = await getCurrentStudioContext();
    const studioId = context.studioId;
    const role = context.studioRole ?? "";

    if (!["studio_owner", "studio_admin"].includes(role)) {
      redirect(addQueryParam(returnTo, "error", "membership_waiver_unauthorized"));
    }
    if (!reason || !isUuid(clientId) || !isUuid(clientMembershipId)) {
      redirect(addQueryParam(returnTo, "error", "membership_waiver_missing_fields"));
    }

    const { data: membership, error } = await supabase
      .from("client_memberships")
      .select("id, client_id, current_period_start, current_period_end, price_snapshot")
      .eq("id", clientMembershipId)
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .single();
    if (error || !membership) {
      redirect(addQueryParam(returnTo, "error", "membership_not_found"));
    }

    const nowIso = new Date().toISOString();
    const { error: periodError } = await supabase
      .from("client_membership_periods")
      .upsert(
        {
          studio_id: studioId,
          client_id: clientId,
          client_membership_id: membership.id,
          period_start: membership.current_period_start,
          period_end: membership.current_period_end,
          amount_due: Number(membership.price_snapshot ?? 0),
          amount_paid: 0,
          currency: "usd",
          payment_status: "waived",
          waived_at: nowIso,
          waived_by: context.userId,
          waiver_reason: reason,
          created_by: context.userId,
          updated_at: nowIso,
        },
        { onConflict: "client_membership_id,period_start,period_end" },
      );
    if (periodError) throw new Error(periodError.message);

    await supabase
      .from("client_memberships")
      .update({ status: "active", updated_at: nowIso })
      .eq("id", membership.id)
      .eq("studio_id", studioId);

    redirect(addQueryParam(returnTo, "success", "membership_period_waived"));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(addQueryParam(returnTo, "error", "membership_waiver_failed"));
  }
}
