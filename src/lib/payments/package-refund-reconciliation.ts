import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveStudioIdForStripeAccount } from "@/lib/payments/paymentDisputes";

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
 * PKG-REFUND-1 (L1): package-refund reconciliation and restoration are bound
 * to the verified Stripe account that delivered the webhook (PAY-DC-2B
 * guarantees event.account is present exactly for Connect-signed events).
 * This reuses the PAY-DC-2C Connect ownership rule (attributeConnectDispute):
 *   - a payment with a stored PAY-DC-2A owner is eligible only when that owner
 *     equals the webhook account;
 *   - a legacy payment with no stored owner is eligible only when its studio is
 *     the studio server-side mapped to the webhook account
 *     (studios.stripe_connected_account_id, PAY-DC-2D write-locked);
 *   - a platform-scoped event (no account) proves no studio ownership, so
 *     nothing is eligible.
 * Ineligible payments get a fixed code and no RPC call, so no package-credit
 * or reconciliation mutation. Lookup errors still throw (webhook retry).
 */
export const PACKAGE_REFUND_OWNER_MISMATCH = "package_refund_owner_mismatch";
export const PACKAGE_REFUND_OWNER_UNVERIFIED = "package_refund_owner_unverified";

type PackageRefundPaymentRow = {
  id: string;
  studio_id: string;
  stripe_account_id: string | null;
};

type OwnerDecision =
  | { eligible: true; payment: PackageRefundPaymentRow }
  | {
      eligible: false;
      payment: PackageRefundPaymentRow;
      code: typeof PACKAGE_REFUND_OWNER_MISMATCH | typeof PACKAGE_REFUND_OWNER_UNVERIFIED;
    };

async function loadOwnerBoundPackagePayments(
  supabase: SupabaseClient,
  stripePaymentIntentId: string,
  stripeAccountId: string | null | undefined,
): Promise<OwnerDecision[]> {
  const { data: payments, error: paymentsLookupError } = await supabase
    .from("payments")
    .select("id, studio_id, stripe_account_id")
    .eq("stripe_payment_intent_id", stripePaymentIntentId);

  if (paymentsLookupError) {
    throw new Error(paymentsLookupError.message);
  }

  const verifiedAccountId = stripeAccountId ?? null;
  let mappedStudioId: string | null | undefined;
  const decisions: OwnerDecision[] = [];

  for (const payment of (payments ?? []) as PackageRefundPaymentRow[]) {
    const storedAccountId = payment.stripe_account_id ?? null;

    if (storedAccountId !== null) {
      decisions.push(
        storedAccountId === verifiedAccountId
          ? { eligible: true, payment }
          : { eligible: false, payment, code: PACKAGE_REFUND_OWNER_MISMATCH },
      );
      continue;
    }

    if (!verifiedAccountId) {
      decisions.push({ eligible: false, payment, code: PACKAGE_REFUND_OWNER_UNVERIFIED });
      continue;
    }

    if (mappedStudioId === undefined) {
      mappedStudioId = await resolveStudioIdForStripeAccount(supabase, verifiedAccountId);
    }

    decisions.push(
      mappedStudioId && payment.studio_id === mappedStudioId
        ? { eligible: true, payment }
        : { eligible: false, payment, code: PACKAGE_REFUND_OWNER_UNVERIFIED },
    );
  }

  for (const decision of decisions) {
    if (!decision.eligible) console.error(decision.code);
  }

  return decisions;
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
  stripeAccountId: string | null | undefined,
): Promise<PackageRefundReconciliationResult[]> {
  const decisions = await loadOwnerBoundPackagePayments(
    supabase,
    input.stripePaymentIntentId,
    stripeAccountId,
  );

  const results: PackageRefundReconciliationResult[] = [];

  for (const decision of decisions) {
    const { payment } = decision;
    if (!decision.eligible) {
      results.push({
        paymentId: payment.id,
        studioId: payment.studio_id,
        reconciliationId: null,
        outcome: decision.code,
        applied: false,
      });
      continue;
    }

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

/**
 * Package Refund P0, Slice 2c-3: a Stripe refund that already voided
 * package credit (via reconcile_package_stripe_refund above, or the staff
 * review RPC) later reversing -- failing or being canceled after initially
 * succeeding, a real, documented Stripe behavior for ACH/bank-debit
 * refunds -- must restore exactly what it voided. See
 * restore_package_refund_reconciliation (20261003090000_pkgrefund1_package_refund_reversal_restoration.sql,
 * which supersedes 20260830090000)
 * for the restoration algorithm itself; this type/function pair is only the
 * decision of *whether* a given refund-status observation represents a
 * reversal, mirroring buildPackageRefundReconciliationInput's own
 * pure-decision-module shape above.
 */
export type StripeRefundReversalInput = {
  stripeRefundId: string;
  newRefundStatus: "failed" | "canceled";
  occurredAt?: string | null;
};

export type PackageRefundReversalResult = {
  paymentId: string;
  studioId: string;
  reconciliationId: string | null;
  outcome: string;
  restoredItemCount: number;
  applied: boolean;
};

const REVERSAL_STATUSES = new Set(["failed", "canceled"]);

/**
 * Pure decision logic for whether handleStripeRefundUpdated should invoke
 * reversal restoration for this observation. Only 'failed'/'canceled' are
 * treated as a reversal signal -- 'succeeded' (the forward path, handled by
 * buildPackageRefundReconciliationInput/reconcilePackageStripeRefund above)
 * and 'pending'/'requires_action' are not.
 */
export function buildPackageRefundReversalInput(
  ctx: StripeRefundEventContext,
): StripeRefundReversalInput | null {
  if (
    !ctx.stripeRefundId ||
    !ctx.resolvedPaymentIntentId ||
    !REVERSAL_STATUSES.has(ctx.refundStatus)
  ) {
    return null;
  }

  return {
    stripeRefundId: ctx.stripeRefundId,
    newRefundStatus: ctx.refundStatus as "failed" | "canceled",
  };
}

/**
 * Resolves every `payments` row for the given Stripe payment intent and
 * calls restore_package_refund_reconciliation for each, mirroring
 * reconcilePackageStripeRefund's own shape above. The RPC itself looks up
 * its target reconciliation row by stripe_refund_id (already globally
 * unique), not payment_id -- p_studio_id here is a scope assertion only, so
 * calling once per matching payment row is harmless: at most one payment's
 * studio_id can actually match the reconciliation this stripe_refund_id
 * belongs to, and the RPC returns a clean 'not_reconciled' no-op for the
 * rest (see its own Step 1).
 *
 * Errors are not caught here -- they propagate to the webhook route's outer
 * try/catch, which correctly triggers Stripe's automatic HTTP-500 retry.
 */
export async function restorePackageRefundReconciliation(
  supabase: SupabaseClient,
  stripePaymentIntentId: string,
  input: StripeRefundReversalInput,
  stripeAccountId: string | null | undefined,
): Promise<PackageRefundReversalResult[]> {
  const decisions = await loadOwnerBoundPackagePayments(
    supabase,
    stripePaymentIntentId,
    stripeAccountId,
  );

  const results: PackageRefundReversalResult[] = [];

  for (const decision of decisions) {
    const { payment } = decision;
    if (!decision.eligible) {
      results.push({
        paymentId: payment.id,
        studioId: payment.studio_id,
        reconciliationId: null,
        outcome: decision.code,
        restoredItemCount: 0,
        applied: false,
      });
      continue;
    }

    const { data, error } = await supabase.rpc("restore_package_refund_reconciliation", {
      p_studio_id: payment.studio_id,
      p_stripe_refund_id: input.stripeRefundId,
      p_new_refund_status: input.newRefundStatus,
      ...(input.occurredAt ? { p_occurred_at: input.occurredAt } : {}),
    });

    if (error) {
      throw new Error(error.message);
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | {
          reconciliation_id: string | null;
          outcome: string;
          restored_item_count: number;
          applied: boolean;
        }
      | undefined;

    results.push({
      paymentId: payment.id,
      studioId: payment.studio_id,
      reconciliationId: row?.reconciliation_id ?? null,
      outcome: row?.outcome ?? "not_reconciled",
      restoredItemCount: row?.restored_item_count ?? 0,
      applied: Boolean(row?.applied),
    });
  }

  return results;
}
