import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import FieldPlacementEditor from "./FieldPlacementEditor";

export default async function EditSigningEnvelopePage({ params, searchParams }: { params: Promise<{ envelopeId: string }>; searchParams: Promise<{ success?: string; error?: string }> }) {
  const { envelopeId } = await params; const query = await searchParams; const context = await getCurrentStudioContext(); const admin = createAdminClient();
  const { data: envelope } = await admin.from("document_sign_envelopes").select("id,title,signer_name,signer_email,status,page_sizes,page_count").eq("id", envelopeId).eq("studio_id", context.studioId).maybeSingle();
  if (!envelope || envelope.status !== "draft") notFound();
  const { data: fields } = await admin.from("document_sign_fields").select("id,field_type,page_number,x,y,width,height,label,required,placeholder_text,default_value").eq("envelope_id", envelopeId).order("sort_order");
  const pageSizes = Array.isArray(envelope.page_sizes) && envelope.page_sizes.length ? envelope.page_sizes : Array.from({ length: envelope.page_count }, (_, index) => ({ pageNumber: index + 1, width: 612, height: 792 }));
  return <main className="mx-auto max-w-[1500px] space-y-5 px-4 py-6 md:px-8"><header className="flex flex-col gap-3 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm md:flex-row md:items-end md:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-700">DanceFlow Sign</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Place signing fields</h1><p className="mt-2 text-sm text-slate-600">{envelope.title} · {envelope.signer_name} · {envelope.signer_email}</p></div><Link href="/app/documents/sign" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold">Back to requests</Link></header>{query.success === "saved" ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">Field layout saved.</div> : null}{query.error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Unable to continue: {query.error.replaceAll("_", " ")}.</div> : null}<FieldPlacementEditor envelopeId={envelopeId} pageSizes={pageSizes} initialFields={(fields ?? []) as never[]} /></main>;
}
