import type { ReactNode } from "react";

/**
 * Shared pieces of the recurring-provider-fees operations panel. `Disclosure` is a native <details>: the open/closed state is announced by the browser
 * and is ALSO shown by an unmistakable visible marker ("[+] Show" / "[-] Hide") plus screen-reader text, so a collapsed section never looks empty.
 */

export function Disclosure({ title, summary, open = false, children, tone = "default" }: { title: string; summary?: ReactNode; open?: boolean; children: ReactNode; tone?: "default" | "attention" }) {
  return (
    <details open={open} className={`group rounded-xl border ${tone === "attention" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"}`}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span aria-hidden="true" className="inline-block w-6 font-mono font-bold text-violet-800 group-open:hidden">[+]</span>
        <span aria-hidden="true" className="hidden w-6 font-mono font-bold text-violet-800 group-open:inline-block">[-]</span>
        <span className="font-semibold text-violet-900">{title}</span>
        {summary ? <span className="text-xs text-slate-600">{summary}</span> : null}
        <span className="sr-only group-open:hidden">{`Collapsed. Press to expand ${title}.`}</span>
        <span className="sr-only hidden group-open:inline">{`Expanded. Press to collapse ${title}.`}</span>
        <span aria-hidden="true" className="ml-auto text-xs font-semibold text-violet-800 group-open:hidden">Show</span>
        <span aria-hidden="true" className="ml-auto hidden text-xs font-semibold text-violet-800 group-open:inline">Hide</span>
      </summary>
      <div className="space-y-3 border-t border-slate-200 px-3 py-3 text-sm text-slate-800">{children}</div>
    </details>
  );
}

/** Amounts are shown in dollars in administrator panels only (never in an email or an owner view). */
export const dollars = (cents: number | null): string => (cents === null ? "n/a" : `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`);

export const stamp = (iso: string | null): string => (iso ? `${iso.slice(0, 16).replace("T", " ")}Z` : "never");

export const shortId = (v: string | null): string => (v ? v.slice(0, 8) : "n/a");

export const REASON_TEXT: Record<string, string> = {
  no_authorization: "The studio has no recurring-fee authorization.",
  authorization_expired: "The studio's authorization expired before this period.",
  authorization_revoked: "The studio revoked its authorization.",
  not_authorized_period: "The authorization does not reach this period.",
  awaiting_charge: "The monthly charge has not run yet.",
  charge_unfunded: "The charge could not be funded from the studio's credit.",
  charge_held: "The charge is held (the account is on hold).",
  charge_refused: "The charge was refused.",
  no_pilot_approval: "The pilot business needs a written approval for this period and none is recorded.",
  provider_billed_uncovered: "The provider billed this fee and no payment covers it.",
  billed_after_cancellation: "The provider billed this resource after it was cancelled.",
  replacement_unfunded: "A replacement resource was registered in the same period and nothing pays its second fee.",
  unknown: "Reason not recorded.",
};
export const reasonText = (reason: string): string => REASON_TEXT[reason] ?? REASON_TEXT.unknown;

export const KIND_TEXT: Record<string, string> = { messaging_service: "Messaging Service", campaign: "campaign", number: "number" };

export const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm font-normal";
export const labelClass = "block text-xs font-semibold text-slate-700";
export const buttonClass = "rounded-lg bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white";
export const dangerButtonClass = "rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white";
