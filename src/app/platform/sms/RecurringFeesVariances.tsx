import type { RflVariance } from "@/lib/sms/providerFeeOps";
import { rflVarianceAckAction } from "./recurringFeeActions";
import { buttonClass, dollars, Disclosure, inputClass, labelClass, shortId, stamp } from "./RecurringFeesDisclosure";

/**
 * (c) provider-cost variances: the provider billed a recurring fee at a different amount than the published expectation. The difference is DanceFlow's cost.
 * Acknowledging records that a person looked at it; it changes no balance and charges nobody.
 */
export default function RecurringFeesVariances({ variances }: { variances: RflVariance[] | null }) {
  if (!variances) {
    return (
      <Disclosure title="Provider-cost variances" summary="not available">
        <p className="text-slate-600">Not available: the variance report is not installed in this environment.</p>
      </Disclosure>
    );
  }
  const open = variances.filter((v) => !v.acknowledged);
  return (
    <Disclosure title="Provider-cost variances" summary={`${open.length} to acknowledge · ${variances.length} recorded`} open={open.length > 0} tone={open.length > 0 ? "attention" : "default"}>
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800">
        DanceFlow bears this cost; it is never charged to the studio. Acknowledging does not move any money or credit; it records that an administrator reviewed the variance.
      </p>
      {variances.length === 0 ? <p className="text-slate-600">No variances recorded.</p> : null}
      <ul className="space-y-3">
        {variances.map((v) => (
          <li key={v.chargeId} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
            <p className="text-slate-900">
              {v.kind ?? "recurring fee"} · business {shortId(v.legalEntityId)} · location {shortId(v.studioId)}
            </p>
            <p className="text-xs text-slate-700">
              Expected {dollars(v.expectedCostCents)} · provider charged {dollars(v.providerCostCents)} · difference {dollars(v.varianceCents)}
            </p>
            {v.acknowledged ? (
              <p className="text-xs text-emerald-900">Acknowledged {stamp(v.acknowledgedAt)} as a DanceFlow-borne cost{v.note ? `: ${v.note}` : ""}</p>
            ) : (
              <form action={rflVarianceAckAction} className="space-y-2">
                <input type="hidden" name="chargeId" value={v.chargeId} />
                <label className={labelClass}>
                  Acknowledgement note (10 to 500 characters)
                  <textarea name="note" required minLength={10} maxLength={500} rows={2} className={inputClass} />
                </label>
                <button type="submit" className={buttonClass}>Acknowledge as DanceFlow-borne</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
