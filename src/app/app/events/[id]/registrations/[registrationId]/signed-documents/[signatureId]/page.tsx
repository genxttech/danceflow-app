import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireEventWorkspaceFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  id: string;
  registrationId: string;
  signatureId: string;
}>;

type EventRow = {
  id: string;
  name: string;
  slug: string | null;
  start_date: string | null;
  start_time: string | null;
};

type RegistrationRow = {
  id: string;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  created_at: string;
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

function formatDate(value: string | null | undefined) {
  if (!value) return "Date not set";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function friendlyValue(value: string | null | undefined) {
  const normalized = (value ?? "").trim();
  if (!normalized) return "Not recorded";

  return normalized
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactJson(value: Record<string, unknown> | null) {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function documentTitle(signature: SignatureRow) {
  return one(signature.document_template_versions)?.title ??
    one(signature.document_templates)?.title ??
    "Signed document";
}

function documentDescription(signature: SignatureRow) {
  return one(signature.document_templates)?.description ?? null;
}

function documentBody(signature: SignatureRow) {
  return signature.signed_body ??
    one(signature.document_template_versions)?.body ??
    "Signed document body was not recorded.";
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

export default async function SignedDocumentReceiptPage({ params }: { params: Params }) {
  const { id, registrationId, signatureId } = await params;

  await requireEventWorkspaceFeature({
    eventId: id,
    feature: "organizer_tools",
    allowedOrganizerRoles: ["organizer_owner", "organizer_admin", "organizer_staff"],
  });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: event, error: eventError },
    { data: registration, error: registrationError },
    { data: signature, error: signatureError },
    { data: auditEvents, error: auditError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select("id, name, slug, start_date, start_time")
      .eq("id", id)
      .eq("studio_id", studioId)
      .maybeSingle<EventRow>(),
    supabase
      .from("event_registrations")
      .select("id, attendee_first_name, attendee_last_name, attendee_email, attendee_phone, created_at")
      .eq("id", registrationId)
      .eq("event_id", id)
      .maybeSingle<RegistrationRow>(),
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
      .eq("event_registration_id", registrationId)
      .eq("event_id", id)
      .maybeSingle<SignatureRow>(),
    supabase
      .from("document_signature_audit_events")
      .select("id, event_type, event_summary, actor_email, ip_address, user_agent, created_at")
      .eq("signature_id", signatureId)
      .order("created_at", { ascending: true }),
  ]);

  if (eventError || !event) notFound();
  if (registrationError || !registration) notFound();
  if (signatureError || !signature) notFound();
  if (auditError) throw new Error(`Failed to load signature audit trail: ${auditError.message}`);

  const typedEvent = event as EventRow;
  const typedRegistration = registration as RegistrationRow;
  const typedSignature = signature as SignatureRow;
  const typedAuditEvents = (auditEvents ?? []) as AuditEventRow[];
  const attendeeName = `${typedRegistration.attendee_first_name} ${typedRegistration.attendee_last_name}`.trim();
  const deviceMetadata = compactJson(typedSignature.device_metadata);
  const signatureMetadata = compactJson(typedSignature.metadata);

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
          <Link
            href={`/app/events/${id}/registrations/${registrationId}`}
            className="text-sm font-semibold text-indigo-600 hover:text-indigo-700"
          >
            Back to registration
          </Link>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link
              href={`/app/events/${id}/registrations/${registrationId}/signed-documents/${signatureId}/pdf`}
              className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              Download PDF
            </Link>
            <p className="text-sm text-slate-500">
              You can also use browser print/save as PDF.
            </p>
          </div>
        </div>

        <article className="print-sheet rounded-[28px] border border-slate-200 bg-white p-8 shadow-sm">
          <header className="border-b border-slate-200 pb-6">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-indigo-600">Signed Document Receipt</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">{documentTitle(typedSignature)}</h1>
            {documentDescription(typedSignature) ? (
              <p className="mt-2 text-sm text-slate-600">{documentDescription(typedSignature)}</p>
            ) : null}
            <p className="mt-4 text-sm text-slate-500">
              Receipt generated {formatDateTime(new Date().toISOString())}
            </p>
          </header>

          <section className="avoid-break mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-base font-semibold text-slate-950">Event</h2>
              <dl className="mt-3 space-y-3">
                <DetailRow label="Event" value={typedEvent.name} />
                <DetailRow label="Date" value={formatDate(typedEvent.start_date)} />
                <DetailRow label="Registration" value={typedRegistration.id} />
                <DetailRow label="Registered" value={formatDateTime(typedRegistration.created_at)} />
              </dl>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-base font-semibold text-slate-950">Signer</h2>
              <dl className="mt-3 space-y-3">
                <DetailRow label="Signer name" value={typedSignature.signer_name} />
                <DetailRow label="Signer email" value={typedSignature.signer_email ?? typedRegistration.attendee_email} />
                <DetailRow label="Attendee" value={attendeeName || typedRegistration.attendee_email} />
                <DetailRow label="Phone" value={typedRegistration.attendee_phone} />
              </dl>
            </div>
          </section>

          <section className="avoid-break mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <h2 className="text-base font-semibold text-emerald-950">Signature Evidence</h2>
            <dl className="mt-3 grid gap-3 md:grid-cols-2">
              <DetailRow label="Signed at" value={formatDateTime(typedSignature.signed_at)} />
              <DetailRow label="Document version" value={versionLabel(typedSignature)} />
              <DetailRow label="Signature method" value={friendlyValue(typedSignature.signature_method ?? "typed")} />
              <DetailRow label="Signature text" value={typedSignature.signature_text} />
              <DetailRow label="IP address" value={typedSignature.ip_address} />
              <DetailRow label="Signer user id" value={typedSignature.signer_user_id} />
            </dl>
            {typedSignature.consent_text ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Consent accepted</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{typedSignature.consent_text}</p>
              </div>
            ) : null}
          </section>

          <section className="mt-6">
            <h2 className="text-lg font-semibold text-slate-950">Signed Document Text</h2>
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-5">
              <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800">{documentBody(typedSignature)}</p>
            </div>
          </section>

          <section className="avoid-break mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h2 className="text-base font-semibold text-slate-950">Technical Metadata</h2>
            <dl className="mt-3 space-y-3">
              <DetailRow label="User agent" value={typedSignature.user_agent} />
              <DetailRow label="Device metadata" value={deviceMetadata} />
              <DetailRow label="Signature metadata" value={signatureMetadata} />
              <DetailRow label="Signature id" value={typedSignature.id} />
              <DetailRow label="Assignment id" value={typedSignature.assignment_id} />
            </dl>
          </section>

          <section className="mt-6">
            <h2 className="text-lg font-semibold text-slate-950">Audit Trail</h2>
            <div className="mt-3 space-y-3">
              {typedAuditEvents.length === 0 ? (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  No audit events were recorded for this signature.
                </p>
              ) : (
                typedAuditEvents.map((event) => (
                  <div key={event.id} className="avoid-break rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <p className="font-semibold text-slate-950">{friendlyValue(event.event_type)}</p>
                      <p className="text-slate-500">{formatDateTime(event.created_at)}</p>
                    </div>
                    {event.event_summary ? <p className="mt-2 text-slate-700">{event.event_summary}</p> : null}
                    <p className="mt-2 text-xs text-slate-500">
                      {event.actor_email ?? "No actor email"}{event.ip_address ? ` • ${event.ip_address}` : ""}
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
