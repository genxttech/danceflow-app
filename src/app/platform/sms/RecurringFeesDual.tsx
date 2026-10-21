import type { RflDualRequest, RflOverview } from "@/lib/sms/providerFeeOps";
import { rflDualApproveAction, rflDualRejectAction, rflDualRequestAction } from "./recurringFeeActions";
import { buttonClass, dangerButtonClass, dollars, Disclosure, inputClass, labelClass, shortId, stamp } from "./RecurringFeesDisclosure";

/**
 * (f) dual control. Absorbing an exposure and authorizing a provider NUMBER cancellation each need two DIFFERENT platform administrators. The requester sees
 * no approve control (and the database refuses it regardless). An approval is bound to the exact business, resource, action, period, amounts and reason,
 * is single-use, and expires 24 hours after the request. Nothing here absorbs or cancels anything: it only records the approval.
 * The immediate safety suspension never waits for this.
 */

const ACTION_TEXT: Record<string, string> = { absorb_exposure: "Absorb exposure", cancel_number: "Cancel provider number" };

export default function RecurringFeesDual({ dual, overview, adminId }: { dual: RflDualRequest[] | null; overview: RflOverview | null; adminId: string }) {
  if (!dual) {
    return (
      <Disclosure title="Dual-control requests" summary="not available">
        <p className="text-slate-600">Not available: dual control is not installed in this environment, so absorbing an exposure and cancelling a number stay unavailable.</p>
      </Disclosure>
    );
  }
  const pending = dual.filter((d) => d.status === "pending");
  const numbers = (overview?.resources ?? []).filter(
    (r) => r.kind === "number" && r.providerState === "active" && !r.openCancelOperation && !dual.some((d) => d.action === "cancel_number" && d.resourceId === r.resourceId),
  );
  return (
    <Disclosure title="Dual-control requests" summary={`${pending.length} waiting for a second administrator · ${dual.length - pending.length} approved`} open={pending.length > 0}>
      <p className="text-xs text-slate-600">
        Two different platform administrators are required. You can never approve your own request. An approval is single-use, tied to the exact facts shown, and expires in 24 hours.
      </p>
      {dual.length === 0 ? <p className="text-slate-600">No pending or approved requests.</p> : null}
      <ul className="space-y-3">
        {dual.map((d) => {
          const mine = d.requestedBy === adminId;
          return (
            <li key={d.requestId} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
              <p className="text-slate-900">
                {ACTION_TEXT[d.action]} · {d.status === "approved" ? "APPROVED, not yet used" : "waiting for approval"} · resource {shortId(d.resourceId)}
                {d.periodKey ? ` · period ${d.periodKey}` : ""} · business {shortId(d.legalEntityId)}
              </p>
              {d.action === "absorb_exposure" ? <p className="text-xs text-slate-700">Expected {dollars(d.expectedProviderCents)} · billed {dollars(d.providerBilledCents)}</p> : null}
              <p className="text-xs text-slate-700">Reason: {d.reason}</p>
              <p className="text-xs text-slate-600">Requested {stamp(d.requestedAt)} by {mine ? "you" : `administrator ${shortId(d.requestedBy)}`} · expires {stamp(d.expiresAt)}</p>
              {d.status === "pending" ? (
                <div className="space-y-2">
                  {mine ? (
                    <p className="text-xs font-semibold text-amber-900">You made this request, so a different administrator must approve it. You can withdraw it.</p>
                  ) : (
                    <form action={rflDualApproveAction} className="space-y-2">
                      <input type="hidden" name="requestId" value={d.requestId} />
                      <label className={labelClass}>
                        Approval note (10 to 500 characters)
                        <textarea name="note" required minLength={10} maxLength={500} rows={2} className={inputClass} />
                      </label>
                      <button type="submit" className={buttonClass}>Approve request</button>
                    </form>
                  )}
                  <form action={rflDualRejectAction} className="space-y-2">
                    <input type="hidden" name="requestId" value={d.requestId} />
                    <label className={labelClass}>
                      {mine ? "Withdrawal note" : "Rejection note"} (10 to 500 characters)
                      <textarea name="note" required minLength={10} maxLength={500} rows={2} className={inputClass} />
                    </label>
                    <button type="submit" className={dangerButtonClass}>{mine ? "Withdraw request" : "Reject request"}</button>
                  </form>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Disclosure title="Request approval to cancel a provider number" summary={`${numbers.length} eligible`}>
        <p className="text-xs text-slate-700">
          A number is never cancelled by DanceFlow. This only asks a second administrator to approve authorizing the cancellation. Absorbing an exposure is requested from the exposure list.
        </p>
        {numbers.length === 0 ? <p className="text-slate-600">No live number is eligible (each has an open cancellation, an existing request, or is already cancelled).</p> : null}
        {numbers.map((r) => (
          <form key={r.resourceId} action={rflDualRequestAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
            <input type="hidden" name="action" value="cancel_number" />
            <input type="hidden" name="resourceId" value={r.resourceId} />
            <p className="text-sm text-slate-900">Number {shortId(r.resourceId)} · location {shortId(r.studioId)} · business {shortId(r.legalEntityId)}</p>
            <label className={labelClass}>
              Written approval reference (10 to 200 characters; the same reference is used when the cancellation is authorized)
              <input name="approvalRef" required minLength={10} maxLength={200} className={inputClass} />
            </label>
            <label className={labelClass}>
              Reason (10 to 500 characters; the same text is used when the cancellation is authorized)
              <textarea name="reason" required minLength={10} maxLength={500} rows={2} className={inputClass} />
            </label>
            <button type="submit" className={buttonClass}>Request approval to cancel number</button>
          </form>
        ))}
      </Disclosure>
    </Disclosure>
  );
}
