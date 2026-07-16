"use client";

import { useActionState, useMemo, useState } from "react";
import { saveAccountantProfileAction } from "./actions";

type Profile = {
  accountant_name: string | null;
  firm_name: string | null;
  email: string | null;
  phone: string | null;
  preferred_cadence: string | null;
  preferred_export_types: string[] | null;
  internal_notes: string | null;
  authorized_to_receive_exports: boolean | null;
  authorization_granted_at: string | null;
  active: boolean | null;
};

type Schedule = {
  enabled: boolean | null;
  first_send_approved: boolean | null;
  next_run_at: string | null;
} | null;

const exportOptions = [
  ["profit_loss", "Profit & loss"],
  ["accounting_ledger", "Accounting activity"],
  ["payments_refunds", "Payments and refunds"],
  ["expenses", "Expenses"],
  ["event_profitability", "Event profitability"],
];

const fieldClass = "mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not scheduled";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function AccountantForm({ profile, schedule }: { profile: Profile | null; schedule: Schedule }) {
  const [state, action, pending] = useActionState(saveAccountantProfileAction, { error: "" });
  const [cadence, setCadence] = useState(profile?.preferred_cadence ?? "manual");
  const [selectedReports, setSelectedReports] = useState<string[]>(profile?.preferred_export_types ?? []);
  const [authorized, setAuthorized] = useState(profile?.authorized_to_receive_exports === true);
  const [active, setActive] = useState(profile?.active !== false);
  const recurring = cadence !== "manual";

  const summary = useMemo(() => {
    const accountant = profile?.accountant_name || "Your accountant";
    const reportNames = exportOptions.filter(([value]) => selectedReports.includes(value)).map(([, label]) => label);
    return { accountant, reportNames };
  }, [profile?.accountant_name, selectedReports]);

  function toggleReport(value: string, checked: boolean) {
    setSelectedReports((current) => checked ? [...new Set([...current, value])] : current.filter((item) => item !== value));
  }

  return (
    <form action={action} className="overflow-hidden rounded-2xl border bg-white shadow-sm">
      <section className="p-5 md:p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-violet-700">1. Accountant</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Who should receive the reports?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Add the person or firm that handles your accounting. Saving this section does not send anything.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium text-slate-900">Accountant name<input name="accountantName" required defaultValue={profile?.accountant_name ?? ""} className={fieldClass} /></label>
          <label className="text-sm font-medium text-slate-900">Firm name<input name="firmName" defaultValue={profile?.firm_name ?? ""} className={fieldClass} /></label>
          <label className="text-sm font-medium text-slate-900">Email<input name="email" type="email" required defaultValue={profile?.email ?? ""} className={fieldClass} /></label>
          <label className="text-sm font-medium text-slate-900">Phone<input name="phone" type="tel" defaultValue={profile?.phone ?? ""} className={fieldClass} /></label>
        </div>
      </section>

      <section className="border-t border-slate-200 p-5 md:p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">2. Reports and delivery</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">What should DanceFlow prepare, and when?</h2>
        <fieldset className="mt-5">
          <legend className="text-sm font-medium text-slate-900">Reports</legend>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {exportOptions.map(([value, label]) => (
              <label key={value} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm">
                <input
                  type="checkbox"
                  name="preferredExportTypes"
                  value={value}
                  checked={selectedReports.includes(value)}
                  onChange={(event) => toggleReport(value, event.target.checked)}
                  className="h-4 w-4 rounded"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-5 block text-sm font-medium text-slate-900">Delivery schedule
          <select name="preferredCadence" value={cadence} onChange={(event) => setCadence(event.target.value)} className={fieldClass}>
            <option value="manual">Manual only</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annually">Annually</option>
          </select>
        </label>

        {recurring ? (
          <label className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
            <input type="checkbox" name="approveRecurringDelivery" defaultChecked={schedule?.first_send_approved === true} className="mt-1 h-4 w-4 rounded" />
            <span><strong>Activate recurring delivery.</strong><br />DanceFlow will create secure report deliveries on this schedule. You can pause it later.</span>
          </label>
        ) : null}

        <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          <input type="checkbox" name="authorizedToReceiveExports" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} className="mt-1 h-4 w-4 rounded" />
          <span><strong>I authorize this accountant to receive the selected studio reports.</strong><br />Reports are delivered through a time-limited secure link, not as ordinary email attachments.</span>
        </label>

        <label className="mt-4 flex items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm">
          <input
            type="checkbox"
            name="active"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            className="mt-1 h-4 w-4 rounded"
          />
          <span>
            <strong className="text-slate-900">
              Allow report delivery to this accountant
            </strong>
            <br />
            <span className="text-slate-600">
              Turn this off to stop manual and scheduled report delivery without
              deleting the accountant&apos;s information or delivery history.
            </span>
          </span>
        </label>

        <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800">Add internal notes</summary>
          <label className="mt-4 block text-sm font-medium text-slate-900">Notes for your studio team<textarea name="internalNotes" rows={4} defaultValue={profile?.internal_notes ?? ""} className={fieldClass} placeholder="These notes are never sent to the accountant." /></label>
        </details>
      </section>

      <section className="border-t border-slate-200 bg-slate-50 p-5 md:p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-sky-700">3. Review</p>
        <h2 className="mt-1 text-lg font-semibold text-slate-900">Accountant setup summary</h2>
        <div className="mt-3 space-y-2 text-sm text-slate-700">
          <p><span className="font-semibold text-slate-900">Recipient:</span> {summary.accountant}</p>
          <p><span className="font-semibold text-slate-900">Reports:</span> {summary.reportNames.length ? summary.reportNames.join(", ") : "None selected"}</p>
          <p><span className="font-semibold text-slate-900">Delivery:</span> {cadence === "manual" ? "Manual only" : cadence.charAt(0).toUpperCase() + cadence.slice(1)}</p>
          {schedule?.enabled && recurring ? <p><span className="font-semibold text-slate-900">Next delivery:</span> {formatDate(schedule.next_run_at)}</p> : null}
          <p><span className="font-semibold text-slate-900">Authorization:</span> {authorized && active ? "Ready" : "Not enabled"}</p>
        </div>
      </section>

      <div className="border-t border-slate-200 p-5 md:p-6">
        {state.error ? (
          <p className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}
        <button
          disabled={pending || selectedReports.length === 0}
          className="w-full rounded-xl bg-[#2D0B45] px-5 py-3 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto"
        >
          {pending ? "Saving..." : "Save accountant setup"}
        </button>
      </div>
    </form>
  );
}
