import { PRICE_LABEL, formatUsd, type AdminCreditOverview } from "@/lib/billing/smsCreditView";

/**
 * Platform-admin monitoring of prepaid SMS credit: read only. Prices (with DanceFlow's provider cost), accounts that need attention, purchases stuck pending,
 * reconciliation variances and the ConfiDance pilot ceiling. Nothing here changes a balance, a price or a hold.
 */
export default function SmsCreditAdmin({ overview }: { overview: AdminCreditOverview | null }) {
  if (!overview) return null;
  const attention = overview.accounts.filter((a) => a.attention);

  return (
    <section aria-labelledby="sms-credit-admin" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="sms-credit-admin" className="text-base font-semibold text-slate-900">Prepaid texting credit</h2>

      {overview.pilot ? (
        <p className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
          Pilot ceiling for {overview.pilot.legalName}: {formatUsd(overview.pilot.usedCents)} of {formatUsd(overview.pilot.ceilingCents)} used. Non-spendable; it is not credit and each use needs its own approval.
        </p>
      ) : null}

      <details open={attention.length > 0 || overview.stalePending.length > 0 || overview.variances.length > 0}>
        <summary className="cursor-pointer text-sm font-semibold text-violet-800">
          Needs attention ({attention.length} accounts, {overview.stalePending.length} stale purchases, {overview.variances.length} variances)
        </summary>
        <div className="mt-3 space-y-4 text-sm">
          <div>
            <h3 className="font-semibold text-slate-800">Funding exceptions</h3>
            {attention.length ? (
              <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {attention.map((a) => (
                  <li key={a.legalEntityId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="font-medium text-slate-900">{a.legalName} <span className="text-xs font-normal text-slate-500">({a.locations} locations)</span></span>
                    <span className="text-slate-700">
                      {formatUsd(a.balanceCents)} balance · {formatUsd(a.reservedCents)} reserved
                      {a.balanceCents < 0 ? " · negative" : ""}
                      {a.hold ? ` · on hold${a.holdReason ? ` (${a.holdReason})` : ""}` : ""}
                      {a.lowBalance ? " · low" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-600">None.</p>
            )}
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Purchases stuck pending</h3>
            {overview.stalePending.length ? (
              <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {overview.stalePending.map((p, i) => (
                  <li key={`${p.createdAt}-${i}`} className="flex justify-between gap-2 px-3 py-2">
                    <span className="text-slate-900">{p.legalName}</span>
                    <span className="text-slate-700">{formatUsd(p.amountCents)} · started {p.createdAt.slice(0, 16).replace("T", " ")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-600">None.</p>
            )}
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Reconciliation variances</h3>
            {overview.variances.length ? (
              <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {overview.variances.map((v, i) => (
                  <li key={`${v.createdAt}-${i}`} className="flex justify-between gap-2 px-3 py-2">
                    <span className="text-slate-900">{v.legalName} · {PRICE_LABEL[v.kind] ?? v.kind}</span>
                    <span className="text-slate-700">cost {formatUsd(v.providerCostCents)} vs expected {v.expectedCostCents == null ? "n/a" : formatUsd(v.expectedCostCents)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-600">None.</p>
            )}
          </div>
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-sm font-semibold text-violet-800">Published prices and provider cost</summary>
        <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
          {overview.prices.map((p) => (
            <li key={p.kind} className="flex justify-between gap-2 px-3 py-2">
              <span className="text-slate-900">{PRICE_LABEL[p.kind] ?? p.kind}</span>
              <span className="text-slate-700">customer {formatUsd(p.customerPriceCents)} · provider {formatUsd(p.providerCostCents)}</span>
            </li>
          ))}
          {overview.prices.length === 0 ? <li className="px-3 py-2 text-slate-600">No prices published yet.</li> : null}
        </ul>
      </details>
    </section>
  );
}
