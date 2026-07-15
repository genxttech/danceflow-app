import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import AccountantForm from "./AccountantForm";
import { createAccountantDeliveryAction, cancelAccountantDeliveryAction } from "./actions";

const labels: Record<string,string> = { profit_loss:"Profit & loss", accounting_ledger:"Accounting ledger", payments_refunds:"Payments and refunds", expenses:"Expenses", event_profitability:"Event profitability" };
export default async function AccountantSettingsPage({ searchParams }: { searchParams: Promise<Record<string,string|undefined>> }) {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) redirect("/app");
  const supabase = await createClient();
  const [{ data: profile, error }, { data: deliveries, error: deliveriesError }] = await Promise.all([
    supabase.from("studio_accountant_profiles").select("id,accountant_name,firm_name,email,phone,preferred_cadence,preferred_export_types,internal_notes,authorized_to_receive_exports,authorization_granted_at,active").eq("studio_id",context.studioId).maybeSingle(),
    supabase.from("studio_accountant_deliveries").select("id,recipient_email,report_types,report_range,status,expires_at,download_count,created_at,sent_at,last_downloaded_at,last_error").eq("studio_id",context.studioId).order("created_at",{ascending:false}).limit(20),
  ]);
  if (error || deliveriesError) throw new Error("Accountant settings could not be loaded.");
  const query = await searchParams;
  const preferred = (profile?.preferred_export_types ?? []).filter((v:string) => labels[v]);
  return <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
    <div className="overflow-hidden rounded-xl border bg-white shadow-sm"><div className="bg-[#2D0B45] p-6 text-white"><p className="text-sm font-semibold uppercase tracking-[0.22em] text-white/75">Accounting settings</p><h1 className="mt-2 text-3xl font-semibold">Accountant and secure deliveries</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-white/85">Store accountant details and send time-limited report packages through DanceFlow's queued delivery system.</p></div><div className="p-5"><Link href="/app/settings" className="text-sm font-semibold text-violet-700">Back to settings</Link></div></div>
    {query.success === "saved" ? <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">Accountant details saved.</p> : null}
    {query.delivery_success ? <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">Delivery {query.delivery_success}.</p> : null}
    {query.delivery_error ? <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">The secure delivery could not be created. Confirm authorization and selected reports, then try again.</p> : null}
    <AccountantForm profile={profile} />
    <section className="rounded-xl border border-l-4 border-l-sky-500 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-sky-700">Secure delivery</p><h2 className="mt-1 text-xl font-semibold">Send a report package</h2><p className="mt-2 text-sm text-slate-600">The accountant receives a seven-day secure link. No financial files are attached to ordinary email.</p>
      <form action={createAccountantDeliveryAction} className="mt-5 space-y-4"><label className="block text-sm font-medium">Report range<select name="reportRange" className="mt-2 w-full rounded-xl border px-3 py-2"><option value="month">This month</option><option value="quarter">This quarter</option><option value="year">This year</option></select></label><fieldset><legend className="text-sm font-medium">Reports</legend><div className="mt-2 grid gap-2 md:grid-cols-2">{preferred.map((v:string)=><label key={v} className="rounded-xl border p-3 text-sm"><input type="checkbox" name="deliveryReportTypes" value={v} defaultChecked className="mr-2" />{labels[v]}</label>)}</div></fieldset><button disabled={!profile?.active || !profile?.authorized_to_receive_exports || preferred.length===0} className="rounded-xl bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Queue secure delivery</button></form>
    </section>
    <section className="rounded-xl border bg-white p-6 shadow-sm"><h2 className="text-xl font-semibold">Delivery history</h2><div className="mt-4 space-y-3">{(deliveries??[]).length===0?<p className="text-sm text-slate-500">No deliveries yet.</p>:(deliveries??[]).map((d)=><div key={d.id} className="rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-3"><div><p className="font-semibold">{d.recipient_email}</p><p className="text-xs text-slate-500">{d.report_range} · {(d.report_types??[]).map((v:string)=>labels[v]??v).join(", ")}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{d.status}</span></div><p className="mt-2 text-xs text-slate-500">Created {new Date(d.created_at).toLocaleString()} · Downloads {d.download_count ?? 0} · Expires {new Date(d.expires_at).toLocaleString()}</p>{["queued","sent"].includes(d.status)?<form action={cancelAccountantDeliveryAction} className="mt-3"><input type="hidden" name="deliveryId" value={d.id}/><button className="text-xs font-semibold text-red-700">Cancel access</button></form>:null}</div>)}</div></section>
  </div>;
}
