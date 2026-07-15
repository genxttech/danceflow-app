"use client";

import { useActionState } from "react";
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

const exportOptions = [
  ["profit_loss", "Profit & loss"],
  ["accounting_ledger", "Accounting ledger"],
  ["payments_refunds", "Payments and refunds"],
  ["expenses", "Expenses"],
  ["event_profitability", "Event profitability"],
  ["payroll_packet", "Payroll packet"],
  ["instructor_compensation", "Instructor compensation detail"],
  ["wave_reconciliation", "Wave reconciliation summary"],
  ["tax_season_package", "Tax-season package"],
];

const fieldClass = "mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm";

export default function AccountantForm({ profile }: { profile: Profile | null }) {
  const [state, action, pending] = useActionState(saveAccountantProfileAction, { error: "" });
  const selected = profile?.preferred_export_types ?? [];

  return (
    <form action={action} className="space-y-6">
      <section className="rounded-xl border border-l-4 border-l-violet-600 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-violet-700">Accountant contact</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Who receives accounting information</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Saving this profile does not send an email or grant access to DanceFlow.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium text-slate-900">Accountant name<input name="accountantName" required defaultValue={profile?.accountant_name ?? ""} className={fieldClass} /></label>
          <label className="text-sm font-medium text-slate-900">Firm name<input name="firmName" defaultValue={profile?.firm_name ?? ""} className={fieldClass} /></label>
          <label className="text-sm font-medium text-slate-900">Email<input name="email" type="email" required defaultValue={profile?.email ?? ""} className={fieldClass} /></label>
          <label className="text-sm font-medium text-slate-900">Phone<input name="phone" type="tel" defaultValue={profile?.phone ?? ""} className={fieldClass} /></label>
        </div>
      </section>

      <section className="rounded-xl border border-l-4 border-l-emerald-500 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Export preferences</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">What the studio expects to prepare</h2>
        <label className="mt-5 block text-sm font-medium text-slate-900">Preferred cadence
          <select name="preferredCadence" defaultValue={profile?.preferred_cadence ?? "manual"} className={fieldClass}>
            <option value="manual">Manual / as needed</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annually">Annually</option>
          </select>
        </label>
        <fieldset className="mt-5"><legend className="text-sm font-medium text-slate-900">Preferred reports and exports</legend>
          <div className="mt-3 grid gap-3 md:grid-cols-2">{exportOptions.map(([value, label]) => <label key={value} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm"><input type="checkbox" name="preferredExportTypes" value={value} defaultChecked={selected.includes(value)} className="h-4 w-4 rounded" />{label}</label>)}</div>
        </fieldset>
      </section>

      <section className="rounded-xl border border-l-4 border-l-amber-500 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Authorization</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Sensitive export permission</h2>
        <label className="mt-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><input type="checkbox" name="authorizedToReceiveExports" defaultChecked={profile?.authorized_to_receive_exports === true} className="mt-1 h-4 w-4 rounded" /><span><strong>I authorize this accountant to receive the selected studio accounting exports.</strong><br />This records permission only. Automatic delivery is not enabled in this version.</span></label>
        {profile?.authorization_granted_at ? <p className="mt-2 text-xs text-slate-500">Current authorization recorded {new Date(profile.authorization_granted_at).toLocaleString()}.</p> : null}
        <label className="mt-5 flex items-center gap-3 rounded-xl border border-slate-200 p-4 text-sm"><input type="checkbox" name="active" defaultChecked={profile?.active !== false} className="h-4 w-4 rounded" />Accountant profile is active</label>
        <label className="mt-5 block text-sm font-medium text-slate-900">Internal notes<textarea name="internalNotes" rows={5} defaultValue={profile?.internal_notes ?? ""} className={fieldClass} placeholder="Internal context for the studio team. These notes are not sent to the accountant." /></label>
      </section>

      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900">Future scheduled delivery will use DanceFlow's existing queued outbound-delivery dispatcher. This screen does not create a second email system or send attachments.</div>
      {state.error ? <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{state.error}</p> : null}
      <button disabled={pending} className="rounded-xl bg-[#2D0B45] px-5 py-3 text-sm font-semibold text-white disabled:opacity-60">{pending ? "Saving..." : "Save accountant details"}</button>
    </form>
  );
}
