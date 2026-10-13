import { NextResponse } from "next/server";
import { getCronAuthFailure } from "@/lib/security/cron";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/payments/stripe";
import { reconcileProcessingEventCartOrder, releaseEventCartOrder } from "@/lib/events/cartSettlement";
import { drainEventSettlementOutbox } from "@/lib/events/settlementOutbox";

export const dynamic = "force-dynamic";

/**
 * PAY-WH-1 reconcile sweeper for ordinary event cart orders:
 *   - pending orders whose capacity hold expired -> two-phase release ('expired') after Stripe is reconciled;
 *   - releases left in 'releasing' (worker interrupted / Stripe unreachable) -> retried;
 *   - delayed payments whose processing hold lapsed -> read back from Stripe (settle / fail / keep processing);
 *   - the settlement outbox -> due effects (including ones whose worker was interrupted) are drained.
 */
export async function GET(request: Request) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  const admin = createAdminClient();
  let stripe = null;
  try {
    stripe = getStripe();
  } catch {
    stripe = null;
  }

  const summary = { due: 0, outcomes: {} as Record<string, number>, errors: 0, outbox: { claimed: 0, done: 0, failed: 0 } };
  const count = (outcome: string) => {
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
  };

  try {
    const { data, error } = await admin.rpc("list_event_cart_orders_due_for_reconcile", { p_limit: 50 });
    if (error) throw new Error(error.message);
    const due = (data ?? []) as Array<{ order_id: string; state: string; retry_final_state?: string | null }>;
    summary.due = due.length;

    for (const order of due) {
      try {
        if (order.state === "processing") {
          if (!stripe) {
            count("stripe_unavailable");
            continue;
          }
          const results = await reconcileProcessingEventCartOrder({ admin, stripe, orderId: order.order_id });
          for (const result of results) count(result.outcome);
          if (results.length === 0) count("processing_unresolved");
        } else {
          const result = await releaseEventCartOrder({
            admin,
            stripe,
            orderId: order.order_id,
            reason: order.state === "releasing" ? "release_retry" : "hold_expired",
            // A stalled release keeps its own outcome (expiry vs cancellation), as reported by the database.
            finalState: order.state === "releasing" ? (order.retry_final_state === "expired" ? "expired" : "released") : "expired",
          });
          count(result.outcome);
        }
      } catch (orderError) {
        summary.errors += 1;
        console.error("event cart reconcile failed for an order", orderError instanceof Error ? orderError.message : orderError);
      }
    }

    summary.outbox = await drainEventSettlementOutbox({ admin, stripe, limit: 50 });
    return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Event cart reconcile cron failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Event cart reconcile failed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
