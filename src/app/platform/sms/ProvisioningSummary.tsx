import { buildAdminProvisioningView, type AdminProvisioningInput } from "@/lib/sms/provisioning/adminView";

/**
 * TW-4F R2c: one compact provisioning summary per studio inside the existing onboarding panel. Read-only: every link points to a control that already
 * exists (and re-checks platform-admin authorization on the server). Where a backend read is not connected the summary says so instead of implying an
 * all-clear.
 */

const TONE = { ok: "bg-emerald-50 text-emerald-800 border-emerald-200", wait: "bg-sky-50 text-sky-800 border-sky-200", bad: "bg-rose-50 text-rose-800 border-rose-200", idle: "bg-slate-50 text-slate-600 border-slate-200" } as const;
const NEXT_TONE = { act: "border-violet-300 bg-violet-50", wait_studio: "border-slate-200 bg-slate-50", wait_provider: "border-sky-200 bg-sky-50", investigate: "border-amber-300 bg-amber-50", unavailable: "border-slate-200 bg-slate-50", done: "border-emerald-200 bg-emerald-50" } as const;

export default function ProvisioningSummary(props: AdminProvisioningInput) {
  const view = buildAdminProvisioningView(props);
  const chips = [
    { k: "Campaign", ...view.campaign },
    { k: "Number", ...view.number },
    { k: "Advanced Opt-Out", ...view.optOut },
    { k: "Sender", ...view.sender },
  ];
  return (
    <div className={`rounded-xl border p-3 ${NEXT_TONE[view.next.kind]}`} data-testid="provisioning-summary" id={`onboarding-${props.studioId}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Next permitted action</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-950" data-testid="admin-next-title">{view.next.title}</p>
      {view.next.detail ? <p className="text-xs text-slate-700">{view.next.detail}</p> : null}
      {view.next.href ? <a href={view.next.href} className="mt-2 inline-flex rounded-lg border border-violet-300 bg-white px-3 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-50" data-testid="admin-next-link">Go to the control</a> : null}
      <ul className="mt-2 flex flex-wrap gap-2" aria-label="Provisioning status">
        {chips.map((c) => (
          <li key={c.k} className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE[c.tone]}`} data-chip={c.k}>{c.k}: {c.label}</li>
        ))}
      </ul>
      {view.blockers.length ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-900" data-testid="admin-blockers">
          {view.blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-slate-500" data-testid="admin-ledger">
        {props.ledgerUnreadable
          ? "Provider operation ledger: could not be read."
          : props.operations === null
          ? "Provider operation ledger: not loaded for this studio."
          : `Provider operations: ${props.operations.length} recorded, ${view.inFlight.length} in flight, ${view.unknownOutcomes.length} unknown.`}
      </p>
    </div>
  );
}
