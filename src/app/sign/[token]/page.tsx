import { createAdminClient } from "@/lib/supabase/admin";
import { hashSigningToken } from "@/lib/documents/signing";
import { declineSigningAction } from "./actions";
import SigningCanvas from "./SigningCanvas";
import { consumePublicSigningRateLimit, serverActionIp } from "@/lib/documents/public-signing-security";

type Params = Promise<{ token: string }>; type Search = Promise<{ success?: string; error?: string }>;
const SAFE_ERRORS: Record<string, string> = {
  invalid_link: "This signing link is invalid or no longer available.",
  link_unavailable: "This signing request is no longer available.",
  link_expired: "This signing link has expired. Contact the studio for a new request.",
  missing_required_fields: "Complete all required fields before submitting.",
  missing_required_signature: "Apply all required signatures or initials before submitting.",
  fields_unavailable: "The signing fields could not be loaded. Contact the studio.",
  document_unavailable: "The document could not be loaded. Contact the studio.",
  completion_failed: "The document could not be completed. Please try again.",
  too_many_attempts: "Too many attempts were made. Wait a few minutes and try again.",
};
export default async function PublicSigningPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { token } = await params; const query = await searchParams; const admin = createAdminClient(); const tokenHash = hashSigningToken(token);
  const pageRateLimit = await consumePublicSigningRateLimit(admin, { action: "page_view", tokenHash, ip: await serverActionIp() });
  if (!pageRateLimit.allowed) return <main className="grid min-h-screen place-items-center bg-slate-50 p-6"><div className="max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm"><h1 className="text-2xl font-semibold">Please wait</h1><p className="mt-3 text-slate-600">Too many requests were made. Wait a moment and try again.</p></div></main>;
  const { data: envelope } = await admin.from("document_sign_envelopes").select("id,studio_id,title,signer_name,signer_email,status,expires_at,viewed_at,completed_at,page_count,page_sizes").eq("token_hash", tokenHash).maybeSingle();
  if (!envelope) return <main className="grid min-h-screen place-items-center bg-slate-50 p-6"><div className="max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm"><h1 className="text-2xl font-semibold">Signing link unavailable</h1><p className="mt-3 text-slate-600">This link is invalid or no longer available.</p></div></main>;
  const { data: studio } = await admin
    .from("studios")
    .select("name,public_name,public_logo_url")
    .eq("id", envelope.studio_id)
    .maybeSingle();
  const studioName = studio?.public_name || studio?.name || "Your studio";
  const studioLogoUrl = typeof studio?.public_logo_url === "string" ? studio.public_logo_url : null;
  const expired = new Date(envelope.expires_at).getTime() <= Date.now();
  if (!envelope.viewed_at && !expired && envelope.status === "sent") { const now = new Date().toISOString(); await admin.from("document_sign_envelopes").update({ status: "viewed", viewed_at: now, updated_at: now }).eq("id", envelope.id).eq("status", "sent"); await admin.from("document_sign_events").insert({ envelope_id: envelope.id, event_type: "viewed", actor_email: envelope.signer_email, summary: "Signer opened the signing link." }); }
  const { data: fields } = await admin.from("document_sign_fields").select("id,field_type,page_number,x,y,width,height,label,required,placeholder_text,default_value,sort_order").eq("envelope_id", envelope.id).order("sort_order");
  const unavailable = expired || ["declined", "expired", "void"].includes(envelope.status); const completed = envelope.status === "completed" || query.success === "completed";
  const pageSizes = Array.isArray(envelope.page_sizes) && envelope.page_sizes.length ? envelope.page_sizes : Array.from({ length: envelope.page_count }, (_, index) => ({ pageNumber: index + 1, width: 612, height: 792 }));
  return <main className="min-h-screen bg-slate-50 px-4 py-8"><div className="mx-auto max-w-6xl space-y-5"><header className="rounded-[28px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-7 text-white shadow-sm"><div className="flex flex-col gap-5 sm:flex-row sm:items-center">{studioLogoUrl ? <img src={studioLogoUrl} alt={`${studioName} logo`} className="h-16 w-16 rounded-2xl bg-white object-contain p-2 shadow-sm" /> : null}<div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">{studioName} · DanceFlow Sign</p><h1 className="mt-3 text-3xl font-semibold">{envelope.title}</h1><p className="mt-2 text-sm text-white/80">Requested for {envelope.signer_name} · {envelope.signer_email}</p></div></div></header>
  {completed ? <section className="rounded-[28px] border border-emerald-200 bg-emerald-50 p-8 text-center"><h2 className="text-2xl font-semibold text-emerald-950">Document completed</h2><p className="mt-2 text-emerald-800">Your signed PDF is ready.</p><a href={`/sign/${encodeURIComponent(token)}/signed`} className="mt-5 inline-flex rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white">Download signed PDF</a></section> : null}
  {query.success === "declined" ? <section className="rounded-[28px] border border-slate-200 bg-white p-8 text-center"><h2 className="text-2xl font-semibold">Signature declined</h2><p className="mt-2 text-slate-600">Your response was recorded.</p></section> : null}
  {query.error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{SAFE_ERRORS[query.error] ?? "The signing request could not be completed. Contact the studio if the problem continues."}</div> : null}
  {!completed && query.success !== "declined" ? unavailable ? <section className="rounded-[28px] border border-slate-200 bg-white p-8 text-center"><h2 className="text-2xl font-semibold">Signing link unavailable</h2><p className="mt-2 text-slate-600">This request has expired, was declined, or was voided.</p></section> : <div className="space-y-5"><SigningCanvas token={token} signerName={envelope.signer_name} fields={(fields ?? []) as never[]} pageSizes={pageSizes} /><details className="rounded-2xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-700">Decline to sign</summary><form action={declineSigningAction} className="mt-3 space-y-3"><input type="hidden" name="token" value={token} /><textarea name="reason" placeholder="Optional reason" className="w-full rounded-xl border border-slate-300 p-3 text-sm" /><button className="rounded-xl border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-700">Decline document</button></form></details></div> : null}
  </div></main>;
}
