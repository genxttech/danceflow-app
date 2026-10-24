import {
  CAP_HOLDING_REFUND_STATUSES,
  netRefundableCaps,
  type DiscountLine,
  type RefundableLine,
} from "@/lib/payments/competitionRefundRules";

/**
 * C1 closeout (read only): competition profit and loss.
 *
 * Pure functions over rows the loader read. Nothing here writes, closes, locks, settles or posts money.
 * Every figure is integer cents and traces to a source row (payment id, refund id, order item id); the
 * reconciliation block recomputes the headline from independent sources and flags any difference.
 *
 * Money semantics (R2 / C1):
 * - Revenue is what event_payments received (Stripe and desk). A refunded competition payment stays at gross.
 * - A refund is money returned only when its ledger row is `succeeded`; its date is `succeeded_at` (the same date the
 *   `competition_entry_refund` accounting entry carries). A reversed refund (succeeded -> failed/canceled) no longer
 *   counts. `requested` / `pending` / `requires_action` refunds only hold cap: shown apart, never as money.
 * - Discounts are already inside what was charged; they are shown for the order lines, not subtracted again.
 */

export type PnlOrder = {
  id: string;
  payment_status: string | null;
  total_amount: number | string | null;
  currency: string | null;
};
export type PnlItem = {
  id: string;
  order_id: string;
  item_type: string;
  description: string;
  total_price: number | string | null;
  metadata: Record<string, unknown> | null;
};
export type PnlEntry = {
  id: string;
  order_item_id: string | null;
  display_name: string;
  status: string;
  sort_order: number | null;
  program_id: string | null;
  division_id: string | null;
};
export type PnlPayment = {
  id: string;
  order_id: string | null;
  amount: number | string | null;
  status: string | null;
  source: string | null;
  payment_method: string | null;
  refund_amount: number | string | null;
  stripe_processing_fee_amount: number | string | null;
  stripe_application_fee_amount: number | string | null;
  platform_fee_amount: number | string | null;
  created_at: string;
};
export type PnlRefund = {
  id: string;
  order_id: string;
  amount_cents: number | string;
  status: string;
  source: string;
  stripe_refund_id: string | null;
  reason: string | null;
  succeeded_at: string | null;
  reversed_at: string | null;
  created_at: string;
};
export type PnlAllocation = {
  refund_id: string;
  order_item_id: string;
  entry_id: string | null;
  line_kind: string;
  amount_cents: number | string;
};
/** Active accounting entries for the event (optional tie-out; null = could not be read). */
export type PnlAccountingEntry = {
  category: string;
  direction: string;
  gross_amount: number | string | null;
  refund_amount: number | string | null;
  entry_status: string | null;
};

export type PnlInput = {
  orders: PnlOrder[];
  items: PnlItem[];
  entries: PnlEntry[];
  payments: PnlPayment[];
  refunds: PnlRefund[];
  allocations: PnlAllocation[];
  accounting: PnlAccountingEntry[] | null;
};

export const toCents = (value: number | string | null | undefined) => Math.round(Number(value ?? 0) * 100);

/** Payment statuses that are money received. A fully refunded competition payment keeps its gross (R2 / C1). */
export const RECEIVED_PAYMENT_STATUSES = ["paid", "refunded"] as const;
export const DESK_PAYMENT_SOURCE = "competition_checkin";

export type DatedRefund = { date: string; cents: number; count: number };
export type PnlRefundRow = {
  refundId: string;
  orderId: string;
  date: string | null;
  cents: number;
  status: string;
  source: string;
  stripeRefundId: string | null;
  reason: string | null;
  attributedCents: number;
  /** Succeeded refund whose allocations do not add up to its amount (a dashboard refund not yet attributed). */
  unattributed: boolean;
  holdsCap: boolean;
  reversed: boolean;
};
export type PnlEntryLine = {
  orderId: string;
  orderItemId: string;
  kind: "entry" | "fee";
  label: string;
  entryId: string | null;
  entryStatus: string | null;
  grossCents: number;
  discountShareCents: number;
  netCents: number;
  refundedCents: number;
  pendingCents: number;
  remainingRefundableCents: number;
};
export type ReconciliationCheck = {
  key: string;
  label: string;
  status: "ok" | "mismatch" | "not_checked";
  expectedCents: number | null;
  actualCents: number | null;
  diffCents: number | null;
  detail: string;
};
export type CompetitionPnl = {
  currency: string;
  orders: number;
  revenue: {
    paymentCount: number;
    grossReceivedCents: number;
    onlineCents: number;
    deskCents: number;
    ignoredPendingOrFailedCount: number;
  };
  fees: {
    processingCents: number;
    applicationCents: number;
    platformFeeRetainedCents: number;
    /** Same sum the accounting trigger posts (processing + application + platform fee). */
    totalCents: number;
  };
  lines: { listPriceCents: number; discountCents: number; netChargeableCents: number };
  refunds: {
    succeededCents: number;
    succeededCount: number;
    byDate: DatedRefund[];
    pendingHoldingCapCents: number;
    pendingCount: number;
    reversedCount: number;
    unattributedCount: number;
    rows: PnlRefundRow[];
  };
  netCents: number;
  netAfterFeesCents: number;
  entryLines: PnlEntryLine[];
  perOrder: { orderId: string; receivedCents: number; refundedCents: number; netCents: number }[];
  reconciliation: { ok: boolean; checks: ReconciliationCheck[] };
};

function lineType(item: PnlItem) {
  return typeof item.metadata?.line_type === "string" ? item.metadata.line_type : "fee";
}
function discountScope(item: PnlItem): string[] {
  const priceLine = item.metadata?.price_line as { metadata?: { scope?: Record<string, unknown> } } | undefined;
  const scope = priceLine?.metadata?.scope ?? {};
  return ["programId", "contestId", "divisionId"]
    .map((key) => scope[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const isCapHolding = (status: string) => (CAP_HOLDING_REFUND_STATUSES as readonly string[]).includes(status);

function check(
  key: string,
  label: string,
  expected: number | null,
  actual: number | null,
  detail: string,
): ReconciliationCheck {
  if (expected === null || actual === null) {
    return { key, label, status: "not_checked", expectedCents: expected, actualCents: actual, diffCents: null, detail };
  }
  const diff = actual - expected;
  return { key, label, status: diff === 0 ? "ok" : "mismatch", expectedCents: expected, actualCents: actual, diffCents: diff, detail };
}

export function buildCompetitionPnl(input: PnlInput): CompetitionPnl {
  const orderIds = new Set(input.orders.map((o) => o.id));
  const currency = input.orders.find((o) => o.currency)?.currency ?? "USD";

  // ---- Revenue: event_payments of this event's competition orders -------------------------------------------
  const received = input.payments.filter((p) => (RECEIVED_PAYMENT_STATUSES as readonly string[]).includes(String(p.status)));
  const grossReceivedCents = sum(received.map((p) => toCents(p.amount)));
  const deskCents = sum(received.filter((p) => p.source === DESK_PAYMENT_SOURCE).map((p) => toCents(p.amount)));
  const processingCents = sum(received.map((p) => toCents(p.stripe_processing_fee_amount)));
  const applicationCents = sum(received.map((p) => toCents(p.stripe_application_fee_amount)));
  const platformFeeRetainedCents = sum(received.map((p) => toCents(p.platform_fee_amount)));

  // ---- Refunds ------------------------------------------------------------------------------------------------
  const allocByRefund = new Map<string, number>();
  const allocByItem = new Map<string, { refundId: string; cents: number }[]>();
  for (const a of input.allocations) {
    allocByRefund.set(a.refund_id, (allocByRefund.get(a.refund_id) ?? 0) + Number(a.amount_cents));
    const list = allocByItem.get(a.order_item_id) ?? [];
    list.push({ refundId: a.refund_id, cents: Number(a.amount_cents) });
    allocByItem.set(a.order_item_id, list);
  }
  const refundStatus = new Map(input.refunds.map((r) => [r.id, r.status]));

  const refundRows: PnlRefundRow[] = input.refunds.map((r) => {
    const cents = Number(r.amount_cents);
    const attributedCents = allocByRefund.get(r.id) ?? 0;
    return {
      refundId: r.id,
      orderId: r.order_id,
      date: r.status === "succeeded" && r.succeeded_at ? r.succeeded_at.slice(0, 10) : null,
      cents,
      status: r.status,
      source: r.source,
      stripeRefundId: r.stripe_refund_id,
      reason: r.reason,
      attributedCents,
      unattributed: r.status === "succeeded" && attributedCents !== cents,
      holdsCap: isCapHolding(r.status) && r.status !== "succeeded",
      reversed: r.reversed_at !== null && r.status !== "succeeded",
    };
  });
  const succeeded = refundRows.filter((r) => r.status === "succeeded");
  const succeededCents = sum(succeeded.map((r) => r.cents));
  const pending = refundRows.filter((r) => r.holdsCap);
  const byDateMap = new Map<string, DatedRefund>();
  for (const r of succeeded) {
    const date = r.date ?? "undated";
    const row = byDateMap.get(date) ?? { date, cents: 0, count: 0 };
    row.cents += r.cents;
    row.count += 1;
    byDateMap.set(date, row);
  }

  // ---- Order lines: gross, discount share (shared R2 rule), refunded, pending ----------------------------------
  const entryByItem = new Map(input.entries.filter((e) => e.order_item_id).map((e) => [e.order_item_id as string, e]));
  const entryLines: PnlEntryLine[] = [];
  let discountCents = 0;
  let listPriceCents = 0;
  const itemsByOrder = new Map<string, PnlItem[]>();
  for (const item of input.items) {
    if (!orderIds.has(item.order_id)) continue;
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }
  for (const [orderId, items] of itemsByOrder) {
    const refundable: RefundableLine[] = [];
    const discounts: DiscountLine[] = [];
    for (const item of items) {
      if (item.item_type === "competition_entry") {
        const entry = entryByItem.get(item.id);
        const contestId = typeof item.metadata?.contest_id === "string" ? item.metadata.contest_id : null;
        refundable.push({
          id: item.id,
          kind: "entry",
          grossCents: toCents(item.total_price),
          sortOrder: entry?.sort_order ?? 0,
          scopeKeys: [entry?.program_id, contestId, entry?.division_id].filter((k): k is string => Boolean(k)),
        });
      } else if (item.item_type === "add_on" && lineType(item) === "discount") {
        discounts.push({
          id: item.id,
          amountCents: toCents(item.metadata?.discount_amount as number | string | undefined),
          scopeKeys: discountScope(item),
        });
      } else if (item.item_type === "add_on") {
        refundable.push({ id: item.id, kind: "fee", grossCents: toCents(item.total_price), sortOrder: 1000000 });
      }
    }
    const activeDiscounts = discounts.filter((d) => d.amountCents > 0);
    const caps = netRefundableCaps(refundable, activeDiscounts);
    discountCents += sum(activeDiscounts.map((d) => d.amountCents));
    for (const line of refundable) {
      const item = items.find((i) => i.id === line.id)!;
      const entry = entryByItem.get(line.id) ?? null;
      const cap = caps.get(line.id) ?? 0;
      const allocs = allocByItem.get(line.id) ?? [];
      const refunded = sum(allocs.filter((a) => refundStatus.get(a.refundId) === "succeeded").map((a) => a.cents));
      const holding = sum(
        allocs
          .filter((a) => {
            const s = refundStatus.get(a.refundId);
            return s !== undefined && s !== "succeeded" && isCapHolding(s);
          })
          .map((a) => a.cents),
      );
      listPriceCents += line.grossCents;
      entryLines.push({
        orderId,
        orderItemId: line.id,
        kind: line.kind,
        label: entry?.display_name ?? item.description,
        entryId: entry?.id ?? null,
        entryStatus: entry?.status ?? null,
        grossCents: line.grossCents,
        discountShareCents: line.grossCents - cap,
        netCents: cap,
        refundedCents: refunded,
        pendingCents: holding,
        remainingRefundableCents: Math.max(0, cap - refunded - holding),
      });
    }
  }

  // ---- Headline and per-order breakdown -------------------------------------------------------------------------
  const netCents = grossReceivedCents - succeededCents;
  const perOrderMap = new Map<string, { orderId: string; receivedCents: number; refundedCents: number; netCents: number }>();
  const bucket = (orderId: string | null) => {
    const key = orderId ?? "unlinked";
    const row = perOrderMap.get(key) ?? { orderId: key, receivedCents: 0, refundedCents: 0, netCents: 0 };
    perOrderMap.set(key, row);
    return row;
  };
  for (const p of received) bucket(p.order_id).receivedCents += toCents(p.amount);
  for (const r of succeeded) bucket(r.orderId).refundedCents += r.cents;
  const perOrder = [...perOrderMap.values()]
    .map((row) => ({ ...row, netCents: row.receivedCents - row.refundedCents }))
    .sort((a, b) => (a.orderId < b.orderId ? -1 : 1));

  // ---- Reconciliation -------------------------------------------------------------------------------------------
  const checks: ReconciliationCheck[] = [];
  // 1. P&L total vs the raw sums (catches rows dropped or double counted while grouping).
  checks.push(
    check(
      "pnl_equals_payments_minus_refunds",
      "P&L net equals payments received minus succeeded refunds",
      grossReceivedCents - succeededCents,
      sum(perOrder.map((o) => o.netCents)),
      "Sum of the per-order rows must equal the headline built from raw event_payments and event_order_refunds.",
    ),
  );
  // 2. Ledger vs the denormalized event_payments.refund_amount (R2 recomputes it after every finalize).
  const paymentRefundCents = sum(input.payments.map((p) => toCents(p.refund_amount)));
  checks.push(
    check(
      "ledger_vs_payment_refund_amount",
      "Succeeded refund ledger equals event_payments.refund_amount",
      succeededCents,
      paymentRefundCents,
      "event_payments.refund_amount is the cumulative copy R2 keeps after each refund; a difference means a refund path bypassed the ledger.",
    ),
  );
  // 3. Every succeeded refund fully allocated to order lines.
  const unattributed = refundRows.filter((r) => r.unattributed);
  checks.push(
    check(
      "refunds_fully_attributed",
      "Every succeeded refund is allocated to order lines",
      succeededCents,
      succeededCents - sum(unattributed.map((r) => r.cents - r.attributedCents)),
      unattributed.length === 0
        ? "All succeeded refunds are attributed."
        : `${unattributed.length} succeeded refund(s) are not fully attributed (Stripe dashboard refunds awaiting attribution).`,
    ),
  );
  // 4. No order refunded beyond what it received.
  const over = perOrder.filter((o) => o.refundedCents > o.receivedCents);
  checks.push(
    check(
      "no_refund_exceeds_received",
      "No order is refunded more than it received",
      0,
      sum(over.map((o) => o.refundedCents - o.receivedCents)),
      over.length === 0 ? "No order is over-refunded." : `${over.length} order(s) are refunded more than their payments received.`,
    ),
  );
  // 5. Payments not linked to an order of this event.
  const unlinked = received.filter((p) => !p.order_id || !orderIds.has(p.order_id));
  checks.push(
    check(
      "payments_linked_to_orders",
      "Every payment received belongs to a competition order of this event",
      0,
      sum(unlinked.map((p) => toCents(p.amount))),
      unlinked.length === 0 ? "All payments are linked." : `${unlinked.length} payment(s) are not linked to a competition order.`,
    ),
  );
  // 6. Accounting tie-out (active entries only). Not checked when the entries could not be read.
  if (input.accounting === null) {
    checks.push(check("accounting_tie_out", "Accounting entries match payments and refunds", null, null, "Accounting entries could not be read."));
  } else {
    const active = input.accounting.filter((e) => (e.entry_status ?? "active") === "active");
    const revenue = sum(active.filter((e) => e.category === "competition_entry_revenue").map((e) => toCents(e.gross_amount)));
    const refundNet = sum(
      active
        .filter((e) => e.category === "competition_entry_refund")
        .map((e) => (e.direction === "credit" ? -toCents(e.refund_amount) : toCents(e.refund_amount))),
    );
    checks.push(
      check(
        "accounting_revenue_equals_payments",
        "Accounting competition revenue equals payments received",
        grossReceivedCents,
        revenue,
        "Gross competition_entry_revenue entries versus event_payments received.",
      ),
    );
    checks.push(
      check(
        "accounting_refunds_equal_ledger",
        "Accounting refund entries (net of reversals) equal succeeded refunds",
        succeededCents,
        refundNet,
        "competition_entry_refund debits minus reversal credits versus the succeeded ledger.",
      ),
    );
  }

  return {
    currency,
    orders: input.orders.length,
    revenue: {
      paymentCount: received.length,
      grossReceivedCents,
      onlineCents: grossReceivedCents - deskCents,
      deskCents,
      ignoredPendingOrFailedCount: input.payments.length - received.length,
    },
    fees: {
      processingCents,
      applicationCents,
      platformFeeRetainedCents,
      totalCents: processingCents + applicationCents + platformFeeRetainedCents,
    },
    lines: { listPriceCents, discountCents, netChargeableCents: listPriceCents - discountCents },
    refunds: {
      succeededCents,
      succeededCount: succeeded.length,
      byDate: [...byDateMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      pendingHoldingCapCents: sum(pending.map((r) => r.cents)),
      pendingCount: pending.length,
      reversedCount: refundRows.filter((r) => r.reversed).length,
      unattributedCount: unattributed.length,
      rows: refundRows,
    },
    netCents,
    netAfterFeesCents: netCents - (processingCents + applicationCents + platformFeeRetainedCents),
    entryLines,
    perOrder,
    reconciliation: { ok: checks.every((c) => c.status !== "mismatch"), checks },
  };
}
