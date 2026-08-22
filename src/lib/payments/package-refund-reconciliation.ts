import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Package Refund P0, Slice 2c-1: dedicated service module for invoking the
 * package-refund reconciliation RPC from the Stripe webhook. Kept separate
 * from the webhook route itself per the approved design -- the route stays a
 * thin dispatcher, and this module owns the "resolve every matching payment,
 * call the RPC for each" logic.
 */

export type StripeRefundReconciliationInput = {
  stripePaymentIntentId: string;
  stripeRefundId: string;
  stripeChargeId: string | null;
  /**
   * The single Stripe refund event's own amount, in cents (Stripe's native
   * unit -- e.g. `refund.amount`). Deliberately NOT a cumulative charge
   * total: `package_refund_reconciliations` is an append-only ledger of
   * individual Stripe refund objects, summed at read time by
   * `get_client_package_refund_financial_state`. Feeding a cumulative
   * amount here would double-count once summed against other rows for the
   * same package.
   */
  refundAmountCents: number;
  refundStatus: string;
  occurredAt?: string | null;
};

export type PackageRefundReconciliationResult = {
  paymentId: string;
  studioId: string;
  reconciliationId: string | null;
  outcome: string;
  applied: boolean;
};

/**
 * Everything the webhook route has on hand after resolving a Stripe Refund
 * event, before deciding whether/how to call package reconciliation.
 * `cumulativeRefundAmountCents` is deliberately part of this type but never
 * read by `buildPackageRefundReconciliationInput` below -- its presence
 * documents, and makes directly testable, the fact that the cumulative
 * charge total (used by the existing, unchanged payment-summary sync) must
 * never leak into the reconciliation path. Only `refundEventAmountCents`
 * (the single Stripe refund object's own amount) does.
 */
export type StripeRefundEventContext = {
  stripeRefundId: string | null;
  refundEventAmountCents: number;
  cumulativeRefundAmountCents: number;
  refundStatus: string;
  resolvedPaymentIntentId: string | null;
  chargeId: string | null;
};

/**
 * Package Refund P0, Slice 2c-1: pure decision logic for whether
 * `handleStripeRefundUpdated` should invoke package-refund reconciliation
 * for this observation, and with what exact arguments. Extracted so the
 * "single-event amount, never cumulative" and "status/identity pass
 * through unmodified" properties are directly unit-testable without a
 * Stripe/Supabase fake -- mirrors this codebase's established pure-decision-
 * module pattern (e.g. computePackageImportActivationPlan).
 */
export function buildPackageRefundReconciliationInput(
  ctx: StripeRefundEventContext,
): StripeRefundReconciliationInput | null {
  if (!ctx.stripeRefundId || !ctx.resolvedPaymentIntentId || ctx.refundEventAmountCents <= 0) {
    return null;
  }

  return {
    stripePaymentIntentId: ctx.resolvedPaymentIntentId,
    stripeRefundId: ctx.stripeRefundId,
    stripeChargeId: ctx.chargeId,
    refundAmountCents: ctx.refundEventAmountCents,
    refundStatus: ctx.refundStatus,
  };
}

/**
 * Resolves every `payments` row for the given Stripe payment intent and
 * calls `reconcile_package_stripe_refund` for each one. Not every matching
 * payment is package-related -- the RPC itself gates on
 * `client_package_id IS NOT NULL` and returns a clean `not_package_related`
 * no-op for the rest, so this module doesn't pre-filter.
 *
 * Errors are not caught here -- they propagate to the webhook route's outer
 * try/catch, which correctly triggers Stripe's automatic HTTP-500 retry.
 */
export async function reconcilePackageStripeRefund(
  supabase: SupabaseClient,
  input: StripeRefundReconciliationInput,
): Promise<PackageRefundReconciliationResult[]> {
  const { data: payments, error: paymentsLookupError } = await supabase
    .from("payments")
    .select("id, studio_id")
    .eq("stripe_payment_intent_id", input.stripePaymentIntentId);

  if (paymentsLookupError) {
    throw new Error(paymentsLookupError.message);
  }

  const results: PackageRefundReconciliationResult[] = [];

  for (const payment of payments ?? []) {
    const { data, error } = await supabase.rpc("reconcile_package_stripe_refund", {
      p_studio_id: payment.studio_id,
      p_payment_id: payment.id,
      p_stripe_refund_id: input.stripeRefundId,
      p_stripe_charge_id: input.stripeChargeId,
      p_refund_amount_cents: input.refundAmountCents,
      p_refund_status: input.refundStatus,
      ...(input.occurredAt ? { p_occurred_at: input.occurredAt } : {}),
    });

    if (error) {
      throw new Error(error.message);
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | { reconciliation_id: string | null; outcome: string; applied: boolean }
      | undefined;

    results.push({
      paymentId: payment.id,
      studioId: payment.studio_id,
      reconciliationId: row?.reconciliation_id ?? null,
      outcome: row?.outcome ?? "not_package_related",
      applied: Boolean(row?.applied),
    });
  }

  return results;
}
