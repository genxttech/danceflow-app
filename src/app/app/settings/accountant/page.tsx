import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import AccountantForm from "./AccountantForm";
import {
  cancelAccountantDeliveryAction,
  createAccountantDeliveryAction,
  pauseAccountantScheduleAction,
  resumeAccountantScheduleAction,
} from "./actions";

const labels: Record<string, string> = {
  profit_loss: "Profit & loss",
  accounting_ledger: "Accounting activity",
  payments_refunds: "Payments and refunds",
  expenses: "Expenses",
  event_profitability: "Event profitability",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "Not scheduled";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function AccountantSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) redirect("/app");
  const supabase = await createClient();
  const [{ data: profile, error }, { data: deliveries, error: deliveriesError }, { data: schedule, error: scheduleError }] = await Promise.all([
    supabase.from("studio_accountant_profiles").select("id,accountant_name,firm_name,email,phone,preferred_cadence,preferred_export_types,internal_notes,authorized_to_receive_exports,authorization_granted_at,active").eq("studio_id", context.studioId).maybeSingle(),
    supabase.from("studio_accountant_deliveries").select("id,recipient_email,report_types,report_range,status,expires_at,download_count,created_at,last_error,schedule_id").eq("studio_id", context.studioId).order("created_at", { ascending: false }).limit(20),
    supabase.from("studio_accountant_delivery_schedules").select("id,cadence,report_types,report_range,enabled,first_send_approved,next_run_at,last_run_at,last_error,consecutive_failures").eq("studio_id", context.studioId).maybeSingle(),
  ]);
  if (error || deliveriesError || scheduleError) throw new Error("Accountant settings could not be loaded.");
  const query = await searchParams;
  const preferred = (profile?.preferred_export_types ?? []).filter((value: string) => labels[value]);
  const recentDeliveries = (deliveries ?? []).slice(0, 3);
  const readyToSend = Boolean(profile?.active && profile?.authorized_to_receive_exports && preferred.length > 0);

  return <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
    <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="bg-[#2D0B45] p-6 text-white">
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-white/75">Accounting settings</p>
        <h1 className="mt-2 text-3xl font-semibold">Accountant setup</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-white/85">Choose who receives reports, what they receive, and whether DanceFlow should send them automatically.</p>
      </div>
      <div className="p-5"><Link href="/app/settings" className="text-sm font-semibold text-violet-700">Back to settings</Link></div>
    </div>

    {query.success === "saved" ? <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">Accountant setup saved.</p> : null}
    {query.delivery_success ? <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">Delivery {query.delivery_success}.</p> : null}
    {query.schedule_success ? <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">Recurring delivery {query.schedule_success}.</p> : null}
    {query.delivery_error || query.schedule_error ? <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">That change could not be completed. Check the accountant email, report selection, and authorization, then try again.</p> : null}

    <AccountantForm profile={profile} schedule={schedule} />

    {profile ? <section className="rounded-xl border bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-sky-700">Send now</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">Need to send the current reports?</h2>
          <p className="mt-1 text-sm text-slate-600">Use the saved report selection and send a secure seven-day link.</p>
        </div>
        <form action={createAccountantDeliveryAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="text-sm font-medium text-slate-700">Report range
            <select name="reportRange" className="mt-1 rounded-xl border px-3 py-2 text-sm"><option value="month">This month</option><option value="quarter">This quarter</option><option value="year">This year</option></select>
          </label>
          {preferred.map((value: string) => <input key={value} type="hidden" name="deliveryReportTypes" value={value} />)}
          <button disabled={!readyToSend} className="rounded-xl bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Send reports now</button>
        </form>
      </div>
      {!readyToSend ? <p className="mt-3 text-xs text-amber-700">Complete the setup and enable authorization before sending.</p> : null}
    </section> : null}

    {schedule ? <section className="rounded-xl border bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">Recurring delivery is {schedule.enabled ? "active" : "paused"}</p>
          <p className="mt-1 text-sm text-slate-600">Next delivery: {formatDate(schedule.next_run_at)}</p>
          {schedule.last_error ? <p className="mt-2 text-sm text-red-700">Needs attention: {schedule.last_error}</p> : null}
        </div>
        {schedule.enabled ? <form action={pauseAccountantScheduleAction}><button className="rounded-xl border border-amber-200 px-4 py-2 text-sm font-semibold text-amber-700">Pause schedule</button></form> : <form action={resumeAccountantScheduleAction}><button className="rounded-xl border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700">Resume schedule</button></form>}
      </div>
    </section> : null}

    <details className="rounded-xl border bg-white p-5 shadow-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-4">
          <div><h2 className="text-lg font-semibold text-slate-900">Recent deliveries</h2><p className="mt-1 text-sm text-slate-600">Review the latest sends only when needed.</p></div>
          <span className="text-sm font-semibold text-violet-700">View</span>
        </div>
      </summary>
      <div className="mt-4 space-y-3">{recentDeliveries.length === 0 ? <p className="text-sm text-slate-500">No deliveries yet.</p> : recentDeliveries.map((delivery) => <div key={delivery.id} className="rounded-xl border p-4">
        <div className="flex flex-wrap justify-between gap-3"><div><p className="font-semibold">{formatDate(delivery.created_at)}</p><p className="text-xs text-slate-500">{(delivery.report_types ?? []).map((value: string) => labels[value] ?? value).join(", ")} · {delivery.schedule_id ? "Scheduled" : "Manual"}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold capitalize">{delivery.status}</span></div>
        <p className="mt-2 text-xs text-slate-500">Downloads {delivery.download_count ?? 0} · Access expires {formatDate(delivery.expires_at)}</p>
        {delivery.last_error ? <p className="mt-2 text-xs text-red-700">{delivery.last_error}</p> : null}
        {["queued", "sent"].includes(delivery.status) ? <form action={cancelAccountantDeliveryAction} className="mt-3"><input type="hidden" name="deliveryId" value={delivery.id} /><button className="text-xs font-semibold text-red-700">Cancel access</button></form> : null}
      </div>)}</div>
    </details>
  </div>;
}
