import { describe, expect, it } from "vitest";
import { buildCompetitionPnl, type PnlInput } from "../pnl";
import { buildCloseoutChecklist, type ChecklistInput } from "../checklist";
import { closeoutCsv, dollars } from "../pnlCsv";
import { loadCompetitionCloseout, type CloseoutClient } from "../load";

const EVENT = "11111111-1111-4111-8111-111111111111";
const STUDIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_A = "0a000000-0000-4000-8000-00000000000a";
const ORDER_B = "0b000000-0000-4000-8000-00000000000b";
const [I_E1, I_E2, I_FEE, I_DISC, I_E3] = ["i1", "i2", "i3", "i4", "i5"].map((k) => `${k}000000-0000-4000-8000-000000000000`);

/**
 * Order A: E1 $60 + E2 $40 + fee $10 = $110.00, unscoped discount $11.00 -> charged $99.00.
 *   Discount shares (R2 rule, largest remainder): E1 6.00, E2 4.00, fee 1.00 -> nets 54 / 36 / 9.
 * Order B: E3 $10.00 paid at the desk.
 */
function base(): PnlInput {
  return {
    orders: [
      { id: ORDER_A, payment_status: "partially_refunded", total_amount: 99, currency: "USD" },
      { id: ORDER_B, payment_status: "paid", total_amount: 10, currency: "USD" },
    ],
    items: [
      { id: I_E1, order_id: ORDER_A, item_type: "competition_entry", description: "E1", total_price: 60, metadata: {} },
      { id: I_E2, order_id: ORDER_A, item_type: "competition_entry", description: "E2", total_price: 40, metadata: {} },
      { id: I_FEE, order_id: ORDER_A, item_type: "add_on", description: "Service fee", total_price: 10, metadata: { line_type: "fee" } },
      { id: I_DISC, order_id: ORDER_A, item_type: "add_on", description: "10% off", total_price: 0, metadata: { line_type: "discount", discount_amount: 11 } },
      { id: I_E3, order_id: ORDER_B, item_type: "competition_entry", description: "E3", total_price: 10, metadata: {} },
    ],
    entries: [
      { id: "e1", order_item_id: I_E1, display_name: "Ana & Ben", status: "withdrawn", sort_order: 1, program_id: "p", division_id: "d" },
      { id: "e2", order_item_id: I_E2, display_name: "Cy & Di", status: "confirmed", sort_order: 2, program_id: "p", division_id: "d" },
      { id: "e3", order_item_id: I_E3, display_name: "Ed & Flo", status: "confirmed", sort_order: 3, program_id: "p", division_id: "d" },
    ],
    payments: [
      { id: "pay1", order_id: ORDER_A, amount: 99, status: "paid", source: "stripe", payment_method: "card", refund_amount: 34, stripe_processing_fee_amount: 3.17, stripe_application_fee_amount: 0, platform_fee_amount: 1, created_at: "2026-10-01T10:00:00Z" },
      { id: "pay2", order_id: ORDER_B, amount: 10, status: "paid", source: "competition_checkin", payment_method: "cash", refund_amount: null, stripe_processing_fee_amount: 0, stripe_application_fee_amount: 0, platform_fee_amount: 0, created_at: "2026-10-12T10:00:00Z" },
    ],
    refunds: [
      // partial refund of E1 (net 54 -> 20 refunded)
      { id: "r1", order_id: ORDER_A, amount_cents: 2000, status: "succeeded", source: "staff", stripe_refund_id: "re_1", reason: "partial", succeeded_at: "2026-10-10T15:00:00Z", reversed_at: null, created_at: "2026-10-10T14:00:00Z" },
      // fee refund (net fee 9.00)
      { id: "r2", order_id: ORDER_A, amount_cents: 900, status: "succeeded", source: "staff", stripe_refund_id: "re_2", reason: "fee", succeeded_at: "2026-10-11T15:00:00Z", reversed_at: null, created_at: "2026-10-11T14:00:00Z" },
      // Stripe dashboard refund, no allocations yet
      { id: "r3", order_id: ORDER_A, amount_cents: 500, status: "succeeded", source: "stripe_dashboard", stripe_refund_id: "re_3", reason: null, succeeded_at: "2026-10-11T18:00:00Z", reversed_at: null, created_at: "2026-10-11T18:00:00Z" },
      // pending refund on E2: holds cap, not money
      { id: "r4", order_id: ORDER_A, amount_cents: 1000, status: "pending", source: "staff", stripe_refund_id: "re_4", reason: "pending", succeeded_at: null, reversed_at: null, created_at: "2026-10-12T09:00:00Z" },
      // reversal: succeeded then failed -> no longer money
      { id: "r5", order_id: ORDER_A, amount_cents: 700, status: "failed", source: "staff", stripe_refund_id: "re_5", reason: "reversed", succeeded_at: "2026-10-09T09:00:00Z", reversed_at: "2026-10-09T12:00:00Z", created_at: "2026-10-09T08:00:00Z" },
    ],
    allocations: [
      { refund_id: "r1", order_item_id: I_E1, entry_id: "e1", line_kind: "entry", amount_cents: 2000 },
      { refund_id: "r2", order_item_id: I_FEE, entry_id: null, line_kind: "fee", amount_cents: 900 },
      { refund_id: "r4", order_item_id: I_E2, entry_id: "e2", line_kind: "entry", amount_cents: 1000 },
      { refund_id: "r5", order_item_id: I_E2, entry_id: "e2", line_kind: "entry", amount_cents: 700 },
    ],
    accounting: [
      { category: "competition_entry_revenue", direction: "credit", gross_amount: 99, refund_amount: 0, entry_status: "active" },
      { category: "competition_entry_revenue", direction: "credit", gross_amount: 10, refund_amount: 0, entry_status: "active" },
      { category: "competition_entry_refund", direction: "debit", gross_amount: 0, refund_amount: 20, entry_status: "active" },
      { category: "competition_entry_refund", direction: "debit", gross_amount: 0, refund_amount: 9, entry_status: "active" },
      { category: "competition_entry_refund", direction: "debit", gross_amount: 0, refund_amount: 5, entry_status: "active" },
      { category: "competition_entry_refund", direction: "debit", gross_amount: 0, refund_amount: 7, entry_status: "active" },
      { category: "competition_entry_refund", direction: "credit", gross_amount: 0, refund_amount: 7, entry_status: "active" },
    ],
  };
}

describe("competition P&L", () => {
  it("traces headline figures to source rows", () => {
    const pnl = buildCompetitionPnl(base());
    expect(pnl.revenue.grossReceivedCents).toBe(10900);
    expect(pnl.revenue.deskCents).toBe(1000);
    expect(pnl.revenue.onlineCents).toBe(9900);
    expect(pnl.fees).toMatchObject({ processingCents: 317, applicationCents: 0, platformFeeRetainedCents: 100, totalCents: 417 });
    expect(pnl.refunds.succeededCents).toBe(3400); // 20 + 9 + 5; the reversed 7.00 is not money
    expect(pnl.netCents).toBe(7500);
    expect(pnl.netAfterFeesCents).toBe(7500 - 417);
  });

  it("dates succeeded refunds and keeps pending apart from money", () => {
    const pnl = buildCompetitionPnl(base());
    expect(pnl.refunds.byDate).toEqual([
      { date: "2026-10-10", cents: 2000, count: 1 },
      { date: "2026-10-11", cents: 1400, count: 2 },
    ]);
    expect(pnl.refunds.pendingHoldingCapCents).toBe(1000);
    expect(pnl.refunds.pendingCount).toBe(1);
    expect(pnl.refunds.reversedCount).toBe(1);
    expect(pnl.netCents).toBe(10900 - 3400); // pending 10.00 is not subtracted
  });

  it("splits a discount over lines (partial and fee refunds, per-line net)", () => {
    const pnl = buildCompetitionPnl(base());
    const line = (id: string) => pnl.entryLines.find((l) => l.orderItemId === id)!;
    expect(pnl.lines).toEqual({ listPriceCents: 12000, discountCents: 1100, netChargeableCents: 10900 });
    expect([line(I_E1).netCents, line(I_E2).netCents, line(I_FEE).netCents, line(I_E3).netCents]).toEqual([5400, 3600, 900, 1000]);
    expect(pnl.entryLines.reduce((s, l) => s + l.discountShareCents, 0)).toBe(1100);
    expect(line(I_E1)).toMatchObject({ refundedCents: 2000, pendingCents: 0, remainingRefundableCents: 3400 });
    expect(line(I_FEE)).toMatchObject({ refundedCents: 900, remainingRefundableCents: 0 });
    expect(line(I_E2)).toMatchObject({ refundedCents: 0, pendingCents: 1000, remainingRefundableCents: 2600 });
  });

  it("flags a dashboard refund that is not attributed, and only that", () => {
    const pnl = buildCompetitionPnl(base());
    expect(pnl.refunds.unattributedCount).toBe(1);
    const failing = pnl.reconciliation.checks.filter((c) => c.status === "mismatch").map((c) => c.key);
    expect(failing).toEqual(["refunds_fully_attributed"]);
    expect(pnl.reconciliation.ok).toBe(false);
  });

  it("reconciles fully once the dashboard refund is attributed", () => {
    const input = base();
    input.allocations.push({ refund_id: "r3", order_item_id: I_E1, entry_id: "e1", line_kind: "entry", amount_cents: 500 });
    const pnl = buildCompetitionPnl(input);
    expect(pnl.reconciliation.checks.map((c) => c.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(pnl.reconciliation.ok).toBe(true);
  });

  it("flags payment.refund_amount drift and accounting drift", () => {
    const input = base();
    input.allocations.push({ refund_id: "r3", order_item_id: I_E1, entry_id: "e1", line_kind: "entry", amount_cents: 500 });
    input.payments[0].refund_amount = 30;
    input.accounting = input.accounting!.slice(0, 5); // reversal pair missing is fine, but drop the 5.00 debit too
    input.accounting = input.accounting.filter((e) => e.refund_amount !== 5);
    const failing = buildCompetitionPnl(input).reconciliation.checks.filter((c) => c.status === "mismatch").map((c) => c.key);
    expect(failing).toEqual(["ledger_vs_payment_refund_amount", "accounting_refunds_equal_ledger"]);
  });

  it("marks the accounting tie-out not checked when entries are unreadable", () => {
    const input = base();
    input.accounting = null;
    const check = buildCompetitionPnl(input).reconciliation.checks.find((c) => c.key === "accounting_tie_out")!;
    expect(check.status).toBe("not_checked");
  });

  it("flags an over-refunded order", () => {
    const input = base();
    input.refunds[0].amount_cents = 20000;
    const keys = buildCompetitionPnl(input).reconciliation.checks.filter((c) => c.status === "mismatch").map((c) => c.key);
    expect(keys).toContain("no_refund_exceeds_received");
  });

  it("ignores pending and failed payments as money", () => {
    const input = base();
    input.payments.push({ ...input.payments[0], id: "pay3", status: "pending", amount: 500, refund_amount: null });
    input.payments.push({ ...input.payments[0], id: "pay4", status: "failed", amount: 700, refund_amount: null });
    const pnl = buildCompetitionPnl(input);
    expect(pnl.revenue.grossReceivedCents).toBe(10900);
    expect(pnl.revenue.ignoredPendingOrFailedCount).toBe(2);
  });

  it("keeps a fully refunded payment at gross (refund is a separate dated line)", () => {
    const input = base();
    input.payments[1].status = "refunded";
    const pnl = buildCompetitionPnl(input);
    expect(pnl.revenue.grossReceivedCents).toBe(10900);
  });

  it("reports an order whose discount cannot be split instead of crashing", () => {
    const input = base();
    input.items[3].metadata = { line_type: "discount", discount_amount: 500 }; // larger than every line it prices
    const pnl = buildCompetitionPnl(input);
    const check = pnl.reconciliation.checks.find((c) => c.key === "order_lines_priced")!;
    expect(check.status).toBe("mismatch");
    expect(pnl.reconciliation.ok).toBe(false);
  });

  it("handles an event with no orders", () => {
    const pnl = buildCompetitionPnl({ orders: [], items: [], entries: [], payments: [], refunds: [], allocations: [], accounting: [] });
    expect(pnl.netCents).toBe(0);
    expect(pnl.reconciliation.ok).toBe(true);
  });
});

describe("CSV export", () => {
  it("formats money as plain decimals and neutralizes formulas in text cells", () => {
    expect(dollars(-1250)).toBe("-12.50");
    expect(dollars(5)).toBe("0.05");
    const input = base();
    input.entries[0].display_name = "=HYPERLINK(\"http://x\")";
    input.items[0].description = "+SUM(1)";
    const lines = closeoutCsv("lines", buildCompetitionPnl(input));
    expect(lines).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(lines).not.toMatch(/(^|,)=HYPERLINK/m);
    const summary = closeoutCsv("pnl", buildCompetitionPnl(input));
    expect(summary).toContain("refunds_succeeded,Total succeeded refunds,-34.00,3,event_order_refunds");
    expect(summary).toContain("refunds_pending,Pending refunds holding cap (NOT money returned),10.00,1");
    expect(summary).toContain("net,Net after refunds,75.00");
    const refunds = closeoutCsv("refunds", buildCompetitionPnl(input));
    expect(refunds).toContain(`r3,${ORDER_A},2026-10-11,5.00,succeeded,yes,stripe_dashboard,re_3,no,no,`);
    expect(refunds).toContain(`r4,${ORDER_A},,10.00,pending,no,staff,re_4,yes,no,pending`);
  });
});

describe("closeout checklist", () => {
  function checklist(patch: Partial<ChecklistInput> = {}) {
    const input = base();
    input.allocations.push({ refund_id: "r3", order_item_id: I_E1, entry_id: "e1", line_kind: "entry", amount_cents: 500 });
    input.refunds[3].status = "succeeded"; // nothing pending by default
    input.refunds[3].succeeded_at = "2026-10-12T10:00:00Z";
    const pnl = buildCompetitionPnl(input);
    return buildCloseoutChecklist({
      eventId: EVENT,
      exceptions: [],
      scopes: [],
      scratches: [],
      deskBalanceHelperAvailable: false,
      deskBalanceOrdersUnpaid: 0,
      settlementStatus: "settled",
      pnl,
      ...patch,
    });
  }
  const status = (items: ReturnType<typeof checklist>, key: string) => items.find((i) => i.key === key)!.status;

  it("passes what is clean and never claims what is not built", () => {
    const items = checklist();
    expect(status(items, "refund_exceptions")).toBe("PASS");
    expect(status(items, "settlement_exceptions")).toBe("PASS");
    expect(status(items, "pending_refunds")).toBe("PASS");
    expect(status(items, "scratch_refunds")).toBe("PASS");
    expect(status(items, "desk_balances")).toBe("NOT AVAILABLE YET");
    expect(status(items, "rounds_published")).toBe("NOT AVAILABLE YET");
    expect(status(items, "event_settlement")).toBe("PASS");
  });

  it("blocks on open exceptions, scopes, pending refunds and unattributed refunds", () => {
    const items = checklist({
      exceptions: [
        { id: "x1", kind: "competition_refund_entry_locked_heat", status: "open", order_id: ORDER_A, event_id: EVENT },
        { id: "x2", kind: "event_order_paid_after_cancel", status: "open", order_id: ORDER_A, event_id: EVENT },
        { id: "x3", kind: "competition_refund_entry_certified_heat", status: "resolved", order_id: ORDER_A, event_id: EVENT },
      ],
      scopes: [{ id: "s1", kind: "competition_refund_entry_locked_heat", resolved_at: null }],
    });
    expect(status(items, "refund_exceptions")).toBe("BLOCKED");
    expect(status(items, "settlement_exceptions")).toBe("BLOCKED");
    expect(items.find((i) => i.key === "settlement_exceptions")!.count).toBe(1);
  });

  it("blocks on pending and unattributed refunds from the P&L", () => {
    const pnl = buildCompetitionPnl(base());
    const items = buildCloseoutChecklist({ eventId: EVENT, exceptions: [], scopes: [], scratches: [], deskBalanceHelperAvailable: false, deskBalanceOrdersUnpaid: 0, settlementStatus: "open", pnl });
    expect(status(items, "pending_refunds")).toBe("BLOCKED");
    expect(status(items, "unattributed_refunds")).toBe("BLOCKED");
    expect(status(items, "reconciliation")).toBe("BLOCKED");
    expect(status(items, "event_settlement")).toBe("BLOCKED");
  });

  it("blocks a scratch that chose refund and was not refunded; passes once refunded", () => {
    const owing = checklist({ scratches: [{ entry_id: "e2", requested_resolution: "refund", performed_at: "2026-10-12T00:00:00Z" }] });
    expect(status(owing, "scratch_refunds")).toBe("BLOCKED");
    const noRefund = checklist({ scratches: [{ entry_id: "e2", requested_resolution: "no_refund", performed_at: "2026-10-12T00:00:00Z" }] });
    expect(status(noRefund, "scratch_refunds")).toBe("PASS");
  });

  it("does not pass a refund-scratch that cannot be matched to an order line", () => {
    expect(status(checklist({ scratches: [{ entry_id: "unknown-entry", requested_resolution: "refund", performed_at: "2026-10-12T00:00:00Z" }] }), "scratch_refunds")).toBe("BLOCKED");
  });

  it("gives no reconciliation verdict when accounting could not be read", () => {
    const input = base();
    input.accounting = null;
    input.allocations.push({ refund_id: "r3", order_item_id: I_E1, entry_id: "e1", line_kind: "entry", amount_cents: 500 });
    const items = buildCloseoutChecklist({ eventId: EVENT, exceptions: [], scopes: [], scratches: [], deskBalanceHelperAvailable: false, deskBalanceOrdersUnpaid: 0, settlementStatus: "settled", pnl: buildCompetitionPnl(input) });
    expect(status(items, "reconciliation")).toBe("NOT AVAILABLE YET");
  });

  it("reports scratches as not available when the table is missing", () => {
    expect(status(checklist({ scratches: null }), "scratch_refunds")).toBe("NOT AVAILABLE YET");
  });

  it("gives the desk balance verdict only when the helper exists", () => {
    expect(status(checklist({ deskBalanceHelperAvailable: true, deskBalanceOrdersUnpaid: 2 }), "desk_balances")).toBe("BLOCKED");
    expect(status(checklist({ deskBalanceHelperAvailable: true, deskBalanceOrdersUnpaid: 0 }), "desk_balances")).toBe("PASS");
  });
});

/** A client that ignores every filter and returns all rows: the loader must still isolate by event and studio. */
function leakyClient(tables: Record<string, unknown[]>): CloseoutClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      const rows = tables[table];
      const result = rows === undefined ? { data: null, error: { message: "relation does not exist", code: "42P01" } } : { data: rows, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "range", "limit"]) {
        chain[m] = () => {
          calls.push(`${table}.${m}`);
          return chain;
        };
      }
      chain.maybeSingle = () => Promise.resolve({ data: Array.isArray(rows) ? (rows[0] ?? null) : null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return chain;
    },
  };
}

describe("loader isolation", () => {
  const OTHER_EVENT = "22222222-2222-4222-8222-222222222222";
  const OTHER_STUDIO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const OTHER_ORDER = "0c000000-0000-4000-8000-00000000000c";

  it("never counts another event's or studio's money, and only issues selects", async () => {
    const client = leakyClient({
      event_order_items: [
        { id: "x1", order_id: ORDER_A, event_id: EVENT, item_type: "competition_entry", description: "mine", total_price: 50, metadata: {} },
        { id: "x2", order_id: OTHER_ORDER, event_id: OTHER_EVENT, item_type: "competition_entry", description: "theirs", total_price: 900, metadata: {} },
      ],
      event_orders: [
        { id: ORDER_A, event_id: EVENT, studio_id: STUDIO, payment_status: "paid", total_amount: 50, currency: "USD" },
        { id: OTHER_ORDER, event_id: OTHER_EVENT, studio_id: OTHER_STUDIO, payment_status: "paid", total_amount: 900, currency: "USD" },
      ],
      event_competition_entries: [],
      event_registrations: [
        { id: "reg1", order_id: ORDER_A, event_id: EVENT },
        { id: "reg2", order_id: OTHER_ORDER, event_id: OTHER_EVENT },
      ],
      event_payments: [
        { id: "p1", registration_id: "reg1", amount: 50, status: "paid", source: "stripe", payment_method: "card", refund_amount: 0, stripe_processing_fee_amount: 0, stripe_application_fee_amount: 0, platform_fee_amount: 0, created_at: "2026-10-01T00:00:00Z" },
        { id: "p2", registration_id: "reg2", amount: 900, status: "paid", source: "stripe", payment_method: "card", refund_amount: 0, stripe_processing_fee_amount: 0, stripe_application_fee_amount: 0, platform_fee_amount: 0, created_at: "2026-10-01T00:00:00Z" },
        { id: "p3", registration_id: "reg-unknown", amount: 77, status: "paid", source: "stripe", payment_method: "card", refund_amount: 0, stripe_processing_fee_amount: 0, stripe_application_fee_amount: 0, platform_fee_amount: 0, created_at: "2026-10-01T00:00:00Z" },
      ],
      event_order_refunds: [
        { id: "rf1", event_id: OTHER_EVENT, order_id: OTHER_ORDER, amount_cents: 12345, status: "succeeded", source: "staff", stripe_refund_id: "re_x", reason: null, succeeded_at: "2026-10-02T00:00:00Z", reversed_at: null, created_at: "2026-10-02T00:00:00Z" },
        { id: "rf2", event_id: EVENT, order_id: OTHER_ORDER, amount_cents: 999, status: "succeeded", source: "staff", stripe_refund_id: "re_y", reason: null, succeeded_at: "2026-10-02T00:00:00Z", reversed_at: null, created_at: "2026-10-02T00:00:00Z" },
      ],
      event_order_refund_allocations: [],
      accounting_entries: [
        { event_id: OTHER_EVENT, category: "competition_entry_revenue", direction: "credit", gross_amount: 900, refund_amount: 0, entry_status: "active" },
      ],
      event_order_settlement_exceptions: [
        { id: "ex1", kind: "competition_refund_unattributed", status: "open", order_id: OTHER_ORDER, event_id: OTHER_EVENT },
        { id: "ex2", kind: "event_order_paid_after_cancel", status: "open", order_id: null, event_id: OTHER_EVENT },
      ],
      event_competition_refund_exception_scopes: [{ id: "sc1", event_id: OTHER_EVENT, kind: "competition_refund_entry_locked_heat", resolved_at: null }],
      event_settlements: [{ status: "settled", event_id: OTHER_EVENT }],
    });
    const data = await loadCompetitionCloseout(client, { id: EVENT, studio_id: STUDIO });
    expect(data.pnl.revenue.grossReceivedCents).toBe(5000);
    expect(data.pnl.refunds.succeededCents).toBe(0);
    expect(data.pnl.orders).toBe(1);
    expect(data.pnl.reconciliation.checks.find((c) => c.key === "accounting_revenue_equals_payments")!.actualCents).toBe(0);
    const byKey = Object.fromEntries(data.checklist.map((i) => [i.key, i.status]));
    expect(byKey.refund_exceptions).toBe("PASS");
    expect(byKey.settlement_exceptions).toBe("PASS");
    expect(byKey.event_settlement).toBe("BLOCKED"); // other event's settled row is not ours
    expect(byKey.scratch_refunds).toBe("NOT AVAILABLE YET"); // table absent in the fake
    const writes = client.calls.filter((c) => /\.(insert|update|upsert|delete|rpc)$/.test(c));
    expect(writes).toEqual([]);
  });
});
