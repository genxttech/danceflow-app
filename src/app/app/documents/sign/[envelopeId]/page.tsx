import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageDocumentsRole } from "@/lib/documents/studio-access";
import { redirect } from "next/navigation";
import {
  duplicateCompletedSignEnvelopeAction,
  resendSignEnvelopeAction,
  reviseSignEnvelopeAction,
  revokeSignEnvelopeAction,
} from "../actions";

function fmt(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function errorMessage(code?: string) {
  if (!code) return null;
  if (code === "revision_reason_required")
    return "Add a clear reason before creating the protected revision.";
  if (code === "already_superseded")
    return "This request was already superseded by another revision.";
  if (code === "revision_create_failed")
    return "The protected revision could not be created.";
  if (code === "revision_supersede_failed")
    return "The replacement draft was created, but the original could not be superseded safely.";
  if (code === "duplicate_create_failed")
    return "The completed request could not be duplicated.";
  return code.replaceAll("_", " ");
}

export default async function SignEnvelopeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ envelopeId: string }>;
  searchParams?: Promise<{ error?: string }>;
}) {
  const { envelopeId } = await params;
  const query = (await searchParams) ?? {};
  const context = await getCurrentStudioContext();

  if (!canManageDocumentsRole(context.studioRole)) redirect("/app");

  const admin = createAdminClient();
  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("*")
    .eq("id", envelopeId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (!envelope) {
    return <main className="p-8">Signing request not found.</main>;
  }

  const { data: events } = await admin
    .from("document_sign_events")
    .select(
      "id,event_type,actor_email,ip_address,user_agent,summary,created_at",
    )
    .eq("envelope_id", envelopeId)
    .order("created_at", { ascending: false });

  const active = ["sent", "viewed", "started"].includes(envelope.status);
  const revisable =
    ["sent", "viewed", "started", "expired", "declined", "void"].includes(
      envelope.status,
    ) && !envelope.superseded_by_envelope_id;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
      <div className="flex flex-col gap-4 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.18em] text-violet-700">
            Signing request
          </p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">
            {envelope.title}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {envelope.signer_name} · {envelope.signer_email}
          </p>
        </div>
        <Link
          href="/app/documents#active-requests"
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
        >
          Back to Documents
        </Link>
      </div>

      {query.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {errorMessage(query.error)}
        </div>
      ) : null}

      {envelope.revision_of_envelope_id ? (
        <section className="rounded-[28px] border border-violet-200 bg-violet-50 p-6">
          <p className="font-bold text-violet-950">
            {envelope.revision_kind === "duplicate"
              ? "Created from a completed request"
              : `Revision ${envelope.revision_number}`}
          </p>
          <p className="mt-2 text-sm leading-6 text-violet-900">
            <Link
              href={`/app/documents/sign/${envelope.revision_of_envelope_id}`}
              className="font-semibold underline"
            >
              View the original request
            </Link>
            {envelope.revision_reason
              ? ` · Reason: ${envelope.revision_reason}`
              : ""}
          </p>
        </section>
      ) : null}

      {envelope.superseded_by_envelope_id ? (
        <section className="rounded-[28px] border border-amber-200 bg-amber-50 p-6">
          <p className="font-bold text-amber-950">
            This request was superseded
          </p>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            Its secure link was invalidated and its audit history was retained.{" "}
            <Link
              href={`/app/documents/sign/${envelope.superseded_by_envelope_id}`}
              className="font-semibold underline"
            >
              Open the replacement request
            </Link>
          </p>
        </section>
      ) : null}

      <section className="grid gap-4 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs font-bold uppercase text-slate-500">Status</p>
          <p className="mt-2 font-bold capitalize text-slate-950">
            {envelope.status}
          </p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase text-slate-500">Sent</p>
          <p className="mt-2 text-sm text-slate-700">{fmt(envelope.sent_at)}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase text-slate-500">
            Completed
          </p>
          <p className="mt-2 text-sm text-slate-700">
            {fmt(envelope.completed_at)}
          </p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase text-slate-500">Expires</p>
          <p className="mt-2 text-sm text-slate-700">
            {fmt(envelope.expires_at)}
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap gap-3">
          {envelope.status === "draft" ? (
            <Link
              href={`/app/documents/sign/${envelope.id}/edit`}
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white"
            >
              Edit field layout
            </Link>
          ) : null}

          {active ? (
            <form action={resendSignEnvelopeAction}>
              <input type="hidden" name="envelopeId" value={envelope.id} />
              <button className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white">
                Resend with new secure link
              </button>
            </form>
          ) : null}

          {["draft", "sent", "viewed", "started"].includes(envelope.status) ? (
            <form action={revokeSignEnvelopeAction} className="flex gap-2">
              <input type="hidden" name="envelopeId" value={envelope.id} />
              <input
                name="reason"
                required
                placeholder="Reason for revoking"
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
              <button className="rounded-xl border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-700">
                Revoke
              </button>
            </form>
          ) : null}

          {envelope.status === "completed" ? (
            <>
              <a
                href={`/app/documents/sign/${envelope.id}/signed`}
                className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white"
              >
                Download signed PDF
              </a>
              <a
                href={`/app/documents/sign/${envelope.id}/certificate`}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700"
              >
                Completion certificate
              </a>
            </>
          ) : null}
        </div>

        {revisable ? (
          <form
            action={reviseSignEnvelopeAction}
            className="rounded-2xl border border-violet-200 bg-violet-50 p-4"
          >
            <input type="hidden" name="envelopeId" value={envelope.id} />
            <div>
              <p className="font-bold text-violet-950">Revise and resend</p>
              <p className="mt-1 text-sm leading-6 text-violet-800">
                Creates a new draft with the same PDF and field layout. The
                current request is superseded, its secure link is invalidated,
                and its audit history remains unchanged.
              </p>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_auto]">
              <input
                name="reason"
                required
                minLength={5}
                maxLength={500}
                placeholder="Why is this request being revised?"
                className="rounded-xl border border-violet-300 bg-white px-3 py-2 text-sm"
              />
              <select
                name="expiresInDays"
                defaultValue="7"
                className="rounded-xl border border-violet-300 bg-white px-3 py-2 text-sm"
              >
                <option value="3">Expires in 3 days</option>
                <option value="7">Expires in 7 days</option>
                <option value="14">Expires in 14 days</option>
                <option value="30">Expires in 30 days</option>
              </select>
              <button className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white">
                Create revision
              </button>
            </div>
          </form>
        ) : null}

        {envelope.status === "completed" ? (
          <form
            action={duplicateCompletedSignEnvelopeAction}
            className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
          >
            <input type="hidden" name="envelopeId" value={envelope.id} />
            <p className="font-bold text-slate-950">Duplicate as new request</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Completed records are immutable. This creates a separate draft
              using the same PDF and field layout.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_auto]">
              <input
                name="reason"
                maxLength={500}
                placeholder="Optional reason for the new request"
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              />
              <select
                name="expiresInDays"
                defaultValue="7"
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="3">Expires in 3 days</option>
                <option value="7">Expires in 7 days</option>
                <option value="14">Expires in 14 days</option>
                <option value="30">Expires in 30 days</option>
              </select>
              <button className="rounded-xl border border-slate-400 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800">
                Create new draft
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-bold text-slate-950">Audit history</h2>
        <div className="mt-4 divide-y divide-slate-200">
          {(events ?? []).map((event) => (
            <div key={event.id} className="py-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <p className="font-bold capitalize text-slate-900">
                  {String(event.event_type).replaceAll("_", " ")}
                </p>
                <p className="text-xs text-slate-500">
                  {fmt(event.created_at)}
                </p>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {event.summary || "Activity recorded."}
              </p>
              {event.actor_email ? (
                <p className="mt-1 text-xs text-slate-500">
                  Actor: {event.actor_email}
                </p>
              ) : null}
            </div>
          ))}
          {!events?.length ? (
            <p className="py-6 text-sm text-slate-500">
              No audit events recorded.
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
