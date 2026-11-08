import type { ExposureView, Loaded } from "@/lib/sms/provisioning/recoveryStore";

/**
 * TW-4F F4: ONE platform-administrator view of DanceFlow-borne provider exposure (campaign orphans, number orphans, unregistered ledger resources), one row
 * per provider resource. Platform-admin only; studios never receive this component or its data, and nothing here asks an owner to authorize or pay.
 * An unknown cost is shown as "unknown", never as $0.00. Recorded amounts are already in the recurring-fee exposure report and are labelled as such: the
 * two views must never be added together.
 */

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const FINDING: Record<string, string> = {
  campaign_orphan: "Campaign the ledger does not account for",
  number_unknown: "Unknown number in the subaccount",
  number_ownership_mismatch: "Provider ownership contradicts the ledger",
  number_duplicate_e164: "Duplicate phone number",
  number_ledger_missing: "Ledger number missing from the provider listing",
  unregistered_ledger_resource: "Provider-confirmed, not in the recurring-fee inventory",
};
const label = (f: string) => FINDING[f] ?? f.replaceAll("_", " ");

export default function ExposureConsolidated({ exposure }: { exposure: Loaded<ExposureView> }) {
  if (exposure === "unavailable") {
    return (
      <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900" data-testid="exposure-unavailable">
        Provider exposure could not be read. Do not assume there is none.
      </p>
    );
  }
  const a = exposure.aggregate;
  return (
    <div className="grid gap-2" data-testid="exposure-consolidated">
      <p className="text-xs text-slate-700">
        {a.resources} provider resource{a.resources === 1 ? "" : "s"} borne by DanceFlow ({a.campaigns} campaign{a.campaigns === 1 ? "" : "s"}, {a.numbers} number{a.numbers === 1 ? "" : "s"}).
        {" "}Cost unknown for {a.costUnknown}; recorded for {a.costRecorded}.
        {" "}Recorded open exposure: <span data-testid="exposure-total">{a.providerBilledCents === null && a.expectedProviderCentsEstimate === null ? "none recorded" : `${a.providerBilledCents === null ? "unknown" : usd(a.providerBilledCents)} billed, ${a.expectedProviderCentsEstimate === null ? "unknown" : usd(a.expectedProviderCentsEstimate)} expected (estimate)`}</span>.
      </p>
      {a.inRflExposureReport > 0 ? (
        <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-900" data-testid="exposure-overlap">
          {a.inRflExposureReport} of these are registered in the recurring-fee inventory: their amounts are already in the recurring-fee exposure report. Do not add the two.
        </p>
      ) : null}
      {exposure.resources.length === 0 ? <p className="text-xs text-slate-600">No DanceFlow-borne provider exposure is recorded.</p> : null}
      <ul className="grid gap-2">
        {exposure.resources.map((r) => (
          <li key={r.providerSid} className="rounded-lg border border-slate-200 p-2 text-xs" data-testid="exposure-row" data-sid={r.providerSid}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">{r.resourceKind === "campaign" ? "Campaign" : r.resourceKind === "number" ? "Phone number" : r.resourceKind}</span>
              <span className="break-all text-slate-600">{r.providerSid}</span>
              <span className="text-slate-500">{r.ageDays} day{r.ageDays === 1 ? "" : "s"}</span>
              {r.costBearer === "lifecycle" ? <span className="rounded-full border border-slate-300 px-2 py-0.5 text-slate-700">studio resource: billed through the recurring-fee lifecycle</span> : null}
              {r.cost.inRflExposureReport ? <span className="rounded-full border border-amber-300 px-2 py-0.5 text-amber-900">in recurring-fee report</span> : null}
            </div>
            <p className="mt-1 text-slate-700">{r.findings.map((f) => label(f.finding)).join("; ")}</p>
            <p className="text-slate-700" data-testid="exposure-cost">
              Cost: {r.cost.known
                ? `${r.cost.providerBilledCents === null ? "unknown" : usd(r.cost.providerBilledCents)} billed, ${r.cost.expectedProviderCentsEstimate === null ? "unknown" : usd(r.cost.expectedProviderCentsEstimate)} expected (estimate)`
                : "unknown (no provider cost recorded)"}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">Unexpected provider resources are borne by DanceFlow. Nothing here charges a studio, and owners are never asked to authorize or pay for it.</p>
    </div>
  );
}
