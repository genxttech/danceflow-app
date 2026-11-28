import { REASON_MAX, REASON_MIN, RECONCILER_REASONS, SWITCH_ON_PHRASE, type ConfiguredRoute, type PinState } from "@/lib/sms/activationControls";
import type { ReconcileOverview } from "@/lib/sms/usageReconcileView";
import type { ReconcilerReadiness } from "@/lib/sms/usageReconcilerReadiness";
import { pinInboundRouteAction, switchBilledTextingOffAction, switchBilledTextingOnAction } from "./activationControlActions";

/**
 * Platform-administrator controls for the pinned inbound route and the billed texting switch. Current state comes from the database; what cannot be read is
 * said to be unknown. Nothing is pre-ticked or pre-filled, and a disabled button is a convenience only: the database re-checks every change.
 */

export type SwitchOverview = Pick<ReconcileOverview, "switchOn" | "usageGaps" | "inboundGaps">;

const input = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs";
const primary = "w-fit rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-slate-300";
const danger = "w-fit rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800";
const box = "grid gap-2 rounded-lg border border-slate-200 p-2";

const PIN_TEXT: Record<PinState, string> = {
  recorded: "A pin is recorded.",
  not_recorded: "No pin is recorded. Compliance validation and activation are refused until one is.",
  unknown: "Not known: the activation checklist, which is the only read that reports the pin, could not be read for any location. This does not mean there is no pin.",
};

function Reason() {
  return (
    <label className="font-medium text-slate-800">Reason ({REASON_MIN}-{REASON_MAX} characters, recorded with your name)
      <input name="reason" required minLength={REASON_MIN} maxLength={REASON_MAX} autoComplete="off" className={input} />
    </label>
  );
}

function Confirm({ label }: { label: string }) {
  return <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" name="confirm" required /> {label}</label>;
}

function RoutePin({ route, pin }: { route: ConfiguredRoute; pin: PinState }) {
  return (
    <div className="grid gap-2" data-testid="controls-route">
      <h3 className="text-sm font-semibold text-slate-900">Inbound route pin</h3>
      <p className="text-slate-700" data-testid="controls-pin-state" data-state={pin}>{PIN_TEXT[pin]}</p>
      <p className="text-slate-600">The database has no read that returns the pinned address, so this page cannot show which address is pinned or whether it matches the one below.</p>
      {route.ok ? (
        <form action={pinInboundRouteAction} className={box} data-testid="controls-pin-form">
          <input type="hidden" name="shownOrigin" value={route.origin} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-slate-500">Will be pinned</dt>
            <dd className="break-all font-mono text-slate-900" data-testid="controls-pin-origin">{route.origin}</dd>
            <dt className="text-slate-500">Inbound webhook address</dt>
            <dd className="break-all font-mono text-slate-900" data-testid="controls-pin-url">{route.inboundUrl}</dd>
          </dl>
          <p className="text-slate-600">
            This is the application&apos;s configured URL, also used by compliance validation and provisioning. It cannot be edited here. Whether Twilio can reach it is not
            checked by this page. The newest pin is the current one: after a change of address, compliance validations judged against the old one stop counting.
          </p>
          <Reason />
          <Confirm label="I checked that inbound texts must reach exactly this address" />
          <button type="submit" className={primary}>Pin this address</button>
        </form>
      ) : (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900" data-testid="controls-pin-unavailable">
          <p>{route.message}</p>
          {route.origin ? <p className="mt-1 break-all font-mono">{route.origin}</p> : null}
        </div>
      )}
    </div>
  );
}

function switchOnBlockers(usage: SwitchOverview | null, readiness: ReconcilerReadiness | null): string[] {
  const out: string[] = [];
  if (!usage) out.push("the current switch state and ledger gaps could not be read");
  else if (usage.switchOn) out.push("billed texting is already on");
  if (!readiness) out.push("the usage reconciler readiness could not be read");
  else if (!readiness.ok) out.push(RECONCILER_REASONS[readiness.detail === "ready" ? "unknown" : readiness.detail]);
  if (usage && (usage.usageGaps > 0 || usage.inboundGaps > 0)) out.push(`the usage ledger does not reconcile (${usage.usageGaps} outbound, ${usage.inboundGaps} inbound gap(s))`);
  return out;
}

function BilledSwitch({ usage, readiness }: { usage: SwitchOverview | null; readiness: ReconcilerReadiness | null }) {
  const state = usage ? (usage.switchOn ? "on" : "off") : "unknown";
  const blockers = switchOnBlockers(usage, readiness);
  return (
    <div className="grid gap-2" data-testid="controls-switch">
      <h3 className="text-sm font-semibold text-slate-900">Billed texting switch</h3>
      <p className="text-slate-700" data-testid="controls-switch-state" data-state={state}>
        {state === "unknown" ? "Current state: not known (the database read is not available)." : `Current state: ${state.toUpperCase()}.`}
        {readiness ? ` Usage reconciler: ${readiness.ok ? "ready" : "not ready"}.` : " Usage reconciler: not known."}
        {usage ? ` Ledger gaps: ${usage.usageGaps} outbound, ${usage.inboundGaps} inbound.` : " Ledger gaps: not known."}
      </p>

      <form action={switchBilledTextingOnAction} className={box} data-testid="controls-switch-on">
        <p className="font-semibold text-slate-900">Switch billed texting ON</p>
        <p className="text-slate-600">Allows billed texts that spend prepaid credit. The database refuses unless the usage reconciler is ready and the ledger has no gaps.</p>
        {blockers.length ? (
          <p className="text-amber-900" data-testid="controls-switch-on-blocked">Not available now: {blockers.join("; ")}.</p>
        ) : null}
        <Reason />
        <label className="font-medium text-slate-800">Type <code className="font-mono">{SWITCH_ON_PHRASE}</code>
          <input name="phrase" required autoComplete="off" className={input} />
        </label>
        <Confirm label="I am switching billed texting on for every billed business" />
        <button type="submit" className={primary} disabled={blockers.length > 0}>Switch ON</button>
      </form>

      {/* the stop never depends on a read */}
      <form action={switchBilledTextingOffAction} className={`${box} border-rose-200`} data-testid="controls-switch-off">
        <p className="font-semibold text-slate-900">Switch billed texting OFF</p>
        <p className="text-slate-600">Always allowed by the database. New billed texts are refused; texts already reserved or sent are not recalled.</p>
        <Reason />
        <Confirm label="I am switching billed texting off" />
        <button type="submit" className={danger}>Switch OFF</button>
      </form>
    </div>
  );
}

export default function ActivationControls({ route, pin, usage, readiness, notice, error }: {
  route: ConfiguredRoute; pin: PinState; usage: SwitchOverview | null; readiness: ReconcilerReadiness | null; notice: string | null; error: string | null;
}) {
  return (
    <section id="sms-activation-controls" className="rounded-[1.5rem] border border-slate-200 bg-white p-5 text-xs shadow-sm" data-testid="sms-activation-controls">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Platform administrators only</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Activation controls</h2>
      <p className="mt-1 text-slate-600">Two platform-wide settings that billed texting depends on. Each change needs a written reason and a confirmation; nothing changes automatically.</p>
      {notice ? <p role="status" className="mt-3 break-words rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">{notice}</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-900">{error}</p> : null}
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <RoutePin route={route} pin={pin} />
        <BilledSwitch usage={usage} readiness={readiness} />
      </div>
    </section>
  );
}
