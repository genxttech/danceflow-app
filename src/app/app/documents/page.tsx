import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3, FileSignature, History, Plus, Send, ShieldCheck, Upload, UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { requireStudioFeature } from "@/lib/billing/access";
import {
  assignDocumentToClientAction,
  assignDocumentToEventAction,
  createDocumentTemplateAction,
  removeDocumentFromEventAction,
  toggleDocumentTemplateStatusAction,
  updateDocumentTemplateAction,
  sendDocumentReminderAction,
  waiveDocumentAssignmentAction,
  voidDocumentAssignmentAction,
} from "./actions";
import {
  createSignEnvelopeAction,
  resendSignEnvelopeAction,
  revokeSignEnvelopeAction,
} from "./sign/actions";

type SearchParams = {
  success?: string;
  error?: string;
};

type DocumentTemplate = {
  id: string;
  scope: "studio" | "organizer";
  organizer_id: string | null;
  document_type: string;
  title: string;
  description: string | null;
  body: string;
  default_consent_text: string | null;
  applies_to: string;
  requires_signature: boolean;
  is_required: boolean;
  is_active: boolean;
  current_version: number;
  current_version_id: string | null;
  updated_at: string;
  document_template_versions: DocumentTemplateVersion[] | null;
};

type DocumentTemplateVersion = {
  id: string;
  version_number: number | null;
  title: string | null;
  created_at: string | null;
  published_at: string | null;
  archived_at: string | null;
  created_by: string | null;
};

type DocumentSignatureSummary = {
  id: string;
  template_id: string;
  signed_at: string | null;
};

type DocumentAssignmentSummary = {
  id: string;
  template_id: string;
  client_id: string | null;
  status: string | null;
  assigned_at: string | null;
  due_at: string | null;
  assigned_to_email: string | null;
  sign_envelope_id: string | null;
  document_templates: { title: string | null; is_required: boolean | null } | { title: string | null; is_required: boolean | null }[] | null;
  clients: { first_name: string | null; last_name: string | null; email: string | null } | { first_name: string | null; last_name: string | null; email: string | null }[] | null;
};

type SigningEnvelopeSummary = {
  id: string;
  status: string | null;
  document_sign_fields:
    | { id: string }[]
    | null;
};

type SigningEnvelopeRow = {
  id: string;
  title: string;
  signer_name: string;
  signer_email: string;
  status: string;
  expires_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  last_reminded_at: string | null;
  reminder_count: number | null;
  assignment_id: string | null;
  document_sign_fields: { id: string }[] | null;
};

type OrganizerOption = {
  id: string;
  name: string | null;
};

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  status: string | null;
};

type EventOption = {
  id: string;
  name: string;
  slug: string;
  status: string | null;
  organizer_id: string | null;
};

type EventRequirement = {
  id: string;
  event_id: string;
  template_id: string;
  active: boolean;
  events:
    | { id: string; name: string; slug: string | null }
    | { id: string; name: string; slug: string | null }[]
    | null;
};

const documentTypes = [
  ["waiver", "Waiver"],
  ["policy", "Policy"],
  ["agreement", "Agreement"],
  ["release", "Photo/video release"],
  ["membership_terms", "Membership terms"],
  ["package_policy", "Package policy"],
  ["cancellation_policy", "Cancellation policy"],
  ["minor_guardian", "Minor/guardian form"],
  ["custom", "Custom document"],
] as const;

const appliesToOptions = [
  ["manual", "Manual assignment"],
  ["all_clients", "All clients"],
  ["event_registrants", "Event registrants"],
  ["package_buyers", "Package buyers"],
  ["membership_buyers", "Membership buyers"],
  ["minors_guardians", "Minors / guardians"],
] as const;

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString();
}

function envelopeStatusClass(status: string) {
  if (status === "completed") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (["sent", "viewed", "started"].includes(status)) {
    return "bg-blue-50 text-blue-700 ring-blue-200";
  }
  if (["expired", "declined", "void"].includes(status)) {
    return "bg-rose-50 text-rose-700 ring-rose-200";
  }
  return "bg-violet-50 text-violet-700 ring-violet-200";
}

function signingStatusMessage(searchParams: SearchParams) {
  if (searchParams.success === "sent") return "Signing request queued successfully.";
  if (searchParams.success === "resent") return "A new secure signing link was emailed.";
  if (searchParams.success === "revoked") return "The signing request was revoked.";
  return null;
}

function statusMessage(searchParams: SearchParams) {
  if (searchParams.success === "created") return "Document template saved.";
  if (searchParams.success === "updated") return "Document template updated.";
  if (searchParams.success === "status_updated")
    return "Document status updated.";
  if (searchParams.success === "assigned")
    return "Document assigned to client.";
  if (searchParams.success === "event_attached")
    return "Event waiver attached.";
  if (searchParams.success === "event_removed") return "Event waiver removed.";
  if (searchParams.success === "reminder_queued") return "Document reminder queued.";
  if (searchParams.success === "waived") return "Document requirement waived.";
  if (searchParams.success === "voided") return "Document assignment voided.";
  if (searchParams.error === "missing_title") return "Add a document title.";
  if (searchParams.error === "missing_body")
    return "Add the document text before saving.";
  if (searchParams.error === "missing_content")
    return "Title and document text are required.";
  if (searchParams.error === "template_not_found")
    return "Document template not found.";
  if (searchParams.error) return decodeURIComponent(searchParams.error);
  return null;
}

async function getOrganizerOptions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [] as OrganizerOption[];

  const { data: organizerUsers } = await supabase
    .from("organizer_users")
    .select("organizer_id, active")
    .eq("user_id", user.id)
    .eq("active", true);

  const organizerIds = Array.from(
    new Set(
      (organizerUsers ?? [])
        .map((row) => String(row.organizer_id ?? ""))
        .filter(Boolean),
    ),
  );

  if (!organizerIds.length) return [] as OrganizerOption[];

  const { data: organizers } = await supabase
    .from("organizers")
    .select("id, name, studio_id, active")
    .in("id", organizerIds)
    .eq("active", true);

  return (organizers ?? [])
    .filter(
      (organizer) => !organizer.studio_id || organizer.studio_id === studioId,
    )
    .map((organizer) => ({
      id: String(organizer.id),
      name: organizer.name ?? "Organizer",
    }));
}

async function getEventOptions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  organizerIds: string[],
) {
  const { data } = await supabase
    .from("events")
    .select("id, name, slug, status, organizer_id, studio_id")
    .eq("studio_id", studioId)
    .in("status", ["draft", "published"])
    .order("start_date", { ascending: false })
    .limit(100);

  return ((data ?? []) as EventOption[]).filter(
    (event) => !event.organizer_id || organizerIds.includes(event.organizer_id),
  );
}

async function getEventRequirements(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  organizerIds: string[],
) {
  let query = supabase
    .from("event_document_requirements")
    .select(
      "id, event_id, template_id, active, organizer_id, events:event_id(id, name, slug)",
    )
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (organizerIds.length) {
    query = query.or(
      `organizer_id.is.null,organizer_id.in.(${organizerIds.join(",")})`,
    );
  } else {
    query = query.is("organizer_id", null);
  }

  const { data } = await query;

  return (data ?? []) as EventRequirement[];
}

function DocumentTemplateForm({
  organizers,
}: {
  organizers: OrganizerOption[];
}) {
  return (
    <form
      action={createDocumentTemplateAction}
      className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-2 text-[var(--brand-primary)]">
          <Plus className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-[var(--brand-text)]">
            Create document template
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
            Add waivers, policies, agreements, and forms that can be assigned or
            signed later.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
          Title
          <input
            name="title"
            required
            className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
            placeholder="Studio liability waiver"
          />
        </label>

        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
          Type
          <select
            name="documentType"
            className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
          >
            {documentTypes.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
          Owner
          <select
            name="scope"
            className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
          >
            <option value="studio">Studio document</option>
            {organizers.length ? (
              <option value="organizer">Organizer document</option>
            ) : null}
          </select>
        </label>

        {organizers.length ? (
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
            Organizer
            <select
              name="organizerId"
              className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
            >
              {organizers.map((organizer) => (
                <option key={organizer.id} value={organizer.id}>
                  {organizer.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
          Short description
          <input
            name="description"
            className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
            placeholder="Shown to staff when choosing documents."
          />
        </label>

        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
          Applies to
          <select
            name="appliesTo"
            className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
          >
            {appliesToOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
          Document text
          <textarea
            name="body"
            required
            rows={10}
            className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm leading-6"
            placeholder="Paste or write the waiver, policy, or agreement text here."
          />
        </label>

        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
          Electronic signature consent text
          <textarea
            name="defaultConsentText"
            rows={3}
            className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm leading-6"
            placeholder="I have reviewed this document, agree to sign electronically, and confirm that my typed name is my signature."
          />
          <span className="block text-xs font-normal leading-5 text-[var(--brand-muted)]">
            This text is stored with each signature so the studio can prove what the signer accepted.
          </span>
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex items-start gap-3 rounded-2xl border border-[var(--brand-border)] p-4 text-sm text-[var(--brand-text)]">
          <input
            name="requiresSignature"
            type="checkbox"
            defaultChecked
            className="mt-1"
          />
          <span>
            <span className="font-semibold">Requires signature</span>
            <br />
            <span className="text-[var(--brand-muted)]">
              Signer must acknowledge and type their name.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-2xl border border-[var(--brand-border)] p-4 text-sm text-[var(--brand-text)]">
          <input name="isRequired" type="checkbox" className="mt-1" />
          <span>
            <span className="font-semibold">Required before participation</span>
            <br />
            <span className="text-[var(--brand-muted)]">
              Used for future warnings and check-in holds.
            </span>
          </span>
        </label>
      </div>

      <button
        type="submit"
        className="mt-5 rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-95"
      >
        Save template
      </button>
    </form>
  );
}

function TemplateCard({
  template,
  organizers,
  clients,
  events,
  eventRequirements,
  pendingAssignmentCount,
  signedRecordCount,
}: {
  template: DocumentTemplate;
  organizers: OrganizerOption[];
  clients: ClientOption[];
  events: EventOption[];
  eventRequirements: EventRequirement[];
  pendingAssignmentCount: number;
  signedRecordCount: number;
}) {
  const organizerName = organizers.find(
    (organizer) => organizer.id === template.organizer_id,
  )?.name;
  const matchingEvents = events.filter((event) =>
    template.scope === "organizer"
      ? event.organizer_id === template.organizer_id
      : !event.organizer_id,
  );
  const attachedEvents = eventRequirements.filter(
    (requirement) => requirement.template_id === template.id,
  );
  const versions = [...(template.document_template_versions ?? [])].sort(
    (a, b) => Number(b.version_number ?? 0) - Number(a.version_number ?? 0),
  );

  return (
    <details className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold text-[var(--brand-text)]">
                {template.title}
              </h3>
              <span className="rounded-full bg-[var(--brand-soft-bg)] px-3 py-1 text-xs font-semibold text-[var(--brand-muted)]">
                {titleCase(template.document_type)}
              </span>
              <span className="rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--brand-primary)]">
                {template.scope === "organizer"
                  ? (organizerName ?? "Organizer")
                  : "Studio"}
              </span>
              {!template.is_active ? (
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                  Inactive
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
              {template.description ||
                `${titleCase(template.applies_to)} · Version ${template.current_version}`}
            </p>
            <p className="mt-1 text-xs font-semibold text-[var(--brand-muted)]">
              Current version {template.current_version}
              {template.updated_at ? ` · Updated ${formatDateTime(template.updated_at)}` : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
                {signedRecordCount} signed record{signedRecordCount === 1 ? "" : "s"}
              </span>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700 ring-1 ring-amber-200">
                {pendingAssignmentCount} pending assignment{pendingAssignmentCount === 1 ? "" : "s"}
              </span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                {versions.length} version{versions.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <form action={toggleDocumentTemplateStatusAction}>
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="scope" value={template.scope} />
            {template.organizer_id ? (
              <input
                type="hidden"
                name="organizerId"
                value={template.organizer_id}
              />
            ) : null}
            <input
              type="hidden"
              name="nextStatus"
              value={template.is_active ? "inactive" : "active"}
            />
            <button
              type="submit"
              className="rounded-2xl border border-[var(--brand-border)] px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-soft-bg)]"
            >
              {template.is_active ? "Deactivate" : "Activate"}
            </button>
          </form>
        </div>
      </summary>

      {template.scope === "studio" && template.is_active ? (
        <div className="mt-5 rounded-3xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-2 text-[var(--brand-primary)]">
              <UserPlus className="h-4 w-4" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-[var(--brand-text)]">
                Assign to a client
              </h4>
              <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">
                Send this document to one client portal for review and
                signature.
              </p>
            </div>
          </div>

          <form
            action={assignDocumentToClientAction}
            className="mt-4 grid gap-3 lg:grid-cols-[1fr_180px_auto] lg:items-end"
          >
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="scope" value="studio" />

            <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
              Client
              <select
                name="clientId"
                required
                className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
                defaultValue=""
              >
                <option value="" disabled>
                  Choose client
                </option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.first_name} {client.last_name}
                    {client.email ? ` · ${client.email}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
              Due date
              <input
                name="dueDate"
                type="date"
                className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
              />
            </label>

            <button
              type="submit"
              className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-95"
            >
              Assign
            </button>
          </form>
        </div>
      ) : null}

      {template.is_active ? (
        <div className="mt-5 rounded-3xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-white p-2 text-[var(--brand-primary)]">
              <FileSignature className="h-5 w-5" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-[var(--brand-text)]">
                Attach to event registration
              </h4>
              <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                Require this document during public event checkout.
              </p>
            </div>
          </div>

          <form
            action={assignDocumentToEventAction}
            className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end"
          >
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="scope" value={template.scope} />
            {template.organizer_id ? (
              <input
                type="hidden"
                name="organizerId"
                value={template.organizer_id}
              />
            ) : null}

            <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
              Event
              <select
                name="eventId"
                required
                className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
                defaultValue=""
              >
                <option value="" disabled>
                  Choose event
                </option>
                {matchingEvents.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.name} · {titleCase(event.status ?? "draft")}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={!matchingEvents.length}
              className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Attach
            </button>
          </form>

          {attachedEvents.length ? (
            <div className="mt-4 space-y-2">
              {attachedEvents.map((requirement) => {
                const event = Array.isArray(requirement.events)
                  ? requirement.events[0]
                  : requirement.events;

                return (
                  <div
                    key={requirement.id}
                    className="flex flex-col gap-2 rounded-2xl border border-[var(--brand-border)] bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm font-semibold text-[var(--brand-text)]">
                      {event?.name ?? "Attached event"}
                    </span>
                    <form action={removeDocumentFromEventAction}>
                      <input
                        type="hidden"
                        name="requirementId"
                        value={requirement.id}
                      />
                      <input
                        type="hidden"
                        name="scope"
                        value={template.scope}
                      />
                      {template.organizer_id ? (
                        <input
                          type="hidden"
                          name="organizerId"
                          value={template.organizer_id}
                        />
                      ) : null}
                      <button
                        type="submit"
                        className="rounded-xl border border-[var(--brand-border)] px-3 py-2 text-xs font-bold text-[var(--brand-text)] hover:bg-[var(--brand-soft-bg)]"
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {versions.length ? (
        <div className="mt-5 rounded-3xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-sm font-bold text-[var(--brand-text)]">
                Version history
              </h4>
              <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">
                Signed receipts stay tied to the exact version accepted by the signer.
              </p>
            </div>
            <span className="rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-bold text-[var(--brand-primary)]">
              Current v{template.current_version}
            </span>
          </div>
          <div className="mt-3 divide-y divide-[var(--brand-border)] rounded-2xl border border-[var(--brand-border)] bg-white">
            {versions.slice(0, 5).map((version) => (
              <div
                key={version.id}
                className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <span className="font-bold text-[var(--brand-text)]">
                    Version {version.version_number ?? "?"}
                  </span>
                  {version.id === template.current_version_id ? (
                    <span className="ml-2 rounded-full bg-green-50 px-2 py-1 text-xs font-bold text-green-700">
                      Current
                    </span>
                  ) : null}
                  {version.title ? (
                    <p className="mt-1 text-xs font-semibold text-[var(--brand-muted)]">
                      {version.title}
                    </p>
                  ) : null}
                </div>
                <div className="text-left text-xs font-semibold text-[var(--brand-muted)] sm:text-right">
                  <p>Published {formatDateTime(version.published_at ?? version.created_at)}</p>
                  {version.archived_at ? <p>Archived {formatDateTime(version.archived_at)}</p> : null}
                </div>
              </div>
            ))}
          </div>
          {versions.length > 5 ? (
            <p className="mt-3 text-xs font-semibold text-[var(--brand-muted)]">
              Showing latest 5 of {versions.length} versions.
            </p>
          ) : null}
        </div>
      ) : null}

      <form
        action={updateDocumentTemplateAction}
        className="mt-5 border-t border-[var(--brand-border)] pt-5"
      >
        <input type="hidden" name="templateId" value={template.id} />
        <input type="hidden" name="scope" value={template.scope} />
        {template.organizer_id ? (
          <input
            type="hidden"
            name="organizerId"
            value={template.organizer_id}
          />
        ) : null}

        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-bold">Editing publishes a new version.</p>
          <p className="mt-1 leading-6">
            Future assignments and event checkout signatures use the new version. Existing signed receipts keep the exact document text, consent text, and version that were accepted.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
            Title
            <input
              name="title"
              defaultValue={template.title}
              required
              className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
            />
          </label>
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
            Type
            <select
              name="documentType"
              defaultValue={template.document_type}
              className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
            >
              {documentTypes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
            Short description
            <input
              name="description"
              defaultValue={template.description ?? ""}
              className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
            />
          </label>
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
            Applies to
            <select
              name="appliesTo"
              defaultValue={template.applies_to}
              className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm"
            >
              {appliesToOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
            Document text
            <textarea
              name="body"
              defaultValue={template.body}
              required
              rows={10}
              className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm leading-6"
            />
          </label>
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)] lg:col-span-2">
            Electronic signature consent text
            <textarea
              name="defaultConsentText"
              defaultValue={template.default_consent_text ?? ""}
              rows={3}
              className="w-full rounded-2xl border border-[var(--brand-border)] px-4 py-3 text-sm leading-6"
              placeholder="I have reviewed this document, agree to sign electronically, and confirm that my typed name is my signature."
            />
            <span className="block text-xs font-normal leading-5 text-[var(--brand-muted)]">
              Each edit creates a new version and stores this consent text for future signatures.
            </span>
          </label>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded-2xl border border-[var(--brand-border)] p-4 text-sm font-semibold text-[var(--brand-text)]">
            <input
              name="requiresSignature"
              type="checkbox"
              defaultChecked={template.requires_signature}
            />
            Requires signature
          </label>
          <label className="flex items-center gap-3 rounded-2xl border border-[var(--brand-border)] p-4 text-sm font-semibold text-[var(--brand-text)]">
            <input
              name="isRequired"
              type="checkbox"
              defaultChecked={template.is_required}
            />
            Required before participation
          </label>
        </div>

        <button
          type="submit"
          className="mt-5 rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-95"
        >
          Save changes
        </button>
      </form>
    </details>
  );
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  await requireStudioFeature("documents");
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const organizers = await getOrganizerOptions(supabase, studioId);
  const organizerIds = organizers.map((organizer) => organizer.id);

  let templateQuery = supabase
    .from("document_templates")
    .select(
      `
      id,
      scope,
      organizer_id,
      document_type,
      title,
      description,
      body,
      default_consent_text,
      applies_to,
      requires_signature,
      is_required,
      is_active,
      current_version,
      current_version_id,
      updated_at,
      document_template_versions (
        id,
        version_number,
        title,
        created_at,
        published_at,
        archived_at,
        created_by
      )
    `,
    )
    .order("updated_at", { ascending: false });

  if (organizerIds.length) {
    templateQuery = templateQuery.or(
      `studio_id.eq.${studioId},organizer_id.in.(${organizerIds.join(",")})`,
    );
  } else {
    templateQuery = templateQuery.eq("studio_id", studioId);
  }

  const { data: templates, error } = await templateQuery;
  const templateIds = ((templates ?? []) as { id: string }[]).map((template) => template.id);

  const [
    { data: signatureRows, error: signaturesError },
    { data: assignmentRows, error: assignmentsError },
  ] = templateIds.length
    ? await Promise.all([
        supabase
          .from("document_signatures")
          .select("id, template_id, signed_at")
          .in("template_id", templateIds)
          .limit(10000),
        supabase
          .from("document_assignments")
          .select("id, template_id, client_id, status, assigned_at, due_at, assigned_to_email, sign_envelope_id, document_templates(title, is_required), clients(first_name, last_name, email)")
          .in("template_id", templateIds)
          .neq("status", "void")
          .limit(10000),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  const envelopeIds = Array.from(
    new Set(
      ((assignmentRows ?? []) as DocumentAssignmentSummary[])
        .map((assignment) => assignment.sign_envelope_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const { data: envelopeRows, error: envelopesError } = envelopeIds.length
    ? await supabase
        .from("document_sign_envelopes")
        .select("id, status, document_sign_fields(id)")
        .in("id", envelopeIds)
    : { data: [], error: null };

  const { data: allEnvelopeRows, error: allEnvelopesError } = await supabase
    .from("document_sign_envelopes")
    .select(
      "id,title,signer_name,signer_email,status,expires_at,sent_at,viewed_at,started_at,completed_at,created_at,last_reminded_at,reminder_count,assignment_id,document_sign_fields(id)",
    )
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false })
    .limit(200);

  const allEnvelopes = (allEnvelopeRows ?? []) as SigningEnvelopeRow[];
  const draftEnvelopes = allEnvelopes.filter((item) => item.status === "draft");
  const activeEnvelopes = allEnvelopes.filter((item) =>
    ["sent", "viewed", "started"].includes(item.status),
  );
  const completedEnvelopes = allEnvelopes.filter(
    (item) => item.status === "completed",
  );
  const closedEnvelopes = allEnvelopes.filter((item) =>
    ["expired", "declined", "void"].includes(item.status),
  );

  const envelopesById = new Map<string, SigningEnvelopeSummary>();
  for (const envelope of (envelopeRows ?? []) as SigningEnvelopeSummary[]) {
    envelopesById.set(envelope.id, envelope);
  }

  const signedCountByTemplateId = new Map<string, number>();
  for (const signature of (signatureRows ?? []) as DocumentSignatureSummary[]) {
    signedCountByTemplateId.set(
      signature.template_id,
      (signedCountByTemplateId.get(signature.template_id) ?? 0) + 1,
    );
  }

  const pendingCountByTemplateId = new Map<string, number>();
  for (const assignment of (assignmentRows ?? []) as DocumentAssignmentSummary[]) {
    if (assignment.status !== "pending") continue;
    pendingCountByTemplateId.set(
      assignment.template_id,
      (pendingCountByTemplateId.get(assignment.template_id) ?? 0) + 1,
    );
  }

  const totalSignedRecords = Array.from(signedCountByTemplateId.values()).reduce(
    (sum, count) => sum + count,
    0,
  );

  const events = await getEventOptions(supabase, studioId, organizerIds);
  const eventRequirements = await getEventRequirements(
    supabase,
    studioId,
    organizerIds,
  );

  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, status")
    .eq("studio_id", studioId)
    .in("status", ["active", "lead"])
    .order("first_name", { ascending: true })
    .order("last_name", { ascending: true });


  const one = <T,>(value: T | T[] | null): T | null => Array.isArray(value) ? value[0] ?? null : value;
  const now = Date.now();
  const pendingAssignments = ((assignmentRows ?? []) as DocumentAssignmentSummary[])
    .filter((assignment) => assignment.status === "pending")
    .sort((a, b) => {
      const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER;
      const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER;
      return aDue - bDue;
    });
  const overdueAssignments = pendingAssignments.filter((assignment) => assignment.due_at && new Date(assignment.due_at).getTime() < now);
  const dueSoonAssignments = pendingAssignments.filter((assignment) => {
    if (!assignment.due_at) return false;
    const due = new Date(assignment.due_at).getTime();
    return due >= now && due <= now + 3 * 24 * 60 * 60 * 1000;
  });
  const deliveryExceptions = pendingAssignments.filter((assignment) => {
    const client = one(assignment.clients);
    return !assignment.assigned_to_email && !client?.email;
  });

  const message = statusMessage(resolvedSearchParams);
  const isError = Boolean(
    resolvedSearchParams.error ||
      error ||
      clientsError ||
      signaturesError ||
      assignmentsError ||
      envelopesError ||
      allEnvelopesError,
  );
  const pageMessage =
    error?.message ??
    clientsError?.message ??
    signaturesError?.message ??
    assignmentsError?.message ??
    envelopesError?.message ??
    allEnvelopesError?.message ??
    signingStatusMessage(resolvedSearchParams) ??
    message;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <section className="overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#4D1F47] via-[#A64AC9] to-[#FF7A59] p-6 text-white shadow-lg sm:p-8">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-white/90">
            <FileSignature className="h-4 w-4" /> Documents
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
            Documents Center
          </h1>
          <p className="mt-3 text-sm leading-7 text-white/85 sm:text-base">
            Create documents from reusable templates or upload a PDF, place signing
            fields, send requests, track progress, and retain completed records from one workspace.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="#create-document"
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3 text-sm font-bold text-[var(--brand-primary)] shadow-sm transition hover:bg-white/90"
            >
              <Plus className="h-4 w-4" />
              Create document
            </a>
            <a
              href="#active-requests"
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/30 bg-white/10 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/20"
            >
              <FileSignature className="h-4 w-4" />
              View requests
            </a>
          </div>
        </div>
      </section>

      {pageMessage ? (
        <div
          className={`rounded-2xl border p-4 text-sm ${isError ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}
        >
          {pageMessage}
        </div>
      ) : null}

      <section id="create-document" className="rounded-[2rem] border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--brand-primary)]">Create document</p>
          <h2 className="mt-2 text-2xl font-bold text-[var(--brand-text)]">Choose how to start</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--brand-muted)]">
            Both options create a document workflow. Use a reusable template for standard studio forms, or upload a PDF when the layout already exists.
          </p>
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-2">
          <details className="rounded-3xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-5">
            <summary className="cursor-pointer list-none">
              <div className="flex items-start gap-3">
                <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-2 text-[var(--brand-primary)]">
                  <FileSignature className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-[var(--brand-text)]">Create from template</h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                    Build a reusable waiver, policy, agreement, release, or membership form.
                  </p>
                </div>
              </div>
            </summary>
            <div className="mt-5">
              <DocumentTemplateForm organizers={organizers} />
            </div>
          </details>

          <details className="rounded-3xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-5">
            <summary className="cursor-pointer list-none">
              <div className="flex items-start gap-3">
                <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-2 text-[var(--brand-primary)]">
                  <Upload className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-[var(--brand-text)]">Upload PDF for signature</h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
                    Upload an existing PDF, identify the signer, then place fields before sending.
                  </p>
                </div>
              </div>
            </summary>

            <form action={createSignEnvelopeAction} className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="text-sm font-semibold text-[var(--brand-text)]">
                Document title
                <input name="title" required className="mt-2 w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2.5" />
              </label>
              <label className="text-sm font-semibold text-[var(--brand-text)]">
                PDF file
                <input name="pdfFile" type="file" accept="application/pdf,.pdf" required className="mt-2 block w-full rounded-xl border border-[var(--brand-border)] bg-white p-2 text-sm" />
              </label>
              <label className="text-sm font-semibold text-[var(--brand-text)]">
                Signer name
                <input name="signerName" required className="mt-2 w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2.5" />
              </label>
              <label className="text-sm font-semibold text-[var(--brand-text)]">
                Signer email
                <input name="signerEmail" type="email" required className="mt-2 w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2.5" />
              </label>
              <label className="text-sm font-semibold text-[var(--brand-text)]">
                Link expires in
                <select name="expiresInDays" defaultValue="7" className="mt-2 w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2.5">
                  <option value="3">3 days</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                </select>
              </label>
              <div className="flex items-end">
                <button className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white">
                  Upload and place fields
                </button>
              </div>
            </form>
          </details>
        </div>
      </section>

      <section className="rounded-[2rem] border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--brand-primary)]">Daily document operations</p>
            <h2 className="mt-2 text-2xl font-bold text-[var(--brand-text)]">What needs attention</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--brand-muted)]">DanceFlow tracks signatures and handles routine delivery. Review only overdue items, upcoming deadlines, and exceptions that need staff judgment.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[430px]">
            <div className="rounded-2xl bg-rose-50 p-3"><p className="text-xs font-semibold text-rose-700">Overdue</p><p className="mt-1 text-2xl font-bold text-rose-900">{overdueAssignments.length}</p></div>
            <div className="rounded-2xl bg-amber-50 p-3"><p className="text-xs font-semibold text-amber-700">Due soon</p><p className="mt-1 text-2xl font-bold text-amber-900">{dueSoonAssignments.length}</p></div>
            <div className="rounded-2xl bg-slate-100 p-3"><p className="text-xs font-semibold text-slate-600">Pending</p><p className="mt-1 text-2xl font-bold text-slate-900">{pendingAssignments.length}</p></div>
            <div className="rounded-2xl bg-emerald-50 p-3"><p className="text-xs font-semibold text-emerald-700">Signed</p><p className="mt-1 text-2xl font-bold text-emerald-900">{totalSignedRecords}</p></div>
          </div>
        </div>

        {pendingAssignments.length ? (
          <div className="mt-6 space-y-3">
            {pendingAssignments.slice(0, 20).map((assignment) => {
              const client = one(assignment.clients);
              const template = one(assignment.document_templates);
              const clientName = [client?.first_name, client?.last_name].filter(Boolean).join(" ") || client?.email || assignment.assigned_to_email || "Client";
              const overdue = Boolean(assignment.due_at && new Date(assignment.due_at).getTime() < now);
              const missingEmail = !assignment.assigned_to_email && !client?.email;
              const envelope = assignment.sign_envelope_id
                ? envelopesById.get(assignment.sign_envelope_id) ?? null
                : null;
              const draftEnvelope = envelope?.status === "draft";
              const savedFieldCount = envelope?.document_sign_fields?.length ?? 0;
              return (
                <div key={assignment.id} className={`rounded-2xl border p-4 ${overdue ? "border-rose-200 bg-rose-50/60" : missingEmail ? "border-amber-200 bg-amber-50/60" : "border-[var(--brand-border)] bg-[var(--brand-surface)]"}`}>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {overdue ? <AlertTriangle className="h-4 w-4 text-rose-600" /> : <Clock3 className="h-4 w-4 text-amber-600" />}
                        <p className="font-bold text-[var(--brand-text)]">{clientName}</p>
                        {template?.is_required ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800">Required</span> : null}
                        {draftEnvelope ? (
                          <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-bold text-violet-800">
                            {savedFieldCount > 0 ? "Draft layout" : "Needs field setup"}
                          </span>
                        ) : null}
                        {missingEmail ? <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-800">No email</span> : null}
                      </div>
                      <p className="mt-1 text-sm text-[var(--brand-muted)]">{template?.title || "Document"}{assignment.due_at ? ` · ${overdue ? "Past due" : "Due"} ${formatDateTime(assignment.due_at)}` : " · No due date"}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {assignment.client_id ? <Link href={`/app/clients/${assignment.client_id}?tab=documents`} className="rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-xs font-bold text-[var(--brand-text)]">Open client</Link> : null}
                      {draftEnvelope && assignment.sign_envelope_id ? (
                        <Link
                          href={`/app/documents/sign/${assignment.sign_envelope_id}/edit`}
                          className="inline-flex items-center gap-1 rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-xs font-bold text-white"
                        >
                          <FileSignature className="h-3.5 w-3.5" />
                          {savedFieldCount > 0 ? "Edit field layout" : "Finish field setup"}
                        </Link>
                      ) : !missingEmail ? (
                        <form action={sendDocumentReminderAction}><input type="hidden" name="assignmentId" value={assignment.id}/><input type="hidden" name="scope" value="studio"/><button className="inline-flex items-center gap-1 rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-xs font-bold text-white"><Send className="h-3.5 w-3.5"/>Send reminder</button></form>
                      ) : null}
                      <form action={waiveDocumentAssignmentAction}><input type="hidden" name="assignmentId" value={assignment.id}/><input type="hidden" name="scope" value="studio"/><button className="rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-800">Waive</button></form>
                      <form action={voidDocumentAssignmentAction}><input type="hidden" name="assignmentId" value={assignment.id}/><input type="hidden" name="scope" value="studio"/><input type="hidden" name="reason" value="Voided from Document Operations Center."/><button className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700">Void</button></form>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-6 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-700"/><div><p className="font-bold text-emerald-900">Document follow-up is clear</p><p className="mt-1 text-sm text-emerald-800">There are no pending client document assignments requiring staff attention.</p></div></div>
        )}

        {deliveryExceptions.length ? <p className="mt-4 text-xs font-semibold text-rose-700">{deliveryExceptions.length} pending assignment{deliveryExceptions.length === 1 ? "" : "s"} cannot receive email until a client email address is added.</p> : null}
      </section>

      <section id="active-requests" className="rounded-[2rem] border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--brand-primary)]">Signing workflow</p>
            <h2 className="mt-2 text-2xl font-bold text-[var(--brand-text)]">Requests and signing history</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
              Drafts and active requests stay operational. Completed and closed requests remain available as signing history.
            </p>
          </div>
          <span className="rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-bold text-[var(--brand-primary)]">
            {allEnvelopes.length} total
          </span>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl bg-violet-50 p-4"><p className="text-xs font-semibold text-violet-700">Drafts</p><p className="mt-1 text-2xl font-bold text-violet-950">{draftEnvelopes.length}</p></div>
          <div className="rounded-2xl bg-blue-50 p-4"><p className="text-xs font-semibold text-blue-700">Active</p><p className="mt-1 text-2xl font-bold text-blue-950">{activeEnvelopes.length}</p></div>
          <div className="rounded-2xl bg-emerald-50 p-4"><p className="text-xs font-semibold text-emerald-700">Completed</p><p className="mt-1 text-2xl font-bold text-emerald-950">{completedEnvelopes.length}</p></div>
          <div className="rounded-2xl bg-slate-100 p-4"><p className="text-xs font-semibold text-slate-600">Closed</p><p className="mt-1 text-2xl font-bold text-slate-950">{closedEnvelopes.length}</p></div>
        </div>

        <div className="mt-6 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-3 pr-4">Document</th>
                <th className="py-3 pr-4">Signer</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3 pr-4">Activity</th>
                <th className="py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {allEnvelopes.map((item) => {
                const active = ["sent", "viewed", "started"].includes(item.status);
                const fieldCount = item.document_sign_fields?.length ?? 0;
                return (
                  <tr key={item.id} className="border-b border-slate-100 align-top">
                    <td className="py-4 pr-4">
                      <Link
                        className="font-semibold text-[var(--brand-primary)] hover:underline"
                        href={item.status === "draft" ? `/app/documents/sign/${item.id}/edit` : `/app/documents/sign/${item.id}`}
                      >
                        {item.title}
                      </Link>
                      <div className="mt-1 text-xs text-slate-500">Created {formatDateTime(item.created_at)}</div>
                    </td>
                    <td className="py-4 pr-4">
                      <div>{item.signer_name}</div>
                      <div className="text-xs text-slate-500">{item.signer_email}</div>
                    </td>
                    <td className="py-4 pr-4">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ring-1 ${envelopeStatusClass(item.status)}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="py-4 pr-4 text-xs text-slate-600">
                      {item.status === "draft" ? <div>{fieldCount} field{fieldCount === 1 ? "" : "s"} placed</div> : null}
                      <div>Sent: {formatDateTime(item.sent_at)}</div>
                      <div>Viewed: {formatDateTime(item.viewed_at)}</div>
                      <div>Completed: {formatDateTime(item.completed_at)}</div>
                    </td>
                    <td className="py-4">
                      <div className="flex flex-wrap gap-2">
                        {item.status === "draft" ? (
                          <Link href={`/app/documents/sign/${item.id}/edit`} className="rounded-lg bg-[var(--brand-primary)] px-3 py-2 text-xs font-semibold text-white">
                            {fieldCount ? "Edit field layout" : "Place fields"}
                          </Link>
                        ) : (
                          <Link href={`/app/documents/sign/${item.id}`} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">
                            Details
                          </Link>
                        )}
                        {active ? (
                          <form action={resendSignEnvelopeAction}>
                            <input type="hidden" name="envelopeId" value={item.id} />
                            <button className="rounded-lg bg-violet-700 px-3 py-2 text-xs font-semibold text-white">Resend</button>
                          </form>
                        ) : null}
                        {["draft", "sent", "viewed", "started"].includes(item.status) ? (
                          <form action={revokeSignEnvelopeAction}>
                            <input type="hidden" name="envelopeId" value={item.id} />
                            <input type="hidden" name="reason" value="Revoked from Documents Center." />
                            <button className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-semibold text-rose-700">Revoke</button>
                          </form>
                        ) : null}
                        {item.status === "completed" ? (
                          <>
                            <a href={`/app/documents/sign/${item.id}/signed`} className="rounded-lg border border-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-700">Signed PDF</a>
                            <a href={`/app/documents/sign/${item.id}/certificate`} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700">Certificate</a>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!allEnvelopes.length ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">No signing requests yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <details className="rounded-[2rem] border border-[var(--brand-border)] bg-white p-5 shadow-sm sm:p-6">
        <summary className="cursor-pointer list-none">
          <div className="flex items-center justify-between gap-4"><div><h2 className="text-xl font-bold text-[var(--brand-text)]">Template library</h2><p className="mt-1 text-sm text-[var(--brand-muted)]">Manage reusable templates, client assignment, event requirements, and version history.</p></div><span className="rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-bold text-[var(--brand-primary)]">{(templates ?? []).filter((template) => template.is_active).length} active</span></div>
        </summary>
        <div className="mt-6 space-y-6">
      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-[var(--brand-text)]">
              Saved templates
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
              Open a template to edit the latest version. Each edit creates a
              new version for future signing history.
            </p>
          </div>
          <Link
            href="/app"
            className="text-sm font-semibold text-[var(--brand-primary)] hover:underline"
          >
            Back to dashboard
          </Link>
        </div>

        {(templates ?? []).length ? (
          <div className="space-y-4">
            {(templates ?? []).map((template) => (
              <TemplateCard
                key={template.id}
                template={template as DocumentTemplate}
                organizers={organizers}
                clients={(clients ?? []) as ClientOption[]}
                events={events}
                eventRequirements={eventRequirements}
                pendingAssignmentCount={pendingCountByTemplateId.get(template.id) ?? 0}
                signedRecordCount={signedCountByTemplateId.get(template.id) ?? 0}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-[var(--brand-border)] bg-white p-8 text-center">
            <ShieldCheck className="mx-auto h-10 w-10 text-[var(--brand-primary)]" />
            <h3 className="mt-3 text-lg font-bold text-[var(--brand-text)]">
              No document templates yet
            </h3>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--brand-muted)]">
              Start with a waiver, policy, or agreement. DanceFlow can then assign it, track signatures, and surface exceptions that need attention.
            </p>
          </div>
        )}
      </section>
        </div>
      </details>
    </main>
  );
}