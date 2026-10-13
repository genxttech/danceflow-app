import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Stripe fee detail sync for payment rows (moved verbatim from src/app/api/payments/webhook/route.ts in PAY-WH-1 so the
 * event-cart settlement outbox worker can run it outside the webhook request).
 */

type StripeFeeDetails = {
  chargeId: string | null;
  balanceTransactionId: string | null;
  stripeProcessingFeeAmount: number;
  stripeApplicationFeeAmount: number;
  platformFeeAmount: number;
};

export function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export function centsToDollars(value: number | null | undefined) {
  return Number(value ?? 0) / 100;
}

function dollarsToCents(value: number | string | null | undefined) {
  return Math.round(Number(value ?? 0) * 100);
}

function prorateCents(
  totalCents: number,
  rowAmountCents: number,
  allRowsAmountCents: number,
) {
  if (totalCents <= 0 || rowAmountCents <= 0 || allRowsAmountCents <= 0)
    return 0;
  return Math.round((totalCents * rowAmountCents) / allRowsAmountCents);
}

async function getStripeFeeDetailsFromCharge(
  stripe: Stripe,
  charge: Stripe.Charge,
  stripeAccountId?: string | null,
): Promise<StripeFeeDetails> {
  const chargeId = charge.id ?? null;
  const balanceTransactionId = stripeObjectId(charge.balance_transaction);

  let stripeProcessingFeeAmount = 0;
  const stripeApplicationFeeAmount = centsToDollars(
    charge.application_fee_amount ?? 0,
  );
  const platformFeeAmount = stripeApplicationFeeAmount;

  if (balanceTransactionId) {
    try {
      const balanceTransaction =
        typeof charge.balance_transaction === "object" &&
        charge.balance_transaction &&
        "fee" in charge.balance_transaction
          ? (charge.balance_transaction as Stripe.BalanceTransaction)
          : await stripe.balanceTransactions.retrieve(
              balanceTransactionId,
              {},
              stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
            );

      stripeProcessingFeeAmount = centsToDollars(balanceTransaction.fee ?? 0);
    } catch (error) {
      console.warn(
        "Unable to retrieve Stripe balance transaction fees.",
        error,
      );
    }
  }

  return {
    chargeId,
    balanceTransactionId,
    stripeProcessingFeeAmount,
    stripeApplicationFeeAmount,
    platformFeeAmount,
  };
}

async function getStripeFeeDetailsFromPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string,
  stripeAccountId?: string | null,
) {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      {
        expand: ["latest_charge", "latest_charge.balance_transaction"],
      },
      stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
    );

    const latestCharge = paymentIntent.latest_charge;
    const charge =
      typeof latestCharge === "object" && latestCharge
        ? (latestCharge as Stripe.Charge)
        : null;

    if (!charge) return null;

    return getStripeFeeDetailsFromCharge(stripe, charge, stripeAccountId);
  } catch (error) {
    console.warn(
      "Unable to retrieve Stripe payment intent fee details.",
      error,
    );
    return null;
  }
}

export async function syncFeeDetailsForPaymentIntent(
  supabase: SupabaseClient,
  stripe: Stripe,
  paymentIntentId: string,
  stripeAccountId?: string | null,
) {
  const feeDetails = await getStripeFeeDetailsFromPaymentIntent(
    stripe,
    paymentIntentId,
    stripeAccountId,
  );
  if (!feeDetails) return false;

  const feePayload = {
    stripe_charge_id: feeDetails.chargeId,
    stripe_balance_transaction_id: feeDetails.balanceTransactionId,
    stripe_processing_fee_amount: feeDetails.stripeProcessingFeeAmount,
    stripe_application_fee_amount: feeDetails.stripeApplicationFeeAmount,
    platform_fee_amount: feeDetails.platformFeeAmount,
  };

  const { error: paymentsError } = await supabase
    .from("payments")
    .update(feePayload)
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (paymentsError) {
    throw new Error(paymentsError.message);
  }

  const { data: eventPayments, error: eventPaymentsLookupError } =
    await supabase
      .from("event_payments")
      .select("id, amount")
      .eq("stripe_payment_intent_id", paymentIntentId);

  if (eventPaymentsLookupError) {
    throw new Error(eventPaymentsLookupError.message);
  }

  const rows = eventPayments ?? [];
  const totalAmountCents = rows.reduce(
    (sum, row) => sum + dollarsToCents(row.amount),
    0,
  );

  if (rows.length > 0) {
    for (const row of rows) {
      const rowAmountCents = dollarsToCents(row.amount);
      const rowProcessingFee = centsToDollars(
        prorateCents(
          Math.round(feeDetails.stripeProcessingFeeAmount * 100),
          rowAmountCents,
          totalAmountCents,
        ),
      );
      const rowApplicationFee = centsToDollars(
        prorateCents(
          Math.round(feeDetails.stripeApplicationFeeAmount * 100),
          rowAmountCents,
          totalAmountCents,
        ),
      );
      const rowPlatformFee = centsToDollars(
        prorateCents(
          Math.round(feeDetails.platformFeeAmount * 100),
          rowAmountCents,
          totalAmountCents,
        ),
      );

      const { error: eventPaymentUpdateError } = await supabase
        .from("event_payments")
        .update({
          stripe_charge_id: feeDetails.chargeId,
          stripe_balance_transaction_id: feeDetails.balanceTransactionId,
          stripe_processing_fee_amount: rowProcessingFee,
          stripe_application_fee_amount: rowApplicationFee,
          platform_fee_amount: rowPlatformFee,
        })
        .eq("id", row.id);

      if (eventPaymentUpdateError) {
        throw new Error(eventPaymentUpdateError.message);
      }
    }
  }

  return true;
}

export async function syncFeeDetailsForCharge(
  supabase: SupabaseClient,
  stripe: Stripe,
  charge: Stripe.Charge,
  stripeAccountId?: string | null,
) {
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!paymentIntentId) return false;

  return syncFeeDetailsForPaymentIntent(
    supabase,
    stripe,
    paymentIntentId,
    stripeAccountId,
  );
}

/**
 * PAY-DC-2A: a row with a stored owner is only reconciled by an event from that
 * same Stripe account. Rows without a stored owner keep legacy behavior.
 */
