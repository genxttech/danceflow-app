import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import {
  markAiCreditPackEntitlementCanceled,
  syncAiCreditPackEntitlementsForStudio,
} from "@/lib/usage/ai-credit-packs";
import { checkRateLimit, getIpFromRequest, rateLimitKey, rateLimitedJson } from "@/lib/security/rate-limit";

type StudioBillingRow = {
  id: string;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
};

type EntitlementRow = {
  id: string;
  studio_id: string | null;
  stripe_subscription_item_id: string | null;
  status: string | null;
};

function buildAppUrl(request: NextRequest) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    request.nextUrl.origin
  );
}

function redirectToBilling(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/app/settings/billing", buildAppUrl(request));

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return NextResponse.redirect(url, { status: 303 });
}

function canManageBilling(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "studio_owner" || role === "studio_admin" || role === "organizer_owner";
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

async function readEntitlementId(request: NextRequest) {
  if (request.method === "GET") {
    return request.nextUrl.searchParams.get("entitlement")?.trim() ?? "";
  }

  const formData = await request.formData();
  const value = formData.get("entitlement");
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const rateLimit = checkRateLimit(
    rateLimitKey("billing:ai-remove", getIpFromRequest(request)),
    { limit: 8, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return rateLimitedJson(rateLimit);
  }

  try {
    const entitlementId = await readEntitlementId(request);

    if (!entitlementId) {
      return redirectToBilling(request, { error: "ai_pack_not_found" });
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
      .select("id, stripe_subscription_id, subscription_status")
      .eq("id", context.studioId)
      .single<StudioBillingRow>();

    if (studioError || !studio) {
      return redirectToBilling(request, { error: "studio_not_found" });
    }

    if (!studio.stripe_subscription_id || !["active", "trialing"].includes(studio.subscription_status ?? "")) {
      return redirectToBilling(request, { error: "ai_pack_subscription_required" });
    }

    const { data: entitlement, error: entitlementError } = await supabaseAdmin
      .from("usage_addon_entitlements")
      .select("id, studio_id, stripe_subscription_item_id, status")
      .eq("id", entitlementId)
      .eq("studio_id", studio.id)
      .eq("feature_key", "ai_action")
      .eq("source", "stripe_subscription_item")
      .maybeSingle<EntitlementRow>();

    if (entitlementError || !entitlement?.stripe_subscription_item_id) {
      return redirectToBilling(request, { error: "ai_pack_not_found" });
    }

    if (entitlement.status !== "active") {
      return redirectToBilling(request, { success: "ai_pack_removed" });
    }

    const stripe = getStripe();
    const subscriptionItem = await stripe.subscriptionItems.retrieve(entitlement.stripe_subscription_item_id);

    if (subscriptionItem.subscription !== studio.stripe_subscription_id) {
      return redirectToBilling(request, { error: "ai_pack_not_found" });
    }

    await stripe.subscriptionItems.del(entitlement.stripe_subscription_item_id, {
      proration_behavior: "none",
    });

    await markAiCreditPackEntitlementCanceled({
      stripeSubscriptionItemId: entitlement.stripe_subscription_item_id,
    });

    await syncAiCreditPackEntitlementsForStudio({
      stripe,
      studioId: studio.id,
      stripeSubscriptionId: studio.stripe_subscription_id,
    });

    return redirectToBilling(request, { success: "ai_pack_removed" });
  } catch (error) {
    console.error("AI credit pack removal failed", error);
    return redirectToBilling(request, { error: "ai_pack_remove_failed" });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
