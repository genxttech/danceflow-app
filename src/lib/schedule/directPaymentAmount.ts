/*
  GC-3.5-1: staff-entered Group Class direct-payment price.

  Staff type dollars (USD only in GC-3.5 v1; no currency selector). The
  server normalizes to the canonical database representation of
  group_class_enrollment_policies.direct_payment_amount / the series
  equivalent: a plain numeric dollar amount with at most two decimals. The
  rules mirror DanceFlow's existing card-reader amount parser
  (parseQuickChargeAmount): digits with an optional 1-2 digit fraction,
  greater than zero, at most 100000. The database additionally requires
  amount > 0 and an amount whenever direct payment is accepted.

  A free class is never "direct payment $0" -- zero is rejected here and by
  the database.
*/

export const MAX_DIRECT_PAYMENT_AMOUNT = 100000;

export type DirectPaymentAmountResult =
  | { ok: true; amount: number }
  | { ok: false; code: "direct_payment_amount_required" | "direct_payment_amount_invalid" };

export function parseDirectPaymentAmount(value: unknown): DirectPaymentAmountResult {
  const raw = String(value ?? "").trim().replace(/^\$\s*/, "");
  if (!raw) return { ok: false, code: "direct_payment_amount_required" };
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { ok: false, code: "direct_payment_amount_invalid" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_DIRECT_PAYMENT_AMOUNT) {
    return { ok: false, code: "direct_payment_amount_invalid" };
  }
  return { ok: true, amount: Math.round(parsed * 100) / 100 };
}

/** "25.00" for an existing stored amount (form default); "" when none. */
export function formatDirectPaymentAmountInput(amount: number | string | null | undefined) {
  if (amount === null || amount === undefined || amount === "") return "";
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed > 0 ? parsed.toFixed(2) : "";
}

export const DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES = {
  direct_payment_amount_required: "Enter a direct payment price to accept direct payment.",
  direct_payment_amount_invalid: "Enter a direct payment price greater than $0 with at most 2 decimal places.",
} as const;
