import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { loadCompetitionCloseout } from "@/lib/competition/closeout/load";
import type { ChecklistStatus } from "@/lib/competition/closeout/checklist";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<ChecklistStatus, string> = {
  PASS: "bg-emerald-100 text-emerald-800",
  BLOCKED: "bg-rose-100 text-rose-800",
  "NOT AVAILABLE YET": "bg-slate-100 text-slate-600",
};

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(cents / 100);
}

export default async function CompetitionCloseoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, event } = await requireCompetitionWorkspace(id);
  const { pnl, checklist } = await loadCompetitionCloseout(supabase, event);
  const c = pnl.currency;
  const base = `/app/events/${id}/competition/closeout/export`;
  const blockedCount = checklist.filter((i) => i.status === "BLOCKED").length;
  const figures: [string, number][] = [
    ["Entry revenue received", pnl.revenue.grossReceivedCents],
    ["  Online and other non-desk", pnl.revenue.onlineCents],
    ["  Desk payments", pnl.revenue.deskCents],
    ["List price of entry and fee lines", pnl.lines.listPriceCents],
    ["Discounts (already inside what was charged)", -pnl.lines.discountCents],
    ["Stripe processing fees", pnl.fees.processingCents],
    ["Stripe application fees", pnl.fees.applicationCents],
    ["Platform fee retained", pnl.fees.platformFeeRetainedCents],
    ["Succeeded refunds", -pnl.refunds.succeededCents],
    ["Net after refunds", pnl.netCents],
    ["Net after refunds and fees", pnl.netAfterFeesCents],
  ];

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-semibold text-slate-950">Closeout</h2>
        <p className="mt-1 text-sm text-slate-600">
          A read-only view of the money and the open items before this competition is closed. Nothing on this page closes, locks,
          settles or posts anything.
        </p>
      </header>

      <section aria-labelledby="checklist" className="space-y-3">
        <h3 id="checklist" className="text-base font-semibold text-slate-950">Checklist</h3>
        <p className="text-sm text-slate-600">
          {blockedCount === 0 ? "No item is blocking." : `${blockedCount} item${blockedCount === 1 ? " is" : "s are"} blocking.`}
        </p>
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {checklist.map((item) => (
            <li key={item.key} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-950">{item.label}</p>
                <p className="mt-1 text-sm text-slate-600">{item.detail}</p>
                {item.href ? <Link href={item.href} className="mt-1 inline-block text-sm text-slate-700 underline">Open</Link> : null}
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[item.status]}`}>{item.status}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pnl" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="pnl" className="text-base font-semibold text-slate-950">Profit and loss</h3>
          <div className="flex gap-3 text-sm">
            <a className="underline" href={`${base}?kind=pnl`}>Summary CSV</a>
            <a className="underline" href={`${base}?kind=lines`}>Entry lines CSV</a>
            <a className="underline" href={`${base}?kind=refunds`}>Refunds CSV</a>
          </div>
        </div>
        <dl className="grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 text-sm sm:grid-cols-2">
          {figures.map(([label, cents]) => (
            <div key={label} className="flex items-center justify-between gap-3 bg-white px-4 py-2.5">
              <dt className="whitespace-pre text-slate-600">{label}</dt>
              <dd className="font-medium tabular-nums text-slate-950">{money(cents, c)}</dd>
            </div>
          ))}
        </dl>
        {pnl.refunds.pendingCount > 0 ? (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            {money(pnl.refunds.pendingHoldingCapCents, c)} in {pnl.refunds.pendingCount} pending refund(s) is holding refund cap. It is not money returned and is not in the figures above.
          </p>
        ) : null}

        <h4 className="pt-2 text-sm font-semibold text-slate-950">Succeeded refunds by date</h4>
        {pnl.refunds.byDate.length === 0 ? (
          <p className="text-sm text-slate-600">No refund has succeeded.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-1 font-medium">Date</th><th className="py-1 font-medium">Refunds</th><th className="py-1 text-right font-medium">Amount</th></tr></thead>
            <tbody>
              {pnl.refunds.byDate.map((d) => (
                <tr key={d.date} className="border-t border-slate-100"><td className="py-1">{d.date}</td><td className="py-1">{d.count}</td><td className="py-1 text-right tabular-nums">{money(d.cents, c)}</td></tr>
              ))}
            </tbody>
          </table>
        )}

        <h4 className="pt-2 text-sm font-semibold text-slate-950">Reconciliation</h4>
        <ul className="space-y-2 text-sm">
          {pnl.reconciliation.checks.map((chk) => (
            <li key={chk.key} className="flex items-start justify-between gap-3">
              <span className="text-slate-700">{chk.label}<span className="block text-xs text-slate-500">{chk.detail}</span></span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${chk.status === "ok" ? STATUS_STYLE.PASS : chk.status === "mismatch" ? STATUS_STYLE.BLOCKED : STATUS_STYLE["NOT AVAILABLE YET"]}`}>
                {chk.status === "ok" ? "OK" : chk.status === "mismatch" ? `MISMATCH ${money(chk.diffCents ?? 0, c)}` : "NOT CHECKED"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
