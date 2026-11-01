import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcilePriceTransition } from "@/lib/billing/priceTransitionReconcile";
import { createReconcileDeps, findOpenTransitionId } from "@/lib/billing/priceTransitionReconcileDeps";

/**
 * D7 WP-3: webhook trigger for post-boundary reconciliation. DARK: does nothing unless PRICE_TRANSITION_RECONCILE_ENABLED is
 * exactly "true". It never trusts the event payload (only the subscription id is used; state is re-read from Stripe), never
 * writes to Stripe, and NEVER throws: a reconciliation problem must not fail or retry an unrelated billing webhook. The
 * sweep (scripts/billing/price-transition-reconcile.ts --all-due) covers any event that is missed.
 */
export function isPriceTransitionReconcileEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PRICE_TRANSITION_RECONCILE_ENABLED === "true";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export async function maybeReconcilePriceTransition(input: { db: Db; stripe: Stripe; stripeSubscriptionId: string | null | undefined; env?: Record<string, string | undefined> }): Promise<void> {
  if (!isPriceTransitionReconcileEnabled(input.env) || !input.stripeSubscriptionId) return;
  try {
    const transitionId = await findOpenTransitionId(input.db, input.stripeSubscriptionId);
    if (!transitionId) return;
    const report = await reconcilePriceTransition(transitionId, createReconcileDeps(input.db, input.stripe), { apply: true });
    if (report.state === "needs_review") {
      console.error("price transition needs owner review", { transitionId, reasons: report.reasons });
    }
  } catch (error) {
    console.error("price transition reconciliation failed (will retry on the next trigger)", error instanceof Error ? error.message : "unknown");
  }
}

/** The subscription id carried by a subscription_schedule.* event object. */
export function subscriptionIdFromSchedule(schedule: Stripe.SubscriptionSchedule): string | null {
  return typeof schedule.subscription === "string" ? schedule.subscription : schedule.subscription?.id ?? null;
}
