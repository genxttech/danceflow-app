import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStudioFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  checkInEventRegistrationAction,
  checkInEventTicketCodeAction,
} from "../registrations/actions";
import TicketCodeScanner from "./TicketCodeScanner";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  q?: string;
  status?: string;
  sessionId?: string;
  success?: string;
  error?: string;
}>;

type WorkspaceRow = {
  id: string;
  name: string | null;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  event_type: string | null;
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  organizers:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null;
};

type RegistrationRow = {
  id: string;
  status: string;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  checked_in_at: string | null;
  created_at: string;
  event_ticket_types:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null;
  event_registration_attendees:
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        attendee_role: string | null;
        sort_order: number | null;
        checked_in_at: string | null;
        ticket_code: string | null;
        ticket_issued_at: string | null;
      }[]
    | null;
};

type EventRegistrationAttendeeRow = {
  id: string;
  registration_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  attendee_role: string | null;
  sort_order: number | null;
  checked_in_at: string | null;
  ticket_code: string | null;
  ticket_issued_at: string | null;
};

type EventSessionRow = {
  id: string;
  session_date: string;
  start_time: string | null;
  end_time: string | null;
  session_label: string | null;
  status: string;
};

type EventDocumentRequirementRow = {
  id: string;
  template_id: string;
  is_required: boolean;
  active: boolean;
  document_templates:
    | { title: string | null }
    | { title: string | null }[]
    | null;
};

type DocumentSignatureRow = {
  id: string;
  event_registration_id: string | null;
  template_id: string;
  signer_name: string;
  signer_email: string | null;
  signed_at: string;
};

function isOrganizerWorkspaceName(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized) return false;

  return (
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events")
  );
}

function getOrganizer(
  value:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null,
) {
  return Array.isArray(value) ? value[0] : value;
}

function getTicketTypeName(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null,
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.name ?? "No ticket type";
}

function getTicketKind(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null,
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.ticket_kind ?? "other";
}

function getRequirementTitle(
  value: EventDocumentRequirementRow["document_templates"],
) {
  const template = Array.isArray(value) ? value[0] : value;
  return template?.title ?? "Required document";
}

function kindLabel(value: string) {
  if (value === "general_admission") return "General Admission";
  if (value === "vip") return "VIP";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "registered")
    return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "confirmed")
    return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "pending")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "waitlisted")
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "cancelled")
    return "bg-red-50 text-red-700 ring-1 ring-red-200";
  if (status === "checked_in")
    return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
  if (status === "attended")
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (status === "no_show")
    return "bg-orange-50 text-orange-700 ring-1 ring-orange-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

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

function buildCheckInHref(params: {
  eventId: string;
  q?: string;
  status?: string;
  sessionId?: string;
}) {
  const search = new URLSearchParams();

  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.sessionId) search.set("sessionId", params.sessionId);

  const query = search.toString();
  return query
    ? `/app/events/${params.eventId}/check-in?${query}`
    : `/app/events/${params.eventId}/check-in`;
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function getBanner(search: { success?: string; error?: string; q?: string }) {
  if (search.success === "checked_in") {
    return {
      kind: "success" as const,
      message: search.q
        ? `Attendee checked in. Search kept for "${search.q}".`
        : "Attendee checked in.",
    };
  }

  if (search.success === "already_checked_in") {
    return {
      kind: "success" as const,
      message: "Attendee was already checked in.",
    };
  }

  if (search.error === "cannot_check_in_cancelled") {
    return {
      kind: "error" as const,
      message: "Cancelled registrations cannot be checked in.",
    };
  }

  if (search.error === "ticket_not_confirmed") {
    return {
      kind: "error" as const,
      message:
        "This ticket is not active yet. Confirm the registration before checking it in.",
    };
  }

  if (search.error === "cannot_check_in_unpaid") {
    return {
      kind: "error" as const,
      message: "This ticket is not paid or payment is still pending.",
    };
  }

  if (search.error === "session_required") {
    return {
      kind: "error" as const,
      message: "Choose a class session before checking in an attendee.",
    };
  }

  if (search.error === "session_not_found") {
    return {
      kind: "error" as const,
      message: "That class session could not be found.",
    };
  }

  if (search.error === "ticket_code_required") {
    return {
      kind: "error" as const,
      message: "Enter a ticket code before checking in.",
    };
  }

  if (search.error === "ticket_code_not_found") {
    return {
      kind: "error" as const,
      message: "No matching ticket code was found for this event.",
    };
  }

  if (search.error === "checkin_failed") {
    return {
      kind: "error" as const,
      message: "Could not check in attendee.",
    };
  }

  return null;
}

export default async function EventCheckInPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  await requireStudioFeature("check_in");

  const { id } = await params;
  const query = await searchParams;
  const qRaw = query.q;
  const statusRaw = query.status;
  const sessionIdRaw = query.sessionId;

  const q = Array.isArray(qRaw)
    ? String(qRaw[0] ?? "")
        .trim()
        .toLowerCase()
    : String(qRaw ?? "")
        .trim()
        .toLowerCase();

  const statusFilter = Array.isArray(statusRaw)
    ? String(statusRaw[0] ?? "ready")
        .trim()
        .toLowerCase()
    : String(statusRaw ?? "ready")
        .trim()
        .toLowerCase();

  const requestedSessionId = Array.isArray(sessionIdRaw)
    ? String(sessionIdRaw[0] ?? "").trim()
    : String(sessionIdRaw ?? "").trim();
  const banner = getBanner(query);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: workspace, error: workspaceError },
    { data: event, error: eventError },
    { data: registrationRows, error: registrationsError },
    { data: sessions, error: sessionsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("events")
      .select(
        `
        id,
        name,
        slug,
        status,
        visibility,
        event_type,
        start_date,
        end_date,
        start_time,
        end_time,
        organizers ( name, slug )
      `,
      )
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    // Keep the registration query intentionally small. Loading attendees through
    // a nested select can timeout on larger events, especially after adding
    // ticket-code lookup. Attendees are loaded in a second indexed query below.
    supabase
      .from("event_registrations")
      .select(
        `
        id,
        status,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        checked_in_at,
        created_at,
        event_ticket_types ( name, ticket_kind )
      `,
      )
      .eq("event_id", id)
      .order("created_at", { ascending: true }),

    supabase
      .from("event_sessions")
      .select(
        `
        id,
        session_date,
        start_time,
        end_time,
        session_label,
        status
      `,
      )
      .eq("event_id", id)
      .eq("studio_id", studioId)
      .neq("status", "cancelled")
      .order("session_date", { ascending: true }),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (eventError || !event) {
    notFound();
  }

  if (registrationsError) {
    throw new Error(
      `Failed to load registrations: ${registrationsError.message}`,
    );
  }

  if (sessionsError) {
    throw new Error(`Failed to load class sessions: ${sessionsError.message}`);
  }

  const baseRegistrations = (registrationRows ?? []) as Omit<
    RegistrationRow,
    "event_registration_attendees"
  >[];
  const registrationIds = baseRegistrations.map(
    (registration) => registration.id,
  );

  let attendeeRows: EventRegistrationAttendeeRow[] = [];

  if (registrationIds.length > 0) {
    const { data: attendees, error: attendeesError } = await supabase
      .from("event_registration_attendees")
      .select(
        `
        id,
        registration_id,
        first_name,
        last_name,
        email,
        phone,
        attendee_role,
        sort_order,
        checked_in_at,
        ticket_code,
        ticket_issued_at
      `,
      )
      .in("registration_id", registrationIds)
      .order("sort_order", { ascending: true });

    if (attendeesError) {
      throw new Error(`Failed to load attendees: ${attendeesError.message}`);
    }

    attendeeRows = (attendees ?? []) as EventRegistrationAttendeeRow[];
  }

  let documentRequirementRows: EventDocumentRequirementRow[] = [];
  let documentSignatureRows: DocumentSignatureRow[] = [];

  if (registrationIds.length > 0) {
    const [
      { data: requirements, error: documentRequirementsError },
      { data: signatures, error: documentSignaturesError },
    ] = await Promise.all([
      supabase
        .from("event_document_requirements")
        .select(
          `
          id,
          template_id,
          is_required,
          active,
          document_templates ( title )
        `,
        )
        .eq("event_id", id)
        .eq("active", true)
        .eq("is_required", true),

      supabase
        .from("document_signatures")
        .select(
          `
          id,
          event_registration_id,
          template_id,
          signer_name,
          signer_email,
          signed_at
        `,
        )
        .in("event_registration_id", registrationIds),
    ]);

    if (documentRequirementsError) {
      throw new Error(
        `Failed to load event document requirements: ${documentRequirementsError.message}`,
      );
    }

    if (documentSignaturesError) {
      throw new Error(
        `Failed to load event document signatures: ${documentSignaturesError.message}`,
      );
    }

    documentRequirementRows = (requirements ??
      []) as EventDocumentRequirementRow[];
    documentSignatureRows = (signatures ?? []) as DocumentSignatureRow[];
  }

  const attendeesByRegistrationId = new Map<
    string,
    EventRegistrationAttendeeRow[]
  >();

  for (const attendee of attendeeRows) {
    const existing =
      attendeesByRegistrationId.get(attendee.registration_id) ?? [];
    existing.push(attendee);
    attendeesByRegistrationId.set(attendee.registration_id, existing);
  }

  const typedEvent = event as EventRow;
  const typedRegistrations = baseRegistrations.map((registration) => ({
    ...registration,
    event_registration_attendees:
      attendeesByRegistrationId.get(registration.id) ?? [],
  })) as RegistrationRow[];
  const typedSessions = (sessions ?? []) as EventSessionRow[];
  const isGroupClass = typedEvent.event_type === "group_class";
  const todayIso = new Date().toISOString().slice(0, 10);
  const selectedSession = isGroupClass
    ? (typedSessions.find((session) => session.id === requestedSessionId) ??
      typedSessions.find((session) => session.session_date === todayIso) ??
      typedSessions[0] ??
      null)
    : null;
  const selectedSessionId = selectedSession?.id ?? "";
  const organizer = getOrganizer(typedEvent.organizers);
  const organizerWorkspace = isOrganizerWorkspaceName(workspace?.name);

  const signaturesByRegistrationId = new Map<string, DocumentSignatureRow[]>();
  for (const signature of documentSignatureRows) {
    if (!signature.event_registration_id) continue;
    const current =
      signaturesByRegistrationId.get(signature.event_registration_id) ?? [];
    current.push(signature);
    signaturesByRegistrationId.set(signature.event_registration_id, current);
  }

  const getDocumentStatus = (registrationId: string) => {
    const signatures = signaturesByRegistrationId.get(registrationId) ?? [];
    const signedTemplateIds = new Set(
      signatures.map((signature) => signature.template_id),
    );
    const missingRequirements = documentRequirementRows.filter(
      (requirement) => !signedTemplateIds.has(requirement.template_id),
    );

    return {
      signatures,
      missingRequirements,
      requiredCount: documentRequirementRows.length,
      signedCount: documentRequirementRows.length - missingRequirements.length,
      isComplete:
        documentRequirementRows.length === 0 ||
        missingRequirements.length === 0,
    };
  };

  const getEffectiveStatus = (registration: RegistrationRow) => {
    const attendeeRows = registration.event_registration_attendees ?? [];
    const hasCheckedInAttendee = attendeeRows.some((attendee) =>
      Boolean(attendee.checked_in_at),
    );

    if (registration.status === "cancelled") return "cancelled";

    // Event Digital Tickets V1 uses event_registrations.checked_in_at and
    // event_registration_attendees.checked_in_at as the source of truth.
    // Do not read attendance_records here because this schema does not have
    // attendance_records.event_session_id.
    if (
      registration.checked_in_at ||
      registration.status === "checked_in" ||
      hasCheckedInAttendee
    ) {
      return "checked_in";
    }

    if (registration.status === "confirmed") return "registered";

    return registration.status;
  };

  const filteredRegistrations = typedRegistrations
    .filter((registration) => {
      const effectiveStatus = getEffectiveStatus(registration);

      if (statusFilter === "ready") {
        return effectiveStatus === "registered";
      }
      if (statusFilter === "checked_in") {
        return (
          effectiveStatus === "checked_in" || effectiveStatus === "attended"
        );
      }
      if (statusFilter === "cancelled") {
        return effectiveStatus === "cancelled";
      }
      if (statusFilter === "all") {
        return true;
      }
      return effectiveStatus === "registered";
    })
    .filter((registration) => {
      if (!q) return true;

      const fullName =
        `${registration.attendee_first_name} ${registration.attendee_last_name}`.toLowerCase();

      return (
        fullName.includes(q) ||
        registration.attendee_email.toLowerCase().includes(q) ||
        (registration.attendee_phone ?? "").toLowerCase().includes(q) ||
        (registration.event_registration_attendees ?? []).some(
          (attendee) =>
            `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`
              .toLowerCase()
              .includes(q) ||
            (attendee.ticket_code ?? "").toLowerCase().includes(q),
        )
      );
    });

  const readyCount = typedRegistrations.filter(
    (registration) => getEffectiveStatus(registration) === "registered",
  ).length;
  const checkedInCount = typedRegistrations.filter((registration) => {
    const effectiveStatus = getEffectiveStatus(registration);
    return effectiveStatus === "checked_in" || effectiveStatus === "attended";
  }).length;
  const cancelledCount = typedRegistrations.filter(
    (registration) => getEffectiveStatus(registration) === "cancelled",
  ).length;
  const missingWaiverCount = documentRequirementRows.length
    ? typedRegistrations.filter(
        (registration) => !getDocumentStatus(registration.id).isComplete,
      ).length
    : 0;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {organizerWorkspace
                  ? "DanceFlow Organizer Check-In"
                  : "DanceFlow Event Check-In"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Check-In Mode
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                {typedEvent.name}
              </p>
              <p className="mt-2 text-sm text-white/75">
                Organizer: {organizer?.name ?? "Unknown"} • /events/
                {typedEvent.slug}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href={`/app/events/${typedEvent.id}`}
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Event
              </Link>

              <Link
                href={`/app/events/${typedEvent.id}/registrations`}
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Registrations
              </Link>

              <Link
                href={`/events/${typedEvent.slug}`}
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Public Event Page
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
            <h2 className="text-lg font-semibold text-sky-950">
              Event-day organizer workflow
            </h2>
            <p className="mt-2 text-sm leading-7 text-sky-900">
              Search attendees quickly, filter by readiness, and move people
              through event-day check-in with less friction.
            </p>
          </div>
        </div>
      </div>

      {isGroupClass ? (
        <section className="rounded-[28px] border border-[#E9D5FF] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                Group Class Session
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">
                Choose the class meeting for check-in
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Attendance is tracked separately for each weekly class session.
              </p>
            </div>

            <form className="w-full md:w-80">
              <input type="hidden" name="q" value={query.q ?? ""} />
              <input type="hidden" name="status" value={statusFilter} />
              <label
                htmlFor="sessionId"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Class session
              </label>
              <div className="flex gap-2">
                <select
                  id="sessionId"
                  name="sessionId"
                  defaultValue={selectedSessionId}
                  className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2"
                >
                  {typedSessions.length === 0 ? (
                    <option value="">No sessions found</option>
                  ) : null}
                  {typedSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.session_label ?? "Class"} ·{" "}
                      {session.session_date} ·{" "}
                      {session.start_time ?? "Time TBD"}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4A1363]"
                >
                  View
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Ready to Check In</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {readyCount}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Checked In</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {checkedInCount}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Cancelled</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {cancelledCount}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Missing Waivers</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {missingWaiverCount}
          </p>
        </div>
      </div>

      <form
        action={checkInEventTicketCodeAction}
        className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm"
      >
        <input type="hidden" name="eventId" value={typedEvent.id} />
        {isGroupClass && selectedSessionId ? (
          <input
            type="hidden"
            name="eventSessionId"
            value={selectedSessionId}
          />
        ) : null}
        <input
          type="hidden"
          name="returnTo"
          value={buildCheckInHref({
            eventId: typedEvent.id,
            q: query.q ?? "",
            status: statusFilter,
            sessionId: selectedSessionId,
          })}
        />

        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="ticketCode"
              className="mb-1 block text-sm font-medium text-slate-900"
            >
              Check in by ticket code
            </label>
            <input
              id="ticketCode"
              name="ticketCode"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono uppercase tracking-wide"
              placeholder="Example: DF-A1B2C3D4E5"
              autoComplete="off"
            />
            <p className="mt-2 text-xs text-slate-500">
              Use this when a guest shows their ticket code or staff reads it
              from a confirmation.
            </p>
            <div className="mt-3">
              <TicketCodeScanner inputId="ticketCode" />
            </div>
          </div>

          <button
            type="submit"
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-white hover:opacity-90"
          >
            Check In Code
          </button>
        </div>
      </form>

      <form className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        {isGroupClass && selectedSessionId ? (
          <input type="hidden" name="sessionId" value={selectedSessionId} />
        ) : null}
        <div className="grid gap-4 md:grid-cols-[1fr_220px_auto]">
          <div>
            <label htmlFor="q" className="mb-1 block text-sm font-medium">
              Search attendee
            </label>
            <input
              id="q"
              name="q"
              defaultValue={query.q ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Name, email, or phone"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              View
            </label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="ready">Ready to Check In</option>
              <option value="checked_in">Checked In</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All</option>
            </select>
          </div>

          <div className="flex items-end gap-3">
            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Apply
            </button>

            <Link
              href={buildCheckInHref({
                eventId: typedEvent.id,
                sessionId: selectedSessionId,
              })}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>
      </form>

      <div className="grid gap-4">
        {filteredRegistrations.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-base font-medium text-slate-900">
              No attendees found
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Try a different search or filter.
            </p>
          </div>
        ) : (
          filteredRegistrations.map((registration) => {
            const attendeeRows = [
              ...(registration.event_registration_attendees ?? []),
            ].sort(
              (left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0),
            );
            const firstCheckedInAttendee =
              attendeeRows.find((attendee) =>
                Boolean(attendee.checked_in_at),
              ) ?? null;
            const effectiveStatus = getEffectiveStatus(registration);
            const effectiveCheckedInAt =
              registration.checked_in_at ??
              firstCheckedInAttendee?.checked_in_at ??
              null;

            const fullName =
              `${registration.attendee_first_name} ${registration.attendee_last_name}`.trim();
            const ticketTypeName = getTicketTypeName(
              registration.event_ticket_types,
            );
            const ticketKind = getTicketKind(registration.event_ticket_types);
            const canCheckIn =
              effectiveStatus === "registered" &&
              (!isGroupClass || Boolean(selectedSessionId));
            const documentStatus = getDocumentStatus(registration.id);
            const latestSignature =
              [...documentStatus.signatures].sort(
                (left, right) =>
                  new Date(right.signed_at).getTime() -
                  new Date(left.signed_at).getTime(),
              )[0] ?? null;
            const returnTo = appendQueryParam(
              appendQueryParam(
                buildCheckInHref({
                  eventId: typedEvent.id,
                  q: query.q ?? "",
                  status: statusFilter,
                  sessionId: selectedSessionId,
                }),
                "q",
                query.q ?? "",
              ),
              "status",
              statusFilter,
            );

            return (
              <div
                key={registration.id}
                className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-2xl font-semibold text-slate-900">
                        {fullName}
                      </h3>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          effectiveStatus,
                        )}`}
                      >
                        {effectiveStatus}
                      </span>

                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                        {ticketTypeName}
                      </span>

                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                        {kindLabel(ticketKind)}
                      </span>

                      {documentRequirementRows.length ? (
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                            documentStatus.isComplete
                              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                              : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                          }`}
                        >
                          Waiver{" "}
                          {documentStatus.isComplete ? "signed" : "missing"}
                        </span>
                      ) : null}
                    </div>

                    {attendeeRows.length > 1 ? (
                      <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-700">
                          {attendeeRows.length} attendees on this registration
                        </summary>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {attendeeRows.map((attendee, index) => {
                            const attendeeName =
                              `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`.trim() ||
                              `Attendee ${index + 1}`;

                            return (
                              <div
                                key={attendee.id}
                                className="rounded-xl border border-slate-200 bg-white p-3"
                              >
                                <p className="font-medium text-slate-900">
                                  {index + 1}. {attendeeName}
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                  {attendee.attendee_role === "buyer"
                                    ? "Buyer"
                                    : "Attendee"}
                                  {attendee.email ? ` • ${attendee.email}` : ""}
                                </p>
                                {attendee.ticket_code ? (
                                  <p className="mt-2 inline-flex rounded-lg bg-slate-100 px-2 py-1 font-mono text-xs font-semibold tracking-wide text-slate-700">
                                    {attendee.ticket_code}
                                  </p>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    ) : null}

                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Email</p>
                        <p className="mt-1 break-words font-medium text-slate-900">
                          {registration.attendee_email}
                        </p>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Phone</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {registration.attendee_phone || "—"}
                        </p>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Registered</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(registration.created_at)}
                        </p>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Checked In</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(effectiveCheckedInAt)}
                        </p>
                      </div>

                      <div
                        className={`rounded-xl border p-4 ${
                          documentRequirementRows.length === 0
                            ? "border-slate-200 bg-slate-50"
                            : documentStatus.isComplete
                              ? "border-emerald-200 bg-emerald-50"
                              : "border-amber-200 bg-amber-50"
                        }`}
                      >
                        <p className="text-sm text-slate-600">
                          Required Documents
                        </p>
                        {documentRequirementRows.length === 0 ? (
                          <p className="mt-1 font-medium text-slate-900">
                            None required
                          </p>
                        ) : documentStatus.isComplete ? (
                          <>
                            <p className="mt-1 font-medium text-emerald-900">
                              Signed
                            </p>
                            <p className="mt-2 text-xs text-emerald-800">
                              {latestSignature
                                ? `${latestSignature.signer_name} • ${formatDateTime(latestSignature.signed_at)}`
                                : `${documentStatus.signedCount}/${documentStatus.requiredCount} complete`}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="mt-1 font-medium text-amber-900">
                              Missing waiver
                            </p>
                            <p className="mt-2 text-xs text-amber-800">
                              {documentStatus.missingRequirements
                                .map((requirement) =>
                                  getRequirementTitle(
                                    requirement.document_templates,
                                  ),
                                )
                                .join(", ")}
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-3 lg:w-48 lg:flex-col">
                    {canCheckIn ? (
                      <form action={checkInEventRegistrationAction}>
                        <input
                          type="hidden"
                          name="eventId"
                          value={typedEvent.id}
                        />
                        <input
                          type="hidden"
                          name="registrationId"
                          value={registration.id}
                        />
                        {isGroupClass && selectedSessionId ? (
                          <input
                            type="hidden"
                            name="eventSessionId"
                            value={selectedSessionId}
                          />
                        ) : null}
                        <input type="hidden" name="returnTo" value={returnTo} />
                        {!documentStatus.isComplete ? (
                          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                            Missing required waiver. Confirm before checking in.
                          </div>
                        ) : null}
                        <button
                          type="submit"
                          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-white hover:bg-slate-800"
                        >
                          Check In
                        </button>
                      </form>
                    ) : null}

                    <Link
                      href={buildCheckInHref({
                        eventId: typedEvent.id,
                        q: registration.attendee_email,
                        status: "all",
                        sessionId: selectedSessionId,
                      })}
                      className="rounded-xl border px-4 py-3 text-center hover:bg-slate-50"
                    >
                      Find Similar
                    </Link>

                    <Link
                      href={`/app/events/${typedEvent.id}/registrations`}
                      className="rounded-xl border px-4 py-3 text-center hover:bg-slate-50"
                    >
                      Open Full Registry
                    </Link>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
