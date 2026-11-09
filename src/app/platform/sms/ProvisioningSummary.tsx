import { buildAdminProvisioningView, runControls, type AdminProvisioningInput, type RunControls } from "@/lib/sms/provisioning/adminView";
import { CAMPAIGN_PHRASE } from "@/lib/sms/provisioning/runOrchestration";
import { runNumberStepAction, runProvisioningStepAction } from "./provisioningRunActions";

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
      <RunControlsPanel studioId={props.studioId} controls={runControls(props)} />
    </div>
  );
}

const BUTTON = "rounded-lg bg-violet-700 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-800";
const QUIET = "rounded-lg border border-violet-300 bg-white px-3 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-50";
const INPUT = "rounded border border-slate-300 px-1 py-0.5 text-xs";

/**
 * TW-4F J1: the provisioning run controls. Each form posts to a server action that re-checks platform-admin access, the real-call switches and every
 * fee gate; a control shown here authorizes nothing. Fee-bearing steps need their confirmation ticked and typed on every run (never remembered).
 */
function RunControlsPanel({ studioId, controls }: { studioId: string; controls: RunControls }) {
  if (controls.provisioning.length === 0 && controls.numbers.length === 0) return null;
  const has = <T extends string>(list: T[], intent: T) => list.includes(intent);
  return (
    <div className="mt-3 space-y-2 border-t border-slate-200 pt-2" id={`prov-run-${studioId}`} data-testid="prov-run-controls">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Provisioning runs</p>
      {controls.provisioning.length ? (
        <div className="flex flex-wrap items-end gap-2">
          {has(controls.provisioning, "service") ? (
            <form action={runProvisioningStepAction}>
              <input type="hidden" name="studioId" value={studioId} />
              <button type="submit" name="intent" value="service" className={QUIET} data-testid="prov-run-service" title="Free: creates or adopts the Messaging Service in the studio's subaccount">Set up Messaging Service</button>
            </form>
          ) : null}
          {has(controls.provisioning, "campaign") ? (
            <form action={runProvisioningStepAction} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-white px-2 py-1" data-testid="prov-run-campaign-form">
              <input type="hidden" name="studioId" value={studioId} />
              <label className="flex items-center gap-1 text-xs text-slate-800">
                <input type="checkbox" name="confirmFee" data-testid="prov-run-campaign-confirm" /> I confirm the campaign fees the owner approved
              </label>
              <label className="flex items-center gap-1 text-xs text-slate-800">
                Type {CAMPAIGN_PHRASE}
                <input name="confirmPhrase" autoComplete="off" aria-label={`Type ${CAMPAIGN_PHRASE} to submit the campaign`} className={`w-20 ${INPUT}`} data-testid="prov-run-campaign-phrase" />
              </label>
              <button type="submit" name="intent" value="campaign" className={BUTTON} data-testid="prov-run-campaign">Submit campaign</button>
            </form>
          ) : null}
          {has(controls.provisioning, "refresh") ? (
            <form action={runProvisioningStepAction}>
              <input type="hidden" name="studioId" value={studioId} />
              <button type="submit" name="intent" value="refresh" className={QUIET} data-testid="prov-run-refresh" title="Read-only: nothing is created, submitted or paid">Check provisioning status</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {controls.numbers.length ? (
        <div className="flex flex-wrap items-end gap-2">
          {has(controls.numbers, "offer") ? (
            <form action={runNumberStepAction} className="flex items-center gap-2">
              <input type="hidden" name="studioId" value={studioId} />
              <label className="flex items-center gap-1 text-xs text-slate-800">
                Area code
                <input name="areaCode" inputMode="numeric" maxLength={3} autoComplete="off" aria-label="Area code (optional)" className={`w-14 ${INPUT}`} data-testid="num-run-area-code" />
              </label>
              <button type="submit" name="intent" value="offer" className={QUIET} data-testid="num-run-offer" title="Free: searches and records an offer the owner chooses from; nothing is bought">Offer numbers to the owner</button>
            </form>
          ) : null}
          {has(controls.numbers, "acquire") ? (
            <form action={runNumberStepAction} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-white px-2 py-1" data-testid="num-run-acquire-form">
              <input type="hidden" name="studioId" value={studioId} />
              <label className="flex items-center gap-1 text-xs text-slate-800">
                <input type="checkbox" name="confirmFee" data-testid="num-run-acquire-confirm" /> I confirm the number fee the owner approved
              </label>
              <label className="flex items-center gap-1 text-xs text-slate-800">
                Owner-approved number
                <input name="approvedE164" autoComplete="off" placeholder="+1..." aria-label="Type the number the owner approved" className={`w-32 ${INPUT}`} data-testid="num-run-acquire-e164" />
              </label>
              <button type="submit" name="intent" value="acquire" className={BUTTON} data-testid="num-run-acquire">Buy the approved number</button>
            </form>
          ) : null}
          {has(controls.numbers, "refresh") ? (
            <form action={runNumberStepAction}>
              <input type="hidden" name="studioId" value={studioId} />
              <button type="submit" name="intent" value="refresh" className={QUIET} data-testid="num-run-refresh" title="Read-only: nothing is bought or attached">Check number status</button>
            </form>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-slate-500">Owners choose and approve their number themselves. Runs are refused unless this deployment allows provider calls.</p>
    </div>
  );
}
