import type { SupabaseClient } from "@supabase/supabase-js";

/*
  Canonical DanceFlow organizer platform fee for event checkouts (direct charges on the
  studio's connected account). Extracted in Phase 10C from event-order-payment.ts so the
  hardened competition checkout does not add another copy of the formula.

  Remaining copies (carry-forward to a cleanup slice): api/events/cart/checkout,
  api/events/private-lessons/checkout and api/student/events/[eventId]/checkout.
*/

export const ORGANIZER_STANDARD_FEE_PERCENT = 0.035;
export const ORGANIZER_STUDIO_ADDON_FEE_PERCENT = 0.0325;
export const ORGANIZER_PRO_ADDON_FEE_PERCENT = 0.03;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

function pickOne<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

/** Application fee in integer cents for a dollar amount; never negative. */
export function calculateApplicationFeeAmount(amount: number, feePercent: number) {
  return Math.round(Math.max(0, Math.round(amount * 100)) * Math.max(0, feePercent));
}

/**
 * Organizer platform fee percent for a studio: Organizer plan = standard rate; Starter/Growth/Pro
 * with an active Organizer Suite add-on = discounted rate; anything else = 0 (no DanceFlow fee).
 */
export async function getOrganizerPlatformFeePercent(admin: Db, studioId: string) {
  const { data: subscription } = await admin
    .from("studio_subscriptions")
    .select("status, subscription_plans ( code )")
    .eq("studio_id", studioId)
    .maybeSingle();

  if (!subscription || !["active", "trialing"].includes(subscription.status ?? "")) return 0;
  const plan = pickOne(subscription.subscription_plans as { code: string | null } | { code: string | null }[] | null);
  const code = (plan?.code ?? "").trim().toLowerCase();
  if (code === "organizer") return ORGANIZER_STANDARD_FEE_PERCENT;
  if (!["starter", "growth", "pro"].includes(code)) return 0;

  const { data: addOns } = await admin
    .from("usage_addon_entitlements")
    .select("id")
    .eq("studio_id", studioId)
    .eq("feature_key", "organizer_suite")
    .in("source", ["stripe_subscription_item", "manual_grant"])
    .eq("status", "active")
    .limit(1);
  if (!addOns?.length) return 0;
  return code === "pro" ? ORGANIZER_PRO_ADDON_FEE_PERCENT : ORGANIZER_STUDIO_ADDON_FEE_PERCENT;
}
