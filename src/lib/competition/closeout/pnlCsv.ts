import { toCsv } from "@/lib/utils/csv";
import type { CompetitionPnl } from "./pnl";

/**
 * Formula-safe CSV for the competition P&L (shared Phase 9D helper: text cells are neutralized, the money strings
 * below are plain decimals the helper leaves alone). Read only; nothing here marks anything exported or closed.
 */

export const CLOSEOUT_CSV_KINDS = ["pnl", "lines", "refunds"] as const;
export type CloseoutCsvKind = (typeof CLOSEOUT_CSV_KINDS)[number];

export function isCloseoutCsvKind(value: string | null): value is CloseoutCsvKind {
  return (CLOSEOUT_CSV_KINDS as readonly string[]).includes(value ?? "");
}

export const dollars = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

export function pnlSummaryCsv(pnl: CompetitionPnl) {
  const rows: Array<Array<unknown>> = [
    ["revenue", "Gross entry revenue received (online + desk)", dollars(pnl.revenue.grossReceivedCents), pnl.revenue.paymentCount, "event_payments paid/refunded"],
    ["revenue", "  of which online (Stripe)", dollars(pnl.revenue.onlineCents), "", "event_payments"],
    ["revenue", "  of which desk payments", dollars(pnl.revenue.deskCents), "", "event_payments source competition_checkin"],
    ["order_lines", "List price of entry and fee lines", dollars(pnl.lines.listPriceCents), "", "event_order_items"],
    ["order_lines", "Discounts (already inside what was charged)", dollars(-pnl.lines.discountCents), "", "event_order_items discount lines"],
    ["order_lines", "Chargeable after discounts", dollars(pnl.lines.netChargeableCents), "", "list price minus discounts"],
    ["fees", "Stripe processing fees", dollars(pnl.fees.processingCents), "", "event_payments"],
    ["fees", "Stripe application fees", dollars(pnl.fees.applicationCents), "", "event_payments"],
    ["fees", "Platform fee retained", dollars(pnl.fees.platformFeeRetainedCents), "", "event_payments"],
    ["fees", "Fees total (as accounting posts)", dollars(pnl.fees.totalCents), "", "processing + application + platform"],
    ...pnl.refunds.byDate.map((d) => ["refunds_succeeded", d.date, dollars(-d.cents), d.count, "event_order_refunds succeeded_at"]),
    ["refunds_succeeded", "Total succeeded refunds", dollars(-pnl.refunds.succeededCents), pnl.refunds.succeededCount, "event_order_refunds"],
    ["refunds_pending", "Pending refunds holding cap (NOT money returned)", dollars(pnl.refunds.pendingHoldingCapCents), pnl.refunds.pendingCount, "event_order_refunds requested/pending/requires_action"],
    ["net", "Net after refunds", dollars(pnl.netCents), "", "received minus succeeded refunds"],
    ["net", "Net after refunds and fees", dollars(pnl.netAfterFeesCents), "", "net minus fees total"],
    ...pnl.reconciliation.checks.map((c) => [
      "reconciliation",
      c.label,
      c.diffCents === null ? "" : dollars(c.diffCents),
      "",
      c.status === "ok" ? "OK" : c.status === "mismatch" ? `MISMATCH: ${c.detail}` : `NOT CHECKED: ${c.detail}`,
    ]),
  ];
  return toCsv(["section", "line", "amount", "count", "basis"], rows);
}

export function pnlLinesCsv(pnl: CompetitionPnl) {
  return toCsv(
    ["order_id", "order_item_id", "line_kind", "entry_id", "label", "entry_status", "gross", "discount_share", "net", "refunded_succeeded", "pending_refund", "remaining_refundable"],
    pnl.entryLines.map((l) => [
      l.orderId, l.orderItemId, l.kind, l.entryId, l.label, l.entryStatus,
      dollars(l.grossCents), dollars(-l.discountShareCents), dollars(l.netCents),
      dollars(-l.refundedCents), dollars(l.pendingCents), dollars(l.remainingRefundableCents),
    ]),
  );
}

export function pnlRefundsCsv(pnl: CompetitionPnl) {
  return toCsv(
    ["refund_id", "order_id", "date", "amount", "status", "counts_as_money", "source", "stripe_refund_id", "attributed", "reversed", "reason"],
    pnl.refunds.rows.map((r) => [
      r.refundId, r.orderId, r.date, dollars(r.cents), r.status, r.status === "succeeded" ? "yes" : "no",
      r.source, r.stripeRefundId, r.unattributed ? "no" : "yes", r.reversed ? "yes" : "no", r.reason,
    ]),
  );
}

export function closeoutCsv(kind: CloseoutCsvKind, pnl: CompetitionPnl) {
  return kind === "pnl" ? pnlSummaryCsv(pnl) : kind === "lines" ? pnlLinesCsv(pnl) : pnlRefundsCsv(pnl);
}
