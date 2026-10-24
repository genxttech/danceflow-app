import type { RflOverview } from "@/lib/sms/providerFeeOps";
import { APPROVAL_REF_MAX, APPROVAL_REF_MIN, DOCUMENT_REF_MAX, EVIDENCE_MAX_AGE_DAYS, EVIDENCE_ROLES, EVIDENCE_ROLE_LABEL } from "@/lib/sms/pilotApprovalEvidence";
import { rflPilotCoverAction } from "./recurringFeeActions";
import { buttonClass, Disclosure, inputClass, KIND_TEXT, labelClass, shortId } from "./RecurringFeesDisclosure";

/**
 * (g) ConfiDance (the pilot business) per-period written approval. The pilot business has NO standing authorization: each approval covers ONE service
 * period of ONE resource, needs ONE written reference, counts against the cumulative $150 pilot ceiling, is never automatic, and the ceiling is never
 * released or replenished (not after a cancellation, a retirement or an unused approval). Only the current or the next period can be approved.
 * Shown only for resources the data marks as belonging to the pilot business.
 */

const monthKey = (ms: number, add: number): string => {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
};

export default function RecurringFeesPilot({ overview, now }: { overview: RflOverview | null; now: number }) {
  const pilot = (overview?.resources ?? []).filter((r) => r.pilot && r.providerState === "active" && r.feeKind);
  if (!overview || pilot.length === 0) return null;
  return (
    <Disclosure title="Pilot per-period written approvals" summary={`${pilot.length} resource(s) of the pilot business`}>
      <ul className="list-disc space-y-1 pl-5 text-xs text-slate-700">
        <li>The pilot business has no standing authorization. Each approval covers one period of one resource.</li>
        <li>One written reference per approval. The same reference cannot be reused. The reference alone is not authorization: the owner&apos;s dated written authorization is recorded as evidence (hash and reference only).</li>
        <li>Approvals count against the cumulative $150 pilot ceiling. The ceiling is never released or replenished automatically.</li>
        <li>Nothing renews or charges by itself: every period needs a new approval, and only the current or the next period can be approved.</li>
      </ul>
      <ul className="space-y-3">
        {pilot.map((r) => {
          const periods = [
            { key: monthKey(now, 0), cover: r.currentPeriod },
            { key: monthKey(now, 1), cover: r.nextPeriod },
          ].filter((p) => !(p.cover ?? "").startsWith("covered:"));
          return (
            <li key={r.resourceId} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
              <p className="text-slate-900">{KIND_TEXT[r.kind]} {shortId(r.resourceId)} · location {shortId(r.studioId)} · {r.feeKind}</p>
              {periods.length === 0 ? (
                <p className="text-xs text-emerald-900">The current and next periods are already covered.</p>
              ) : (
                <form action={rflPilotCoverAction} className="space-y-2">
                  <input type="hidden" name="resourceId" value={r.resourceId} />
                  <label className={labelClass}>
                    Period
                    <select name="periodKey" required defaultValue="" className={inputClass}>
                      <option value="" disabled>Choose a period</option>
                      {periods.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
                    </select>
                  </label>
                  <p className="text-xs text-slate-600">These months are shown in UTC. The database enforces the business&apos;s own month (its time zone), and refuses a period outside the current or next one.</p>
                  <label className={labelClass}>
                    Written approval reference ({APPROVAL_REF_MIN} to {APPROVAL_REF_MAX} characters)
                    <input name="approvalRef" required minLength={APPROVAL_REF_MIN} maxLength={APPROVAL_REF_MAX} className={inputClass} />
                  </label>
                  <p className="text-xs text-slate-600">
                    The reference alone is not authorization. Record the owner&apos;s dated written authorization below. DanceFlow stores only the date, who authorized it, the scope, the amount, the period,
                    the document id or link and the sha256 of the retained text. The text itself is never entered here and never stored.
                  </p>
                  <label className={labelClass}>
                    Date of the owner&apos;s written authorization (not in the future, not older than {EVIDENCE_MAX_AGE_DAYS} days)
                    <input type="date" name="authorizedOn" required className={inputClass} />
                  </label>
                  <label className={labelClass}>
                    Authorized by (as stated in the written authorization)
                    <select name="authorizedByRole" required defaultValue="" className={inputClass}>
                      <option value="" disabled>Choose who authorized</option>
                      {EVIDENCE_ROLES.map((role) => <option key={role} value={role}>{EVIDENCE_ROLE_LABEL[role]}</option>)}
                    </select>
                  </label>
                  <label className={labelClass}>
                    Scope
                    <input name="scope" readOnly value="pilot_period_cover" className={inputClass} />
                  </label>
                  <label className={labelClass}>
                    Authorized amount in dollars, for example 25.00 (must equal the published price of this fee; anything else is refused)
                    <input name="amountUsd" required inputMode="decimal" pattern="[0-9]{1,5}(\.[0-9]{1,2})?" className={inputClass} />
                  </label>
                  <label className={labelClass}>
                    Retained document: an id or a plain https link (no query string, no credentials)
                    <input name="documentRef" required minLength={6} maxLength={DOCUMENT_REF_MAX} className={inputClass} />
                  </label>
                  <label className={labelClass}>
                    sha256 of the retained authorization text (64 lowercase hex characters)
                    <input name="documentSha256" required minLength={64} maxLength={64} pattern="[0-9a-f]{64}" autoComplete="off" className={inputClass} />
                  </label>
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input type="checkbox" name="ack" value="yes" required className="mt-0.5" />
                    <span>This is one written approval for one period of this resource. It is not a standing authorization and will not repeat.</span>
                  </label>
                  <button type="submit" className={buttonClass}>Record period approval</button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}
