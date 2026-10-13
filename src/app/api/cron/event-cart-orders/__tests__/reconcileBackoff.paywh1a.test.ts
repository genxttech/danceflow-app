import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAY-WH-1A L-1 -- the reconcile sweeper records every order's outcome so an order that cannot be reconciled backs off
 * (and is escalated by the database after repeated failures) instead of being re-listed every run; payment-exception
 * alerts are drained on every run. The database side is covered by sql-tests/test_T_paywh1a_remediation.sql.
 */

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let dueOrders: Array<{ order_id: string; state: string; retry_final_state?: string }> = [];

vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => null }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "list_event_cart_orders_due_for_reconcile") return { data: dueOrders, error: null };
      return { data: { outcome: "ok" }, error: null };
    },
  }),
}));
const releaseOutcomes = new Map<string, unknown>();
vi.mock("@/lib/events/cartSettlement", () => ({
  releaseEventCartOrder: vi.fn(async ({ orderId }: { orderId: string }) => {
    const outcome = releaseOutcomes.get(orderId);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }),
  reconcileProcessingEventCartOrder: vi.fn(async () => []),
}));
vi.mock("@/lib/events/settlementOutbox", () => ({ drainEventSettlementOutbox: vi.fn(async () => ({ claimed: 0, done: 0, failed: 0 })) }));
const drainAlerts = vi.fn(async () => ({ claimed: 2, sent: 2, failed: 0 }));
vi.mock("@/lib/events/settlementAlerts", () => ({ drainSettlementExceptionAlerts: (...args: unknown[]) => drainAlerts(...(args as [])) }));

import { GET } from "@/app/api/cron/event-cart-orders/route";

const notes = () => rpcCalls.filter((call) => call.fn === "note_event_cart_reconcile_outcome").map((call) => call.args);

beforeEach(() => {
  rpcCalls.length = 0;
  releaseOutcomes.clear();
  drainAlerts.mockClear();
});

describe("event cart reconcile sweeper", () => {
  it("records a resolved order as ok and an unresolved / failing one as a failure (backoff), and drains staff alerts", async () => {
    dueOrders = [
      { order_id: "o-released", state: "pending" },
      { order_id: "o-retry", state: "releasing", retry_final_state: "expired" },
      { order_id: "o-throws", state: "pending" },
      { order_id: "o-processing", state: "processing" },
    ];
    releaseOutcomes.set("o-released", { outcome: "released" });
    releaseOutcomes.set("o-retry", { outcome: "retry" });
    releaseOutcomes.set("o-throws", new Error("stripe timeout"));
    const response = await GET(new Request("http://localhost/api/cron/event-cart-orders"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(notes()).toEqual([
      { p_order_id: "o-released", p_ok: true, p_error: null },
      { p_order_id: "o-retry", p_ok: false, p_error: "retry" },
      { p_order_id: "o-throws", p_ok: false, p_error: "stripe timeout" },
      { p_order_id: "o-processing", p_ok: false, p_error: "processing_unresolved" },
    ]);
    expect(drainAlerts).toHaveBeenCalledTimes(1);
    expect(body.alerts).toEqual({ claimed: 2, sent: 2, failed: 0 });
  });

  it("an alert-drain failure never fails the sweep (alerts stay queued for the next run)", async () => {
    dueOrders = [];
    drainAlerts.mockRejectedValueOnce(new Error("db unavailable"));
    const response = await GET(new Request("http://localhost/api/cron/event-cart-orders"));
    expect(response.status).toBe(200);
  });
});
