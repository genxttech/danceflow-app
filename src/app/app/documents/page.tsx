import Link from "next/link";
import { FileSignature, Plus, ShieldCheck, UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  assignDocumentToClientAction,
  assignDocumentToEventAction,
  createDocumentTemplateAction,
  removeDocumentFromEventAction,
  toggleDocumentTemplateStatusAction,
  updateDocumentTemplateAction,
} from "./actions";

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
  applies_to: string;
  requires_signature: boolean;
  is_required: boolean;
  is_active: boolean;
  current_version: number;
  updated_at: string;
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
  events: { id: string; name: string; slug: string | null } | { id: string; name: string; slug: string | null }[] | null;
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

function statusMessage(searchParams: SearchParams) {
  if (searchParams.success === "created") return "Document template saved.";
  if (searchParams.success === "updated") return "Document template updated.";
  if (searchParams.success === "status_updated")
    return "Document status updated.";
  if (searchParams.success === "assigned") return "Document assigned to client.";
  if (searchParams.success === "event_attached") return "Event waiver attached.";
  if (searchParams.success === "event_removed") return "Event waiver removed.";
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
    query = query.or(`organizer_id.is.null,organizer_id.in.(${organizerIds.join(",")})`);
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
}: {
  template: DocumentTemplate;
  organizers: OrganizerOption[];
  clients: ClientOption[];
  events: EventOption[];
  eventRequirements: EventRequirement[];
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
                Send this document to one client portal for review and signature.
              </p>
            </div>
          </div>

          <form action={assignDocumentToClientAction} className="mt-4 grid gap-3 lg:grid-cols-[1fr_180px_auto] lg:items-end">
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

          <form action={assignDocumentToEventAction} className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="scope" value={template.scope} />
            {template.organizer_id ? (
              <input type="hidden" name="organizerId" value={template.organizer_id} />
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
                      <input type="hidden" name="requirementId" value={requirement.id} />
                      <input type="hidden" name="scope" value={template.scope} />
                      {template.organizer_id ? (
                        <input type="hidden" name="organizerId" value={template.organizer_id} />
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
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const organizers = await getOrganizerOptions(supabase, studioId);
  const organizerIds = organizers.map((organizer) => organizer.id);

  let templateQuery = supabase
    .from("document_templates")
    .select(
      "id, scope, organizer_id, document_type, title, description, body, applies_to, requires_signature, is_required, is_active, current_version, updated_at",
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

  const events = await getEventOptions(supabase, studioId, organizerIds);
  const eventRequirements = await getEventRequirements(supabase, studioId, organizerIds);

  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, status")
    .eq("studio_id", studioId)
    .in("status", ["active", "lead"])
    .order("first_name", { ascending: true })
    .order("last_name", { ascending: true });

  const message = statusMessage(resolvedSearchParams);
  const isError = Boolean(resolvedSearchParams.error || error || clientsError);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <section className="overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#4D1F47] via-[#A64AC9] to-[#FF7A59] p-6 text-white shadow-lg sm:p-8">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-white/90">
            <FileSignature className="h-4 w-4" /> Documents
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
            Documents & e-signatures
          </h1>
          <p className="mt-3 text-sm leading-7 text-white/85 sm:text-base">
            Create reusable waivers, policies, agreements, and releases for your
            studio or organizer events. Signing and assignment workflows will
            build from these templates.
          </p>
        </div>
      </section>

      {message || error || clientsError ? (
        <div
          className={`rounded-2xl border p-4 text-sm ${isError ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}
        >
          {error ? error.message : clientsError ? clientsError.message : message}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-[var(--brand-muted)]">
            Active templates
          </p>
          <p className="mt-2 text-3xl font-bold text-[var(--brand-text)]">
            {(templates ?? []).filter((template) => template.is_active).length}
          </p>
        </div>
        <div className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-[var(--brand-muted)]">
            Required documents
          </p>
          <p className="mt-2 text-3xl font-bold text-[var(--brand-text)]">
            {
              (templates ?? []).filter((template) => template.is_required)
                .length
            }
          </p>
        </div>
        <div className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-[var(--brand-muted)]">
            Organizer templates
          </p>
          <p className="mt-2 text-3xl font-bold text-[var(--brand-text)]">
            {
              (templates ?? []).filter(
                (template) => template.scope === "organizer",
              ).length
            }
          </p>
        </div>
      </section>

      <DocumentTemplateForm organizers={organizers} />

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
              Start with a waiver, policy, or agreement. You will use these
              templates later for portal signing, event waivers, and
              signed-document tracking.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
