import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createSignEnvelopeAction, resendSignEnvelopeAction, revokeSignEnvelopeAction } from "./actions";

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
function statusClass(status: string) {
  if (status === "completed") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (["sent","viewed","started"].includes(status)) return "bg-blue-50 text-blue-700 ring-blue-200";
  if (["expired","declined","void"].includes(status)) return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}
function message(params: { success?: string; error?: string }) {
  if (params.success === "sent") return "Signing request queued successfully.";
  if (params.success === "resent") return "A new secure signing link was emailed.";
  if (params.success === "revoked") return "The signing request was revoked.";
  if (params.error) return `The request could not be completed: ${params.error.replaceAll("_", " ")}.`;
  return null;
}

export default async function DanceFlowSignPage({ searchParams }: { searchParams: Promise<{ success?: string; error?: string }> }) {
  const params = await searchParams;
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  const { data: envelopes, error } = await supabase.from("document_sign_envelopes")
    .select("id,title,signer_name,signer_email,status,expires_at,sent_at,viewed_at,started_at,completed_at,created_at,last_reminded_at,reminder_count")
    .eq("studio_id", context.studioId).order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  const flash = message(params);
  const isError = Boolean(params.error);

  return <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-8">
    <div className="flex flex-col gap-4 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm md:flex-row md:items-end md:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-700">DanceFlow Sign</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Document signing operations</h1><p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">Create, send, track, resend, revoke, and download signed documents from one workspace.</p></div>
      <Link href="/app/documents" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Back to Documents</Link>
    </div>

    {flash ? <div className={`rounded-2xl border p-4 text-sm ${isError ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{flash}</div> : null}

    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">New signing request</h2><p className="mt-2 text-sm text-slate-600">Upload a PDF, identify the signer, then place fields before sending.</p>
      <form action={createSignEnvelopeAction} className="mt-6 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-800">Document title<input name="title" required className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>
        <label className="text-sm font-medium text-slate-800">PDF file<input name="pdfFile" type="file" accept="application/pdf,.pdf" required className="mt-2 block w-full rounded-xl border border-slate-300 p-2 text-sm" /></label>
        <label className="text-sm font-medium text-slate-800">Signer name<input name="signerName" required className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>
        <label className="text-sm font-medium text-slate-800">Signer email<input name="signerEmail" type="email" required className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>
        <label className="text-sm font-medium text-slate-800">Link expires in<select name="expiresInDays" defaultValue="7" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5"><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
        <div className="flex items-end"><button className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white">Upload and place fields</button></div>
      </form>
    </section>

    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-semibold text-slate-950">Signing requests</h2><p className="mt-1 text-sm text-slate-600">Open a request for its full audit history and downloads.</p></div><span className="text-sm font-semibold text-slate-500">{envelopes?.length ?? 0} shown</span></div>
      <div className="mt-4 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-3 pr-4">Document</th><th className="py-3 pr-4">Signer</th><th className="py-3 pr-4">Status</th><th className="py-3 pr-4">Activity</th><th className="py-3">Actions</th></tr></thead><tbody>
        {(envelopes ?? []).map((item) => {
          const active = ["sent","viewed","started"].includes(item.status);
          return <tr key={item.id} className="border-b border-slate-100 align-top">
            <td className="py-4 pr-4"><Link className="font-semibold text-violet-700 hover:underline" href={item.status === "draft" ? `/app/documents/sign/${item.id}/edit` : `/app/documents/sign/${item.id}`}>{item.title}</Link><div className="mt-1 text-xs text-slate-500">Created {formatDate(item.created_at)}</div></td>
            <td className="py-4 pr-4"><div>{item.signer_name}</div><div className="text-xs text-slate-500">{item.signer_email}</div></td>
            <td className="py-4 pr-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ring-1 ${statusClass(item.status)}`}>{item.status}</span></td>
            <td className="py-4 pr-4 text-xs text-slate-600"><div>Sent: {formatDate(item.sent_at)}</div><div>Viewed: {formatDate(item.viewed_at)}</div><div>Completed: {formatDate(item.completed_at)}</div>{Number(item.reminder_count ?? 0) > 0 ? <div>Reminders: {item.reminder_count}</div> : null}</td>
            <td className="py-4"><div className="flex flex-wrap gap-2">
              <Link href={`/app/documents/sign/${item.id}`} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">Details</Link>
              {active ? <form action={resendSignEnvelopeAction}><input type="hidden" name="envelopeId" value={item.id}/><button className="rounded-lg bg-violet-700 px-3 py-2 text-xs font-semibold text-white">Resend</button></form> : null}
              {["draft","sent","viewed","started"].includes(item.status) ? <form action={revokeSignEnvelopeAction}><input type="hidden" name="envelopeId" value={item.id}/><input type="hidden" name="reason" value="Revoked from document operations."/><button className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-semibold text-rose-700">Revoke</button></form> : null}
              {item.status === "completed" ? <><a href={`/app/documents/sign/${item.id}/signed`} className="rounded-lg border border-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-700">Signed PDF</a><a href={`/app/documents/sign/${item.id}/certificate`} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">Certificate</a></> : null}
            </div></td>
          </tr>;
        })}
        {!envelopes?.length ? <tr><td colSpan={5} className="py-8 text-center text-slate-500">No signing requests yet.</td></tr> : null}
      </tbody></table></div>
    </section>
  </main>;
}
