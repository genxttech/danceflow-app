/**
 * Competition check-in desk balance.
 *
 * A refund settles money that was already captured; it never creates a debt. R2 (competition entry refunds)
 * records refunds in event_payments.refund_amount (succeeded refunds only) and never lowers
 * event_orders.total_amount, so the order total stays the price of the registration:
 *
 *   balance due = max(0, order total - captured)
 *
 * where captured is the gross amount of every payment row that was actually collected (status "paid", or
 * "refunded" once a payment is fully refunded). refund_amount is deliberately ignored: subtracting it (the old
 * rule) turned a refund into an unpaid charge. The SQL twin is record_competition_checkin_payment
 * (20270111090000_competition_checkin_balance_refund.sql); keep the two in step.
 */
export type CheckinPaymentRow = { amount?: number | string | null; refund_amount?: number | string | null; status?: string | null };

export const CAPTURED_PAYMENT_STATUSES = ["paid", "refunded"] as const;

const cents = (value: number | string | null | undefined) => Math.round(Number(value ?? 0) * 100);

export function capturedAmount(payments: CheckinPaymentRow[]): number {
  return payments
    .filter((payment) => (CAPTURED_PAYMENT_STATUSES as readonly string[]).includes(String(payment.status ?? "")))
    .reduce((sum, payment) => sum + cents(payment.amount), 0) / 100;
}

export function checkinBalanceDue(orderTotal: number | string | null | undefined, payments: CheckinPaymentRow[]): number {
  const due = cents(orderTotal) - Math.round(capturedAmount(payments) * 100);
  return Math.max(0, due) / 100;
}
