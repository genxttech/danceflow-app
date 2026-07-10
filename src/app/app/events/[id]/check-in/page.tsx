import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireEventWorkspaceFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  checkInEventRegistrationAction,
  checkInEventTicketCodeAction,
} from "../registrations/actions";
import {
  publishEventGroupLessonRecapAction,
  saveEventGroupLessonRecapAction,
  unpublishEventGroupLessonRecapAction,
} from "./recap-actions";
import TicketCodeScanner from "./TicketCodeScanner";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  q?: string;
  status?: string;
  sessionId?: string;
  success?: string;
  warning?: string;
  error?: string;
  ticket?: string;
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

type SessionAttendanceRow = {
  id: string;
  event_registration_id: string | null;
  event_registration_attendee_id: string | null;
  event_session_id: string | null;
  status: string | null;
  checked_in_at: string | null;
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

type GroupLessonRecapRow = {
  id: string;
  title: string;
  summary: string | null;
  technique_notes: string | null;
  safety_notes: string | null;
  practice_assignment: string | null;
  media_links: string[] | null;
  status: string;
  published_at: string | null;
  updated_at: string | null;
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

function getBanner(search: {
  success?: string;
  warning?: string;
  error?: string;
  q?: string;
  ticket?: string;
}) {
  if (search.success === "checked_in") {
    return {
      kind: "success" as const,
      message: search.q
        ? `Attendee checked in. Search kept for "${search.q}".`
        : "Attendee checked in.",
    };
  }

  if (search.warning === "already_checked_in" || search.success === "already_checked_in") {
    const ticket = search.ticket ? ` Ticket ${search.ticket}` : "This ticket";

    return {
      kind: "warning" as const,
      message: `${ticket} was already checked in. Do not admit a duplicate ticket without verifying the attendee.`,
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

  if (search.success === "recap_saved") {
    return {
      kind: "success" as const,
      message: "Group recap draft saved.",
    };
  }

  if (search.success === "recap_published") {
    return {
      kind: "success" as const,
      message: "Group recap published to checked-in students.",
    };
  }

  if (search.success === "recap_unpublished") {
    return {
      kind: "success" as const,
      message: "Group recap unpublished.",
    };
  }

  if (search.error === "recap_save_failed") {
    return {
      kind: "error" as const,
      message: "Could not save group recap.",
    };
  }

  if (search.error === "recap_publish_failed") {
    return {
      kind: "error" as const,
      message:
        "Could not publish group recap. Save a draft and make sure students are checked in.",
    };
  }

  if (search.error === "recap_unpublish_failed") {
    return {
      kind: "error" as const,
      message: "Could not unpublish group recap.",
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
  const { id } = await params;

  await requireEventWorkspaceFeature({
    eventId: id,
    feature: "check_in",
    allowedOrganizerRoles: [
      "organizer_owner",
      "organizer_admin",
      "organizer_staff",
    ],
  });
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
    // Keep this scoped to the registrations already loaded for this event.
    // Large event-level attendee scans can hit statement timeouts on check-in.
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
      .eq("event_id", id)
      .in("registration_id", registrationIds)
      .order("registration_id", { ascending: true })
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
  const currentCheckInHref = buildCheckInHref({
    eventId: typedEvent.id,
    q: query.q ?? "",
    status: statusFilter,
    sessionId: selectedSessionId,
  });

  let sessionAttendanceRows: SessionAttendanceRow[] = [];

  if (isGroupClass && selectedSessionId && registrationIds.length > 0) {
    const { data: attendanceRows, error: attendanceError } = await supabase
      .from("attendance_records")
      .select("id, event_registration_id, event_registration_attendee_id, event_session_id, status, checked_in_at")
      .eq("studio_id", studioId)
      .eq("event_session_id", selectedSessionId)
      .in("event_registration_id", registrationIds);

    if (attendanceError) {
      throw new Error(`Failed to load class check-ins: ${attendanceError.message}`);
    }

    sessionAttendanceRows = (attendanceRows ?? []) as SessionAttendanceRow[];
  }

  const sessionAttendanceByRegistrationId = new Map<string, SessionAttendanceRow>();
  const sessionAttendanceByAttendeeId = new Map<string, SessionAttendanceRow>();
  for (const attendance of sessionAttendanceRows) {
    if (attendance.event_registration_attendee_id) {
      sessionAttendanceByAttendeeId.set(
        attendance.event_registration_attendee_id,
        attendance,
      );
    } else if (attendance.event_registration_id) {
      sessionAttendanceByRegistrationId.set(attendance.event_registration_id, attendance);
    }
  }

  const getSessionAttendance = (registrationId: string) =>
    sessionAttendanceByRegistrationId.get(registrationId) ?? null;

  const getAttendeeSessionAttendance = (attendeeId: string) =>
    sessionAttendanceByAttendeeId.get(attendeeId) ?? null;

  const isAttendeeSessionCheckedIn = (attendeeId: string) => {
    const attendance = getAttendeeSessionAttendance(attendeeId);
    return attendance?.status === "checked_in" || attendance?.status === "attended";
  };

  const getAttendeeSessionCheckedInAt = (attendeeId: string) => {
    const attendance = getAttendeeSessionAttendance(attendeeId);
    return attendance?.checked_in_at ?? null;
  };

  const isRegistrationSessionCheckedIn = (registration: RegistrationRow) => {
    const attendeeRows = registration.event_registration_attendees ?? [];
    if (attendeeRows.length > 0) {
      return attendeeRows.every((attendee) => isAttendeeSessionCheckedIn(attendee.id));
    }

    const attendance = getSessionAttendance(registration.id);
    return attendance?.status === "checked_in" || attendance?.status === "attended";
  };

  const getRegistrationSessionCheckedInAt = (registration: RegistrationRow) => {
    const attendeeRows = registration.event_registration_attendees ?? [];
    const attendeeCheckedInAt = attendeeRows
      .map((attendee) => getAttendeeSessionCheckedInAt(attendee.id))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);

    if (attendeeCheckedInAt) return attendeeCheckedInAt;

    const attendance = getSessionAttendance(registration.id);
    return attendance?.checked_in_at ?? null;
  };

  let groupLessonRecap: GroupLessonRecapRow | null = null;
  let groupLessonRecapRecipientCount = 0;

  if (isGroupClass && selectedSessionId) {
    const [
      { data: recap, error: recapError },
      { count: recipientCount, error: recipientCountError },
    ] = await Promise.all([
      supabase
        .from("group_lesson_recaps")
        .select(
          `
          id,
          title,
          summary,
          technique_notes,
          safety_notes,
          practice_assignment,
          media_links,
          status,
          published_at,
          updated_at
        `,
        )
        .eq("studio_id", studioId)
        .eq("event_session_id", selectedSessionId)
        .maybeSingle(),
      supabase
        .from("group_lesson_recap_recipients")
        .select("id", { count: "exact", head: true })
        .eq("studio_id", studioId)
        .eq("event_session_id", selectedSessionId),
    ]);

    if (recapError) {
      throw new Error(`Failed to load group recap: ${recapError.message}`);
    }

    if (recipientCountError) {
      throw new Error(
        `Failed to load group recap recipients: ${recipientCountError.message}`,
      );
    }

    groupLessonRecap = (recap ?? null) as GroupLessonRecapRow | null;
    groupLessonRecapRecipientCount = recipientCount ?? 0;
  }

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
    if (registration.status === "cancelled") return "cancelled";

    if (isGroupClass && selectedSessionId) {
      if (isRegistrationSessionCheckedIn(registration)) return "checked_in";
      if (["confirmed", "checked_in", "attended"].includes(registration.status)) {
        return "registered";
      }
      return registration.status;
    }

    const attendeeRows = registration.event_registration_attendees ?? [];
    const hasAttendeeTickets = attendeeRows.length > 0;
    const allAttendeeTicketsCheckedIn =
      hasAttendeeTickets &&
      attendeeRows.every((attendee) => Boolean(attendee.checked_in_at));

    // QR tickets are checked in per attendee row. If a registration has
    // attendee ticket rows, keep it in the ready list until every ticket row is
    // checked in. This avoids one scanned QR code making a multi-ticket
    // registration look fully checked in.
    if (hasAttendeeTickets) {
      if (allAttendeeTicketsCheckedIn) return "checked_in";
      if (registration.status === "confirmed") return "registered";
      return registration.status;
    }

    if (registration.checked_in_at || registration.status === "checked_in") {
      return "checked_in";
    }

    if (registration.status === "confirmed") return "registered";

    return registration.status;
  };

  const getTicketCountForRegistration = (registration: RegistrationRow) => {
    const attendeeRows = registration.event_registration_attendees ?? [];
    return attendeeRows.length > 0 ? attendeeRows.length : 1;
  };

  const getCheckedInTicketCountForRegistration = (
    registration: RegistrationRow,
  ) => {
    if (isGroupClass && selectedSessionId) {
      const attendeeRows = registration.event_registration_attendees ?? [];
      if (attendeeRows.length > 0) {
        return attendeeRows.filter((attendee) =>
          isAttendeeSessionCheckedIn(attendee.id),
        ).length;
      }

      return isRegistrationSessionCheckedIn(registration) ? 1 : 0;
    }

    const attendeeRows = registration.event_registration_attendees ?? [];
    if (attendeeRows.length > 0) {
      return attendeeRows.filter((attendee) => Boolean(attendee.checked_in_at))
        .length;
    }

    const effectiveStatus = getEffectiveStatus(registration);
    return effectiveStatus === "checked_in" || effectiveStatus === "attended"
      ? 1
      : 0;
  };

  const readyCount = typedRegistrations.reduce((sum, registration) => {
    if (isGroupClass && selectedSessionId) {
      if (getEffectiveStatus(registration) === "cancelled") return sum;
      return (
        sum +
        Math.max(
          getTicketCountForRegistration(registration) -
            getCheckedInTicketCountForRegistration(registration),
          0,
        )
      );
    }

    if (getEffectiveStatus(registration) !== "registered") return sum;
    return sum + getTicketCountForRegistration(registration);
  }, 0);
  const checkedInCount = typedRegistrations.reduce(
    (sum, registration) => sum + getCheckedInTicketCountForRegistration(registration),
    0,
  );
  const cancelledCount = typedRegistrations.reduce((sum, registration) => {
    if (getEffectiveStatus(registration) !== "cancelled") return sum;
    return sum + getTicketCountForRegistration(registration);
  }, 0);
  const missingWaiverCount = documentRequirementRows.length
    ? typedRegistrations.filter(
        (registration) => !getDocumentStatus(registration.id).isComplete,
      ).length
    : 0;

  const filteredRegistrations = typedRegistrations
    .filter((registration) => {
      const effectiveStatus = getEffectiveStatus(registration);

      if (statusFilter === "ready") {
        if (isGroupClass && selectedSessionId) {
          return (
            effectiveStatus !== "cancelled" &&
            getCheckedInTicketCountForRegistration(registration) <
              getTicketCountForRegistration(registration)
          );
        }
        return effectiveStatus === "registered";
      }
      if (statusFilter === "checked_in") {
        if (isGroupClass && selectedSessionId) {
          return getCheckedInTicketCountForRegistration(registration) > 0;
        }
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

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : banner.kind === "warning"
                ? "border-amber-300 bg-amber-50 text-amber-800"
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
                  ? "DanceFlow Organizer Check-in"
                  : "DanceFlow Event Check-in"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Event check-in
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

        <div className="mb-3 flex items-center justify-between gap-3 md:hidden">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Fast check-in
            </p>
            <p className="text-sm text-slate-600">
              Scan or enter a ticket code for this event.
            </p>
          </div>
          <span className="rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--brand-primary)]">
            Mobile ready
          </span>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
          <div className="min-w-0">
            <label
              htmlFor="ticketCode"
              className="mb-1 block text-sm font-medium text-slate-900"
            >
              Ticket code
            </label>
            <input
              id="ticketCode"
              name="ticketCode"
              className="w-full rounded-xl border border-slate-300 px-3 py-3 font-mono text-base uppercase tracking-wide md:py-2"
              placeholder="Example: DF-A1B2C3D4E5"
              autoComplete="off"
              inputMode="text"
            />
            <p className="mt-2 hidden text-xs text-slate-500 md:block">
              Use this when a guest shows their ticket code or staff reads it
              from a confirmation.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:items-end">
            <TicketCodeScanner inputId="ticketCode" />

            <button
              type="submit"
              className="inline-flex w-full items-center justify-center rounded-xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90 md:py-2 lg:w-auto"
            >
              Check In Code
            </button>
          </div>
        </div>
      </form>

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

      {isGroupClass && selectedSessionId ? (
        <section className="rounded-[28px] border border-[#E9D5FF] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                Group Lesson Recap
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">
                Share notes from this class
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Recaps publish to checked-in attendees for the selected class
                session.
              </p>
            </div>

            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700 ring-1 ring-slate-200">
                {groupLessonRecap?.status ?? "No draft"}
              </span>
              <span className="rounded-full bg-purple-50 px-3 py-1 font-medium text-purple-700 ring-1 ring-purple-200">
                {groupLessonRecapRecipientCount} recipients
              </span>
            </div>
          </div>

          <form action={saveEventGroupLessonRecapAction} className="mt-5 grid gap-4">
            <input type="hidden" name="eventId" value={typedEvent.id} />
            <input type="hidden" name="eventSessionId" value={selectedSessionId} />
            <input type="hidden" name="returnTo" value={currentCheckInHref} />

            <div>
              <label htmlFor="recap-title" className="mb-1 block text-sm font-medium text-slate-900">
                Title
              </label>
              <input
                id="recap-title"
                name="title"
                defaultValue={
                  groupLessonRecap?.title ??
                  `${typedEvent.name} recap - ${
                    selectedSession?.session_label ?? selectedSession?.session_date ?? "Class"
                  }`
                }
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                required
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <label htmlFor="recap-summary" className="mb-1 block text-sm font-medium text-slate-900">
                  Summary
                </label>
                <textarea
                  id="recap-summary"
                  name="summary"
                  defaultValue={groupLessonRecap?.summary ?? ""}
                  rows={4}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="recap-technique" className="mb-1 block text-sm font-medium text-slate-900">
                  Technique notes
                </label>
                <textarea
                  id="recap-technique"
                  name="techniqueNotes"
                  defaultValue={groupLessonRecap?.technique_notes ?? ""}
                  rows={4}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="recap-safety" className="mb-1 block text-sm font-medium text-slate-900">
                  Safety notes
                </label>
                <textarea
                  id="recap-safety"
                  name="safetyNotes"
                  defaultValue={groupLessonRecap?.safety_notes ?? ""}
                  rows={3}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="recap-practice" className="mb-1 block text-sm font-medium text-slate-900">
                  Practice assignment
                </label>
                <textarea
                  id="recap-practice"
                  name="practiceAssignment"
                  defaultValue={groupLessonRecap?.practice_assignment ?? ""}
                  rows={3}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>
            </div>

            <div>
              <label htmlFor="recap-media" className="mb-1 block text-sm font-medium text-slate-900">
                Media links
              </label>
              <textarea
                id="recap-media"
                name="mediaLinks"
                defaultValue={(groupLessonRecap?.media_links ?? []).join("\n")}
                rows={3}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                placeholder="One link per line"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Save Draft
              </button>
            </div>
          </form>

          <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-200 pt-4">
            <form action={publishEventGroupLessonRecapAction}>
              <input type="hidden" name="eventId" value={typedEvent.id} />
              <input type="hidden" name="eventSessionId" value={selectedSessionId} />
              <input type="hidden" name="returnTo" value={currentCheckInHref} />
              <button
                type="submit"
                className="rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4A1363]"
              >
                Publish to Checked-In
              </button>
            </form>

            {groupLessonRecap ? (
              <form action={unpublishEventGroupLessonRecapAction}>
                <input type="hidden" name="eventId" value={typedEvent.id} />
                <input type="hidden" name="eventSessionId" value={selectedSessionId} />
                <input type="hidden" name="returnTo" value={currentCheckInHref} />
                <button
                  type="submit"
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Unpublish
                </button>
              </form>
            ) : null}
          </div>
        </section>
      ) : null}

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
            const sessionCheckedInAt = isGroupClass
              ? getRegistrationSessionCheckedInAt(registration)
              : null;
            const firstCheckedInAttendee =
              attendeeRows.find((attendee) =>
                Boolean(attendee.checked_in_at),
              ) ?? null;
            const checkedInAttendeeCount = isGroupClass
              ? getCheckedInTicketCountForRegistration(registration)
              : attendeeRows.filter((attendee) =>
                  Boolean(attendee.checked_in_at),
                ).length;
            const effectiveStatus = getEffectiveStatus(registration);
            const effectiveCheckedInAt =
              sessionCheckedInAt ??
              firstCheckedInAttendee?.checked_in_at ??
              (attendeeRows.length === 0 ? registration.checked_in_at : null);

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
                      <details
                        open={checkedInAttendeeCount < attendeeRows.length}
                        className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3"
                      >
                        <summary className="cursor-pointer text-sm font-medium text-slate-700">
                          {attendeeRows.length} attendees on this registration
                        </summary>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {attendeeRows.map((attendee, index) => {
                            const attendeeSessionCheckedInAt = isGroupClass
                              ? getAttendeeSessionCheckedInAt(attendee.id)
                              : null;
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
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  {attendee.ticket_code ? (
                                    <p className="inline-flex rounded-lg bg-slate-100 px-2 py-1 font-mono text-xs font-semibold tracking-wide text-slate-700">
                                      {attendee.ticket_code}
                                    </p>
                                  ) : null}
                                  <span
                                    className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                                      isGroupClass
                                        ? attendeeSessionCheckedInAt
                                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                                          : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"
                                        : attendee.checked_in_at
                                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                                          : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"
                                    }`}
                                  >
                                    {isGroupClass
                                      ? attendeeSessionCheckedInAt
                                        ? `Checked in ${formatDateTime(attendeeSessionCheckedInAt)}`
                                        : "Not checked in for this class"
                                      : attendee.checked_in_at
                                        ? `Checked in ${formatDateTime(attendee.checked_in_at)}`
                                        : "Not checked in"}
                                  </span>
                                </div>
                                {((isGroupClass &&
                                  selectedSessionId &&
                                  !attendeeSessionCheckedInAt) ||
                                  (!isGroupClass && !attendee.checked_in_at)) ? (
                                  <form
                                    action={checkInEventRegistrationAction}
                                    className="mt-3"
                                  >
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
                                    <input
                                      type="hidden"
                                      name="eventRegistrationAttendeeId"
                                      value={attendee.id}
                                    />
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
                                      value={returnTo}
                                    />
                                    <button
                                      type="submit"
                                      className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800"
                                    >
                                      Check In This Attendee
                                    </button>
                                  </form>
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
                          {attendeeRows.length > 0
                            ? `${checkedInAttendeeCount}/${attendeeRows.length} ${
                                isGroupClass ? "attendees" : "tickets"
                              }`
                            : formatDateTime(effectiveCheckedInAt)}
                        </p>
                        {attendeeRows.length > 0 && effectiveCheckedInAt ? (
                          <p className="mt-1 text-xs text-slate-500">
                            Latest: {formatDateTime(effectiveCheckedInAt)}
                          </p>
                        ) : null}
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
                          {isGroupClass && attendeeRows.length > 1
                            ? "Check In All"
                            : "Check In"}
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
