import Link from "next/link";
import { randomUUID } from "crypto";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { COMPETITION_REFUND_ERROR_COPY } from "@/lib/payments/competitionRefunds";
import { buildRefundSummary, type SummaryPlacement } from "@/lib/payments/competitionRefundSummary";
import {
  attributeCompetitionRefundAction,
  refundCompetitionOrderAction,
  retryCompetitionRefundAction,
  resolveCompetitionRefundExceptionAction,
  resolveCompetitionRefundScopeAction,
} from "../../refundActions";

type Order = { id: string; event_id: string; payment_status: string; total_amount: number | string; currency: string; buyer_name: string; buyer_email: string };
type Refund = { id: string; status: string; amount_cents: number; source: string; stripe_refund_id: string | null; reason: string | null; created_at: string };
type Allocation = { refund_id: string; order_item_id: string; amount_cents: number; participation_outcome: string | null };
type Exception = { id: string; kind: string; status: string; created_at: string };
type Scope = { id: string; exception_id: string; kind: string; entry_id: string; round_id: string | null; competitive_effect: boolean; resolved_at: string | null; resolution: string | null };
type PlacementRow = { entry_id: string; heat_id: string; status: SummaryPlacement["status"]; event_competition_heats: { lock_state: SummaryPlacement["lockState"]; round_id: string | null } | null };

const KIND_LABEL: Record<string, string> = {
  competition_refund_entry_locked_heat: "Refunded entry in a locked or danced heat",
  competition_refund_entry_certified_heat: "Refunded entry in a certified heat",
  competition_refund_unattributed: "Stripe dashboard refund not yet attributed",
  competition_refund_reversed: "Refund reversed by Stripe",
};
const RESOLUTIONS: Record<string, { value: string; label: string }[]> = {
  competition_refund_entry_locked_heat: [
    { value: "withdrawn_after_unlock", label: "Entry withdrawn after an audited heat unlock" },
    { value: "keep_entry", label: "Keep the entry (official decision)" },
  ],
  competition_refund_entry_certified_heat: [
    { value: "result_stands", label: "Certified result stands (refund is financial only)" },
    { value: "k0_correction", label: "Changed through a results correction" },
  ],
  competition_refund_unattributed: [{ value: "attributed", label: "Refund attributed" }],
  competition_refund_reversed: [
    { value: "keep_entry", label: "Keep the entry" },
    { value: "withdrawn_after_unlock", label: "Entry withdrawn after an audited heat unlock" },
  ],
};

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(cents / 100);
}
function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export default async function CompetitionOrderRefundPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; orderId: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id, orderId } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const context = await getCurrentStudioContext();
  const { data: event } = await supabase.from("events").select("id, name").eq("id", id).eq("studio_id", context.studioId).maybeSingle();
  if (!event) notFound();
  const { data: orderRow } = await supabase.from("event_orders")
    .select("id, event_id, payment_status, total_amount, currency, buyer_name, buyer_email").eq("id", orderId).eq("event_id", id).maybeSingle();
  if (!orderRow) notFound();
  const order = orderRow as Order;

  const [itemResult, entryResult, refundResult, allocationResult, exceptionResult] = await Promise.all([
    supabase.from("event_order_items").select("id, item_type, description, total_price, metadata").eq("order_id", orderId),
    supabase.from("event_competition_entries").select("id, order_item_id, display_name, status, sort_order, program_id, division_id").eq("order_id", orderId),
    supabase.from("event_order_refunds").select("id, status, amount_cents, source, stripe_refund_id, reason, created_at").eq("order_id", orderId).order("created_at"),
    supabase.from("event_order_refund_allocations").select("refund_id, order_item_id, amount_cents, participation_outcome").eq("order_id", orderId),
    supabase.from("event_order_settlement_exceptions").select("id, kind, status, created_at").eq("order_id", orderId).like("kind", "competition\\_refund\\_%").order("created_at"),
  ]);
  const loadError = itemResult.error || entryResult.error || refundResult.error || allocationResult.error || exceptionResult.error;
  if (loadError) throw new Error(`Could not load the order refunds: ${loadError.message}`);
  const entries = entryResult.data ?? [];
  const refunds = (refundResult.data ?? []) as Refund[];
  const allocations = (allocationResult.data ?? []) as Allocation[];
  const exceptions = (exceptionResult.data ?? []) as Exception[];

  const [placementResult, scopeResult] = await Promise.all([
    entries.length
      ? supabase.from("event_competition_heat_entries").select("entry_id, heat_id, status, event_competition_heats(lock_state, round_id)").in("entry_id", entries.map((e) => e.id))
      : Promise.resolve({ data: [], error: null }),
    exceptions.length
      ? supabase.from("event_competition_refund_exception_scopes").select("id, exception_id, kind, entry_id, round_id, competitive_effect, resolved_at, resolution").in("exception_id", exceptions.map((x) => x.id))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (placementResult.error || scopeResult.error) throw new Error("Could not load heat placements or exception scopes.");
  const placements: SummaryPlacement[] = ((placementResult.data ?? []) as unknown as PlacementRow[]).map((p) => ({
    entryId: p.entry_id, heatId: p.heat_id, status: p.status,
    lockState: p.event_competition_heats?.lock_state ?? "open", roundId: p.event_competition_heats?.round_id ?? null,
  }));
  const scopes = (scopeResult.data ?? []) as Scope[];
  const statusByRefund = new Map(refunds.map((r) => [r.id, r.status]));
  const lines = buildRefundSummary({
    items: itemResult.data ?? [],
    entries,
    placements,
    allocations: allocations.map((a) => ({ order_item_id: a.order_item_id, amount_cents: a.amount_cents, refund_status: statusByRefund.get(a.refund_id) ?? "failed" })),
  });
  const currency = order.currency || "USD";
  const awaitingStripe = refunds.filter((r) => r.source === "staff" && r.status === "requested");
  const unattributed = refunds.filter((r) => r.source === "stripe_dashboard" && r.status === "succeeded" && !allocations.some((a) => a.refund_id === r.id));
  const entryName = new Map(entries.map((e) => [e.id, e.display_name]));
  const message = query.error ? COMPETITION_REFUND_ERROR_COPY[query.error] ?? COMPETITION_REFUND_ERROR_COPY.COMP_REFUND_FAILED : null;
  const requestId = randomUUID();

  return <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
    <header className="border-b border-slate-200 pb-5">
      <Link href={`/app/events/${id}/competition/registrations`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to Competition Registrations</Link>
      <h1 className="mt-2 text-2xl font-semibold text-slate-950">Refunds · {order.buyer_name}</h1>
      <p className="mt-1 text-sm text-slate-600">{event.name} · {order.buyer_email} · {label(order.payment_status)} · paid {money(Math.round(Number(order.total_amount) * 100), currency)}</p>
    </header>
    {message ? <p role="alert" className="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{message}</p> : null}
    {query.success ? <p role="status" className="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{label(query.success)}.</p> : null}

    <section className="mt-6">
      <h2 className="text-lg font-semibold text-slate-950">Refund lines</h2>
      <p className="mt-1 text-sm text-slate-600">Amounts are net of discounts. Refunding the whole payment also withdraws every entry that has not danced and is not in a locked or certified heat. An entry that has danced or is in a locked or certified heat is never withdrawn automatically; it opens an exception for an official decision.</p>
      <form action={refundCompetitionOrderAction} className="mt-4 space-y-4">
        <input type="hidden" name="eventId" value={id} /><input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="requestId" value={requestId} />
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500"><th className="py-2">Line</th><th>Refundable</th><th>Refunded</th><th>Refund now</th><th>Withdraw entry</th></tr></thead><tbody>
          {lines.map((line) => <tr key={line.orderItemId} className="border-b border-slate-100 align-top">
            <td className="py-3"><input type="hidden" name="itemId" value={line.orderItemId} /><span className="font-medium text-slate-900">{line.label}</span><span className="block text-xs text-slate-500">{line.kind === "fee" ? "Fee" : `Entry · ${label(line.entryStatus ?? "")}${line.participation && line.participation !== "unplaced" ? ` · ${line.participation === "locked" ? "locked or danced heat" : `${line.participation} heat`}` : ""}`}</span></td>
            <td className="py-3">{money(line.remainingCents, currency)}<span className="block text-xs text-slate-500">of {money(line.capCents, currency)}</span></td>
            <td className="py-3">{money(line.refundedCents, currency)}</td>
            <td className="py-3"><label className="sr-only" htmlFor={`amount_${line.orderItemId}`}>Refund amount for {line.label}</label><input id={`amount_${line.orderItemId}`} name={`amount_${line.orderItemId}`} inputMode="decimal" placeholder="0.00" disabled={line.remainingCents === 0} className="h-9 w-28 rounded border border-slate-300 px-2 text-sm disabled:bg-slate-50" /></td>
            <td className="py-3">{line.kind === "entry" ? <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" name={`withdraw_${line.orderItemId}`} disabled={!line.canWithdraw} defaultChecked={line.canWithdraw} />{line.canWithdraw ? "Withdraw" : "Official decision required"}</label> : <span className="text-xs text-slate-400">—</span>}</td>
          </tr>)}
        </tbody></table></div>
        <label className="block text-sm font-medium text-slate-800" htmlFor="reason">Reason</label>
        <textarea id="reason" name="reason" required rows={2} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" />
        <button className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white">Refund selected lines</button>
      </form>
    </section>

    {awaitingStripe.length > 0 ? <section className="mt-10">
      <h2 className="text-lg font-semibold text-slate-950">Waiting for Stripe</h2>
      <p className="mt-1 text-sm text-slate-600">Stripe did not confirm these refunds. Their amounts stay reserved so nothing is refunded twice. Retrying sends the same request, so Stripe returns the same refund if one exists.</p>
      <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200 text-sm">{awaitingStripe.map((refund) => <li key={refund.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
        <span>{money(refund.amount_cents, currency)}{refund.reason ? ` · ${refund.reason}` : ""} · requested {new Date(refund.created_at).toLocaleString("en-US")}</span>
        <form action={retryCompetitionRefundAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="refundId" value={refund.id} /><button className="rounded border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700">Retry with Stripe</button></form>
      </li>)}</ul>
    </section> : null}

    {unattributed.length > 0 ? <section className="mt-10">
      <h2 className="text-lg font-semibold text-slate-950">Attribute Stripe dashboard refunds</h2>
      {unattributed.map((refund) => <form key={refund.id} action={attributeCompetitionRefundAction} className="mt-4 space-y-3 border border-amber-200 bg-amber-50 p-4">
        <input type="hidden" name="eventId" value={id} /><input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="refundId" value={refund.id} />
        <p className="text-sm text-amber-900">{money(refund.amount_cents, currency)} refunded in Stripe ({refund.stripe_refund_id}). Split it across lines; the total must match.</p>
        {lines.map((line) => <div key={line.orderItemId} className="flex flex-wrap items-center gap-3 text-sm"><input type="hidden" name="itemId" value={line.orderItemId} /><span className="w-56">{line.label}</span><input aria-label={`Attributed amount for ${line.label}`} name={`amount_${line.orderItemId}`} inputMode="decimal" placeholder="0.00" className="h-9 w-28 rounded border border-slate-300 px-2" />{line.kind === "entry" ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" name={`withdraw_${line.orderItemId}`} disabled={!line.canWithdraw} />Withdraw</label> : null}</div>)}
        <button className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white">Attribute refund</button>
      </form>)}
    </section> : null}

    <section className="mt-10">
      <h2 className="text-lg font-semibold text-slate-950">Exceptions</h2>
      {exceptions.length === 0 ? <p className="mt-2 text-sm text-slate-600">No refund exceptions for this order.</p> : <div className="mt-3 space-y-4">{exceptions.map((exception) => {
        const ownScopes = scopes.filter((s) => s.exception_id === exception.id);
        const openScopes = ownScopes.filter((s) => !s.resolved_at);
        return <div key={exception.id} className="border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-slate-900">{KIND_LABEL[exception.kind] ?? label(exception.kind)}</h3><span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{label(exception.status)}</span></div>
          {ownScopes.length === 0 ? <p className="mt-2 text-sm text-slate-600">Financial only: it does not block results publication.</p> : null}
          {ownScopes.map((scope) => <div key={scope.id} className="mt-3 border-t border-slate-100 pt-3 text-sm">
            <p className="text-slate-800">{entryName.get(scope.entry_id) ?? "Entry"}{scope.competitive_effect && !scope.resolved_at ? " · blocks publication of its round" : ""}{scope.resolved_at ? ` · resolved: ${label(scope.resolution ?? "")}` : ""}</p>
            {!scope.resolved_at ? <form action={resolveCompetitionRefundScopeAction} className="mt-2 grid gap-2 sm:grid-cols-[220px_1fr_auto]">
              <input type="hidden" name="eventId" value={id} /><input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="scopeId" value={scope.id} />
              <select name="resolution" aria-label="Resolution" className="h-9 rounded border border-slate-300 bg-white px-2">{(RESOLUTIONS[scope.kind] ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              <input name="note" required aria-label="Resolution note" placeholder="Official note (required)" className="h-9 rounded border border-slate-300 px-2" />
              <button className="rounded border border-slate-300 px-3 text-xs font-semibold text-slate-700">Resolve</button>
            </form> : null}
          </div>)}
          {exception.status !== "resolved" && openScopes.length === 0 && ["competition_refund_unattributed", "competition_refund_reversed"].includes(exception.kind) ? <form action={resolveCompetitionRefundExceptionAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <input type="hidden" name="eventId" value={id} /><input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="exceptionId" value={exception.id} />
            <input name="note" required aria-label="Resolution note" placeholder="Reconciliation note (required)" className="h-9 rounded border border-slate-300 px-2 text-sm" />
            <button className="rounded border border-slate-300 px-3 text-xs font-semibold text-slate-700">Mark reconciled</button>
          </form> : null}
        </div>;
      })}</div>}
    </section>

    <section className="mt-10">
      <h2 className="text-lg font-semibold text-slate-950">Refund history</h2>
      {refunds.length === 0 ? <p className="mt-2 text-sm text-slate-600">No refunds yet.</p> : <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200 text-sm">{refunds.map((refund) => <li key={refund.id} className="flex flex-wrap justify-between gap-2 py-3"><span>{money(refund.amount_cents, currency)} · {refund.source === "staff" ? "Staff" : "Stripe dashboard"}{refund.reason ? ` · ${refund.reason}` : ""}</span><span className="font-medium">{label(refund.status)}</span></li>)}</ul>}
    </section>
  </main>;
}
