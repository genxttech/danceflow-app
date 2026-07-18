import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageDocumentsRole } from "@/lib/documents/studio-access";
import { redirect } from "next/navigation";
import { resendSignEnvelopeAction, revokeSignEnvelopeAction } from "../actions";

function fmt(value: string | null) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(); }
export default async function SignEnvelopeDetailPage({ params }: { params: Promise<{ envelopeId: string }> }) {
  const { envelopeId } = await params;
  const context = await getCurrentStudioContext();
  if (!canManageDocumentsRole(context.studioRole)) redirect("/app");
  const admin = createAdminClient();
  const { data: envelope } = await admin.from("document_sign_envelopes").select("*").eq("id", envelopeId).eq("studio_id", context.studioId).maybeSingle();
  if (!envelope) return <main className="p-8">Signing request not found.</main>;
  const { data: events } = await admin.from("document_sign_events").select("id,event_type,actor_email,ip_address,user_agent,summary,created_at").eq("envelope_id", envelopeId).order("created_at", { ascending: false });
  const active = ["sent","viewed","started"].includes(envelope.status);
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
    <div className="flex flex-col gap-4 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-violet-700">Signing request</p><h1 className="mt-2 text-3xl font-bold text-slate-950">{envelope.title}</h1><p className="mt-2 text-sm text-slate-600">{envelope.signer_name} · {envelope.signer_email}</p></div><Link href="/app/documents#active-requests" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Back to Documents</Link></div>
    <section className="grid gap-4 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
      <div><p className="text-xs font-bold uppercase text-slate-500">Status</p><p className="mt-2 font-bold capitalize text-slate-950">{envelope.status}</p></div><div><p className="text-xs font-bold uppercase text-slate-500">Sent</p><p className="mt-2 text-sm text-slate-700">{fmt(envelope.sent_at)}</p></div><div><p className="text-xs font-bold uppercase text-slate-500">Completed</p><p className="mt-2 text-sm text-slate-700">{fmt(envelope.completed_at)}</p></div><div><p className="text-xs font-bold uppercase text-slate-500">Expires</p><p className="mt-2 text-sm text-slate-700">{fmt(envelope.expires_at)}</p></div>
    </section>
    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap gap-3">{envelope.status === "draft" ? <Link href={`/app/documents/sign/${envelope.id}/edit`} className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white">Edit field layout</Link> : null}{active ? <form action={resendSignEnvelopeAction}><input type="hidden" name="envelopeId" value={envelope.id}/><button className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white">Resend with new secure link</button></form> : null}{["draft","sent","viewed","started"].includes(envelope.status) ? <form action={revokeSignEnvelopeAction} className="flex gap-2"><input type="hidden" name="envelopeId" value={envelope.id}/><input name="reason" placeholder="Reason for revoking" className="rounded-xl border border-slate-300 px-3 py-2 text-sm"/><button className="rounded-xl border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-700">Revoke</button></form> : null}{envelope.status === "completed" ? <><a href={`/app/documents/sign/${envelope.id}/signed`} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white">Download signed PDF</a><a href={`/app/documents/sign/${envelope.id}/certificate`} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700">Completion certificate</a></> : null}</div></section>
    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-xl font-bold text-slate-950">Audit history</h2><div className="mt-4 divide-y divide-slate-200">{(events ?? []).map((event) => <div key={event.id} className="py-4"><div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"><p className="font-bold capitalize text-slate-900">{String(event.event_type).replaceAll("_"," ")}</p><p className="text-xs text-slate-500">{fmt(event.created_at)}</p></div><p className="mt-1 text-sm text-slate-600">{event.summary || "Activity recorded."}</p>{event.actor_email ? <p className="mt-1 text-xs text-slate-500">Actor: {event.actor_email}</p> : null}</div>)}{!events?.length ? <p className="py-6 text-sm text-slate-500">No audit events recorded.</p> : null}</div></section>
  </main>;
}
