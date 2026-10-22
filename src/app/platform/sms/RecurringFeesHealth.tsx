import type { RflHealth } from "@/lib/sms/providerFeeOps";
import { rflSetSwitchAction } from "./recurringFeeActions";
import { buttonClass, dangerButtonClass, Disclosure, inputClass, labelClass, stamp } from "./RecurringFeesDisclosure";

/** (a) scheduler readiness and heartbeat, (d) alert and escalation visibility. Counts only: no business, resource, amount or provider reference. */

function ageText(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "none waiting";
  const m = Math.floor(seconds / 60);
  return m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}

function SwitchForm({ name, label, on }: { name: "scan" | "delivery"; label: string; on: boolean }) {
  const next = on ? "off" : "on";
  return (
    <form action={rflSetSwitchAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
      <input type="hidden" name="switch" value={name} />
      <input type="hidden" name="enabled" value={next} />
      <p className="text-sm text-slate-900">
        {label}: <span className="font-semibold">{on ? "ON" : "OFF"}</span>
      </p>
      <label className={labelClass}>
        {`Written reason to turn ${label.toLowerCase()} ${next.toUpperCase()} (10 to 500 characters)`}
        <textarea name="reason" required minLength={10} maxLength={500} rows={2} className={inputClass} />
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" name="confirm" value="yes" required className="mt-0.5" />
        <span>{`I confirm: turn the ${label.toLowerCase()} switch ${next.toUpperCase()}. This is audited. It does not register any schedule.`}</span>
      </label>
      <button type="submit" className={on ? dangerButtonClass : buttonClass}>{`Turn ${label.toLowerCase()} ${next.toUpperCase()}`}</button>
    </form>
  );
}

export default function RecurringFeesHealth({ health }: { health: RflHealth | null }) {
  if (!health) {
    return (
      <Disclosure title="Scheduler readiness and alerts" summary="not available">
        <p className="text-slate-600">Not available: the scheduler health report is not installed in this environment.</p>
      </Disclosure>
    );
  }
  const attention = health.stale || health.runsFailed24h > 0 || health.alertsFailed > 0 || health.alertsExhausted > 0;
  return (
    <Disclosure
      title="Scheduler readiness and alerts"
      summary={`scan ${health.scanSwitch ? "ON" : "OFF"} · delivery ${health.deliverySwitch ? "ON" : "OFF"}${health.stale ? " · STALE" : ""}`}
      open={attention}
      tone={attention ? "attention" : "default"}
    >
      {health.stale ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 font-semibold text-red-900">
          No scan has completed in the last 26 hours (last success {stamp(health.lastSuccessAt)}). Uncovered provider fees are not being detected until it runs.
        </p>
      ) : null}
      <p className="text-slate-700">
        Last run {stamp(health.lastRunAt)}{health.lastStatus ? ` (${health.lastStatus})` : ""} · last success {stamp(health.lastSuccessAt)} · failed runs in 24 h {health.runsFailed24h}
      </p>
      <p className="text-xs text-slate-600">All switches fail closed (off until a row says otherwise). No schedule is registered by this panel; activation is a separate, reviewed step.</p>

      <Disclosure title="Switches" summary="turning one on or off needs a written reason and a confirmation">
        <div className="grid gap-3 sm:grid-cols-2">
          <SwitchForm name="scan" label="Scan" on={health.scanSwitch} />
          <SwitchForm name="delivery" label="Alert delivery" on={health.deliverySwitch} />
        </div>
      </Disclosure>

      <Disclosure title="Alerts and escalation" summary={`${health.alertsPending} pending · ${health.alertsFailed} failed · ${health.alertsExhausted} exhausted`} open={health.alertsExhausted > 0}>
        <p className="text-slate-700">
          Pending {health.alertsPending} (oldest {ageText(health.oldestPendingAlertAgeSeconds)}) · failed {health.alertsFailed} · exhausted after 5 attempts {health.alertsExhausted}
        </p>
        {health.alertsExhausted > 0 ? (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-900">
            {health.alertsExhausted} alert(s) could not be delivered after 5 attempts and have been escalated to platform administrators. Check the administrator alerts.
          </p>
        ) : null}
        <p className="text-slate-700">Open exposures {health.openExposureCount} · open cancellation operations {health.openCancelOperations}</p>
        <p className="text-xs text-slate-600">Alerts reach people by email only. No email contains a provider reference, credential, balance or amount.</p>
      </Disclosure>
    </Disclosure>
  );
}
