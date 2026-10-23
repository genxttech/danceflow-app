import type { ActivationCheck } from "@/lib/sms/activation";
import { activateAction, attestOptOutAction, markReadyAction, recordActivationSenderAction, runComplianceAction, suspendAction, verifyActivationSenderAction } from "./activationActions";

/**
 * TW-4F J4: the activation console's action forms for ONE location. Each form posts only the studio id plus what the administrator writes or ticks; the
 * provider identifiers are never form fields. Disabled buttons are a convenience only: the database re-checks the state and the checklist on every call.
 */

const input = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs";
const primary = "w-fit rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-slate-300";
const danger = "w-fit rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800";
const box = "grid gap-1 rounded-lg border border-slate-200 p-2";

type Reads = { compliance: { enabled: boolean; reason: string | null }; sender: { enabled: boolean; reason: string | null } };

const OPT_OUT_ITEMS: [string, string][] = [
  ["advanced_opt_out_enabled", "Advanced Opt-Out is enabled on this Messaging Service"],
  ["stop_keyword_confirmed", "STOP (opt-out) keywords are configured"],
  ["start_keyword_confirmed", "START (opt-in) keywords are configured"],
  ["help_keyword_confirmed", "HELP keywords are configured"],
  ["confirmation_replies_confirmed", "The opt-out, opt-in and help confirmation replies are set"],
];

function ReadsOff({ reason }: { reason: string | null }) {
  return (
    <p className="text-amber-900" data-testid="activation-reads-off">
      Provider reads are not enabled in this environment{reason ? ` (${reason})` : ""}. The action will refuse; nothing is read or recorded.
    </p>
  );
}

function Note({ name, label }: { name: string; label: string }) {
  return (
    <label className="font-medium text-slate-800">{label} (10-300 characters, recorded with your name)
      <input name={name} required minLength={10} maxLength={300} className={input} />
    </label>
  );
}

/**
 * The emergency stop. It depends on nothing but the studio id: it is rendered for an active location even when its checklist cannot be read, and it is
 * never gated by KI-1 or the checklist (the database only requires the location to be active and a reason).
 */
export function SuspendForm({ studioId }: { studioId: string }) {
  return (
    <form action={suspendAction} className={`${box} border-rose-200 text-xs`} data-testid="activation-suspend">
      <input type="hidden" name="studioId" value={studioId} />
      <p className="font-semibold text-slate-900">Suspend (immediate stop)</p>
      <p className="text-slate-600">Revokes the sender and suspends the location at once. Reactivation needs the full checklist again.</p>
      <Note name="reason" label="Reason" />
      <button type="submit" className={danger}>Suspend now</button>
    </form>
  );
}

/** `listState` is the onboarding state from the location list: Suspend is offered when EITHER source says active. */
export default function ActivationForms({ studioId, check, reads, ki1Blocked, listState = null }: { studioId: string; check: ActivationCheck; reads: Reads; ki1Blocked: boolean; listState?: string | null }) {
  const state = check.state ?? "";
  const canMarkReady = check.ready && !ki1Blocked && state === "campaign_pending";
  const canActivate = check.ready && !ki1Blocked && (state === "ready_for_activation" || state === "suspended");
  const hidden = <input type="hidden" name="studioId" value={studioId} />;
  return (
    <div className="mt-3 grid gap-2 text-xs" data-testid="activation-forms">
      {state === "active" || listState === "active" ? <SuspendForm studioId={studioId} /> : null}

      <form action={recordActivationSenderAction} className={box} data-testid="activation-record-sender">
        {hidden}
        <p className="font-semibold text-slate-900">1. Record the sender from the ledger</p>
        <p className="text-slate-600">Uses the ledger&apos;s own Messaging Service, campaign and number shown above (pending until verified). Nothing is entered here.</p>
        <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" name="confirm" required /> Record the sender from the ledger&apos;s identifiers</label>
        <button type="submit" className={primary}>Record sender</button>
      </form>

      <form action={attestOptOutAction} className={box} data-testid="activation-attest">
        {hidden}
        <p className="font-semibold text-slate-900">2. Advanced Opt-Out attestation (Twilio Console, D4)</p>
        <p className="text-slate-600">Twilio does not expose Advanced Opt-Out to the API. Check each item yourself in the Twilio Console for this location&apos;s Messaging Service, then attest it. Every item is required.</p>
        {OPT_OUT_ITEMS.map(([name, label]) => (
          <label key={name} className="flex items-center gap-2 text-slate-800"><input type="checkbox" name={name} required /> {label}</label>
        ))}
        <label className="font-medium text-slate-800">Evidence reference (10-300 characters, for example where the Console screenshot is kept)
          <input name="evidenceRef" required minLength={10} maxLength={300} className={input} />
        </label>
        <button type="submit" className={primary}>Record attestation</button>
      </form>

      <form action={runComplianceAction} className={box} data-testid="activation-compliance">
        {hidden}
        <p className="font-semibold text-slate-900">3. Compliance validation (read-only provider read)</p>
        <p className="text-slate-600">Reads the campaign&apos;s keywords and replies and the service&apos;s inbound route in the ledger&apos;s subaccount (GET only). The database judges the result.</p>
        {reads.compliance.enabled ? null : <ReadsOff reason={reads.compliance.reason} />}
        <button type="submit" className={primary} disabled={!reads.compliance.enabled}>Run compliance validation</button>
      </form>

      <form action={verifyActivationSenderAction} className={box} data-testid="activation-verify">
        {hidden}
        <p className="font-semibold text-slate-900">4. Verify the sender (read-only provider read)</p>
        <p className="text-slate-600">Needs a current attestation and a passed compliance validation for the same service and campaign.</p>
        {reads.sender.enabled ? null : <ReadsOff reason={reads.sender.reason} />}
        <button type="submit" className={primary} disabled={!reads.sender.enabled}>Verify sender</button>
      </form>

      <form action={markReadyAction} className={box} data-testid="activation-mark-ready">
        {hidden}
        <p className="font-semibold text-slate-900">5. Mark ready for activation</p>
        <p className="text-slate-600">Only from &quot;campaign_pending&quot; with every checklist item met.</p>
        <Note name="note" label="Note" />
        <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" name="confirm" required /> I reviewed every checklist item</label>
        <button type="submit" className={primary} disabled={!canMarkReady}>Mark ready</button>
      </form>

      <form action={activateAction} className={box} data-testid="activation-activate">
        {hidden}
        <p className="font-semibold text-slate-900">6. Activate (manual release)</p>
        <p className="text-slate-600">Only from &quot;ready_for_activation&quot; or &quot;suspended&quot;. The database re-checks the whole checklist in the same step. Nothing activates automatically.</p>
        <Note name="note" label="Note" />
        <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" name="confirm" required /> I am manually activating this location</label>
        <button type="submit" className={primary} disabled={!canActivate}>Activate</button>
      </form>
    </div>
  );
}
