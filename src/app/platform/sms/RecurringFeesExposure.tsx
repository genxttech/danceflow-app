import type { RflDualRequest, RflExposure } from "@/lib/sms/providerFeeOps";
import { AGING_BUCKETS } from "@/lib/sms/providerFeeOps";
import { rflDisposeExposureAction, rflDualRequestAction } from "./recurringFeeActions";
import { buttonClass, dangerButtonClass, dollars, Disclosure, inputClass, KIND_TEXT, labelClass, reasonText, shortId, stamp } from "./RecurringFeesDisclosure";

/**
 * (b) recurring-fee exposure: provider fees that nothing pays for, per business and resource, with the expected and billed provider cost. Administrator
 * panel only (cents are shown as dollars here and nowhere else). An exposure is DanceFlow's to carry: it is never charged to the studio retroactively.
 * Absorbing an exposure needs an APPROVED dual-control request (a second administrator); the absorb form only appears once one exists.
 */

function RowActions({ x, approved, pending }: { x: RflExposure; approved: RflDualRequest | null; pending: boolean }) {
  return (
    <div className="space-y-3">
      {approved ? (
        <form action={rflDisposeExposureAction} className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
          <input type="hidden" name="resourceId" value={x.resourceId} />
          <input type="hidden" name="periodKey" value={x.periodKey} />
          <input type="hidden" name="disposition" value="absorbed" />
          <p className="text-xs font-semibold text-emerald-900">Approved by a second administrator (single use, expires 24 h after the request). DanceFlow absorbs this cost; the studio is never charged.</p>
          <label className={labelClass}>
            Note (must be identical to the approved request&apos;s reason)
            <textarea name="note" required minLength={10} maxLength={500} rows={2} defaultValue={approved.reason} className={inputClass} />
          </label>
          <button type="submit" className={dangerButtonClass}>Absorb exposure</button>
        </form>
      ) : pending ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">An absorption request is waiting for a second platform administrator. See Dual-control requests.</p>
      ) : (
        <form action={rflDualRequestAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
          <input type="hidden" name="action" value="absorb_exposure" />
          <input type="hidden" name="resourceId" value={x.resourceId} />
          <input type="hidden" name="periodKey" value={x.periodKey} />
          <p className="text-xs text-slate-700">Absorbing needs two different administrators: you request it here, someone else approves it.</p>
          <label className={labelClass}>
            Reason for absorbing (10 to 500 characters)
            <textarea name="reason" required minLength={10} maxLength={500} rows={2} className={inputClass} />
          </label>
          <button type="submit" className={buttonClass}>Request approval to absorb</button>
        </form>
      )}
      <form action={rflDisposeExposureAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
        <input type="hidden" name="resourceId" value={x.resourceId} />
        <input type="hidden" name="periodKey" value={x.periodKey} />
        <input type="hidden" name="disposition" value="not_billed_confirmed" />
        <label className={labelClass}>
          Confirm the provider did NOT bill this period (note, 10 to 500 characters)
          <textarea name="note" required minLength={10} maxLength={500} rows={2} className={inputClass} />
        </label>
        <button type="submit" className={buttonClass}>Record not billed</button>
      </form>
    </div>
  );
}

export default function RecurringFeesExposure({ exposures, dual }: { exposures: RflExposure[] | null; dual: RflDualRequest[] | null }) {
  if (!exposures) {
    return (
      <Disclosure title="Recurring-fee exposure" summary="not available">
        <p className="text-slate-600">Not available: the exposure report is not installed in this environment.</p>
      </Disclosure>
    );
  }
  const byBucket = AGING_BUCKETS.map((b) => [b, exposures.filter((x) => x.agingBucket === b).length] as const);
  const expectedTotal = exposures.reduce((n, x) => n + (x.expectedProviderCents ?? 0), 0);
  const billedTotal = exposures.reduce((n, x) => n + (x.providerBilledCents ?? 0), 0);
  const entities = [...new Set(exposures.map((x) => x.legalEntityId))];
  const findDual = (x: RflExposure, status: "approved" | "pending") =>
    dual?.find((d) => d.action === "absorb_exposure" && d.status === status && d.resourceId === x.resourceId && d.periodKey === x.periodKey) ?? null;

  return (
    <Disclosure title="Recurring-fee exposure" summary={`${exposures.length} open · expected ${dollars(expectedTotal)} · billed ${dollars(billedTotal)}`} open={exposures.length > 0} tone={exposures.length > 0 ? "attention" : "default"}>
      <p className="text-xs text-slate-600">
        Provider fees that no authorization, charge or written approval pays for. DanceFlow bears this cost; it is never charged to the studio retroactively. Amounts are administrator-only.
      </p>
      <p className="text-slate-700">Aging: {byBucket.map(([b, n]) => `${b} days ${n}`).join(" · ")}</p>
      {exposures.length === 0 ? <p className="text-slate-600">No open exposure.</p> : null}
      {entities.map((entityId) => {
        const rows = exposures.filter((x) => x.legalEntityId === entityId);
        const expected = rows.reduce((n, x) => n + (x.expectedProviderCents ?? 0), 0);
        const billed = rows.reduce((n, x) => n + (x.providerBilledCents ?? 0), 0);
        return (
          <Disclosure key={entityId} title={`Business ${shortId(entityId)}`} summary={`${rows.length} open · expected ${dollars(expected)} · billed ${dollars(billed)}`} open={rows.some((r) => r.agingBucket === "90+" || r.agingBucket === "31-90")}>
            <ul className="space-y-3">
              {rows.map((x) => {
                const approved = findDual(x, "approved");
                const pending = x.dualRequestStatus === "pending" || findDual(x, "pending") !== null;
                return (
                  <li key={`${x.resourceId}:${x.periodKey}`} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
                    <p className="text-slate-900">
                      {x.resourceKind ? KIND_TEXT[x.resourceKind] : "resource"} {shortId(x.resourceId)} · location {shortId(x.studioId)} · {x.feeKind ?? "fee"} · period {x.periodKey}
                    </p>
                    <p className="text-xs text-slate-700">{reasonText(x.reason)}</p>
                    <p className="text-xs text-slate-700">
                      Expected provider cost {dollars(x.expectedProviderCents)} · provider billed {dollars(x.providerBilledCents)} · open {x.ageDays ?? "?"} days (bucket {x.agingBucket ?? "n/a"}) since {stamp(x.firstDetectedAt)}
                    </p>
                    <Disclosure title="Actions for this exposure" summary={approved ? "approved to absorb" : pending ? "request pending" : "no request"}>
                      <RowActions x={x} approved={approved} pending={pending} />
                    </Disclosure>
                  </li>
                );
              })}
            </ul>
          </Disclosure>
        );
      })}
    </Disclosure>
  );
}
