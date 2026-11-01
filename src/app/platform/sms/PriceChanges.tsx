import { PRICE_KIND_TEXT, type PriceChangeOverview, type PriceChangeRequest } from "@/lib/sms/priceChange";
import { priceApprove, priceFreeze, pricePropose, priceReject, priceReportCompromise, priceRevise } from "./priceChangeActions";
import PriceAuthorize from "./PriceAuthorize";
import { buttonClass, dangerButtonClass, dollars, Disclosure, inputClass, labelClass, shortId, stamp } from "./RecurringFeesDisclosure";

/**
 * SMS price changes. A price is never edited in place: a platform administrator PROPOSES a new price and a DIFFERENT platform administrator APPROVES it. A proposal
 * changes nothing. The proposer sees no approve control (and the database refuses it regardless: the database is the authority, this page only reflects it).
 * An approval is bound to the exact amounts and the price that was active when the proposal was made; if that price has changed, or 24 hours pass, the proposal is void.
 * Amounts appear in dollars in this administrator panel only. Nothing here calls Twilio or Stripe, or moves money.
 */

const STATUS_TEXT: Record<string, string> = {
  pending: "waiting for a second administrator", approved: "approved", applied: "approved and in effect", rejected: "rejected or withdrawn", expired: "expired", invalidated: "invalidated",
};

function Compare({ r, current }: { r: PriceChangeRequest; current: PriceChangeOverview["active"][number] | undefined }) {
  return (
    <table className="w-full text-left text-xs text-slate-800">
      <caption className="sr-only">Current prices compared with the proposed prices</caption>
      <thead>
        <tr>
          <th scope="col" className="pr-3 font-semibold"><span className="sr-only">Row</span></th>
          <th scope="col" className="pr-3 font-semibold">Customer price</th>
          <th scope="col" className="font-semibold">DanceFlow provider cost</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row" className="pr-3 font-semibold">Active when proposed</th>
          <td className="pr-3">{dollars(r.baseCustomerPriceCents)}</td>
          <td>{dollars(r.baseProviderCostCents)}</td>
        </tr>
        {current && r.baseChanged ? (
          <tr>
            <th scope="row" className="pr-3 font-semibold">Active now</th>
            <td className="pr-3">{dollars(current.customerPriceCents)}</td>
            <td>{dollars(current.providerCostCents)}</td>
          </tr>
        ) : null}
        <tr>
          <th scope="row" className="pr-3 font-semibold">Proposed</th>
          <td className="pr-3 font-semibold">{dollars(r.customerPriceCents)}</td>
          <td className="font-semibold">{dollars(r.providerCostCents)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function PriceChanges({ overview, adminId, notice = null, error = null }: { overview: PriceChangeOverview | null; adminId: string; notice?: string | null; error?: string | null }) {
  const pending = overview?.requests.filter((r) => r.status === "pending") ?? [];
  const decided = overview?.requests.filter((r) => r.status !== "pending") ?? [];
  const activeOf = (kind: string) => overview?.active.find((a) => a.kind === kind);
  return (
    <section id="price-changes" aria-labelledby="price-changes-title" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="price-changes-title" className="text-base font-semibold text-slate-900">SMS price changes</h2>
      <p className="text-sm text-slate-700">
        In single-owner mode the owner proposes, waits a mandatory 24 hours, and then authorizes from a separate sign-in with a hardware key that signs the exact change; in team mode two different registered administrators are required and you can never approve your own proposal. A proposal changes no price
        until it is approved, expires after 24 hours, and is voided if the active price changes first. Changing a price moves no money and does not alter any past charge.
      </p>
      {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}
      {overview?.frozen ? <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">Price publication is SUSPENDED. Nothing can be published until the suspension is lifted with the hardware key.</p> : null}
      {!overview ? <p className="text-sm text-slate-600">Not available: price change control is not installed in this environment, so prices cannot be changed.</p> : null}
      {overview ? (
        <>
          <Disclosure title="Published prices" summary={`${overview.active.length} active`}>
            {overview.active.length === 0 ? <p className="text-slate-600">No price is published yet.</p> : null}
            <ul className="space-y-1">
              {overview.active.map((a) => (
                <li key={a.priceId} className="text-xs text-slate-800">
                  {PRICE_KIND_TEXT[a.kind] ?? a.kind}: customer {dollars(a.customerPriceCents)} · provider cost {dollars(a.providerCostCents)} · {a.description}
                </li>
              ))}
            </ul>
          </Disclosure>

          <Disclosure title="Waiting for a second administrator" summary={`${pending.length} open`} open={pending.length > 0}>
            {pending.length === 0 ? <p className="text-slate-600">No price change is waiting.</p> : null}
            <ul className="space-y-3">
              {pending.map((r) => {
                const mine = r.requestedBy === adminId;
                return (
                  <li key={r.requestId} className="space-y-2 rounded-xl border border-slate-200 px-3 py-2">
                    <p className="text-slate-900">{PRICE_KIND_TEXT[r.kind] ?? r.kind} · {STATUS_TEXT[r.status]} · request {shortId(r.requestId)}</p>
                    <Compare r={r} current={activeOf(r.kind)} />
                    <p className="text-xs text-slate-700">Description: {r.description}</p>
                    <p className="text-xs text-slate-700">Reason: {r.reason}</p>
                    <p className="text-xs text-slate-600">Proposed {stamp(r.requestedAt)} by {mine ? "you" : `administrator ${shortId(r.requestedBy)}`} · expires {stamp(r.expiresAt)}</p>
                    {r.baseChanged ? <p className="text-xs font-semibold text-amber-900">The active price changed after this proposal was made. An approval will void it; propose again.</p> : null}
                    {r.approvalMode === "owner" ? (
                      <div className="space-y-2">
                        <p className="text-xs text-slate-700">Single-owner proposal, version {r.proposalVersion}. Mandatory cooling-off until {stamp(r.coolingUntil)}; it never publishes by itself. After that, authorize from a SEPARATE sign-in with your hardware key.</p>
                        {mine ? <PriceAuthorize requestId={r.requestId} /> : <p className="text-xs font-semibold text-amber-900">Only the owner who proposed this change can authorize it.</p>}
                        {mine ? (
                          <form action={priceRevise} className="space-y-2">
                            <input type="hidden" name="requestId" value={r.requestId} />
                            <p className="text-xs text-slate-700">Changing the proposal voids this one and every signature over it, and restarts the 24-hour cooling-off.</p>
                            <label className={labelClass}>New customer price in dollars<input name="customerUsd" required inputMode="decimal" pattern="[0-9]{1,5}(\.[0-9]{1,2})?" className={inputClass} /></label>
                            <label className={labelClass}>New provider cost in dollars<input name="providerUsd" required inputMode="decimal" pattern="[0-9]{1,5}(\.[0-9]{1,2})?" className={inputClass} /></label>
                            <label className={labelClass}>Description<input name="description" required minLength={3} maxLength={200} className={inputClass} /></label>
                            <label className={labelClass}>Reason<textarea name="reason" required minLength={10} maxLength={500} rows={2} className={inputClass} /></label>
                            <button type="submit" className={buttonClass}>Revise and restart the cooling-off</button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="space-y-2">
                      {r.approvalMode === "owner" ? null : mine ? (
                        <p className="text-xs font-semibold text-amber-900">You proposed this change, so a different administrator must approve it. You can withdraw it.</p>
                      ) : (
                        <form action={priceApprove} className="space-y-2">
                          <input type="hidden" name="requestId" value={r.requestId} />
                          <label className={labelClass}>
                            Approval note (10 to 500 characters)
                            <textarea name="note" required minLength={10} maxLength={500} rows={2} className={inputClass} />
                          </label>
                          <button type="submit" className={buttonClass}>Approve and publish this price</button>
                        </form>
                      )}
                      <form action={priceReject} className="space-y-2">
                        <input type="hidden" name="requestId" value={r.requestId} />
                        <label className={labelClass}>
                          {mine ? "Withdrawal note" : "Rejection note"} (10 to 500 characters)
                          <textarea name="note" required minLength={10} maxLength={500} rows={2} className={inputClass} />
                        </label>
                        <button type="submit" className={dangerButtonClass}>{mine ? "Withdraw proposal" : "Reject proposal"}</button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Disclosure>

          <Disclosure title="Propose a price change" summary="does not change any price">
            <form action={pricePropose} className="space-y-2">
              <label className={labelClass}>
                Price
                <select name="kind" required defaultValue="" className={inputClass}>
                  <option value="" disabled>Choose the price to change</option>
                  {Object.entries(PRICE_KIND_TEXT).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                </select>
              </label>
              <label className={labelClass}>
                New customer price in dollars (for example 2.00)
                <input name="customerUsd" required inputMode="decimal" pattern="[0-9]{1,5}(\.[0-9]{1,2})?" className={inputClass} />
              </label>
              <label className={labelClass}>
                DanceFlow provider cost in dollars (what Twilio is expected to charge; internal, never shown to studios)
                <input name="providerUsd" required inputMode="decimal" pattern="[0-9]{1,5}(\.[0-9]{1,2})?" className={inputClass} />
              </label>
              <label className={labelClass}>
                Description (3 to 200 characters)
                <input name="description" required minLength={3} maxLength={200} className={inputClass} />
              </label>
              <label className={labelClass}>
                Reason for the change (10 to 500 characters)
                <textarea name="reason" required minLength={10} maxLength={500} rows={2} className={inputClass} />
              </label>
              <button type="submit" className={buttonClass}>Propose price change</button>
            </form>
          </Disclosure>

          <Disclosure title="Suspend price publication" summary="can only suspend">
            <p className="text-xs text-slate-700">A suspension can never publish or change a price. Lifting it needs the hardware key.</p>
            <form action={priceFreeze} className="space-y-2">
              <label className={labelClass}>Reason (10 to 300 characters)<textarea name="reason" required minLength={10} maxLength={300} rows={2} className={inputClass} /></label>
              <button type="submit" className={dangerButtonClass}>Suspend price publication</button>
            </form>
            <form action={priceReportCompromise} className="space-y-2">
              <label className={labelClass}>I suspect my sign-in or hardware key is compromised (10 to 300 characters)<textarea name="note" required minLength={10} maxLength={300} rows={2} className={inputClass} /></label>
              <button type="submit" className={dangerButtonClass}>Report a compromise (suspends publication)</button>
            </form>
          </Disclosure>

          <Disclosure title="Decided proposals" summary={`${decided.length} recorded`}>
            {decided.length === 0 ? <p className="text-slate-600">None yet.</p> : null}
            <ul className="space-y-2">
              {decided.map((r) => (
                <li key={r.requestId} className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-800">
                  {PRICE_KIND_TEXT[r.kind] ?? r.kind} · {dollars(r.baseCustomerPriceCents)} to {dollars(r.customerPriceCents)} · {STATUS_TEXT[r.status]} · proposed {stamp(r.requestedAt)} by{" "}
                  {r.requestedBy === adminId ? "you" : shortId(r.requestedBy)}
                  {r.decidedBy ? ` · decided by ${r.decidedBy === adminId ? "you" : shortId(r.decidedBy)} ${stamp(r.decidedAt)}` : ""}
                  {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                </li>
              ))}
            </ul>
          </Disclosure>
        </>
      ) : null}
    </section>
  );
}
