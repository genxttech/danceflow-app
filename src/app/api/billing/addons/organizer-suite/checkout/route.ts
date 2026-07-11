import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

type StudioBillingRow = {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
};

type OrganizerSuiteEntitlementRow = {
  id: string;
  studio_id: string | null;
  stripe_subscription_item_id: string | null;
  status: string | null;
};

const ORGANIZER_SUITE_FEATURE_KEY = "organizer_suite";

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  );
}

function canManageBilling(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "studio_owner" || role === "studio_admin";
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase admin environment variables.");
  }

  return createSupabaseAdmin(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function redirectToBilling(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/app/settings/billing", buildAppUrl(request));

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return NextResponse.redirect(url, { status: 303 });
}

function getOrganizerSuitePriceId() {
  const founderActive =
    process.env.NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE !== "false" &&
    process.env.FOUNDER_PRICING_ACTIVE !== "false";

  const founderPrice = process.env.STRIPE_PRICE_ORGANIZER_SUITE_ADDON_FOUNDER?.trim();
  const standardPrice = process.env.STRIPE_PRICE_ORGANIZER_SUITE_ADDON_STANDARD?.trim();

  if (founderActive && founderPrice) return founderPrice;
  return standardPrice || null;
}

async function upsertOrganizerSuiteEntitlement(params: {
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>;
  studioId: string;
  stripeSubscriptionItemId: string;
}) {
  const { error } = await params.supabaseAdmin
    .from("usage_addon_entitlements")
    .upsert(
      {
        studio_id: params.studioId,
        workspace_type: "studio",
        feature_key: ORGANIZER_SUITE_FEATURE_KEY,
        source: "stripe_subscription_item",
        stripe_subscription_item_id: params.stripeSubscriptionItemId,
        quantity_included: 1,
        status: "active",
      },
      { onConflict: "stripe_subscription_item_id" },
    );

  if (error) {
    throw new Error(error.message);
  }
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("billing:organizer-checkout", getIpFromRequest(request)),
    { limit: 6, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  try {
    const priceId = getOrganizerSuitePriceId();

    if (!priceId) {
      return redirectToBilling(request, { error: "organizer_suite_missing_price" });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const context = await getCurrentStudioContext();

    if (!context?.studioId) {
      return redirectToBilling(request, { error: "no_studio_context" });
    }

    if (!canManageBilling(context.studioRole, context.isPlatformAdmin)) {
      return redirectToBilling(request, { error: "billing_access_denied" });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data: studio, error: studioError } = await supabaseAdmin
      .from("studios")
      .select("id, stripe_customer_id, stripe_subscription_id, subscription_status")
      .eq("id", context.studioId)
      .single<StudioBillingRow>();

    if (studioError || !studio) {
      return redirectToBilling(request, { error: "studio_not_found" });
    }

    if (!studio.stripe_subscription_id || !["active", "trialing"].includes(studio.subscription_status ?? "")) {
      return redirectToBilling(request, { error: "organizer_suite_subscription_required" });
    }

    const { data: existingEntitlement, error: entitlementError } = await supabaseAdmin
      .from("usage_addon_entitlements")
      .select("id, studio_id, stripe_subscription_item_id, status")
      .eq("studio_id", studio.id)
      .eq("feature_key", ORGANIZER_SUITE_FEATURE_KEY)
      .eq("source", "stripe_subscription_item")
      .eq("status", "active")
      .limit(1)
      .maybeSingle<OrganizerSuiteEntitlementRow>();

    if (entitlementError) {
      throw new Error(entitlementError.message);
    }

    if (existingEntitlement?.stripe_subscription_item_id) {
      return redirectToBilling(request, { success: "organizer_suite_current" });
    }

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(studio.stripe_subscription_id, {
      expand: ["items.data.price"],
    });

    const existingItem = subscription.items.data.find((item) => item.price?.id === priceId);

    if (existingItem) {
      await upsertOrganizerSuiteEntitlement({
        supabaseAdmin,
        studioId: studio.id,
        stripeSubscriptionItemId: existingItem.id,
      });

      return redirectToBilling(request, { success: "organizer_suite_current" });
    }

    const addedItem = await stripe.subscriptionItems.create({
      subscription: studio.stripe_subscription_id,
      price: priceId,
      quantity: 1,
      proration_behavior: "none",
      metadata: {
        source: "organizer_suite_addon",
        featureKey: ORGANIZER_SUITE_FEATURE_KEY,
        studioId: studio.id,
      },
    });

    await upsertOrganizerSuiteEntitlement({
      supabaseAdmin,
      studioId: studio.id,
      stripeSubscriptionItemId: addedItem.id,
    });

    return redirectToBilling(request, { success: "organizer_suite_added" });
  } catch (error) {
    console.error("Organizer Suite add-on checkout failed", error);
    return redirectToBilling(request, { error: "organizer_suite_checkout_failed" });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
