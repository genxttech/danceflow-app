"use client";

import { useActionState, useState } from "react";
import { usd } from "@/lib/sms/provisioning/journey";
import type { OwnerNumberOffers } from "@/lib/sms/provisioning/ownerRead";
import { approveNumberAction, withdrawNumberAction, type NumberActionState } from "./numberActions";

/**
 * The page remounts this component (key) whenever the approval or the offer changes, so a result or an error never outlives the state it was about.
 *
 * TW-4F J3: the studio owner chooses ONE offered texting number and approves its published monthly price, or withdraws an open approval. Rendered only for the
 * owner, only when the owner offers read says the number step is open. The form carries only the owner's choice and the price they saw; the server action
 * re-reads the offers, and the database re-checks everything. Approving buys nothing by itself: DanceFlow secures the number afterwards.
 */

export const formatNumber = (e164: string) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;

const PILOT = "Covered by your business's pilot arrangement: each number needs its own written approval inside the pilot limit, and nothing renews automatically.";
const CREDIT = "Billed monthly from your prepaid texting credit under your recurring authorization of the number charge, within your monthly spending limit.";

export default function NumberSelection({ offers }: { offers: OwnerNumberOffers }) {
  const [approveState, approve, approving] = useActionState<NumberActionState, FormData>(approveNumberAction, {});
  const [withdrawState, withdraw, withdrawing] = useActionState<NumberActionState, FormData>(withdrawNumberAction, {});
  const [chosen, setChosen] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const price = offers.monthlyCents;
  const approval = offers.approval;

  return (
    <section id="sms-number" aria-labelledby="sms-number-heading" className="rounded-2xl border border-violet-200 bg-white p-5 shadow-sm" data-testid="sms-number-selection">
      <h2 id="sms-number-heading" className="text-base font-semibold text-slate-950">Your texting number</h2>

      {approveState.ok || withdrawState.ok ? (
        <p role="status" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" data-testid="sms-number-result">{approveState.notice ?? withdrawState.notice}</p>
      ) : null}
      {approval?.status === "open" ? (
        <div className="mt-3 space-y-3" data-testid="sms-number-approved">
          <p className="text-sm text-slate-800">
            You approved <span className="font-semibold">{formatNumber(approval.e164)}</span>. DanceFlow will secure it; nothing is complete until the provider confirms it.
          </p>
          <details className="text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold text-violet-800">What you approved</summary>
            <p className="mt-1">{approval.statement}</p>
          </details>
          <form action={withdraw}>
            <input type="hidden" name="selection_id" value={approval.selectionId} />
            <button type="submit" disabled={withdrawing} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50" data-testid="sms-number-withdraw">
              {withdrawing ? "Withdrawing…" : "Withdraw this approval"}
            </button>
          </form>
        </div>
      ) : approveState.ok ? null : !offers.stepOpen ? (
        <p className="mt-3 text-sm text-slate-700" data-testid="sms-number-waiting">The number step is not open right now. DanceFlow will let you know.</p>
      ) : offers.blocker === "pilot_ceiling" ? (
        <p className="mt-3 text-sm text-slate-700" data-testid="sms-number-blocked">Your pilot limit cannot cover another number right now. DanceFlow will follow up with you; nothing is needed from you yet.</p>
      ) : offers.blocker === "unpriced" || price == null ? (
        <p className="mt-3 text-sm text-slate-700" data-testid="sms-number-blocked">The monthly price for a texting number is not published yet, so a number cannot be approved. DanceFlow will let you know.</p>
      ) : offers.blocker !== "none" || !offers.offer || offers.offer.numbers.length === 0 ? (
        <p className="mt-3 text-sm text-slate-700" data-testid="sms-number-waiting">DanceFlow is preparing number options for you. They will appear here.</p>
      ) : (
        <form action={approve} className="mt-3 space-y-3" data-testid="sms-number-form">
          <input type="hidden" name="offer_id" value={offers.offer.offerId} />
          <input type="hidden" name="ack_price_cents" value={String(price)} />
          <fieldset>
            <legend className="text-sm text-slate-700">Choose one number. Each costs <span className="font-semibold">{usd(price)} per month</span>.</legend>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {offers.offer.numbers.map((n) => (
                <li key={n.e164}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:border-violet-300 has-[:checked]:border-violet-500 has-[:checked]:bg-violet-50">
                    <input type="radio" name="e164" value={n.e164} checked={chosen === n.e164} onChange={() => setChosen(n.e164)} data-testid="sms-number-option" />
                    <span className="font-medium text-slate-900">{formatNumber(n.e164)}</span>
                    {n.locality || n.region ? <span className="text-xs text-slate-500">{[n.locality, n.region].filter(Boolean).join(", ")}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <p className="text-xs text-slate-600">This is a recurring cost: {usd(price)} every month until the number is released. {offers.fundingMode === "pilot" ? PILOT : CREDIT} DanceFlow buys nothing until your approval, the published price and settled funding are all in place. Your approval covers one number and expires after 24 hours.</p>
          <label className="flex items-start gap-2 text-sm text-slate-800">
            <input type="checkbox" name="confirm" value="yes" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" data-testid="sms-number-confirm" />
            <span>I approve DanceFlow acquiring the selected number at {usd(price)} per month.</span>
          </label>
          <button type="submit" disabled={approving || !chosen || !confirmed} className="rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50" data-testid="sms-number-approve">
            {approving ? "Approving…" : "Approve this number"}
          </button>
        </form>
      )}

      {approveState.error || withdrawState.error ? <p role="alert" className="mt-2 text-sm font-medium text-rose-700" data-testid="sms-number-error">{approveState.error ?? withdrawState.error}</p> : null}
    </section>
  );
}
