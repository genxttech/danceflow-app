/* eslint-disable @typescript-eslint/no-explicit-any */
import type { StripeSubscriptionRead } from "@/lib/billing/priceTransitionRunner";
import type { TransitionItemShape, TransitionTargetPrice } from "@/lib/billing/priceTransition";

/**
 * D7 WP-3: the ONE mapping from Stripe objects to the planner's inputs, shared by the production script and the test-mode
 * proof harness so the proof exercises the same reader that production uses. Pure: takes already-retrieved Stripe objects.
 *
 * Anything on the subscription that the transition does not model is reported in `unsupportedSettings`, which blocks the plan
 * (fail closed) until it is understood and proven: trials, pauses, pending updates, scheduled cancellation, invoice-based
 * collection, discounts, automatic tax (price tax behaviour is not part of the disclosed amount) and a missing period.
 */
export function mapStripeSubscription(sub: any): StripeSubscriptionRead {
  const item = sub.items?.data?.[0];
  const periodStart = sub.current_period_start ?? item?.current_period_start;
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  const unsupportedSettings: string[] = [];
  if (sub.trial_end) unsupportedSettings.push("trial");
  if (sub.pause_collection) unsupportedSettings.push("pause_collection");
  if (sub.pending_update) unsupportedSettings.push("pending_update");
  if (sub.cancel_at) unsupportedSettings.push("cancel_at");
  if (sub.collection_method !== "charge_automatically") unsupportedSettings.push("collection_method");
  if ((Array.isArray(sub.discounts) && sub.discounts.length > 0) || sub.discount) unsupportedSettings.push("discounts");
  if (sub.automatic_tax?.enabled) unsupportedSettings.push("automatic_tax");
  if (typeof periodStart !== "number" || typeof periodEnd !== "number") unsupportedSettings.push("period_unreadable");
  // Multi-item: every item must report the same period (newer API versions carry it per item); a disagreement is not modelled.
  const itemPeriods = (sub.items?.data ?? []).map((i: any) => `${i.current_period_start ?? ""}|${i.current_period_end ?? ""}`);
  if (new Set(itemPeriods).size > 1) unsupportedSettings.push("item_periods_differ");
  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    currentPeriodStart: new Date((periodStart ?? Number.NaN) * 1000),
    currentPeriodEnd: new Date((periodEnd ?? Number.NaN) * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    scheduleId: typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null,
    items: (sub.items?.data ?? []).map((i: any) => ({
      priceId: i.price.id,
      quantity: i.quantity ?? 1,
      metadata: { ...(i.metadata ?? {}) },
      shape: mapItemShape(i.price),
      unsupported: itemUnsupported(i),
    })),
    metadata: { ...(sub.metadata ?? {}) },
    unsupportedSettings,
  };
}

/** Billing shape of the Price on a subscription item (null/odd values are kept as such so the planner can fail closed). */
function mapItemShape(price: any): TransitionItemShape {
  return {
    currency: typeof price?.currency === "string" ? price.currency : "",
    interval: price?.recurring?.interval ?? null,
    intervalCount: price?.recurring?.interval_count ?? null,
    type: price?.type ?? null,
    billingScheme: price?.billing_scheme ?? null,
    usageType: price?.recurring?.usage_type ?? null,
    hasTransformQuantity: price?.transform_quantity != null,
  };
}

/** Item-level settings that a phase copy would have to carry verbatim; on a multi-item subscription any of them blocks the plan. */
function itemUnsupported(item: any): string[] {
  const out: string[] = [];
  if (item.billing_thresholds) out.push("billing_thresholds");
  if (Array.isArray(item.discounts) && item.discounts.length > 0) out.push("discounts");
  if (Array.isArray(item.tax_rates) && item.tax_rates.length > 0) out.push("tax_rates");
  return out;
}

export function mapStripePrice(price: any): TransitionTargetPrice {
  return {
    id: price.id,
    active: price.active,
    unitAmountCents: price.unit_amount,
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    type: price.type ?? null,
    billingScheme: price.billing_scheme,
    usageType: price.recurring?.usage_type ?? null,
    hasTransformQuantity: price.transform_quantity != null,
  };
}
