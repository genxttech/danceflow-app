import type { RflDualRequest, RflOverview } from "@/lib/sms/providerFeeOps";
import { cancelReleaseAvailable } from "@/lib/sms/twilioIsv/cancelRuntime";
import {
  rflCancelAuthorizeAction, rflCancelBeginAction, rflCancelFinishAction, rflCancelReleaseAction, rflCancelResolveAction, rflCancelWithdrawAction, rflSuspendAction,
} from "./recurringFeeActions";
import { buttonClass, dangerButtonClass, Disclosure, inputClass, KIND_TEXT, labelClass, shortId } from "./RecurringFeesDisclosure";

/**
 * (e) controlled cancellation and (h) immediate safety suspension.
 * DanceFlow NEVER cancels anything at Twilio. A cancellation is authorized here (a written reference, a decision type and an irreversibility
 * acknowledgement), the operator performs the console step themselves, and then records the evidence digest. A provider NUMBER also needs an approved
 * dual-control request first. The safety suspension stops DanceFlow sending only; it never waits for a second administrator.
 * TW-4F F5: where the cancellation runtime is switched on and installed (`cancelReleaseAvailable`; off everywhere today), an authorized operation also
 * offers "Release at Twilio now", which claims, releases ONCE, reads back and records. The manual path stays beside it.
 */

const OperationId = ({ value = null }: { value?: string | null }) => (
  value ? (
    <div className={labelClass}>
      Cancellation operation <span className="font-mono font-normal">{value.slice(0, 8)}</span>
      <input type="hidden" name="operationId" value={value} />
    </div>
  ) : (
  <label className={labelClass}>
    Cancellation operation id
    <input name="operationId" required pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" className={`${inputClass} font-mono`} />
  </label>
  )
);

const Note = ({ label = "Note (10 to 500 characters)" }: { label?: string }) => (
  <label className={labelClass}>
    {label}
    <textarea name="note" required minLength={10} maxLength={500} rows={2} className={inputClass} />
  </label>
);

export default function RecurringFeesCancel({ overview, dual, releaseAvailable }: { overview: RflOverview | null; dual: RflDualRequest[] | null; releaseAvailable?: boolean }) {
  const release = releaseAvailable ?? cancelReleaseAvailable();
  if (!overview) {
    return (
      <Disclosure title="Cancellation and safety suspension" summary="not available">
        <p className="text-slate-600">Not available: the resource overview is not installed in this environment.</p>
      </Disclosure>
    );
  }
  const live = overview.resources.filter((r) => r.providerState === "active");
  const studios = [...new Set(overview.resources.map((r) => r.studioId))];
  return (
    <Disclosure title="Cancellation and safety suspension" summary={`${overview.cancelOperationsOpen} open cancellation operation(s) · ${live.length} live resource(s)`} open={overview.cancelOperationsOpen > 0}>
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        {release
          ? "DanceFlow can release an authorized resource at Twilio from here (once, with a provider read as evidence), or you perform the console step yourself and record the evidence digest. A provider cancellation cannot be undone."
          : "DanceFlow never cancels anything at Twilio. You authorize here, perform the console step yourself, and record the evidence digest of what the console showed. A provider cancellation cannot be undone."}
      </p>

      <Disclosure title="Immediate safety suspension" summary="stops DanceFlow sending only; never waits for a second administrator">
        <p className="text-xs text-slate-700">
          Stops DanceFlow from sending for one location right now. It does not cancel, release or change anything at Twilio: the provider fees continue. Use it first if a resource is being billed without cover.
        </p>
        {studios.length === 0 ? <p className="text-slate-600">No registered location.</p> : (
          <form action={rflSuspendAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
            <label className={labelClass}>
              Location
              <select name="studioId" required className={inputClass}>
                {studios.map((s) => <option key={s} value={s}>{`Location ${shortId(s)}`}</option>)}
              </select>
            </label>
            <label className={labelClass}>
              Written reason (10 to 500 characters)
              <textarea name="reason" required minLength={10} maxLength={500} rows={2} className={inputClass} />
            </label>
            <button type="submit" className={dangerButtonClass}>Suspend DanceFlow sending now</button>
          </form>
        )}
      </Disclosure>

      <Disclosure title="Resources" summary={`${live.length} live`} open={overview.cancelOperationsOpen > 0}>
        {live.length === 0 ? <p className="text-slate-600">No live recurring-fee resource.</p> : null}
        <ul className="space-y-3">
          {live.map((r) => {
            const op = r.openCancelOperation;
            const needsDual = r.kind === "number";
            const approvedRequest = dual?.find((d) => d.action === "cancel_number" && d.status === "approved" && d.resourceId === r.resourceId) ?? null;
            const approved = approvedRequest !== null;
            return (
              <li key={r.resourceId} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
                <p className="text-slate-900">
                  {KIND_TEXT[r.kind]} {shortId(r.resourceId)} · location {shortId(r.studioId)} · {r.feeKind ?? "no fee"} · DanceFlow sending {r.dfSending === null ? "unknown" : r.dfSending ? "on" : "stopped"}
                  {op ? ` · cancellation ${op.replace("_", " ")}` : ""}
                </p>
                {!op && !needsDual ? <Authorize resourceId={r.resourceId} /> : null}
                {!op && needsDual && approved ? <Authorize resourceId={r.resourceId} dualApproved approvedRequest={approvedRequest} /> : null}
                {!op && needsDual && !approved ? (
                  <p className="text-xs text-slate-700">A number needs an approved dual-control request before a cancellation can be authorized. Request it under Dual-control requests.</p>
                ) : null}
                {op === "authorized" && release ? <Release operationId={r.openCancelOperationId} isNumber={r.kind === "number"} /> : null}
                {op === "authorized" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <form action={rflCancelBeginAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
                      <p className="text-xs text-slate-700">Begin records the single claim. DanceFlow still cancels nothing: you perform the console step.</p>
                      <OperationId value={r.openCancelOperationId} />
                      <button type="submit" className={buttonClass}>Begin cancellation claim</button>
                    </form>
                    <form action={rflCancelWithdrawAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
                      <OperationId value={r.openCancelOperationId} />
                      <Note label="Withdrawal note (10 to 500 characters)" />
                      <button type="submit" className={buttonClass}>Withdraw authorization</button>
                    </form>
                  </div>
                ) : null}
                {op === "in_flight" ? <Finish operationId={r.openCancelOperationId} /> : null}
                {op === "unknown_outcome" ? <Resolve operationId={r.openCancelOperationId} /> : null}
              </li>
            );
          })}
        </ul>
      </Disclosure>
    </Disclosure>
  );
}

function Authorize({ resourceId, dualApproved = false, approvedRequest = null }: { resourceId: string; dualApproved?: boolean; approvedRequest?: RflDualRequest | null }) {
  const lockedDecision = approvedRequest?.decidedBy ?? null;
  return (
    <Disclosure title="Authorize a cancellation" summary={dualApproved ? "dual-control approved" : "written reference required"}>
      <form action={rflCancelAuthorizeAction} className="space-y-2">
        <input type="hidden" name="resourceId" value={resourceId} />
        {dualApproved ? <p className="text-xs text-emerald-900">An approved second-administrator request exists. The reference and reason below are filled in from the approved request and must stay identical; the approval is consumed once.</p> : null}
        <label className={labelClass}>
          Written approval reference (10 to 200 characters)
          <input name="approvalRef" required minLength={10} maxLength={200} defaultValue={approvedRequest?.approvalRef ?? undefined} className={inputClass} />
        </label>
        <label className={labelClass}>
          Decision type
          {lockedDecision ? (
            <>
              <input type="hidden" name="decidedBy" value={lockedDecision} />
              <span className="mt-1 block text-sm font-normal text-slate-900">{lockedDecision === "owner_written" ? "Studio owner, in writing" : "DanceFlow founder, in writing"} (fixed by the approved request)</span>
            </>
          ) : (
            <select name="decidedBy" required defaultValue="" className={inputClass}>
              <option value="" disabled>Choose the decision type</option>
              <option value="owner_written">Studio owner, in writing</option>
              <option value="founder_written">DanceFlow founder, in writing</option>
              {dualApproved ? null : <option value="policy_lapse">Policy lapse (never for a number)</option>}
            </select>
          )}
        </label>
        <label className={labelClass}>
          Reason (10 to 500 characters)
          <textarea name="reason" required minLength={10} maxLength={500} rows={2} defaultValue={approvedRequest?.reason} className={inputClass} />
        </label>
        <label className="flex items-start gap-2 text-xs text-slate-700">
          <input type="checkbox" name="irreversibleAck" value="yes" required className="mt-0.5" />
          <span>I understand a provider cancellation cannot be undone and that DanceFlow will not perform it: I do the console step myself.</span>
        </label>
        <button type="submit" className={dangerButtonClass}>Authorize cancellation</button>
      </form>
    </Disclosure>
  );
}

function Release({ operationId, isNumber }: { operationId: string | null; isNumber: boolean }) {
  return (
    <form action={rflCancelReleaseAction} className="space-y-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
      <p className="text-xs text-red-900">
        Release at Twilio now: DanceFlow claims this operation, sends ONE release request, reads the resource back and records the result. An unknown outcome is never repeated.
        {isNumber ? " The number needs the consumed approval of two different administrators." : ""}
      </p>
      <OperationId value={operationId} />
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" name="releaseAck" value="yes" required className="mt-0.5" />
        <span>I understand DanceFlow will release this resource at Twilio now and that it cannot be undone.</span>
      </label>
      <button type="submit" className={dangerButtonClass}>Release at Twilio now</button>
    </form>
  );
}

function Finish({ operationId }: { operationId: string | null }) {
  return (
    <form action={rflCancelFinishAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
      <p className="text-xs text-slate-700">After the console step, record what happened. Nothing was cancelled by DanceFlow.</p>
      <OperationId value={operationId} />
      <label className={labelClass}>
        Outcome
        <select name="outcome" required className={inputClass}>
          <option value="confirmed">Cancelled (console confirmed)</option>
          <option value="refused">Twilio refused</option>
          <option value="unknown">Outcome unknown</option>
        </select>
      </label>
      <label className={labelClass}>
        Evidence digest of the provider read (exactly 64 lowercase hex characters; required for cancelled and still active)
        <input name="evidenceDigest" maxLength={64} pattern="[0-9a-f]{64}" className={`${inputClass} font-mono`} />
      </label>
      <label className={labelClass}>
        Error code (api only for a definite provider refusal)
        <input name="errorCode" maxLength={40} className={inputClass} />
      </label>
      <button type="submit" className={buttonClass}>Record outcome</button>
    </form>
  );
}

function Resolve({ operationId }: { operationId: string | null }) {
  return (
    <form action={rflCancelResolveAction} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
      <p className="text-xs text-slate-700">The earlier outcome is unknown. Look the resource up in the Twilio console first, then record what you found.</p>
      <OperationId value={operationId} />
      <label className={labelClass}>
        Resolution
        <select name="resolution" required className={inputClass}>
          <option value="cancelled">It is cancelled</option>
          <option value="still_active">It is still active</option>
        </select>
      </label>
      <label className={labelClass}>
        Evidence digest of the provider read (exactly 64 lowercase hex characters; required for cancelled and still active)
        <input name="evidenceDigest" maxLength={64} pattern="[0-9a-f]{64}" className={`${inputClass} font-mono`} />
      </label>
      <Note />
      <button type="submit" className={buttonClass}>Resolve operation</button>
    </form>
  );
}
