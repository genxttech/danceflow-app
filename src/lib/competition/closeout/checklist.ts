import { toCents, type CompetitionPnl } from "./pnl";

/**
 * C1 closeout checklist (read only). Each item is PASS, BLOCKED or NOT AVAILABLE YET. There is no transition
 * here: nothing closes, locks, settles or posts money. Write transitions belong to migration slot 20270107 and
 * stay unauthorized.
 */

export type ChecklistStatus = "PASS" | "BLOCKED" | "NOT AVAILABLE YET";
export type ChecklistItem = {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
  count: number | null;
  /** Staff page that resolves the item, when one exists. */
  href?: string;
};

export type ChecklistException = {
  id: string;
  kind: string;
  status: string;
  order_id: string | null;
  event_id: string | null;
};
export type ChecklistScope = { id: string; kind: string; resolved_at: string | null };
export type ChecklistScratch = { entry_id: string; requested_resolution: string; performed_at: string };
export type ChecklistRound = { id: string; status: string };

export type ChecklistInput = {
  eventId: string;
  exceptions: ChecklistException[];
  scopes: ChecklistScope[];
  /** null = the SC1 scratch table does not exist in this database yet. */
  scratches: ChecklistScratch[] | null;
  /** Orders with a shortfall are informational until W2's desk balance helper exists. */
  deskBalanceHelperAvailable: boolean;
  deskBalanceOrdersUnpaid: number | null;
  settlementStatus: string | null;
  pnl: CompetitionPnl;
};

export const COMPETITION_REFUND_PREFIX = "competition_refund_";
export const UNATTRIBUTED_KIND = "competition_refund_unattributed";

const pass = (key: string, label: string, detail: string, count: number | null = 0, href?: string): ChecklistItem => ({ key, label, status: "PASS", detail, count, href });
const blocked = (key: string, label: string, detail: string, count: number | null, href?: string): ChecklistItem => ({ key, label, status: "BLOCKED", detail, count, href });
const later = (key: string, label: string, detail: string): ChecklistItem => ({ key, label, status: "NOT AVAILABLE YET", detail, count: null });

export function buildCloseoutChecklist(input: ChecklistInput): ChecklistItem[] {
  const open = input.exceptions.filter((e) => e.status === "open");
  const refundExceptions = open.filter((e) => e.kind.startsWith(COMPETITION_REFUND_PREFIX) && e.kind !== UNATTRIBUTED_KIND);
  const openScopes = input.scopes.filter((s) => s.resolved_at === null);
  const settlementExceptions = open.filter((e) => !e.kind.startsWith(COMPETITION_REFUND_PREFIX));
  const unattributedExceptions = open.filter((e) => e.kind === UNATTRIBUTED_KIND);
  const unattributedRefunds = input.pnl.refunds.rows.filter((r) => r.unattributed);
  const items: ChecklistItem[] = [];

  const refundCount = Math.max(refundExceptions.length, openScopes.length);
  items.push(
    refundCount === 0
      ? pass("refund_exceptions", "No open competition refund exceptions", "None open.")
      : blocked(
          "refund_exceptions",
          "No open competition refund exceptions",
          `${refundExceptions.length} open exception(s), ${openScopes.length} unresolved heat scope(s). Resolve them on each order's refund page.`,
          refundCount,
        ),
  );

  items.push(
    settlementExceptions.length === 0
      ? pass("settlement_exceptions", "No open payment settlement exceptions (PAY-WH-1A)", "None open.")
      : blocked(
          "settlement_exceptions",
          "No open payment settlement exceptions (PAY-WH-1A)",
          `${settlementExceptions.length} open settlement exception(s) for this event.`,
          settlementExceptions.length,
        ),
  );

  const unattributedCount = Math.max(unattributedExceptions.length, unattributedRefunds.length);
  items.push(
    unattributedCount === 0
      ? pass("unattributed_refunds", "No unattributed Stripe dashboard refunds", "Every succeeded refund is attributed to order lines.")
      : blocked(
          "unattributed_refunds",
          "No unattributed Stripe dashboard refunds",
          `${unattributedRefunds.length} succeeded refund(s) not fully attributed; ${unattributedExceptions.length} open attribution exception(s).`,
          unattributedCount,
        ),
  );

  items.push(
    input.pnl.refunds.pendingCount === 0
      ? pass("pending_refunds", "No pending Stripe refunds", "No refund is waiting on Stripe.")
      : blocked(
          "pending_refunds",
          "No pending Stripe refunds",
          `${input.pnl.refunds.pendingCount} refund(s) not yet succeeded or failed (they hold cap and are not counted as money returned).`,
          input.pnl.refunds.pendingCount,
        ),
  );

  if (!input.deskBalanceHelperAvailable) {
    items.push(
      later(
        "desk_balances",
        "No unpaid desk balances",
        `Depends on the desk balance helper (W2, src/lib/competition/checkinBalance.ts). Until then no verdict is given${
          input.deskBalanceOrdersUnpaid === null ? "" : `; informational only: ${input.deskBalanceOrdersUnpaid} order(s) show payments below the order total`
        }.`,
      ),
    );
  } else {
    items.push(
      (input.deskBalanceOrdersUnpaid ?? 0) === 0
        ? pass("desk_balances", "No unpaid desk balances", "All orders are settled at the desk.")
        : blocked("desk_balances", "No unpaid desk balances", `${input.deskBalanceOrdersUnpaid} order(s) have a balance due.`, input.deskBalanceOrdersUnpaid),
    );
  }

  if (input.scratches === null) {
    items.push(later("scratch_refunds", "Scratches resolved as refund have been refunded", "The scratch workflow (SC1) is not in this database yet."));
  } else {
    const latest = new Map<string, ChecklistScratch>();
    for (const s of [...input.scratches].sort((a, b) => (a.performed_at < b.performed_at ? -1 : 1))) latest.set(s.entry_id, s);
    const owed = [...latest.values()].filter((s) => {
      if (s.requested_resolution !== "refund") return false;
      const lines = input.pnl.entryLines.filter((l) => l.entryId === s.entry_id);
      if (lines.length === 0) return false;
      return lines.some((l) => l.netCents - l.refundedCents > 0);
    });
    items.push(
      owed.length === 0
        ? pass("scratch_refunds", "Scratches resolved as refund have been refunded", "No scratched entry is waiting on a refund.")
        : blocked(
            "scratch_refunds",
            "Scratches resolved as refund have been refunded",
            `${owed.length} scratched entr${owed.length === 1 ? "y" : "ies"} chose refund and still ${owed.length === 1 ? "has" : "have"} an unrefunded balance.`,
            owed.length,
          ),
    );
  }

  items.push(later("rounds_published", "Every round published and results certified", "Needs the results lifecycle and publication (F2/F3), which are not built yet."));

  items.push(
    input.pnl.reconciliation.ok
      ? pass("reconciliation", "Competition P&L reconciles", "Payments, refund ledger and accounting entries agree.")
      : blocked(
          "reconciliation",
          "Competition P&L reconciles",
          `${input.pnl.reconciliation.checks.filter((c) => c.status === "mismatch").length} reconciliation check(s) show a mismatch.`,
          input.pnl.reconciliation.checks.filter((c) => c.status === "mismatch").length,
        ),
  );

  const status = (input.settlementStatus ?? "none").toLowerCase();
  items.push(
    status === "settled" || status === "ready_to_settle"
      ? pass("event_settlement", "Event settlement", `Event settlement is ${status.replaceAll("_", " ")}.`, null)
      : blocked("event_settlement", "Event settlement", `Event settlement is ${status === "none" ? "not started" : status}; complete it on the settlement page after the items above.`, null, `/app/events/${input.eventId}/settlement`),
  );

  return items;
}

/** Orders whose payments received are below the order total (refunds ignored): informational, not a verdict. */
export function countOrdersBelowTotal(
  orders: { id: string; payment_status: string | null; total_amount: number | string | null }[],
  pnl: CompetitionPnl,
) {
  const received = new Map(pnl.perOrder.map((o) => [o.orderId, o.receivedCents]));
  return orders.filter(
    (o) => ["paid", "partially_refunded", "refunded", "partial"].includes(String(o.payment_status)) && (received.get(o.id) ?? 0) < toCents(o.total_amount),
  ).length;
}
