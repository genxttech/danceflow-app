"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveMonthlyLimitCall, saveTimezoneCall } from "@/lib/billing/smsMonthlyLimitsClient";
import { COMMON_TIMEZONES, type MonthlyLimitOverview } from "@/lib/billing/smsMonthlyLimits";
import { formatUsd } from "@/lib/billing/smsCreditView";
import { localDate, monthLabel, remainingCents } from "@/lib/billing/smsMonthlyLimitsFormat";

/** Whole dollars or dollars and cents typed by the owner, as cents; null when it is not a plain non-negative amount. */
export function dollarsToCents(text: string): number | null {
  const match = /^\s*\$?\s*([0-9]{1,6})(?:\.([0-9]{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
}

export default function SmsLimitPanel({
  overview,
  isOwner,
  enabled,
  initialOpen = false,
  initialDollars = "",
}: {
  overview: MonthlyLimitOverview;
  isOwner: boolean;
  enabled: boolean;
  initialOpen?: boolean;
  initialDollars?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initialOpen);
  const [dollars, setDollars] = useState(initialDollars);
  const [confirmed, setConfirmed] = useState(false);
  const [zone, setZone] = useState(overview.nextMonthTimezone || overview.timezone);
  const [zoneReason, setZoneReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
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

  if (!overview.legalBusiness) return null;

  const proposed = dollarsToCents(dollars);
  const increase = proposed !== null && proposed > overview.limitCents;
  const overCeiling = proposed !== null && proposed > overview.ceilingCents;
  const remaining = remainingCents(overview);
  const notSet = overview.limitCents === 0;
  const zoneChanging = overview.nextMonthTimezone !== overview.timezone;

  async function saveLimit() {
    if (proposed === null || overCeiling || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const outcome = await saveMonthlyLimitCall({ limitCents: proposed });
    setBusy(false);
    if (outcome.ok) {
      setConfirmed(false);
      setSaved(`Your monthly limit is now ${formatUsd(proposed)}.`);
      router.refresh();
    } else setError(outcome.message);
  }

  async function saveZone() {
    if (busy || !zone || zoneReason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const outcome = await saveTimezoneCall({ timezone: zone, reason: zoneReason.trim() });
    setBusy(false);
    if (outcome.ok) {
      setSaved("The timezone change is saved and starts next month.");
      setZoneReason("");
      router.refresh();
    } else setError(outcome.message);
  }

  return (
    <section aria-labelledby="sms-limit-heading" className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sms-limit-heading" className="text-base font-semibold text-slate-900">Monthly spending limit</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Covers texting usage, phone-number rent and monthly fees for {monthLabel(overview.month)} ({overview.timezone}). It resets each calendar month and never adds credit or charges a card.
          </p>
        </div>
        <button type="button" onClick={(e) => { openerRef.current = e.currentTarget; setOpen(true); }} className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          {isOwner ? "Change" : "View"}
        </button>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Spent or set aside</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(overview.spentCents)}</dd>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Limit this month</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(overview.effectiveLimitCents)}</dd>
          {overview.effectiveLimitCents < overview.limitCents ? <p className="text-xs text-amber-700">Capped by the platform safety ceiling</p> : null}
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Room left</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900">{formatUsd(remaining)}</dd>
        </div>
      </dl>

      {notSet ? (
        <p role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No monthly limit is set, so texting charges and monthly fees are refused until the owner sets one.
        </p>
      ) : remaining === 0 ? (
        <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          This month&apos;s limit is used up. Charges resume next month, or when the owner raises the limit.
        </p>
      ) : null}
      {overview.onHold ? <p role="status" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">Your credit is on hold by DanceFlow, so the limit cannot be raised right now.</p> : null}
      {overview.pilotBusiness ? (
        <p className="mt-3 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          The pilot allowance is separate: it never resets, each fee needs its own approval, and it cannot pay for texting.
        </p>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
          <button type="button" aria-label="Close panel" tabIndex={-1} className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside role="dialog" aria-modal="true" aria-labelledby="sms-limit-title" className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <h3 id="sms-limit-title" className="text-lg font-semibold text-slate-900">Monthly spending limit</h3>
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-100">Close</button>
            </div>

            <div className="mt-4 space-y-5">
              <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
                <p>{monthLabel(overview.month)}: <span className="font-semibold">{formatUsd(overview.spentCents)}</span> spent or set aside of <span className="font-semibold">{formatUsd(overview.effectiveLimitCents)}</span>.</p>
                <p className="mt-1 text-xs text-slate-500">
                  Texts sent {formatUsd(overview.usageCents)} · texts received {formatUsd(overview.inboundCents)} · recurring fees {formatUsd(overview.recurringCents)} · first months set aside {formatUsd(overview.setAsideCents)}.
                </p>
                {overview.overrunCents > 0 ? (
                  <p className="mt-1 text-xs text-amber-800">
                    Received texts are never refused, so this month is {formatUsd(overview.overrunCents)} over the limit. New texts can be sent once the limit is raised or next month begins.
                  </p>
                ) : null}
                {overview.inboundUncollectedCents > 0 || overview.absorbedCostCents > 0 ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Not charged to you: received texts beyond your credit allowance {formatUsd(overview.inboundUncollectedCents)} · STOP, START and HELP texts and replies {formatUsd(overview.absorbedCostCents)}.
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-slate-500">
                  The month runs {localDate(overview.monthStartsAt, overview.timezone)} to {localDate(overview.monthEndsAt, overview.timezone, -1000)} ({overview.timezone}). Next month&apos;s limit: {formatUsd(overview.nextMonthLimitCents)}.
                </p>
              </div>

              {isOwner ? (
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold text-slate-800">Set the limit</h4>
                  <label className="block text-sm text-slate-700">
                    New monthly limit (US dollars)
                    <input inputMode="decimal" value={dollars} onChange={(e) => { setDollars(e.target.value); setConfirmed(false); }} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" placeholder="e.g. 50" />
                  </label>
                  <p className="text-xs text-slate-500">
                    Platform safety ceiling: {formatUsd(overview.ceilingCents)} a month. It is a bound, not an authorization: nothing is spent up to it unless you set a limit. DanceFlow can approve a higher ceiling for your business separately.
                  </p>
                  {proposed === null && dollars.trim() !== "" ? <p role="alert" className="text-sm text-red-700">Enter an amount like 50 or 50.00.</p> : null}
                  {overCeiling ? <p role="alert" className="text-sm text-red-700">That is above the platform safety ceiling of {formatUsd(overview.ceilingCents)}.</p> : null}
                  {proposed !== null && !overCeiling ? (
                    <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-700">
                      <p>
                        Change from <span className="font-semibold">{formatUsd(overview.limitCents)}</span> to <span className="font-semibold">{formatUsd(proposed)}</span> a month, starting now.
                      </p>
                      <p className="mt-1">This month you have spent or set aside {formatUsd(overview.spentCents)}.</p>
                      {increase ? <p className="mt-1 text-xs text-amber-800">Raising the limit asks you to have signed in within the last 15 minutes, and is not possible while your credit is on hold or negative.</p> : null}
                    </div>
                  ) : null}
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
                    <span>I confirm this change. It does not add credit or charge a card, and spending still needs enough prepaid credit.</span>
                  </label>
                  {!enabled ? <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">Spending limits are not open yet.</p> : null}
                  <button type="button" onClick={saveLimit} disabled={!enabled || proposed === null || overCeiling || !confirmed || busy} className="w-full rounded-xl bg-violet-700 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50">
                    {busy ? "Saving…" : proposed === null ? "Enter an amount" : `Set the limit to ${formatUsd(proposed)}`}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-slate-600">Only the studio owner can change the limit or the timezone.</p>
              )}

              {isOwner ? (
                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <h4 className="text-sm font-semibold text-slate-800">Timezone</h4>
                  <p className="text-xs text-slate-500">
                    Months start at midnight on the 1st in {overview.timezone}.{zoneChanging ? ` From next month: ${overview.nextMonthTimezone}.` : ""} A change always starts next month, so a month never moves in the middle.
                  </p>
                  <select value={zone} onChange={(e) => setZone(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm">
                    {[...new Set([zone, overview.timezone, ...COMMON_TIMEZONES])].map((z) => (
                      <option key={z} value={z}>{z}</option>
                    ))}
                  </select>
                  <input value={zoneReason} onChange={(e) => setZoneReason(e.target.value)} placeholder="Why is it changing?" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
                  <button type="button" onClick={saveZone} disabled={!enabled || busy || zoneReason.trim().length < 3 || zone === (overview.nextMonthTimezone || overview.timezone)} className="w-full rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                    Change timezone from next month
                  </button>
                </div>
              ) : null}

              {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}
              {saved ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{saved}</p> : null}

              {overview.recentChanges.length ? (
                <div className="border-t border-slate-100 pt-4">
                  <h4 className="text-sm font-semibold text-slate-800">Recent changes</h4>
                  <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
                    {overview.recentChanges.map((change, index) => (
                      <li key={`${change.createdAt}-${index}`} className="flex items-start justify-between gap-3 px-3 py-2">
                        <span>
                          <span className="font-medium text-slate-900">{formatUsd(change.previousLimitCents)} to {formatUsd(change.limitCents)}</span>
                          <span className="block text-xs text-slate-500">From {monthLabel(change.effectiveMonth)} · {change.changedByRole === "owner" ? "by the owner" : "by DanceFlow"} · {change.createdAt.slice(0, 10)}</span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">{formatUsd(change.spendAtChangeCents)} spent</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
