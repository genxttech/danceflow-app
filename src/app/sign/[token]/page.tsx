import { createAdminClient } from "@/lib/supabase/admin";
import { hashSigningToken } from "@/lib/documents/signing";
import { completeSigningAction, declineSigningAction } from "./actions";

type Params = Promise<{ token: string }>;
type Search = Promise<{ success?: string; error?: string }>;

export default async function PublicSigningPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { token } = await params;
  const query = await searchParams;
  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id,title,signer_name,signer_email,status,expires_at,viewed_at,completed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!envelope) return <main className="grid min-h-screen place-items-center bg-slate-50 p-6"><div className="max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm"><h1 className="text-2xl font-semibold">Signing link unavailable</h1><p className="mt-3 text-slate-600">This link is invalid or no longer available.</p></div></main>;

  const expired = new Date(envelope.expires_at).getTime() <= Date.now();
  if (!envelope.viewed_at && !expired && envelope.status === "sent") {
    const now = new Date().toISOString();
    await admin.from("document_sign_envelopes").update({ status: "viewed", viewed_at: now, updated_at: now }).eq("id", envelope.id).eq("status", "sent");
    await admin.from("document_sign_events").insert({ envelope_id: envelope.id, event_type: "viewed", actor_email: envelope.signer_email, summary: "Signer opened the signing link." });
  }

  const { data: fields } = await admin.from("document_sign_fields").select("id,field_type,label,required,sort_order").eq("envelope_id", envelope.id).order("sort_order");
  const unavailable = expired || ["declined", "expired", "void"].includes(envelope.status);
  const completed = envelope.status === "completed" || query.success === "completed";

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="rounded-[28px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-7 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">DanceFlow Sign</p>
          <h1 className="mt-3 text-3xl font-semibold">{envelope.title}</h1>
          <p className="mt-2 text-sm text-white/80">Requested for {envelope.signer_name} · {envelope.signer_email}</p>
        </header>

        {completed ? <section className="rounded-[28px] border border-emerald-200 bg-emerald-50 p-8 text-center"><h2 className="text-2xl font-semibold text-emerald-950">Document completed</h2><p className="mt-2 text-emerald-800">Your signed PDF is ready.</p><a href={`/sign/${encodeURIComponent(token)}/signed`} className="mt-5 inline-flex rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white">Download signed PDF</a></section> : null}
        {query.success === "declined" ? <section className="rounded-[28px] border border-slate-200 bg-white p-8 text-center"><h2 className="text-2xl font-semibold">Signature declined</h2><p className="mt-2 text-slate-600">Your response was recorded.</p></section> : null}
        {query.error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Unable to continue: {query.error.replaceAll("_", " ")}.</div> : null}

        {!completed && query.success !== "declined" ? (
          unavailable ? <section className="rounded-[28px] border border-slate-200 bg-white p-8 text-center"><h2 className="text-2xl font-semibold">Signing link unavailable</h2><p className="mt-2 text-slate-600">This request has expired, was declined, or was voided.</p></section> :
          <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
            <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 p-4"><h2 className="font-semibold text-slate-950">Review the document</h2></div>
              <iframe title="Document to sign" src={`/sign/${encodeURIComponent(token)}/source`} className="h-[720px] w-full bg-slate-100" />
            </section>
            <aside className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-950">Complete required fields</h2>
              <form action={completeSigningAction} className="mt-5 space-y-4">
                <input type="hidden" name="token" value={token} />
                <label className="block text-sm font-medium text-slate-800">Signer name<input name="signerName" defaultValue={envelope.signer_name} required className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>
                {(fields ?? []).map((field) => {
                  if (["signature", "printed_name", "date"].includes(field.field_type)) return null;
                  if (field.field_type === "checkbox") return <label key={field.id} className="flex gap-3 rounded-xl border border-slate-200 p-3 text-sm"><input type="checkbox" name={`field_${field.id}`} required={field.required} /><span>{field.label}</span></label>;
                  return <label key={field.id} className="block text-sm font-medium text-slate-800">{field.label}<input name={`field_${field.id}`} required={field.required} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5" /></label>;
                })}
                <label className="flex gap-3 rounded-xl border border-slate-200 p-3 text-sm leading-6"><input type="checkbox" name="consent" required className="mt-1" /><span>I have reviewed this document and agree to sign it electronically.</span></label>
                <button className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white">Finish and sign</button>
              </form>
              <details className="mt-5 border-t border-slate-200 pt-4"><summary className="cursor-pointer text-sm font-semibold text-slate-700">Decline to sign</summary><form action={declineSigningAction} className="mt-3 space-y-3"><input type="hidden" name="token" value={token} /><textarea name="reason" placeholder="Optional reason" className="w-full rounded-xl border border-slate-300 p-3 text-sm" /><button className="w-full rounded-xl border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-700">Decline document</button></form></details>
            </aside>
          </div>
        ) : null}
      </div>
    </main>
  );
}
