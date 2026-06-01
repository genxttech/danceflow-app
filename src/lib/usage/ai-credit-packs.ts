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

async function saveAiCreditPackEntitlement(args: {
  studioId: string;
  stripeSubscriptionItemId: string;
  quantityIncluded: number;
  status: "active" | "canceled";
  label: string;
}) {
  const supabaseAdmin = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await supabaseAdmin
    .from("usage_addon_entitlements")
    .select("id")
    .eq("stripe_subscription_item_id", args.stripeSubscriptionItemId)
    .maybeSingle<{ id: string }>();

  if (readError) {
    throw new Error(`Failed to read AI credit entitlement: ${readError.message}`);
  }

  if (existing?.id) {
    const { error: updateError } = await supabaseAdmin
      .from("usage_addon_entitlements")
      .update({
        studio_id: args.studioId,
        organizer_id: null,
        workspace_type: "studio",
        feature_key: "ai_action",
        quantity_included: args.quantityIncluded,
        source: "stripe_subscription_item",
        status: args.status,
        notes: args.label,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Failed to update AI credit entitlement: ${updateError.message}`);
    }

    return;
  }

  const { error: insertError } = await supabaseAdmin.from("usage_addon_entitlements").insert({
    studio_id: args.studioId,
    organizer_id: null,
    workspace_type: "studio",
    feature_key: "ai_action",
    quantity_included: args.quantityIncluded,
    source: "stripe_subscription_item",
    stripe_subscription_item_id: args.stripeSubscriptionItemId,
    status: args.status,
    notes: args.label,
    updated_at: now,
  });

  if (insertError) {
    throw new Error(`Failed to insert AI credit entitlement: ${insertError.message}`);
  }
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

    await saveAiCreditPackEntitlement({
      studioId: args.studioId,
      stripeSubscriptionItemId: item.id,
      quantityIncluded: pack.quantityIncluded * Math.max(1, item.quantity ?? 1),
      status: subscription.status === "active" || subscription.status === "trialing" ? "active" : "canceled",
      label: pack.label,
    });
  }

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


export type ActiveAiCreditPackEntitlement = {
  id: string;
  quantityIncluded: number;
  label: string | null;
  stripeSubscriptionItemId: string;
  status: string;
};

export async function getActiveAiCreditPackEntitlementsForStudio(studioId: string): Promise<ActiveAiCreditPackEntitlement[]> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data, error } = await supabaseAdmin
    .from("usage_addon_entitlements")
    .select("id, quantity_included, notes, stripe_subscription_item_id, status")
    .eq("studio_id", studioId)
    .eq("feature_key", "ai_action")
    .eq("source", "stripe_subscription_item")
    .eq("status", "active")
    .not("stripe_subscription_item_id", "is", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to read active AI credit pack entitlements: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    quantityIncluded: Math.max(0, row.quantity_included ?? 0),
    label: row.notes ?? null,
    stripeSubscriptionItemId: row.stripe_subscription_item_id ?? "",
    status: row.status ?? "active",
  })).filter((row) => row.stripeSubscriptionItemId);
}

export async function markAiCreditPackEntitlementCanceled(args: {
  stripeSubscriptionItemId: string;
}) {
  const supabaseAdmin = getSupabaseAdmin();

  const { error } = await supabaseAdmin
    .from("usage_addon_entitlements")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("stripe_subscription_item_id", args.stripeSubscriptionItemId)
    .eq("feature_key", "ai_action")
    .eq("source", "stripe_subscription_item");

  if (error) {
    throw new Error(`Failed to cancel AI credit entitlement: ${error.message}`);
  }
}

export async function saveAiCreditPackEntitlementForStripeItem(args: {
  studioId: string;
  stripeSubscriptionItemId: string;
  pack: AiCreditPack;
  quantity?: number | null;
}) {
  await saveAiCreditPackEntitlement({
    studioId: args.studioId,
    stripeSubscriptionItemId: args.stripeSubscriptionItemId,
    quantityIncluded: args.pack.quantityIncluded * Math.max(1, args.quantity ?? 1),
    status: "active",
    label: args.pack.label,
  });
}
