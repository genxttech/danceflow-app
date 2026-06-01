import Stripe from "stripe";
import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";

export type AiCreditPackKey = "ai_200" | "ai_750" | "ai_2000";

export type AiCreditPack = {
  key: AiCreditPackKey;
  label: string;
  description: string;
  quantityIncluded: number;
  displayPrice: string;
  envPriceKey: string;
  stripePriceId: string | null;
};

function getEnvValue(name: string) {
  const value = process.env[name]?.trim();
  return value || null;
}

export function getAiCreditPacks(): AiCreditPack[] {
  return [
    {
      key: "ai_200",
      label: "AI Starter Pack",
      description: "Add a small monthly boost for follow-ups, campaigns, lesson notes, and insights.",
      quantityIncluded: 200,
      displayPrice: "$10/month",
      envPriceKey: "STRIPE_PRICE_AI_CREDITS_200",
      stripePriceId: getEnvValue("STRIPE_PRICE_AI_CREDITS_200"),
    },
    {
      key: "ai_750",
      label: "AI Growth Pack",
      description: "Add more monthly AI help for busy studios using campaigns and follow-up tools regularly.",
      quantityIncluded: 750,
      displayPrice: "$25/month",
      envPriceKey: "STRIPE_PRICE_AI_CREDITS_750",
      stripePriceId: getEnvValue("STRIPE_PRICE_AI_CREDITS_750"),
    },
    {
      key: "ai_2000",
      label: "AI High Usage Pack",
      description: "Add a larger monthly allowance for studios that use AI across daily operations.",
      quantityIncluded: 2000,
      displayPrice: "$49/month",
      envPriceKey: "STRIPE_PRICE_AI_CREDITS_2000",
      stripePriceId: getEnvValue("STRIPE_PRICE_AI_CREDITS_2000"),
    },
  ];
}

export function getAiCreditPack(packKey: string | null | undefined) {
  return getAiCreditPacks().find((pack) => pack.key === packKey) ?? null;
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

function getPackByStripePriceId(stripePriceId: string | null | undefined) {
  if (!stripePriceId) return null;
  return getAiCreditPacks().find((pack) => pack.stripePriceId === stripePriceId) ?? null;
}

export async function syncAiCreditPackEntitlementsForStudio(args: {
  stripe: Stripe;
  studioId: string;
  stripeSubscriptionId: string | null | undefined;
}) {
  if (!args.stripeSubscriptionId) return;

  const configuredPacks = getAiCreditPacks().filter((pack) => pack.stripePriceId);
  if (configuredPacks.length === 0) return;

  const supabaseAdmin = getSupabaseAdmin();
  const subscription = await args.stripe.subscriptions.retrieve(args.stripeSubscriptionId, {
    expand: ["items.data.price"],
  });

  const activePackItemIds = new Set<string>();

  for (const item of subscription.items.data) {
    const pack = getPackByStripePriceId(item.price?.id);
    if (!pack) continue;

    activePackItemIds.add(item.id);

    const { error } = await supabaseAdmin.from("usage_addon_entitlements").upsert(
      {
        studio_id: args.studioId,
        organizer_id: null,
        workspace_type: "studio",
        feature_key: "ai_action",
        quantity_included: pack.quantityIncluded * Math.max(1, item.quantity ?? 1),
        source: "stripe_subscription_item",
        stripe_subscription_item_id: item.id,
        status: subscription.status === "active" || subscription.status === "trialing" ? "active" : "canceled",
        notes: pack.label,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_subscription_item_id" },
    );

    if (error) {
      console.error("Failed to sync AI credit pack entitlement", error.message);
    }
  }

  const configuredPriceIds = configuredPacks.map((pack) => pack.stripePriceId).filter(Boolean);

  if (configuredPriceIds.length > 0) {
    const { data: existingEntitlements } = await supabaseAdmin
      .from("usage_addon_entitlements")
      .select("id, stripe_subscription_item_id")
      .eq("studio_id", args.studioId)
      .eq("feature_key", "ai_action")
      .eq("source", "stripe_subscription_item")
      .not("stripe_subscription_item_id", "is", null);

    const staleIds = (existingEntitlements ?? [])
      .filter((row) => row.stripe_subscription_item_id && !activePackItemIds.has(row.stripe_subscription_item_id))
      .map((row) => row.id);

    if (staleIds.length > 0) {
      await supabaseAdmin
        .from("usage_addon_entitlements")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .in("id", staleIds);
    }
  }
}
