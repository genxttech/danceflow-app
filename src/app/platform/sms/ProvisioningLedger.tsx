import { ChevronDown } from "lucide-react";
import type { EvidenceStatus, LedgerSnapshot } from "@/lib/sms/provisioning/provisionLedger";
import type { ProvisioningOperationView } from "@/lib/sms/provisioning/adminView";
import { CONFIRM_PHRASE, FEE_RELEASE_MESSAGE } from "@/lib/sms/provisioning/provisionCommands";
import { FEE_RELEASE_ENABLED } from "@/lib/sms/provisioning/provisionLedger";
import { recordProviderListingAction, reopenProvisioningAction, resolveProvisioningOperationAction } from "./provisioningActions";

/**
 * TW-4F R2c-I1: the platform-admin provisioning ledger for one studio, with a focused resolution form for an unknown provider outcome. Platform-admin
 * only (the page and both actions require it); studios never receive this component or its data. It never calls a provider: the admin checks the Twilio
 * console, then records what they found. An unknown outcome is never presented as a failure.
 */

const OP_LABEL: Record<string, string> = { messaging_service: "Messaging Service", campaign: "Campaign" };
const STATUS: Record<string, { label: string; tone: string }> = {
  in_flight: { label: "In flight", tone: "border-sky-200 bg-sky-50 text-sky-900" },
  succeeded: { label: "Created (the provider answered)", tone: "border-emerald-200 bg-emerald-50 text-emerald-900" },
  failed: { label: "Refused by the provider (definite)", tone: "border-rose-200 bg-rose-50 text-rose-900" },
  unknown_outcome: { label: "Outcome unknown: the provider may or may not hold it", tone: "border-amber-300 bg-amber-50 text-amber-900" },
  abandoned: { label: "Closed: an admin confirmed it was not created", tone: "border-slate-200 bg-slate-50 text-slate-700" },
};
const UNRECOGNIZED = { label: "Unrecognized status: investigate", tone: "border-rose-300 bg-rose-50 text-rose-900" };
const input = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const open = (o: ProvisioningOperationView) => (o.status === "unknown_outcome" || o.status === "in_flight") && !o.superseded;
const held = (o: ProvisioningOperationView) => o.feeBearing && open(o);

function ResolveForm({ studioId, op }: { studioId: string; op: ProvisioningOperationView }) {
  return (
    <details className="group/resolve mt-2" data-testid="resolve-form">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-violet-800 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open/resolve:rotate-180" />
        Resolve this outcome
      </summary>
      <form action={resolveProvisioningOperationAction} className="mt-2 grid gap-2 rounded-lg border border-slate-200 p-3">
        <input type="hidden" name="studioId" value={studioId} />
        <input type="hidden" name="operationId" value={op.id} />
        <p className="text-xs text-slate-600">Look this resource up in the Twilio console first. Do not guess: record only what you found.</p>
        <fieldset className="grid gap-1 text-xs text-slate-800">
          <legend className="font-semibold">What did you find?</legend>
          <label className="flex items-center gap-2"><input type="radio" name="resolution" value="created" required /> It exists at the provider (enter its SID)</label>
          {op.feeBearing && !FEE_RELEASE_ENABLED ? null : <label className="flex items-center gap-2"><input type="radio" name="resolution" value="not_created" /> It does not exist at the provider</label>}
        </fieldset>
        <label className="text-xs font-medium text-slate-800">Resource SID (only if it exists)
          <input name="providerSid" autoComplete="off" pattern={op.kind === "campaign" ? "QE[0-9a-fA-F]{32}" : "MG[0-9a-fA-F]{32}"} className={input} />
        </label>
        <label className="text-xs font-medium text-slate-800">What you checked (10-500 characters)
          <input name="note" required minLength={10} maxLength={500} className={input} />
        </label>
        {op.feeBearing && !FEE_RELEASE_ENABLED ? (
          <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-900" data-testid="fee-release-disabled">{FEE_RELEASE_MESSAGE} You can still record that it exists at the provider.</p>
        ) : null}
        {op.feeBearing ? (
          <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            This operation involves a fee ({(op.feeKinds ?? []).join(", ") || "fee"}).{FEE_RELEASE_ENABLED ? " “Does not exist” releases the set-aside amount." : ""} &ldquo;Exists&rdquo; captures nothing until a provider read confirms it. Your choice is recorded with your name.
          </p>
        ) : null}
        <label className="flex items-center gap-2 text-xs text-slate-800"><input type="checkbox" name="confirm" required /> I checked the provider myself</label>
        {op.feeBearing ? (
          <label className="text-xs font-medium text-slate-800">Type {CONFIRM_PHRASE} to confirm
            <input name="phrase" autoComplete="off" required className={input} />
          </label>
        ) : null}
        <button type="submit" className="w-fit rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800">Record resolution</button>
      </form>
    </details>
  );
}

const PROOF_REASON: Record<string, string> = {
  no_listing: "no provider listing recorded yet",
  latest_not_absent: "the latest listing does not show it absent",
  stale: "the latest listing is older than 60 minutes",
  need_two_independent_listings: "a second complete listing, 10+ minutes apart and 20+ minutes after the attempt, is needed",
  resource_seen: "a listing showed a campaign for this attempt",
  chain_broken: "an incomplete listing broke the chain",
  scope_changed: "the listings are not of the attempt's own Messaging Service",
  reads_not_independent: "the two reads were not independent",
  orphan_open: "the business has an open unaccounted provider resource",
  unaccounted_resource_seen: "a listing showed a resource the ledger does not account for",
  fake_evidence: "fake evidence is not accepted here",
  verified_absence: "two independent listings prove it was not created",
};

/** F4 evidence console: what the recorded provider listings prove for an unresolved fee-bearing campaign attempt, and a read-only "take a listing now" action. */
function EvidenceConsole({ studioId, op, status }: { studioId: string; op: ProvisioningOperationView; status: EvidenceStatus | "unavailable" | undefined }) {
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2" data-testid="evidence-console">
      <p className="font-semibold text-slate-900">Provider evidence</p>
      {status === "unavailable" || status === undefined ? (
        <p className="text-rose-900" data-testid="evidence-unavailable">The evidence could not be read. Do not assume none was recorded.</p>
      ) : (
        <>
          <p className="text-slate-700">
            {status.listings} listing{status.listings === 1 ? "" : "s"} recorded{status.latestVerdict ? `; latest: ${status.latestVerdict} at ${when(status.latestObservedAt)} (${status.latestSource ?? "?"})` : ""}.
          </p>
          <p className={status.proofOk ? "text-emerald-900" : "text-slate-700"} data-testid="evidence-proof">
            Proof of non-creation: {status.proofOk ? "complete" : "not complete"} ({PROOF_REASON[status.proofReason] ?? status.proofReason}).
          </p>
          {status.pilot ? <p className="text-amber-900" data-testid="evidence-pilot">Pilot business: a not-created determination never releases its fee, whatever the evidence.</p> : null}
          {status.releasePermittedByEvidence && !FEE_RELEASE_ENABLED ? (
            <p className="text-amber-900" data-testid="evidence-release-off">The evidence would permit releasing the held fee, but release stays switched off until the owner decides (U-1). Nothing is released.</p>
          ) : null}
        </>
      )}
      <form action={recordProviderListingAction} className="mt-2 grid gap-1" data-testid="record-listing-form">
        <input type="hidden" name="studioId" value={studioId} />
        <input type="hidden" name="operationId" value={op.id} />
        <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" name="confirm" required /> Take one read-only provider listing now (nothing is created, resolved or released)</label>
        <button type="submit" className="w-fit rounded-lg border border-violet-300 px-3 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-50">Record provider listing</button>
      </form>
    </div>
  );
}

export default function ProvisioningLedger({ studioId, ledger }: { studioId: string; ledger: LedgerSnapshot | "unreadable" | "none" | null }) {
  if (ledger === null || ledger === "none") return null;
  if (ledger === "unreadable") {
    return (
      <p role="alert" id={`ledger-${studioId}`} className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900" data-testid="ledger-unreadable">
        The provisioning ledger for this studio could not be read. Reload; do not assume nothing is in flight.
      </p>
    );
  }
  const unresolved = ledger.operations.filter(open);
  const canReopen = ledger.state === "exception" && unresolved.length === 0 && /^(prov_|campaign_rejected$)/.test(ledger.lastErrorCode ?? "");
  return (
    <details id={`ledger-${studioId}`} open={unresolved.length > 0} className="group/ledger mt-2 rounded-xl border border-slate-200 p-3" data-testid="provisioning-ledger">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open/ledger:rotate-180" />
        Provider operations ({ledger.operations.length}){unresolved.length ? `, ${unresolved.length} need attention` : ""}
      </summary>
      {ledger.operations.length === 0 ? <p className="mt-2 text-xs text-slate-600">No provider operation has been recorded for this studio.</p> : null}
      <ul className="mt-2 space-y-2">
        {ledger.operations.map((op) => {
          const status = STATUS[op.status] ?? UNRECOGNIZED;
          return (
            <li key={op.id} className="rounded-lg border border-slate-100 p-2 text-xs" data-op-status={op.status}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">{OP_LABEL[op.kind] ?? op.kind} #{op.attempt ?? "?"}</span>
                <span className={`rounded-full border px-2 py-0.5 font-semibold ${status.tone}`}>{status.label}</span>
                {op.superseded ? <span className="text-slate-500">(superseded)</span> : null}
              </div>
              <p className="mt-1 text-slate-600">Started {when(op.attemptedAt)}{op.finishedAt ? `, finished ${when(op.finishedAt)}` : ""}{op.errorCode ? `, code ${op.errorCode}` : ""}</p>
              {op.errorDetail ? <p className="text-slate-600">{op.errorDetail}</p> : null}
              {op.providerSid ? <p className="break-all text-slate-600">Provider resource: {op.providerSid}</p> : null}
              {held(op) ? <p className="mt-1 font-medium text-amber-900" data-testid="held-reservation">Fee set aside and held ({(op.feeKinds ?? []).join(", ") || "fee"}): neither charged nor released until this is settled.</p> : null}
              {op.resource ? (
                <p className="text-slate-600">Provider read: {op.resource.status ?? "?"}{op.resource.providerStatus ? ` (${op.resource.providerStatus})` : ""}{op.resource.mismatchCode ? `, mismatch ${op.resource.mismatchCode}` : ""}{op.resource.failureReasons ? `, ${op.resource.failureReasons}` : ""}</p>
              ) : null}
              {op.resolutionNote ? <p className="text-slate-600">Resolution note: {op.resolutionNote}</p> : null}
              {held(op) && op.kind === "campaign" ? (
                <EvidenceConsole studioId={studioId} op={op} status={ledger.evidence === "unavailable" ? "unavailable" : ledger.evidence?.[op.id]} />
              ) : null}
              {open(op) ? <ResolveForm studioId={studioId} op={op} /> : null}
            </li>
          );
        })}
      </ul>
      {canReopen ? (
        <form action={reopenProvisioningAction} className="mt-3 grid gap-2 rounded-lg border border-slate-200 p-3" data-testid="reopen-form">
          <input type="hidden" name="studioId" value={studioId} />
          <p className="text-xs text-slate-600">This studio is in an exception ({ledger.lastErrorCode ?? "unspecified"}). Reopening only moves it back to the provisioning step it belongs to; it submits, charges and creates nothing.</p>
          <label className="text-xs font-medium text-slate-800">Why can it continue? (10-300 characters)
            <input name="reason" required minLength={10} maxLength={300} className={input} />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-800"><input type="checkbox" name="confirm" required /> I understand the exception</label>
          <button type="submit" className="w-fit rounded-lg border border-violet-300 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-50">Reopen provisioning</button>
        </form>
      ) : null}
    </details>
  );
}
