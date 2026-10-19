"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authorizeRecurringCall, revokeRecurringCall } from "@/lib/billing/smsRecurringClient";
import { RECURRING_KIND_LABEL, RECURRING_TERMS, buildAuthorizationStatement, isRecurringKind, type RecurringKind, type RecurringOverview } from "@/lib/billing/smsRecurring";
import { formatUsd, type CreditPrice } from "@/lib/billing/smsCreditView";

const ISSUE_ACTION: Record<string, string> = {
  unfunded: "There is not enough credit to cover it. Add credit so it can be taken.",
  held: "Your credit is on hold by DanceFlow, so it cannot be taken. Contact support.",
  limit: "The amount you authorized has been used up. Authorize again to continue.",
  price: "The price changed since you authorized. Review the new price and authorize again.",
  waiting: "It has not been taken yet.",
};
const SERVICE_NOTE: Record<"past_due" | "suspended", { tone: "amber" | "red"; text: string }> = {
  past_due: { tone: "amber", text: "A monthly charge is due." },
  suspended: { tone: "red", text: "A monthly charge is overdue, so texting service is marked as paused. Your phone numbers are kept." },
};

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d);
}

export default function SmsRecurringPanel({
  overview,
  prices,
  isOwner,
  enabled,
  initialOpen = false,
  initialKind = null,
  initialTerm = 12,
}: {
  overview: RecurringOverview;
  prices: CreditPrice[];
  isOwner: boolean;
  enabled: boolean;
  initialOpen?: boolean;
  initialKind?: RecurringKind | null;
  initialTerm?: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initialOpen);
  const [kind, setKind] = useState<RecurringKind | null>(initialKind);
  const [term, setTerm] = useState<number>(initialTerm);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      openerRef.current?.focus();
    };
  }, [open]);

  if (!overview.legalBusiness || (!enabled && overview.authorizations.length === 0)) return null; // nothing to show while the feature is off and nothing exists

  const price = prices.find((p) => p.kind === kind) ?? null;
  const limit = price ? price.customerPriceCents * term : 0;
  const active = overview.authorizations.filter((a) => a.status === "active");
  const note = overview.serviceState === "past_due" || overview.serviceState === "suspended" ? SERVICE_NOTE[overview.serviceState] : null;

  async function submit() {
    if (!kind || !price || !agreed || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await authorizeRecurringCall({ kind, acknowledgedPriceCents: price.customerPriceCents, termMonths: term, totalLimitCents: limit });
    setBusy(false);
    if (outcome.ok) {
      setAgreed(false);
      setKind(null);
      router.refresh();
      return;
    }
    setError(outcome.message);
  }

  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const outcome = await revokeRecurringCall(id);
    setBusy(false);
    if (outcome.ok) router.refresh();
    else setError(outcome.message);
  }

  return (
    <section aria-labelledby="sms-recurring-heading" className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sms-recurring-heading" className="text-base font-semibold text-slate-900">Monthly texting charges</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {active.length
              ? `${formatUsd(overview.expectedMonthlyCents)} a month from your credit. ${overview.monthsCovered === null ? "" : `Your available credit covers ${overview.monthsCovered} month${overview.monthsCovered === 1 ? "" : "s"}.`}`
              : "Nothing is authorized. Phone-number rent and the monthly service fee are only taken from your credit after you authorize them."}
          </p>
        </div>
        <button type="button" onClick={(e) => { openerRef.current = e.currentTarget; setOpen(true); }} className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          {isOwner ? "Manage" : "View"}
        </button>
      </div>

      {overview.lowForRecurring ? (
        <p role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Your available credit is below the next monthly charges ({formatUsd(overview.expectedMonthlyCents)}). Add credit so the charge can be taken.
        </p>
      ) : null}
      {note ? (
        <p role="alert" className={`mt-3 rounded-xl border px-3 py-2 text-sm ${note.tone === "red" ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          {note.text} {overview.serviceIssue ? ISSUE_ACTION[overview.serviceIssue] : ""}
        </p>
      ) : null}
      {overview.onHold ? (
        <p role="status" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">Your credit is on hold by DanceFlow, so monthly charges are paused until it is lifted.</p>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
          <button type="button" aria-label="Close panel" tabIndex={-1} className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside role="dialog" aria-modal="true" aria-labelledby="sms-recurring-title" className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <h3 id="sms-recurring-title" className="text-lg font-semibold text-slate-900">Monthly texting charges</h3>
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-100">Close</button>
            </div>

            <div className="mt-4 space-y-5">
              <div>
                <h4 className="text-sm font-semibold text-slate-800">Authorized</h4>
                {overview.authorizations.length ? (
                  <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
                    {overview.authorizations.map((a) => (
                      <li key={a.id} className="px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <span>
                            <span className="font-medium text-slate-900">{RECURRING_KIND_LABEL[a.kind]}</span>
                            <span className="block text-xs text-slate-500">
                              {formatUsd(a.priceCents)} a month · up to {formatUsd(a.totalLimitCents)} · {a.status === "active" ? `until ${when(a.expiresAt)}` : "revoked"} · {a.thisLocation ? "This location" : "Another location"}
                            </span>
                            <span className="block text-xs text-slate-500">Charged so far: {formatUsd(a.spentCents)}{a.lastStatus && a.lastStatus !== "charged" ? ` · last attempt: ${a.lastStatus === "unfunded" ? "not enough credit" : a.lastStatus === "held" ? "credit on hold" : "not allowed"}` : ""}</span>
                          </span>
                          {isOwner && a.status === "active" && a.thisLocation ? (
                            <button type="button" disabled={busy} onClick={() => revoke(a.id)} className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Revoke</button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-slate-600">Nothing authorized yet.</p>
                )}
              </div>

              {isOwner ? (
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold text-slate-800">Authorize a monthly charge for this location</h4>
                  <div className="grid gap-2">
                    {(["number", "monthly"] as const).map((k) => {
                      const p = prices.find((x) => x.kind === k);
                      const taken = overview.authorizations.some((a) => a.kind === k && a.status === "active" && a.thisLocation);
                      const disabled = !p || taken;
                      return (
                        <label key={k} className={`flex items-center justify-between rounded-xl border px-3 py-3 text-sm ${kind === k ? "border-violet-600 bg-violet-50" : "border-slate-200"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                          <span className="flex items-center gap-3">
                            <input type="radio" name="kind" value={k} disabled={disabled} checked={kind === k} onChange={() => isRecurringKind(k) && setKind(k)} />
                            <span className="font-medium text-slate-900">{RECURRING_KIND_LABEL[k]}</span>
                          </span>
                          <span className="text-slate-700">{p ? `${formatUsd(p.customerPriceCents)} / month` : "Price not published"}{taken ? " · authorized" : ""}</span>
                        </label>
                      );
                    })}
                  </div>
                  <label className="block text-sm text-slate-700">
                    Term
                    <select value={term} onChange={(e) => setTerm(Number(e.target.value))} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm">
                      {RECURRING_TERMS.map((t) => (
                        <option key={t} value={t}>{t} month{t === 1 ? "" : "s"}</option>
                      ))}
                    </select>
                  </label>
                  {price && kind ? (
                    <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      {buildAuthorizationStatement({ kind, priceCents: price.customerPriceCents, termMonths: term, totalLimitCents: limit })}
                    </p>
                  ) : null}
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" />
                    <span>I agree to the statement above.</span>
                  </label>
                  {!enabled ? <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">Recurring charges are not open yet.</p> : null}
                  {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}
                  <button type="button" onClick={submit} disabled={!enabled || !kind || !price || !agreed || busy} className="w-full rounded-xl bg-violet-700 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50">
                    {busy ? "Saving…" : "Authorize"}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-slate-600">Only the studio owner can authorize or revoke monthly charges.</p>
              )}

              <p className="text-xs text-slate-500">
                If credit does not cover a charge, nothing is taken, the service is marked as paused after a short grace period, and your phone numbers are kept. Adding credit lets the charge be taken.
              </p>
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
