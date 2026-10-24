import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCompetitionCloseout, type CloseoutClient } from "../load";

/**
 * Rows captured by src/lib/competition/closeout/sql/test_c1_closeout_reads.sql from the AUTHENTICATED owner's own
 * RLS view on a local Postgres (main schema + R2 + SC1), after real request/observe RPC calls. The figures asserted
 * here are the ones that SQL file computes in plain SQL, so the TypeScript read model and the database agree.
 */
type Snapshot = Record<string, unknown> & { eventId: string; studioId: string };
const load = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim()) as Snapshot;
const A = load("c1read-snapshot-a.json");
const B = load("c1read-snapshot-b.json");

const TABLES: Record<string, string> = {
  event_order_items: "items",
  event_orders: "orders",
  event_competition_entries: "entries",
  event_registrations: "registrations",
  event_payments: "payments",
  event_order_refunds: "refunds",
  event_order_refund_allocations: "allocations",
  accounting_entries: "accounting",
  event_order_settlement_exceptions: "exceptions",
  event_competition_refund_exception_scopes: "scopes",
  event_competition_scratches: "scratches",
};

/** Serves the union of the given snapshots to every query, ignoring filters (worst case: no RLS, no .eq). */
function client(...snaps: Snapshot[]): CloseoutClient {
  return {
    from(table: string) {
      const key = TABLES[table];
      const rows = key ? snaps.flatMap((s) => (s[key] as unknown[]) ?? []) : table === "event_settlements" ? [] : undefined;
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "range", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows ?? null, error: rows ? null : { message: "missing", code: "42P01" } });
      return chain;
    },
  };
}

describe("read model against rows captured from local Postgres", () => {
  it("event A: figures equal the plain-SQL expectations", async () => {
    const data = await loadCompetitionCloseout(client(A), { id: A.eventId, studio_id: A.studioId });
    const { pnl } = data;
    expect(pnl.revenue).toMatchObject({ grossReceivedCents: 10900, onlineCents: 9900, deskCents: 1000 });
    expect(pnl.refunds.succeededCents).toBe(3400);
    expect(pnl.refunds.pendingHoldingCapCents).toBe(1000);
    expect(pnl.refunds.pendingCount).toBe(1);
    expect(pnl.refunds.reversedCount).toBe(1);
    expect(pnl.refunds.unattributedCount).toBe(1);
    expect(pnl.netCents).toBe(7500);
    expect(pnl.fees).toMatchObject({ processingCents: 317, platformFeeRetainedCents: 100 });
    expect(pnl.lines).toEqual({ listPriceCents: 12000, discountCents: 1100, netChargeableCents: 10900 });
    const nets = Object.fromEntries(pnl.entryLines.map((l) => [l.label, l.netCents]));
    expect(nets).toMatchObject({ "Ana & Ben": 5400, "Cy & Di": 3600, "Registration fee": 900 });
    const byCheck = Object.fromEntries(pnl.reconciliation.checks.map((c) => [c.key, c.status]));
    expect(byCheck).toMatchObject({
      pnl_equals_payments_minus_refunds: "ok",
      ledger_vs_payment_refund_amount: "ok", // 34.00 on event_payments.refund_amount = succeeded ledger
      accounting_revenue_equals_payments: "ok",
      accounting_refunds_equal_ledger: "ok", // the reversed 7.00 nets to zero
      refunds_fully_attributed: "mismatch", // the dashboard refund
    });
  });

  it("event A: checklist reflects the open exceptions, pending and unattributed refunds", async () => {
    const { checklist } = await loadCompetitionCloseout(client(A), { id: A.eventId, studio_id: A.studioId });
    const status = Object.fromEntries(checklist.map((i) => [i.key, i.status]));
    expect(status).toMatchObject({
      refund_exceptions: "BLOCKED", // competition_refund_reversed is open
      unattributed_refunds: "BLOCKED",
      pending_refunds: "BLOCKED",
      scratch_refunds: "PASS",
      desk_balances: "NOT AVAILABLE YET",
      rounds_published: "NOT AVAILABLE YET",
      event_settlement: "BLOCKED",
    });
  });

  it("event B: its own money only", async () => {
    const { pnl } = (await loadCompetitionCloseout(client(B), { id: B.eventId, studio_id: B.studioId }));
    expect(pnl.revenue.grossReceivedCents).toBe(20000);
    expect(pnl.refunds.succeededCents).toBe(5000);
    expect(pnl.netCents).toBe(15000);
  });

  it("two tenants: serving both tenants' rows to either loader never mixes them", async () => {
    const both = client(A, B);
    const a = await loadCompetitionCloseout(both, { id: A.eventId, studio_id: A.studioId });
    const b = await loadCompetitionCloseout(both, { id: B.eventId, studio_id: B.studioId });
    expect(a.pnl.netCents).toBe(7500);
    expect(a.pnl.orders).toBe(2);
    expect(b.pnl.netCents).toBe(15000);
    expect(b.pnl.orders).toBe(1);
    expect(a.pnl.refunds.rows.map((r) => r.orderId)).not.toContain(b.pnl.refunds.rows[0].orderId);
    expect(JSON.stringify(a.pnl)).not.toContain(B.eventId);
    expect(JSON.stringify(b.pnl)).not.toContain(A.eventId);
    // a studio id that does not own the event sees nothing at all
    const wrongStudio = await loadCompetitionCloseout(both, { id: A.eventId, studio_id: B.studioId });
    expect(wrongStudio.pnl.orders).toBe(0);
    expect(wrongStudio.pnl.netCents).toBe(0);
  });
});
