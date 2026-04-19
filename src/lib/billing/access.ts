import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  planHasFeature,
  requiredPlanForFeature,
  type BillingFeature,
} from "./plans";

type StudioSubscriptionAccessRow = {
  status: string;
  subscription_plans:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null;
};

function getPlan(
  value:
    | { code: string; name: string }
    | { code: string; name: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function buildBillingUpgradeUrl(feature: BillingFeature) {
  const search = new URLSearchParams({
    reason: "feature_required",
    feature,
    requiredPlan: requiredPlanForFeature(feature),
  });

  return `/app/settings/billing?${search.toString()}`;
}

export async function getCurrentStudioPlanForUser() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const context = await getCurrentStudioContext();
  const studioId = context?.studioId ?? null;

  if (!studioId) {
    return null;
  }

  const { data: subscription, error: subscriptionError } = await supabase
    .from("studio_subscriptions")
    .select(
      `
      status,
      subscription_plans (
        code,
        name
      )
    `
    )
    .eq("studio_id", studioId)
    .maybeSingle();

  if (subscriptionError || !subscription) {
    return {
      studioId,
      status: "inactive",
      planCode: null,
      planName: null,
    };
  }

  const typedSubscription = subscription as StudioSubscriptionAccessRow;
  const plan = getPlan(typedSubscription.subscription_plans);

  return {
    studioId,
    status: typedSubscription.status,
    planCode: plan?.code ?? null,
    planName: plan?.name ?? null,
  };
}

export async function studioHasFeature(feature: BillingFeature) {
  const subscription = await getCurrentStudioPlanForUser();

  if (!subscription) return false;
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return false;
  }

  return planHasFeature(subscription.planCode, feature);
}

export async function requireStudioFeature(feature: BillingFeature) {
  const allowed = await studioHasFeature(feature);

  if (!allowed) {
    redirect(buildBillingUpgradeUrl(feature));
  }
}