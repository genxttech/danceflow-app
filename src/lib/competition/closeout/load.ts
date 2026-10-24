import { buildCompetitionPnl, type CompetitionPnl, type PnlAccountingEntry, type PnlAllocation, type PnlEntry, type PnlItem, type PnlOrder, type PnlPayment, type PnlRefund } from "./pnl";
import {
  buildCloseoutChecklist,
  countOrdersBelowTotal,
  type ChecklistException,
  type ChecklistItem,
  type ChecklistScope,
  type ChecklistScratch,
} from "./checklist";

/**
 * Read-only loader for the competition closeout page and exports.
 *
 * It takes the caller's own Supabase client (row level security is the real boundary) and additionally scopes every
 * query to one event and drops any row whose event does not match, so a mistaken policy or a cross-event join can never
 * leak another event's money into this one. Only `select` is used: no insert, update, delete or rpc.
 */

// Minimal structural type so tests can pass a fake; the real client satisfies it.
type Rows = { data: unknown[] | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CloseoutClient = { from: (table: string) => any };

const PAGE = 1000;
const CHUNK = 150;

async function selectAll<T>(build: (from: number, to: number) => PromiseLike<Rows>, label: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`Could not load ${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function selectIn<T>(ids: string[], build: (chunk: string[], from: number, to: number) => PromiseLike<Rows>, label: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    out.push(...(await selectAll<T>((from, to) => build(chunk, from, to), label)));
  }
  return out;
}

const isCompetitionItem = (item: { item_type: string; metadata: Record<string, unknown> | null }) =>
  item.item_type === "competition_entry" || item.metadata?.revenue_class === "competition_entry";

export type CloseoutData = {
  eventId: string;
  pnl: CompetitionPnl;
  checklist: ChecklistItem[];
  settlementStatus: string | null;
};

export async function loadCompetitionCloseout(
  supabase: CloseoutClient,
  event: { id: string; studio_id: string },
  options: { deskBalanceHelperAvailable?: boolean } = {},
): Promise<CloseoutData> {
  const eventId = event.id;

  const itemRows = await selectAll<PnlItem & { event_id: string }>(
    (from, to) =>
      supabase.from("event_order_items").select("id, order_id, event_id, item_type, description, total_price, metadata").eq("event_id", eventId).order("id").range(from, to),
    "order items",
  );
  const itemsAll = itemRows.filter((i) => i.event_id === eventId);
  const competitionOrderIds = [...new Set(itemsAll.filter(isCompetitionItem).map((i) => i.order_id))];

  const orderRows = await selectIn<PnlOrder & { event_id: string; studio_id: string }>(
    competitionOrderIds,
    (chunk, from, to) =>
      supabase.from("event_orders").select("id, event_id, studio_id, payment_status, total_amount, currency").eq("event_id", eventId).eq("studio_id", event.studio_id).in("id", chunk).order("id").range(from, to),
    "orders",
  );
  const orders = orderRows.filter((o) => o.event_id === eventId && o.studio_id === event.studio_id);
  const orderIds = new Set(orders.map((o) => o.id));
  const items = itemsAll.filter((i) => orderIds.has(i.order_id));

  const entries = (
    await selectAll<PnlEntry & { event_id: string }>(
      (from, to) =>
        supabase.from("event_competition_entries").select("id, event_id, order_item_id, display_name, status, sort_order, program_id, division_id").eq("event_id", eventId).order("id").range(from, to),
      "entries",
    )
  ).filter((e) => e.event_id === eventId);

  const registrations = await selectIn<{ id: string; order_id: string | null; event_id: string }>(
    [...orderIds],
    (chunk, from, to) => supabase.from("event_registrations").select("id, order_id, event_id").eq("event_id", eventId).in("order_id", chunk).order("id").range(from, to),
    "registrations",
  );
  const orderByRegistration = new Map(registrations.filter((r) => r.event_id === eventId && r.order_id !== null && orderIds.has(r.order_id)).map((r) => [r.id, r.order_id]));

  const paymentRows = await selectIn<Omit<PnlPayment, "order_id"> & { registration_id: string }>(
    [...orderByRegistration.keys()],
    (chunk, from, to) =>
      supabase
        .from("event_payments")
        .select("id, registration_id, amount, status, source, payment_method, refund_amount, stripe_processing_fee_amount, stripe_application_fee_amount, platform_fee_amount, created_at")
        .in("registration_id", chunk)
        .order("id")
        .range(from, to),
    "payments",
  );
  const payments: PnlPayment[] = paymentRows.filter((p) => orderByRegistration.has(p.registration_id)).map((p) => ({ ...p, order_id: orderByRegistration.get(p.registration_id) ?? null }));

  const refunds = (
    await selectAll<PnlRefund & { event_id: string }>(
      (from, to) =>
        supabase.from("event_order_refunds").select("id, event_id, order_id, amount_cents, status, source, stripe_refund_id, reason, succeeded_at, reversed_at, created_at").eq("event_id", eventId).order("id").range(from, to),
      "refunds",
    )
  ).filter((r) => r.event_id === eventId && orderIds.has(r.order_id));
  const refundIds = new Set(refunds.map((r) => r.id));
  const allocations = (
    await selectAll<PnlAllocation & { event_id: string }>(
      (from, to) =>
        supabase.from("event_order_refund_allocations").select("refund_id, event_id, order_item_id, entry_id, line_kind, amount_cents").eq("event_id", eventId).order("id").range(from, to),
      "refund allocations",
    )
  ).filter((a) => a.event_id === eventId && refundIds.has(a.refund_id));

  // Accounting tie-out is best effort: a read failure leaves the check "not checked", never a silent pass.
  let accounting: PnlAccountingEntry[] | null = null;
  try {
    accounting = await selectAll<PnlAccountingEntry & { event_id: string | null }>(
      (from, to) =>
        supabase
          .from("accounting_entries")
          .select("event_id, category, direction, gross_amount, refund_amount, entry_status")
          .eq("event_id", eventId)
          .in("category", ["competition_entry_revenue", "competition_entry_refund"])
          .order("id")
          .range(from, to),
      "accounting entries",
    );
    accounting = accounting.filter((a) => (a as { event_id: string | null }).event_id === eventId);
  } catch {
    accounting = null;
  }

  const exceptionsByEvent = await selectAll<ChecklistException>(
    (from, to) => supabase.from("event_order_settlement_exceptions").select("id, kind, status, order_id, event_id").eq("event_id", eventId).order("id").range(from, to),
    "settlement exceptions",
  );
  const exceptionsByOrder = await selectIn<ChecklistException>(
    [...orderIds],
    (chunk, from, to) => supabase.from("event_order_settlement_exceptions").select("id, kind, status, order_id, event_id").in("order_id", chunk).order("id").range(from, to),
    "settlement exceptions",
  );
  const exceptions = new Map<string, ChecklistException>();
  for (const e of [...exceptionsByEvent, ...exceptionsByOrder]) {
    if (e.event_id !== null && e.event_id !== eventId) continue;
    if (e.order_id !== null && !orderIds.has(e.order_id) && e.event_id !== eventId) continue;
    exceptions.set(e.id, e);
  }

  const scopes = (
    await selectAll<ChecklistScope & { event_id: string }>(
      (from, to) => supabase.from("event_competition_refund_exception_scopes").select("id, event_id, kind, resolved_at").eq("event_id", eventId).order("id").range(from, to),
      "refund exception scopes",
    )
  ).filter((s) => s.event_id === eventId);

  // SC1 may not exist in this database; a missing table means "not available yet", any other error is real.
  let scratches: ChecklistScratch[] | null = null;
  {
    const probe = await supabase.from("event_competition_scratches").select("entry_id, requested_resolution, performed_at, event_id").eq("event_id", eventId).order("performed_at").limit(PAGE);
    if (!probe.error) {
      scratches = ((probe.data ?? []) as (ChecklistScratch & { event_id: string })[]).filter((s) => s.event_id === eventId);
    } else if (!["42P01", "PGRST205", "PGRST200"].includes(String(probe.error.code))) {
      throw new Error(`Could not load scratches: ${probe.error.message}`);
    }
  }

  const settlement = await supabase.from("event_settlements").select("status, event_id").eq("event_id", eventId).maybeSingle();
  if (settlement.error) throw new Error(`Could not load event settlement: ${settlement.error.message}`);
  const settlementStatus = settlement.data && settlement.data.event_id === eventId ? (settlement.data.status as string) : null;

  const pnl = buildCompetitionPnl({ orders, items, entries, payments, refunds, allocations, accounting });
  const checklist = buildCloseoutChecklist({
    eventId,
    exceptions: [...exceptions.values()],
    scopes,
    scratches,
    deskBalanceHelperAvailable: options.deskBalanceHelperAvailable ?? false,
    deskBalanceOrdersUnpaid: countOrdersBelowTotal(orders, pnl),
    settlementStatus,
    pnl,
  });
  return { eventId, pnl, checklist, settlementStatus };
}
