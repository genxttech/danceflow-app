/**
 * Stage 3 (C6 / D24 two-stage hosted invoicing): pure, order-independent reconciliation helpers.
 *
 * Not wired into the webhook route. They encode what the Stage 2 sandbox runs showed about Stripe-hosted invoices so
 * that delayed, duplicated and out-of-order deliveries converge on the same state:
 *   - invoice state is the maximum observation under a TOTAL order (lifecycle rank, event time, then the observed
 *     amounts and status), so arrival order cannot change the result and a later lower-rank snapshot never reopens an
 *     invoice;
 *   - an invoice payment is keyed by its invoice_payment id, so a second event for the same payment is a no-op;
 *   - refunds and credits are keyed by their own ids and only move forward (pending -> succeeded -> failed/canceled);
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

export type InvoiceState = InvoiceObservation & {
  /** Every status ever observed for this invoice (sorted). Kept so anomalies do not depend on arrival order. */
  seenStatuses: HostedInvoiceStatus[];
  anomalies: string[];
};

function compareObservations(a: InvoiceObservation, b: InvoiceObservation): number {
  const keys: Array<[number | string, number | string]> = [
    [STATUS_RANK[a.status], STATUS_RANK[b.status]],
    [a.eventCreated, b.eventCreated],
    [a.amountPaid, b.amountPaid],
    [-a.amountRemaining, -b.amountRemaining], // less remaining is later in a normal lifecycle
    [-a.amountDue, -b.amountDue],
    [a.total, b.total],
    [a.status, b.status], // paid vs void at the same rank, time and amounts: deterministic (void sorts later)
  ];
  for (const [x, y] of keys) if (x !== y) return x < y ? -1 : 1;
  return 0;
}

const anomaliesFor = (seen: HostedInvoiceStatus[]) => (seen.includes("paid") && seen.includes("void") ? ["paid_and_void_observed"] : []);

export function applyInvoiceObservation(current: InvoiceState | null, observed: InvoiceObservation): InvoiceState {
  const seen = [...new Set([...(current?.seenStatuses ?? []), observed.status])].sort() as HostedInvoiceStatus[];
  if (!current) return { ...observed, seenStatuses: seen, anomalies: anomaliesFor(seen) };
  if (current.invoiceId !== observed.invoiceId) throw new Error("observation is for a different invoice");
  const winner = compareObservations(observed, current) > 0 ? observed : current;
  const { seenStatuses: _s, anomalies: _a, ...snapshot } = winner as InvoiceState;
  void _s;
  void _a;
  return { ...snapshot, seenStatuses: seen, anomalies: anomaliesFor(seen) };
}

export type InvoicePaymentFact = {
  invoicePaymentId: string; // inpay_...
  invoiceId: string;
  status: "paid" | "open" | "canceled";
  /** What the payment was asked to collect (present in every status). */
  amountRequested: number;
  /** What was collected; Stripe reports 0 or null until the payment is paid. */
  amountPaid: number;
};

export type PaymentLedger = { payments: Record<string, InvoicePaymentFact>; anomalies: string[] };

export const emptyLedger = (): PaymentLedger => ({ payments: {}, anomalies: [] });

const PAYMENT_RANK = { open: 0, canceled: 1, paid: 2 } as const;

/** Idempotent by invoice payment id: a repeated event for the same payment and state changes nothing. */
export function recordInvoicePayment(ledger: PaymentLedger, fact: InvoicePaymentFact): { ledger: PaymentLedger; duplicate: boolean } {
  const existing = ledger.payments[fact.invoicePaymentId];
  const conflict = (): { ledger: PaymentLedger; duplicate: boolean } => ({
    ledger: { payments: ledger.payments, anomalies: [...new Set([...ledger.anomalies, "invoice_payment_conflict:" + fact.invoicePaymentId])].sort() },
    duplicate: true,
  });
  if (!existing) return { ledger: { payments: { ...ledger.payments, [fact.invoicePaymentId]: fact }, anomalies: ledger.anomalies }, duplicate: false };
  if (existing.invoiceId !== fact.invoiceId || existing.amountRequested !== fact.amountRequested) return conflict();
  const rankDiff = PAYMENT_RANK[fact.status] - PAYMENT_RANK[existing.status];
  if (rankDiff > 0) return { ledger: { payments: { ...ledger.payments, [fact.invoicePaymentId]: fact }, anomalies: ledger.anomalies }, duplicate: false };
  if (rankDiff === 0 && existing.amountPaid !== fact.amountPaid) return conflict();
  return { ledger, duplicate: true };
}

export type RefundFact = { refundId: string; invoiceId: string; amount: number; status: "pending" | "succeeded" | "failed" | "canceled" };
// a bank refund can fail after it succeeded, so failed and canceled outrank succeeded; failed vs canceled is decided lexically
const REFUND_RANK = { pending: 0, succeeded: 1, canceled: 2, failed: 3 } as const;

export function recordRefund(refunds: Record<string, RefundFact>, fact: RefundFact): Record<string, RefundFact> {
  const existing = refunds[fact.refundId];
  if (!existing || REFUND_RANK[fact.status] > REFUND_RANK[existing.status]) return { ...refunds, [fact.refundId]: fact };
  return refunds;
}

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
