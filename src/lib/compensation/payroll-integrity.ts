/**
 * Phase 9A payroll integrity rules shared by the Instructor Pay actions.
 *
 * The database is authoritative (20261102090000_phase9a_payroll_integrity):
 * an earning reaches "paid" only through mark_payroll_batch_paid, and an
 * approved earning whose amount changes returns to "pending". These helpers
 * keep the app from offering anything the database would refuse.
 */

export type EarningStatus = "pending" | "approved" | "paid" | "void";

/**
 * Review operations allowed on an individual, unbatched earning. Payment is
 * never an individual-earning operation, and an approval is withdrawn only by
 * changing the amount (which the database turns back into "pending").
 */
export function isAllowedEarningReviewTransition(current: string, next: string) {
  if (current === "pending") return next === "approved" || next === "void";
  if (current === "approved") return next === "void";
  return false;
}

export type OverrideSource = {
  adjustment_type: string | null;
  reimbursement_amount: number | string | null;
  deduction_amount: number | string | null;
};

export type OverrideAmounts = {
  earning_amount: number;
  taxable_compensation_amount: number;
  reimbursement_amount: number;
  deduction_amount: number;
  adjustment_type: string;
};

function money(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

/**
 * Amount fields for a manual override. A reimbursement or deduction keeps its
 * classification (the override changes that amount only); a compensation
 * earning keeps any reimbursement it already carries.
 */
export function overrideEarningAmounts(existing: OverrideSource, rawAmount: number): OverrideAmounts | { error: string } {
  const amount = money(rawAmount);
  if (!Number.isFinite(rawAmount)) return { error: "invalid_override_amount" };

  if (existing.adjustment_type === "reimbursement") {
    if (amount < 0) return { error: "invalid_override_amount" };
    return {
      earning_amount: amount,
      taxable_compensation_amount: 0,
      reimbursement_amount: amount,
      deduction_amount: 0,
      adjustment_type: "reimbursement",
    };
  }

  if (existing.adjustment_type === "deduction") {
    const deduction = Math.abs(amount);
    return {
      earning_amount: -deduction,
      taxable_compensation_amount: 0,
      reimbursement_amount: 0,
      deduction_amount: deduction,
      adjustment_type: "deduction",
    };
  }

  const reimbursement = Math.max(money(existing.reimbursement_amount), 0);
  return {
    earning_amount: amount,
    taxable_compensation_amount: Math.max(amount, 0),
    reimbursement_amount: reimbursement,
    deduction_amount: amount < 0 ? Math.abs(amount) : 0,
    adjustment_type: "override",
  };
}
