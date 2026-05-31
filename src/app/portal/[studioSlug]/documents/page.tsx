import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signPortalDocumentAction } from "./actions";

type Params = Promise<{
  studioSlug: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  slug: string;
  public_name: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

type AssignmentRow = {
  id: string;
  template_id: string;
  template_version_id: string | null;
  status: string;
  due_at: string | null;
  assigned_at: string;
  signed_at: string | null;
};

type TemplateRow = {
  id: string;
  title: string;
  description: string | null;
  body: string;
  current_version: number | null;
  document_type: string;
  requires_signature: boolean | null;
  is_required: boolean | null;
  applies_to: string | null;
};

type VersionRow = {
  id: string;
  template_id: string;
  version_number: number;
  title: string;
  description: string | null;
  body: string;
  requires_signature: boolean | null;
  is_required: boolean | null;
};

type SignatureRow = {
  id: string;
  assignment_id: string | null;
  template_id: string;
  template_version_id: string | null;
  signer_name: string;
  signed_at: string;
};

type DocumentItem = {
  key: string;
  assignment: AssignmentRow | null;
  template: TemplateRow;
  version: VersionRow | null;
  signature: SignatureRow | null;
  isSigned: boolean;
  isRequired: boolean;
};

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function typeLabel(value: string | null | undefined) {
  if (value === "waiver") return "Waiver";
  if (value === "policy") return "Policy";
  if (value === "agreement") return "Agreement";
  if (value === "release") return "Release";
  if (value === "membership_terms") return "Membership Terms";
  if (value === "package_policy") return "Package Policy";
  if (value === "cancellation_policy") return "Cancellation Policy";
  if (value === "minor_guardian") return "Minor / Guardian Form";
  return "Document";
}

function getClientName(client: ClientRow) {
  const name = [client.first_name, client.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  return name || client.email || "Portal User";
}

function getErrorMessage(value: string | undefined) {
  if (!value) return null;
  if (value === "missing_signature_name") return "Enter your name before signing.";
  if (value === "missing_consent") return "Check the agreement box before signing.";
  if (value === "document_not_found") return "That document could not be found.";
  if (value === "document_not_assigned") return "That document is not assigned to this portal account.";
  return value.replaceAll("_", " ");
}

export default async function PortalDocumentsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const typedStudio = studio as StudioRow;
  const studioLabel = typedStudio.public_name?.trim() || typedStudio.name;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email")
    .eq("studio_id", typedStudio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (clientError) throw clientError;

  if (!client) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const typedClient = client as ClientRow;

  const [assignmentsResult, allClientTemplatesResult, signaturesResult] =
    await Promise.all([
      supabase
        .from("document_assignments")
        .select("id, template_id, template_version_id, status, due_at, assigned_at, signed_at")
        .eq("studio_id", typedStudio.id)
        .eq("client_id", typedClient.id)
        .neq("status", "void")
        .order("assigned_at", { ascending: false }),

      supabase
        .from("document_templates")
        .select("id, title, description, body, current_version, document_type, requires_signature, is_required, applies_to")
        .eq("studio_id", typedStudio.id)
        .eq("is_active", true)
        .eq("applies_to", "all_clients")
        .order("created_at", { ascending: false }),

      supabase
        .from("document_signatures")
        .select("id, assignment_id, template_id, template_version_id, signer_name, signed_at")
        .eq("studio_id", typedStudio.id)
        .eq("client_id", typedClient.id)
        .order("signed_at", { ascending: false }),
    ]);

  if (assignmentsResult.error) throw assignmentsResult.error;
  if (allClientTemplatesResult.error) throw allClientTemplatesResult.error;
  if (signaturesResult.error) throw signaturesResult.error;

  const assignments = (assignmentsResult.data ?? []) as AssignmentRow[];
  const allClientTemplates =
    (allClientTemplatesResult.data ?? []) as TemplateRow[];
  const signatures = (signaturesResult.data ?? []) as SignatureRow[];

  const assignmentTemplateIds = assignments.map((item) => item.template_id);
  const allTemplateIds = Array.from(
    new Set([
      ...assignmentTemplateIds,
      ...allClientTemplates.map((item) => item.id),
    ]),
  );

  let templatesById = new Map<string, TemplateRow>();
  let versionsById = new Map<string, VersionRow>();
  let latestVersionsByTemplateId = new Map<string, VersionRow>();

  if (allTemplateIds.length) {
    const [{ data: templates, error: templatesError }, { data: versions, error: versionsError }] =
      await Promise.all([
        supabase
          .from("document_templates")
          .select("id, title, description, body, current_version, document_type, requires_signature, is_required, applies_to")
          .in("id", allTemplateIds),
        supabase
          .from("document_template_versions")
          .select("id, template_id, version_number, title, description, body, requires_signature, is_required")
          .in("template_id", allTemplateIds)
          .order("version_number", { ascending: false }),
      ]);

    if (templatesError) throw templatesError;
    if (versionsError) throw versionsError;

    templatesById = new Map(
      ((templates ?? []) as TemplateRow[]).map((template) => [template.id, template]),
    );

    versionsById = new Map(
      ((versions ?? []) as VersionRow[]).map((version) => [version.id, version]),
    );

    for (const version of (versions ?? []) as VersionRow[]) {
      if (!latestVersionsByTemplateId.has(version.template_id)) {
        latestVersionsByTemplateId.set(version.template_id, version);
      }
    }
  }

  for (const template of allClientTemplates) {
    templatesById.set(template.id, template);
  }

  const signaturesByAssignmentId = new Map(
    signatures
      .filter((signature) => signature.assignment_id)
      .map((signature) => [signature.assignment_id as string, signature]),
  );

  const signaturesByTemplateVersion = new Map<string, SignatureRow>();
  const signaturesByTemplate = new Map<string, SignatureRow>();

  for (const signature of signatures) {
    if (signature.template_version_id) {
      signaturesByTemplateVersion.set(
        `${signature.template_id}:${signature.template_version_id}`,
        signature,
      );
    }
    if (!signaturesByTemplate.has(signature.template_id)) {
      signaturesByTemplate.set(signature.template_id, signature);
    }
  }

  const assignedItems: DocumentItem[] = assignments
    .map((assignment) => {
      const template = templatesById.get(assignment.template_id);
      if (!template) return null;
      const version = assignment.template_version_id
        ? versionsById.get(assignment.template_version_id) ?? null
        : latestVersionsByTemplateId.get(template.id) ?? null;
      const signature =
        signaturesByAssignmentId.get(assignment.id) ??
        (version?.id
          ? signaturesByTemplateVersion.get(`${template.id}:${version.id}`)
          : undefined) ??
        null;
      const isSigned = assignment.status === "signed" || Boolean(signature);

      return {
        key: `assignment-${assignment.id}`,
        assignment,
        template,
        version,
        signature,
        isSigned,
        isRequired: Boolean(template.is_required || version?.is_required),
      };
    })
    .filter(Boolean) as DocumentItem[];

  const assignedTemplateIds = new Set(assignments.map((item) => item.template_id));

  const allClientItems: DocumentItem[] = allClientTemplates
    .filter((template) => !assignedTemplateIds.has(template.id))
    .map((template) => {
      const version = latestVersionsByTemplateId.get(template.id) ?? null;
      const signature =
        (version?.id
          ? signaturesByTemplateVersion.get(`${template.id}:${version.id}`)
          : undefined) ?? signaturesByTemplate.get(template.id) ?? null;

      return {
        key: `template-${template.id}`,
        assignment: null,
        template,
        version,
        signature,
        isSigned: Boolean(signature),
        isRequired: Boolean(template.is_required || version?.is_required),
      };
    });

  const documentItems = [...assignedItems, ...allClientItems].sort((a, b) => {
    if (a.isSigned !== b.isSigned) return a.isSigned ? 1 : -1;
    if (a.isRequired !== b.isRequired) return a.isRequired ? -1 : 1;
    return a.template.title.localeCompare(b.template.title);
  });

  const unsignedItems = documentItems.filter((item) => !item.isSigned);
  const signedItems = documentItems.filter((item) => item.isSigned);
  const errorMessage = getErrorMessage(resolvedSearchParams.error);

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-5 py-8 text-white md:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow Client Portal
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Documents & Waivers
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85">
              Review documents from {studioLabel}. Documents that need your
              signature will appear at the top.
            </p>
          </div>
          <Link
            href={`/portal/${encodeURIComponent(typedStudio.slug)}`}
            className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
          >
            Back to Portal
          </Link>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 md:px-8">
        {resolvedSearchParams.success === "signed" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            Document signed successfully.
          </div>
        ) : null}

        {errorMessage ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Needs Signature</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {unsignedItems.length}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Signed</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {signedItems.length}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-slate-500">Signer</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">
              {getClientName(typedClient)}
            </p>
          </div>
        </section>

        {documentItems.length ? (
          <div className="space-y-5">
            {documentItems.map((item) => {
              const version = item.version;
              const displayTitle = version?.title || item.template.title;
              const displayBody = version?.body || item.template.body;
              const displayDescription =
                version?.description || item.template.description;

              return (
                <section
                  key={item.key}
                  className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm"
                >
                  <div className="border-b border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="flex flex-wrap gap-2">
                          <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            {typeLabel(item.template.document_type)}
                          </span>
                          {item.isRequired ? (
                            <span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-100">
                              Required
                            </span>
                          ) : null}
                          {item.isSigned ? (
                            <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100">
                              Signed
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700 ring-1 ring-orange-100">
                              Needs Signature
                            </span>
                          )}
                        </div>
                        <h2 className="mt-3 text-xl font-semibold text-slate-950">
                          {displayTitle}
                        </h2>
                        {displayDescription ? (
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            {displayDescription}
                          </p>
                        ) : null}
                      </div>
                      <div className="text-sm text-slate-500 md:text-right">
                        {item.isSigned ? (
                          <p>Signed {formatDateTime(item.signature?.signed_at ?? item.assignment?.signed_at ?? null)}</p>
                        ) : item.assignment?.due_at ? (
                          <p>Due {formatDateTime(item.assignment.due_at)}</p>
                        ) : (
                          <p>Ready to review</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-0 lg:grid-cols-[1fr_360px]">
                    <div className="max-h-[520px] overflow-y-auto p-5 md:p-6">
                      <div className="whitespace-pre-wrap text-sm leading-7 text-slate-700">
                        {displayBody}
                      </div>
                    </div>

                    <div className="border-t border-slate-200 bg-slate-50 p-5 lg:border-l lg:border-t-0">
                      {item.isSigned ? (
                        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                          <p className="text-sm font-semibold text-emerald-900">
                            Signature recorded
                          </p>
                          <p className="mt-2 text-sm leading-6 text-emerald-800">
                            Signed by {item.signature?.signer_name || getClientName(typedClient)} on {formatDateTime(item.signature?.signed_at ?? item.assignment?.signed_at ?? null)}.
                          </p>
                        </div>
                      ) : (
                        <form action={signPortalDocumentAction} className="space-y-4">
                          <input type="hidden" name="studioSlug" value={typedStudio.slug} />
                          <input type="hidden" name="assignmentId" value={item.assignment?.id ?? ""} />
                          <input type="hidden" name="templateId" value={item.template.id} />
                          <input type="hidden" name="templateVersionId" value={version?.id ?? ""} />

                          <div>
                            <label className="text-sm font-medium text-slate-800">
                              Type your full name
                            </label>
                            <input
                              name="signerName"
                              defaultValue={getClientName(typedClient)}
                              className="mt-2 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                            />
                          </div>

                          <label className="flex gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700">
                            <input
                              type="checkbox"
                              name="consentAccepted"
                              className="mt-1 h-4 w-4 rounded border-slate-300"
                            />
                            <span>
                              I have reviewed this document and agree to sign it electronically.
                            </span>
                          </label>

                          <button
                            type="submit"
                            className="w-full rounded-2xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-medium text-white hover:opacity-95"
                          >
                            Sign Document
                          </button>

                          <p className="text-xs leading-5 text-slate-500">
                            Your typed name will be stored with the signed document and signing time.
                          </p>
                        </form>
                      )}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <section className="rounded-[28px] border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm">
            <h2 className="text-xl font-semibold text-slate-950">
              No documents yet
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-7 text-slate-600">
              Any documents or waivers your studio asks you to review will appear here.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
