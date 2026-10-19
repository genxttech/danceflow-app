"use client";

import { useEffect, useRef, useState } from "react";
import { startCreditCheckout } from "@/lib/billing/smsCreditCheckoutClient";
import {
  ACTIVITY_LABEL,
  CREDIT_MAX_BALANCE_CENTS,
  CREDIT_PACKS_CENTS,
  PRICE_LABEL,
  PURCHASE_LABEL,
  deriveCreditState,
  formatUsd,
  packFits,
  type CreditState,
  type CreditView,
} from "@/lib/billing/smsCreditView";

type Panel = "add" | "activity" | null;

const STATE_NOTE: Record<Exclude<CreditState, "ok" | "no_business">, { tone: "amber" | "red"; text: string }> = {
  on_hold: { tone: "red", text: "Your texting credit is on hold by DanceFlow, so credit cannot be spent right now. Contact support before adding more." },
  negative: { tone: "red", text: "Your balance is below zero after a refund or dispute. New credit first covers the shortfall, and nothing can be charged until the balance is positive." },
  insufficient: { tone: "red", text: "No credit is available, so steps and usage that cost money cannot run from credit. Add credit to continue." },
  low: { tone: "amber", text: "Your credit is running low. Add credit to avoid interruptions." },
};

const TERMS = [
  "Credit is prepaid and is added only after your payment is confirmed.",
  `A business can hold at most ${formatUsd(CREDIT_MAX_BALANCE_CENTS)} of credit, counting purchases still waiting for payment.`,
  "DanceFlow never tops up automatically and never saves your card for credit. Every purchase is started by you.",
  "Fees that DanceFlow approves with you, such as setup and monthly service, are taken from your credit when they are charged. Refunded or disputed payments reduce your credit.",
  "Credit belongs to your legal business and is shared by all of its locations; it cannot be moved to another business.",
];

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

export default function SmsCreditPanel({ view, purchasesEnabled, returned, initialPanel = null, initialPack = null }: { view: CreditView; purchasesEnabled: boolean; returned: "success" | "cancelled" | null; initialPanel?: Panel; initialPack?: number | null }) {
  const { overview } = view;
  const state = deriveCreditState(overview);
  const [panel, setPanel] = useState<Panel>(initialPanel);
  const [pack, setPack] = useState<number | null>(initialPack);
  const [busy, setBusy] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!panel) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      openerRef.current?.focus(); // give focus back to the button that opened the panel
    };
  }, [panel]);

  if (state === "no_business") {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <h2 className="text-base font-semibold text-slate-900">Texting credit</h2>
        <p className="mt-1">Texting credit becomes available once your legal business is verified.</p>
      </section>
    );
  }

  async function buy() {
    if (!pack || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await startCreditCheckout(pack);
    if (outcome.ok) {
      window.location.assign(outcome.url);
      return; // leaving the page: keep the button busy so it cannot be pressed twice
    }
    setError(outcome.message);
    setBusy(false);
  }

  const note = state === "ok" ? null : STATE_NOTE[state];
  const prices = view.prices;
  const noteClass = note?.tone === "red" ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <section aria-labelledby="sms-credit-heading" className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sms-credit-heading" className="text-base font-semibold text-slate-900">Texting credit</h2>
          <p className="mt-0.5 text-xs text-slate-500">One balance for your whole legal business, shared by all of its locations.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={(e) => { openerRef.current = e.currentTarget; setPanel("activity"); }} className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Activity</button>
          <button type="button" onClick={(e) => { openerRef.current = e.currentTarget; setPanel("add"); }} className="rounded-xl bg-violet-700 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-800">Add credit</button>
        </div>
      </div>

      {returned === "success" ? (
        <p role="status" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Thanks. Credit appears here once your payment is confirmed, usually within a minute.
        </p>
      ) : returned === "cancelled" ? (
        <p role="status" className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">The payment was cancelled. Nothing was charged.</p>
      ) : null}

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Available</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(overview.availableCents)}</dd>
          {overview.balanceCents < 0 ? <p className="text-xs font-semibold text-red-700">Balance: {formatUsd(overview.balanceCents)}</p> : null}
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reserved</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(overview.reservedCents)}</dd>
          <p className="text-xs text-slate-500">Held for a step in progress</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Waiting for payment</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(overview.pendingCents)}</dd>
          <p className="text-xs text-slate-500">Not spendable until confirmed</p>
        </div>
      </dl>

      {note ? (
        <p role="alert" className={`mt-3 rounded-xl border px-3 py-2 text-sm ${noteClass}`}>{note.text}</p>
      ) : null}

      {overview.pilotCeilingCents != null ? (
        <p className="mt-3 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          Pilot allowance: {formatUsd(overview.pilotUsedCents)} of {formatUsd(overview.pilotCeilingCents)} used for approved setup fees. It is not credit, cannot pay for texting, and each use needs its own approval.
        </p>
      ) : null}

      {panel ? (
        <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
          <button type="button" aria-label="Close panel" tabIndex={-1} className="absolute inset-0 bg-slate-900/40" onClick={() => setPanel(null)} />
          <aside role="dialog" aria-modal="true" aria-labelledby="sms-credit-panel-title" className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <h3 id="sms-credit-panel-title" className="text-lg font-semibold text-slate-900">{panel === "add" ? "Add texting credit" : "Credit activity"}</h3>
              <button ref={closeRef} type="button" onClick={() => setPanel(null)} className="rounded-lg px-2 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-100">Close</button>
            </div>

            {panel === "add" ? (
              <div className="mt-4 space-y-5">
                <fieldset>
                  <legend className="text-sm font-semibold text-slate-800">Choose a pack</legend>
                  <div className="mt-2 grid gap-2">
                    {CREDIT_PACKS_CENTS.map((cents) => {
                      const fits = packFits(overview, cents);
                      return (
                        <label key={cents} className={`flex items-center justify-between rounded-xl border px-3 py-3 text-sm ${pack === cents ? "border-violet-600 bg-violet-50" : "border-slate-200"} ${fits ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
                          <span className="flex items-center gap-3">
                            <input type="radio" name="pack" value={cents} disabled={!fits} checked={pack === cents} onChange={() => setPack(cents)} />
                            <span className="font-semibold text-slate-900">{formatUsd(cents)}</span>
                          </span>
                          {fits ? null : <span className="text-xs text-slate-500">Would go over {formatUsd(CREDIT_MAX_BALANCE_CENTS)}</span>}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <div>
                  <h4 className="text-sm font-semibold text-slate-800">What credit pays for</h4>
                  {prices.length ? (
                    <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
                      {prices.map((price) => (
                        <li key={price.kind} className="flex items-start justify-between gap-3 px-3 py-2">
                          <span>
                            <span className="font-medium text-slate-900">{PRICE_LABEL[price.kind] ?? price.kind}</span>
                            {price.kind === "monthly" ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Recurring</span> : null}
                            <span className="block text-xs text-slate-500">{price.description}</span>
                          </span>
                          <span className="shrink-0 font-semibold text-slate-900">{formatUsd(price.customerPriceCents)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">Prices are listed here before anything is charged.</p>
                  )}
                </div>

                <div>
                  <h4 className="text-sm font-semibold text-slate-800">Purchase terms</h4>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                    {TERMS.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-slate-500">Final purchase terms are not yet published.</p>
                </div>

                {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}
                {overview.onHold ? <p role="status" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">Credit is on hold, so purchases are paused.</p> : null}
                {!purchasesEnabled ? <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">Credit purchases are not open yet.</p> : null}

                <button type="button" onClick={buy} disabled={!purchasesEnabled || overview.onHold || !pack || busy} className="w-full rounded-xl bg-violet-700 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy ? "Opening secure payment…" : pack ? `Pay ${formatUsd(pack)} securely` : "Choose a pack"}
                </button>
              </div>
            ) : (
              <div className="mt-4 space-y-5">
                <div>
                  <h4 className="text-sm font-semibold text-slate-800">Purchases</h4>
                  {view.purchases === null ? (
                    <p className="mt-2 text-sm text-slate-600">Purchases could not be loaded right now.</p>
                  ) : view.purchases.length ? (
                    <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
                      {view.purchases.map((purchase, index) => (
                        <li key={`${purchase.createdAt}-${index}`} className="flex items-start justify-between gap-3 px-3 py-2">
                          <span>
                            <span className="font-medium text-slate-900">{PURCHASE_LABEL[purchase.status]}</span>
                            <span className="block text-xs text-slate-500">{when(purchase.createdAt)} · {purchase.thisLocation ? "This location" : "Another location"}</span>
                            {purchase.refundedCents + purchase.disputedCents > 0 ? <span className="block text-xs text-amber-700">{formatUsd(purchase.refundedCents + purchase.disputedCents)} refunded or disputed</span> : null}
                          </span>
                          <span className="shrink-0 font-semibold text-slate-900">{formatUsd(purchase.amountCents)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">No purchases yet.</p>
                  )}
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-slate-800">Recent credit activity</h4>
                  {view.activity.length ? (
                    <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
                      {view.activity.map((entry) => (
                        <li key={entry.seq} className="flex items-start justify-between gap-3 px-3 py-2">
                          <span>
                            <span className="font-medium text-slate-900">{ACTIVITY_LABEL[entry.kind]}</span>
                            <span className="block text-xs text-slate-500">{when(entry.createdAt)} · {entry.hasLocation ? (entry.thisLocation ? "This location" : "Another location") : "DanceFlow"}</span>
                          </span>
                          <span className={`shrink-0 font-semibold ${entry.balanceDeltaCents < 0 ? "text-slate-900" : entry.balanceDeltaCents > 0 ? "text-emerald-700" : "text-slate-500"}`}>
                            {entry.balanceDeltaCents === 0 ? (entry.kind === "release" ? "released" : "held") : `${entry.balanceDeltaCents > 0 ? "+" : ""}${formatUsd(entry.balanceDeltaCents)}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">Nothing yet.</p>
                  )}
                  <p className="mt-2 text-xs text-slate-500">This location&apos;s net charges so far: {formatUsd(overview.thisLocationNetChargesCents)}.</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      ) : null}
    </section>
  );
}
