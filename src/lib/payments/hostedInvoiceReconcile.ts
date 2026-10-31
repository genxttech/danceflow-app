/**
 * Stage 3 (C6 / D24 two-stage hosted invoicing): pure, order-independent reconciliation helpers.
 *
 * Not wired into the webhook route. They encode what the Stage 2 sandbox runs showed about Stripe-hosted invoices so
 * that delayed, duplicated and out-of-order deliveries converge on the same state:
 *   - invoice state is the observation with the greatest (event time, lifecycle rank); arrival order is irrelevant;
 *   - an invoice payment is keyed by its invoice_payment id, so a second event for the same payment is a no-op;
 *   - refunds and credits are keyed by their own ids and only move forward (pending -> succeeded);
 *   - void and uncollectible stay distinct and neither refunds or erases a payment;
 *   - a refunded invoice stays "paid"; money is judged from the payment and refund facts, not the invoice status.
 * Amounts are integer cents. Nothing here performs I/O.
 */

export type HostedInvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

// uncollectible can later be paid or voided; paid and void are the terminal ends.
const STATUS_RANK: Record<HostedInvoiceStatus, number> = { draft: 0, open: 1, uncollectible: 2, paid: 3, void: 3 };

export type InvoiceObservation = {
  invoiceId: string;
  status: HostedInvoiceStatus;
  /** Stripe event.created (unix seconds) of the event that carried this snapshot. */
  eventCreated: number;
  total: number;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
};

export type InvoiceState = InvoiceObservation & { anomalies: string[] };

export function applyInvoiceObservation(current: InvoiceState | null, observed: InvoiceObservation): InvoiceState {
  if (!current) return { ...observed, anomalies: [] };
  if (current.invoiceId !== observed.invoiceId) throw new Error("observation is for a different invoice");
  const anomalies = new Set(current.anomalies);
  const a = [current.eventCreated, STATUS_RANK[current.status]] as const;
  const b = [observed.eventCreated, STATUS_RANK[observed.status]] as const;
  const newer = b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]);
  const sameKey = b[0] === a[0] && b[1] === a[1];
  // paid and void share a rank; both on the same invoice is a data anomaly to surface, not to resolve silently.
  if ((current.status === "paid" && observed.status === "void") || (current.status === "void" && observed.status === "paid")) {
    anomalies.add("paid_and_void_observed");
  }
  if (sameKey && current.status !== observed.status) {
    // deterministic choice so order cannot matter: the lexically greater status wins; the clash is recorded.
    const winner = current.status > observed.status ? current : { ...observed };
    return { ...winner, anomalies: [...anomalies].sort() };
  }
  const winner = newer ? { ...observed } : { ...current };
  return { ...winner, anomalies: [...anomalies].sort() };
}

export type InvoicePaymentFact = {
  invoicePaymentId: string; // inpay_...
  invoiceId: string;
  status: "paid" | "open" | "canceled";
  amountPaid: number;
};

export type PaymentLedger = { payments: Record<string, InvoicePaymentFact>; anomalies: string[] };

export const emptyLedger = (): PaymentLedger => ({ payments: {}, anomalies: [] });

/** Idempotent by invoice payment id: a repeated event for the same payment and state changes nothing. */
export function recordInvoicePayment(ledger: PaymentLedger, fact: InvoicePaymentFact): { ledger: PaymentLedger; duplicate: boolean } {
  const existing = ledger.payments[fact.invoicePaymentId];
  if (!existing) return { ledger: { payments: { ...ledger.payments, [fact.invoicePaymentId]: fact }, anomalies: ledger.anomalies }, duplicate: false };
  if (existing.invoiceId !== fact.invoiceId || existing.amountPaid !== fact.amountPaid) {
    const anomalies = [...new Set([...ledger.anomalies, "invoice_payment_conflict:" + fact.invoicePaymentId])].sort();
    return { ledger: { payments: ledger.payments, anomalies }, duplicate: true };
  }
  const rank = { open: 0, canceled: 1, paid: 2 } as const;
  if (rank[fact.status] > rank[existing.status]) {
    return { ledger: { payments: { ...ledger.payments, [fact.invoicePaymentId]: fact }, anomalies: ledger.anomalies }, duplicate: false };
  }
  return { ledger, duplicate: true };
}

export type RefundFact = { refundId: string; invoiceId: string; amount: number; status: "pending" | "succeeded" | "failed" | "canceled" };
const REFUND_RANK = { pending: 0, succeeded: 1, failed: 1, canceled: 1 } as const;

export function recordRefund(refunds: Record<string, RefundFact>, fact: RefundFact): Record<string, RefundFact> {
  const existing = refunds[fact.refundId];
  if (!existing || REFUND_RANK[fact.status] > REFUND_RANK[existing.status]) return { ...refunds, [fact.refundId]: fact };
  return refunds;
}

export type CreditFact = { balanceTransactionId: string; customerId: string; amount: number }; // negative = credit

export type ReconcileInput = {
  invoice: InvoiceState;
  payments: PaymentLedger;
  refunds: Record<string, RefundFact>;
};

export type ReconcileResult = {
  collected: number;
  refunded: number;
  netReceived: number;
  /** Amount still owed by the customer as a live receivable (void and uncollectible are excluded). */
  openReceivable: number;
  /** Amount written off as uncollectible; kept as a distinct, auditable figure. */
  uncollectibleAmount: number;
  anomalies: string[];
};

export function reconcileInvoice(input: ReconcileInput): ReconcileResult {
  const { invoice } = input;
  const anomalies = [...invoice.anomalies, ...input.payments.anomalies];
  const own = Object.values(input.payments.payments).filter((p) => p.invoiceId === invoice.invoiceId && p.status === "paid");
  const collected = own.reduce((sum, p) => sum + p.amountPaid, 0);
  const refunded = Object.values(input.refunds)
    .filter((r) => r.invoiceId === invoice.invoiceId && r.status === "succeeded")
    .reduce((sum, r) => sum + r.amount, 0);
  if (refunded > collected) anomalies.push("refunded_exceeds_collected");
  if (invoice.status === "paid" && collected !== invoice.amountPaid) anomalies.push("paid_invoice_amount_mismatch");
  if (invoice.status === "void" && collected > 0) anomalies.push("void_invoice_has_payments");

  let openReceivable = 0;
  let uncollectibleAmount = 0;
  if (invoice.status === "open") openReceivable = invoice.amountRemaining;
  if (invoice.status === "uncollectible") uncollectibleAmount = invoice.amountRemaining;

  return { collected, refunded, netReceived: collected - refunded, openReceivable, uncollectibleAmount, anomalies: [...new Set(anomalies)].sort() };
}
