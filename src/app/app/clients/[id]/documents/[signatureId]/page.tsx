import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{ id: string; signatureId: string }>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
};

type SignatureRow = {
  id: string;
  assignment_id: string | null;
  template_id: string;
  template_version_id: string | null;
  signer_name: string;
  signer_email: string | null;
  signer_user_id: string | null;
  signature_method: string | null;
  signature_text: string | null;
  consent_text: string | null;
  signed_body: string | null;
  ip_address: string | null;
  user_agent: string | null;
  device_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  signed_at: string;
  document_templates:
    | { title: string | null; description: string | null }
    | { title: string | null; description: string | null }[]
    | null;
  document_template_versions:
    | { version_number: number | null; title: string | null; body: string | null }
    | { version_number: number | null; title: string | null; body: string | null }[]
    | null;
};

type AuditEventRow = {
  id: string;
  event_type: string;
  event_summary: string | null;
  actor_email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function friendlyValue(value: string | null | undefined) {
  const normalized = (value ?? "").trim();
  if (!normalized) return "Not recorded";
  return normalized.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactJson(value: Record<string, unknown> | null) {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function documentTitle(signature: SignatureRow) {
  return (
    one(signature.document_template_versions)?.title ??
    one(signature.document_templates)?.title ??
    "Signed document"
  );
}

function documentDescription(signature: SignatureRow) {
  return one(signature.document_templates)?.description ?? null;
}

function documentBody(signature: SignatureRow) {
  return (
    signature.signed_body ??
    one(signature.document_template_versions)?.body ??
    "Signed document body was not recorded."
  );
}

function versionLabel(signature: SignatureRow) {
  const version = one(signature.document_template_versions);
  return typeof version?.version_number === "number"
    ? `Version ${version.version_number}`
    : "Version not recorded";
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm text-slate-950">{value || "Not recorded"}</dd>
    </div>
  );
}

export default async function ClientSignedDocumentReceiptPage({ params }: { params: Params }) {
  const { id, signatureId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: client, error: clientError },
    { data: signature, error: signatureError },
    { data: auditEvents, error: auditError },
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone")
      .eq("id", id)
      .eq("studio_id", studioId)
      .maybeSingle<ClientRow>(),
    supabase
      .from("document_signatures")
      .select(
        `
        id,
        assignment_id,
        template_id,
        template_version_id,
        signer_name,
        signer_email,
        signer_user_id,
        signature_method,
        signature_text,
        consent_text,
        signed_body,
        ip_address,
        user_agent,
        device_metadata,
        metadata,
        signed_at,
        document_templates ( title, description ),
        document_template_versions ( version_number, title, body )
      `,
      )
      .eq("id", signatureId)
      .eq("client_id", id)
      .eq("studio_id", studioId)
      .maybeSingle<SignatureRow>(),
    supabase
      .from("document_signature_audit_events")
      .select("id, event_type, event_summary, actor_email, ip_address, user_agent, created_at")
      .eq("signature_id", signatureId)
      .order("created_at", { ascending: true }),
  ]);

  if (clientError || !client) notFound();
  if (signatureError || !signature) notFound();
  if (auditError) throw new Error(`Failed to load signature audit trail: ${auditError.message}`);

  const clientName = `${client.first_name} ${client.last_name}`.trim() || client.email || "Client";
  const deviceMetadata = compactJson(signature.device_metadata);
  const signatureMetadata = compactJson(signature.metadata);

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 text-slate-950 print:bg-white print:px-0 print:py-0">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-sheet { border: none !important; box-shadow: none !important; max-width: none !important; }
          .avoid-break { break-inside: avoid; }
        }
      `}</style>

      <div className="mx-auto max-w-4xl space-y-4">
        <div className="no-print flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <Link href={`/app/clients/${id}?tab=documents`} className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
            Back to client documents
          </Link>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link
              href={`/app/clients/${id}/documents/${signatureId}/pdf`}
              className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              Download PDF
            </Link>
            <p className="text-sm text-slate-500">You can also use browser print/save as PDF.</p>
          </div>
        </div>

        <article className="print-sheet rounded-[28px] border border-slate-200 bg-white p-8 shadow-sm">
          <header className="border-b border-slate-200 pb-6">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-indigo-600">Signed Document Receipt</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">{documentTitle(signature)}</h1>
            {documentDescription(signature) ? <p className="mt-2 text-sm text-slate-600">{documentDescription(signature)}</p> : null}
            <p className="mt-4 text-sm text-slate-500">Receipt generated {formatDateTime(new Date().toISOString())}</p>
          </header>

          <section className="avoid-break mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-base font-semibold text-slate-950">Client</h2>
              <dl className="mt-3 space-y-3">
                <DetailRow label="Client" value={clientName} />
                <DetailRow label="Email" value={client.email} />
                <DetailRow label="Phone" value={client.phone} />
                <DetailRow label="Client id" value={client.id} />
              </dl>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-base font-semibold text-slate-950">Signer</h2>
              <dl className="mt-3 space-y-3">
                <DetailRow label="Signer name" value={signature.signer_name} />
                <DetailRow label="Signer email" value={signature.signer_email ?? client.email} />
                <DetailRow label="Signer user id" value={signature.signer_user_id} />
                <DetailRow label="Signed at" value={formatDateTime(signature.signed_at)} />
              </dl>
            </div>
          </section>

          <section className="avoid-break mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <h2 className="text-base font-semibold text-emerald-950">Signature Evidence</h2>
            <dl className="mt-3 grid gap-3 md:grid-cols-2">
              <DetailRow label="Document version" value={versionLabel(signature)} />
              <DetailRow label="Signature method" value={friendlyValue(signature.signature_method ?? "typed")} />
              <DetailRow label="Signature text" value={signature.signature_text} />
              <DetailRow label="IP address" value={signature.ip_address} />
              <DetailRow label="Signature id" value={signature.id} />
              <DetailRow label="Assignment id" value={signature.assignment_id} />
            </dl>
            {signature.consent_text ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Consent accepted</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{signature.consent_text}</p>
              </div>
            ) : null}
          </section>

          <section className="mt-6">
            <h2 className="text-lg font-semibold text-slate-950">Signed Document Text</h2>
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-5">
              <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800">{documentBody(signature)}</p>
            </div>
          </section>

          <section className="avoid-break mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h2 className="text-base font-semibold text-slate-950">Technical Metadata</h2>
            <dl className="mt-3 space-y-3">
              <DetailRow label="User agent" value={signature.user_agent} />
              <DetailRow label="Device metadata" value={deviceMetadata} />
              <DetailRow label="Signature metadata" value={signatureMetadata} />
            </dl>
          </section>

          <section className="mt-6">
            <h2 className="text-lg font-semibold text-slate-950">Audit Trail</h2>
            <div className="mt-3 space-y-3">
              {(auditEvents ?? []).length === 0 ? (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  No audit events were recorded for this signature.
                </p>
              ) : (
                (auditEvents as AuditEventRow[]).map((event) => (
                  <div key={event.id} className="avoid-break rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <p className="font-semibold text-slate-950">{friendlyValue(event.event_type)}</p>
                      <p className="text-slate-500">{formatDateTime(event.created_at)}</p>
                    </div>
                    {event.event_summary ? <p className="mt-2 text-slate-700">{event.event_summary}</p> : null}
                    <p className="mt-2 text-xs text-slate-500">
                      {event.actor_email ?? "No actor email"}{event.ip_address ? ` - ${event.ip_address}` : ""}
                    </p>
                    {event.user_agent ? <p className="mt-1 break-words text-xs text-slate-500">User agent: {event.user_agent}</p> : null}
                  </div>
                ))
              )}
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}