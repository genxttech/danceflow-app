import { ChevronDown } from "lucide-react";
import type { MonthlyLimitOverview } from "@/lib/billing/smsMonthlyLimits";
import { localDate, monthLabel, remainingCents } from "@/lib/billing/smsMonthlyLimitsFormat";
import { formatCents } from "@/lib/sms/twilioIsv/panel";

/**
 * TW-4F panel: the legal business's monthly spending limit for routine messaging (SMS usage, number rent, monthly fees), shown next to the cumulative
 * setup budget it is separate from. READ-ONLY: the limit is the owner's to approve on the studio's Texting screen; nothing here can change it.
 * Headline figures always visible; the breakdown, month window, ceiling and recent changes on demand.
 */

type Status = { label: string; className: string };
const SET: Status = { label: "Approved", className: "border-violet-200 bg-violet-50 text-violet-800" };
const NOT_SET: Status = { label: "Not set", className: "border-amber-200 bg-amber-50 text-amber-900" };
const USED_UP: Status = { label: "Used up", className: "border-rose-200 bg-rose-50 text-rose-800" };

export default function PanelMonthlyLimit({ limit }: { limit: MonthlyLimitOverview | null }) {
  if (!limit) {
    return (
      <div className="rounded-xl border border-slate-200 p-3" data-testid="monthly-limit">
        <p className="text-xs font-semibold text-slate-900">Monthly spending limit</p>
        <p className="mt-1 text-xs text-amber-900">The monthly limit is not available in this environment yet. The setup budget below is unaffected.</p>
      </div>
    );
  }
  const remaining = remainingCents(limit);
  const notSet = limit.limitCents === 0;
  const status = notSet ? NOT_SET : remaining === 0 ? USED_UP : SET;
  const capped = limit.effectiveLimitCents < limit.limitCents;
  const zoneChanging = Boolean(limit.nextMonthTimezone) && limit.nextMonthTimezone !== limit.timezone;
  const limitChanging = limit.nextMonthLimitCents !== limit.limitCents;
  return (
    <div className="rounded-xl border border-slate-200 p-3" data-testid="monthly-limit">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-900">Monthly spending limit: {monthLabel(limit.month)}</p>
        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${status.className}`} data-testid="monthly-limit-status">{status.label}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-slate-500">Approved limit</dt>
          <dd className="font-semibold text-slate-900" data-testid="monthly-limit-approved">{formatCents(limit.limitCents)}</dd>
          {capped ? <dd className="text-amber-800">Capped at {formatCents(limit.effectiveLimitCents)} by the ceiling</dd> : null}
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-slate-500">Used this month</dt>
          <dd className="font-semibold text-slate-900" data-testid="monthly-limit-used">{formatCents(limit.spentCents)}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-slate-500">Remaining</dt>
          <dd className="font-semibold text-slate-900" data-testid="monthly-limit-remaining">{formatCents(remaining)}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-slate-500">Timezone</dt>
          <dd className="break-all font-semibold text-slate-900" data-testid="monthly-limit-timezone">{limit.timezone || "UTC"}</dd>
          {zoneChanging ? <dd className="text-slate-600">{limit.nextMonthTimezone} from next month</dd> : null}
        </div>
      </dl>
      {notSet ? (
        <p className="mt-2 text-xs text-amber-900">The owner has not approved a monthly limit, so SMS usage and monthly fees are refused. Only the owner sets it, on the studio&apos;s Texting screen.</p>
      ) : null}
      <details className="group/monthly mt-2 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-violet-800 [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open/monthly:rotate-180" />
          Breakdown, ceiling and recent changes
        </summary>
        <div className="mt-2 space-y-1 text-slate-600">
          <p>SMS usage {formatCents(limit.usageCents)} · recurring fees {formatCents(limit.recurringCents)} · first months set aside {formatCents(limit.setAsideCents)}.</p>
          <p>
            The month runs {localDate(limit.monthStartsAt, limit.timezone)} to {localDate(limit.monthEndsAt, limit.timezone, -1000)} ({limit.timezone || "UTC"}).
            {limitChanging ? ` Next month's limit: ${formatCents(limit.nextMonthLimitCents)}.` : ""}
          </p>
          <p>Platform safety ceiling {formatCents(limit.ceilingCents)} a month: a bound, never an authorization.</p>
          <p>Separate from the cumulative setup budget, which covers one-time registration fees only.{limit.pilotBusiness ? " The pilot ceiling never pays for messaging." : ""}</p>
          {limit.recentChanges.length ? (
            <ul className="mt-1 space-y-0.5" data-testid="monthly-limit-changes">
              {limit.recentChanges.map((c, i) => (
                <li key={`${c.createdAt}-${i}`}>
                  {c.createdAt.slice(0, 10)}: {formatCents(c.previousLimitCents)} to {formatCents(c.limitCents)} from {monthLabel(c.effectiveMonth)}, {c.changedByRole === "owner" ? "approved by the owner" : "set by a platform admin"} ({formatCents(c.spendAtChangeCents)} spent then)
                </li>
              ))}
            </ul>
          ) : (
            <p>No limit changes recorded.</p>
          )}
        </div>
      </details>
    </div>
  );
}
