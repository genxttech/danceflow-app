import { ChevronDown } from "lucide-react";
import type { NumberLedgerSnapshot } from "@/lib/sms/provisioning/recoveryStore";

/**
 * TW-4F F4: the platform-admin number-operation ledger for one studio (R2b `tw4_num_status`): purchases and attachments, their provider outcomes and holds.
 * Read only and platform-admin only (the page requires it; the database re-checks the actor). An unknown outcome is never shown as a failure.
 */

const OP_LABEL: Record<string, string> = { number_purchase: "Number purchase", number_attach: "Attach to Messaging Service" };
const STATUS: Record<string, { label: string; tone: string }> = {
  in_flight: { label: "In flight", tone: "border-sky-200 bg-sky-50 text-sky-900" },
  succeeded: { label: "Done (the provider answered)", tone: "border-emerald-200 bg-emerald-50 text-emerald-900" },
  failed: { label: "Refused by the provider (definite)", tone: "border-rose-200 bg-rose-50 text-rose-900" },
  unknown_outcome: { label: "Outcome unknown: the provider may or may not hold it", tone: "border-amber-300 bg-amber-50 text-amber-900" },
  abandoned: { label: "Closed: confirmed not created", tone: "border-slate-200 bg-slate-50 text-slate-700" },
};
const UNRECOGNIZED = { label: "Unrecognized status: investigate", tone: "border-rose-300 bg-rose-50 text-rose-900" };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");

export default function NumberLedger({ studioId, studioName, ledger }: { studioId: string; studioName: string; ledger: NumberLedgerSnapshot | "unreadable" | "none" }) {
  if (ledger === "none") return null;
  if (ledger === "unreadable") {
    return (
      <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900" data-testid="number-ledger-unreadable">
        The number ledger for {studioName} could not be read. Reload; do not assume nothing is in flight.
      </p>
    );
  }
  const open = ledger.operations.filter((o) => (o.status === "unknown_outcome" || o.status === "in_flight") && !o.superseded);
  return (
    <details id={`number-ledger-${studioId}`} open={open.length > 0} className="group/numledger rounded-xl border border-slate-200 p-3" data-testid="number-ledger">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open/numledger:rotate-180" />
        {studioName}: number operations ({ledger.operations.length}){open.length ? `, ${open.length} unresolved` : ""}
      </summary>
      <p className="mt-1 text-xs text-slate-600">State {ledger.state}{ledger.step ? `, step ${ledger.step}` : ""}{ledger.lastErrorCode ? `, last error ${ledger.lastErrorCode}` : ""}{ledger.leased ? ", a run holds the lease" : ""}.</p>
      {ledger.operations.length === 0 ? <p className="mt-2 text-xs text-slate-600">No number operation has been recorded for this studio.</p> : null}
      <ul className="mt-2 space-y-2">
        {ledger.operations.map((op) => {
          const status = STATUS[op.status] ?? UNRECOGNIZED;
          return (
            <li key={op.id} className="rounded-lg border border-slate-100 p-2 text-xs" data-op-status={op.status}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">{OP_LABEL[op.kind] ?? op.kind} #{op.attempt ?? "?"}</span>
                <span className={`rounded-full border px-2 py-0.5 font-semibold ${status.tone}`}>{status.label}</span>
                {op.superseded ? <span className="text-slate-500">(retired)</span> : null}
              </div>
              <p className="mt-1 text-slate-600">Started {when(op.startedAt)}{op.finishedAt ? `, finished ${when(op.finishedAt)}` : ""}{op.errorCode ? `, code ${op.errorCode}` : ""}</p>
              {op.e164 || op.providerSid ? <p className="break-all text-slate-600">{op.e164 ?? ""}{op.providerSid ? ` (${op.providerSid})` : ""}</p> : null}
              {op.errorDetail ? <p className="text-slate-600">{op.errorDetail}</p> : null}
              {op.feeBearing && (op.status === "unknown_outcome" || op.status === "in_flight") && !op.superseded ? (
                <p className="mt-1 font-medium text-amber-900" data-testid="number-held">Number fee held: neither charged nor released until the outcome is settled.</p>
              ) : null}
              {op.resource ? (
                <p className="text-slate-600">Provider read: {op.resource.status ?? "?"}{op.resource.mismatchCode ? `, mismatch ${op.resource.mismatchCode}` : ""} at {when(op.resource.observedAt)} ({op.resource.source ?? "?"})</p>
              ) : null}
              {op.resolutionNote ? <p className="text-slate-600">Resolution note: {op.resolutionNote}</p> : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
