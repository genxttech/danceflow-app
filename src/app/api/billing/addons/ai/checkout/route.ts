import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import {
  getAiCreditPack,
  saveAiCreditPackEntitlementForStripeItem,
  syncAiCreditPackEntitlementsForStudio,
} from "@/lib/usage/ai-credit-packs";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

type StudioBillingRow = {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
};

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

async function readPackKey(request: NextRequest) {
  if (request.method === "GET") {
    return request.nextUrl.searchParams.get("pack")?.trim() ?? "";
  }

  const formData = await request.formData();
  const value = formData.get("pack");
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("billing:ai-checkout", getIpFromRequest(request)),
    { limit: 6, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  try {
    const packKey = await readPackKey(request);
    const pack = getAiCreditPack(packKey);

    if (!pack) {
      return redirectToBilling(request, { error: "ai_pack_not_found" });
    }

    if (!pack.stripePriceId) {
      return redirectToBilling(request, { error: "ai_pack_missing_price" });
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
      return redirectToBilling(request, { error: "ai_pack_subscription_required" });
    }

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(studio.stripe_subscription_id, {
      expand: ["items.data.price"],
    });

    const existingItem = subscription.items.data.find((item) => item.price?.id === pack.stripePriceId);

    if (existingItem) {
      await syncAiCreditPackEntitlementsForStudio({
        stripe,
        studioId: studio.id,
        stripeSubscriptionId: studio.stripe_subscription_id,
      });

      return redirectToBilling(request, { success: "ai_pack_current" });
    }

    // Add the AI pack as a separate subscription item. Do not update the full
    // subscription item list, because that can disturb the base studio plan item.
    const addedItem = await stripe.subscriptionItems.create({
      subscription: studio.stripe_subscription_id,
      price: pack.stripePriceId,
      quantity: 1,
      proration_behavior: "none",
      metadata: {
        source: "ai_credit_pack",
        aiCreditPack: pack.key,
        studioId: studio.id,
      },
    });

    await saveAiCreditPackEntitlementForStripeItem({
      studioId: studio.id,
      stripeSubscriptionItemId: addedItem.id,
      pack,
      quantity: addedItem.quantity,
    });

    return redirectToBilling(request, { success: "ai_pack_added" });
  } catch (error) {
    console.error("AI credit pack checkout failed", error);
    return redirectToBilling(request, { error: "ai_pack_checkout_failed" });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
