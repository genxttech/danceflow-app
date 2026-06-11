import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireEventWorkspaceFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  resendEventTicketConfirmationAction,
  updateEventRegistrationAttendeeAction,
  upsertEventAttendanceAction,
} from "./actions";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  filter?: string;
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
  organizers:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null;
};

type RegistrationRow = {
  id: string;
  client_id: string | null;
  ticket_type_id: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  quantity: number | null;
  status: string;
  payment_status: string | null;
  total_amount: number | null;
  total_price: number | null;
  currency: string | null;
  checked_in_at: string | null;
  notes: string | null;
  created_at: string;
  clients:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null;
  event_ticket_types:
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }[]
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
        registration_id: string;
        checked_in_at: string | null;
        ticket_code: string | null;
        ticket_issued_at: string | null;
      }[]
    | null;
};

type AttendanceRow = {
  id: string;
  event_registration_id: string;
  client_id: string | null;
  status: string;
  checked_in_at: string | null;
};

type PaymentRow = {
  id: string;
  registration_id: string;
  amount: number;
  currency: string;
  payment_method: string;
  status: string;
  refund_amount: number | null;
  refunded_at: string | null;
  source: string | null;
};

type TicketEmailAuditRow = {
  id: string;
  related_id: string | null;
  template_key: string | null;
  recipient_email: string | null;
  status: string | null;
  sent_at: string | null;
  error_message: string | null;
  created_at: string;
};

type ClientOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
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

function getClientName(
  value:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  if (!client) return "Not linked";
  return (
    `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() ||
    "Linked client"
  );
}

function getTicketTypeName(
  value:
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }[]
    | null,
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.name ?? "No ticket type";
}

function getTicketKind(
  value:
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }[]
    | null,
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.ticket_kind ?? "other";
}

function getTicketAdmitsPerTicket(
  value:
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }
    | { name: string; ticket_kind: string; attendees_per_ticket: number | null }[]
    | null,
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return Math.max(1, Number(ticket?.attendees_per_ticket ?? 1));
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

function paymentBadgeClass(status: string | null) {
  if (status === "paid")
    return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "pending")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "partial")
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "refunded")
    return "bg-red-50 text-red-700 ring-1 ring-red-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function shouldBlockAttendanceForPayment(paymentStatus: string | null) {
  return ["pending", "unpaid", "failed", "refunded"].includes(paymentStatus ?? "");
}

function isRegistrationActiveForCheckIn(
  registration: Pick<RegistrationRow, "status" | "payment_status">,
) {
  const statusIsActive = [
    "confirmed",
    "registered",
    "checked_in",
    "attended",
  ].includes(registration.status ?? "");

  return statusIsActive && !shouldBlockAttendanceForPayment(registration.payment_status);
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

function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function registrationsHref(eventId: string, filter: string) {
  return filter === "all"
    ? `/app/events/${eventId}/registrations`
    : `/app/events/${eventId}/registrations?filter=${encodeURIComponent(filter)}`;
}

function ticketQrSrc(ticketCode: string) {
  return `/api/tickets/qr?code=${encodeURIComponent(ticketCode)}`;
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "attendance_updated") {
    return {
      kind: "success" as const,
      message: "Attendance and CRM handoff updated.",
    };
  }

  if (search.success === "ticket_confirmation_resent") {
    return {
      kind: "success" as const,
      message: "Ticket confirmation email queued.",
    };
  }

  if (search.success === "attendee_updated") {
    return {
      kind: "success" as const,
      message: "Attendee details updated.",
    };
  }

  if (search.success === "registration_confirmed") {
    return {
      kind: "success" as const,
      message: "Registration confirmed.",
    };
  }

  if (search.success === "registration_cancelled") {
    return {
      kind: "success" as const,
      message: "Registration cancelled.",
    };
  }

  if (search.success === "registration_linked") {
    return {
      kind: "success" as const,
      message: "Registration linked to CRM client.",
    };
  }

  if (search.success === "lead_created") {
    return {
      kind: "success" as const,
      message: "Lead created from registration.",
    };
  }

  if (search.success === "registration_paid") {
    return {
      kind: "success" as const,
      message: "Registration marked paid.",
    };
  }

  if (search.success === "registration_refunded") {
    return {
      kind: "success" as const,
      message: "Registration refunded.",
    };
  }

  if (search.success === "marked_attended") {
    return {
      kind: "success" as const,
      message: "Attendance marked attended.",
    };
  }

  if (search.error === "registration_not_found") {
    return {
      kind: "error" as const,
      message: "Registration not found.",
    };
  }

  if (search.error === "client_not_found") {
    return {
      kind: "error" as const,
      message: "Selected client was not found in this workspace.",
    };
  }

  if (search.error === "attendance_update_failed") {
    return {
      kind: "error" as const,
      message: "Could not update attendance or CRM handoff.",
    };
  }

  if (search.error === "registration_confirm_failed") {
    return {
      kind: "error" as const,
      message: "Could not confirm registration.",
    };
  }

  if (search.error === "registration_cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel registration.",
    };
  }

  if (search.error === "link_client_failed") {
    return {
      kind: "error" as const,
      message: "Could not link registration to client.",
    };
  }

  if (search.error === "lead_create_failed") {
    return {
      kind: "error" as const,
      message: "Could not create lead from registration.",
    };
  }

  if (search.error === "resend_not_confirmed") {
    return {
      kind: "error" as const,
      message: "Only confirmed registrations can receive ticket confirmations.",
    };
  }

  if (search.error === "resend_not_paid") {
    return {
      kind: "error" as const,
      message: "Only paid registrations can receive ticket confirmations.",
    };
  }

  if (search.error === "resend_missing_email") {
    return {
      kind: "error" as const,
      message: "This registration does not have an email address.",
    };
  }

  if (search.error === "resend_ticket_failed") {
    return {
      kind: "error" as const,
      message: "Could not queue the ticket confirmation email.",
    };
  }

  if (search.error === "attendee_not_found") {
    return {
      kind: "error" as const,
      message: "Attendee record not found for this registration.",
    };
  }

  if (search.error === "attendee_name_required") {
    return {
      kind: "error" as const,
      message: "Attendee first and last name are required.",
    };
  }

  if (search.error === "attendee_update_failed") {
    return {
      kind: "error" as const,
      message: "Could not update attendee details.",
    };
  }

  if (search.error === "mark_paid_failed") {
    return {
      kind: "error" as const,
      message: "Could not mark registration paid.",
    };
  }

  if (search.error === "refund_failed") {
    return {
      kind: "error" as const,
      message: "Could not refund registration.",
    };
  }

  if (search.error === "mark_attended_failed") {
    return {
      kind: "error" as const,
      message: "Could not mark attendee as attended.",
    };
  }

  return null;
}

export default async function EventRegistrationsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;

  await requireEventWorkspaceFeature({
    eventId: id,
    feature: "organizer_tools",
    allowedOrganizerRoles: [
      "organizer_owner",
      "organizer_admin",
      "organizer_staff",
    ],
  });
  const search = await searchParams;
  const activeFilter = (search.filter ?? "all").trim().toLowerCase();
  const banner = getBanner(search);
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
    { data: clients, error: clientsError },
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
        organizers ( name, slug )
      `,
      )
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("event_registrations")
      .select(
        `
        id,
        client_id,
        ticket_type_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        quantity,
        status,
        payment_status,
        total_amount,
        total_price,
        currency,
        checked_in_at,
        notes,
        created_at,
        clients ( id, first_name, last_name ),
        event_ticket_types ( name, ticket_kind, attendees_per_ticket )
      `,
      )
      .eq("event_id", id)
      .order("created_at", { ascending: true }),

    supabase
      .from("clients")
      .select("id, first_name, last_name, email")
      .eq("studio_id", studioId)
      .order("last_name", { ascending: true })
      .order("first_name", { ascending: true }),
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

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  const registrationIds = ((registrationRows ?? []) as { id: string }[]).map(
    (registration) => registration.id,
  );

  const [
    { data: attendeeRows, error: attendeesError },
    { data: attendanceRows, error: attendanceError },
    { data: paymentRows, error: paymentError },
    { data: ticketEmailRows, error: ticketEmailError },
    { data: documentRequirementRows, error: documentRequirementsError },
    { data: documentSignatureRows, error: documentSignaturesError },
  ] = registrationIds.length
    ? await Promise.all([
        supabase
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
          .order("registration_id", { ascending: true })
          .order("sort_order", { ascending: true }),

        supabase
          .from("attendance_records")
          .select(
            `
            id,
            event_registration_id,
            client_id,
            status,
            checked_in_at
          `,
          )
          .eq("studio_id", studioId)
          .in("event_registration_id", registrationIds),

        supabase
          .from("event_payments")
          .select(
            `
            id,
            registration_id,
            amount,
            currency,
            payment_method,
            status,
            refund_amount,
            refunded_at,
            source
          `,
          )
          .in("registration_id", registrationIds),

        supabase
          .from("outbound_deliveries")
          .select(
            `
            id,
            related_id,
            template_key,
            recipient_email,
            status,
            sent_at,
            error_message,
            created_at
          `,
          )
          .eq("related_table", "event_registrations")
          .in("related_id", registrationIds)
          .in("template_key", [
            "event_ticket_confirmation",
            "event_registration_ticket_confirmation",
            "event_registration_ticket_confirmation_resend",
          ])
          .order("created_at", { ascending: false }),

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
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];

  if (attendeesError) {
    throw new Error(
      `Failed to load registration attendees: ${attendeesError.message}`,
    );
  }

  if (attendanceError) {
    throw new Error(
      `Failed to load attendance records: ${attendanceError.message}`,
    );
  }

  if (paymentError) {
    throw new Error(`Failed to load payments: ${paymentError.message}`);
  }

  if (ticketEmailError) {
    throw new Error(
      `Failed to load ticket email audit: ${ticketEmailError.message}`,
    );
  }

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

  const typedEvent = event as EventRow;
  const typedAttendanceRows = (attendanceRows ?? []) as AttendanceRow[];
  const typedPaymentRows = (paymentRows ?? []) as PaymentRow[];
  const typedTicketEmailRows = (ticketEmailRows ?? []) as TicketEmailAuditRow[];
  const typedClients = (clients ?? []) as ClientOption[];

  type AttendeeRow = NonNullable<
    RegistrationRow["event_registration_attendees"]
  >[number];

  const attendeesByRegistrationId = new Map<string, AttendeeRow[]>();
  for (const attendee of (attendeeRows ?? []) as AttendeeRow[]) {
    const current =
      attendeesByRegistrationId.get(attendee.registration_id) ?? [];
    current.push(attendee);
    attendeesByRegistrationId.set(attendee.registration_id, current);
  }

  const typedRegistrations = (
    (registrationRows ?? []) as RegistrationRow[]
  ).map((registration) => ({
    ...registration,
    event_registration_attendees:
      attendeesByRegistrationId.get(registration.id) ?? [],
  }));
  const organizer = getOrganizer(typedEvent.organizers);
  const organizerWorkspace = isOrganizerWorkspaceName(workspace?.name);

  const attendanceByRegistrationId = new Map(
    typedAttendanceRows.map((row) => [row.event_registration_id, row]),
  );

  const paymentsByRegistrationId = new Map<string, PaymentRow[]>();
  for (const payment of typedPaymentRows) {
    const current = paymentsByRegistrationId.get(payment.registration_id) ?? [];
    current.push(payment);
    paymentsByRegistrationId.set(payment.registration_id, current);
  }

  const ticketEmailsByRegistrationId = new Map<string, TicketEmailAuditRow[]>();
  for (const ticketEmail of typedTicketEmailRows) {
    if (!ticketEmail.related_id) continue;
    const current = ticketEmailsByRegistrationId.get(ticketEmail.related_id) ?? [];
    current.push(ticketEmail);
    ticketEmailsByRegistrationId.set(ticketEmail.related_id, current);
  }

  const requiredDocumentRows = (documentRequirementRows ??
    []) as EventDocumentRequirementRow[];
  const signaturesByRegistrationId = new Map<string, DocumentSignatureRow[]>();
  for (const signature of (documentSignatureRows ??
    []) as DocumentSignatureRow[]) {
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
    const missingRequirements = requiredDocumentRows.filter(
      (requirement) => !signedTemplateIds.has(requirement.template_id),
    );

    return {
      signatures,
      missingRequirements,
      requiredCount: requiredDocumentRows.length,
      signedCount: requiredDocumentRows.length - missingRequirements.length,
      isComplete:
        requiredDocumentRows.length === 0 || missingRequirements.length === 0,
    };
  };

  const getEffectiveStatus = (registration: RegistrationRow) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    if (attendance?.status) return attendance.status;
    if (registration.status === "confirmed") return "registered";
    return registration.status;
  };

  const filteredRegistrations = typedRegistrations.filter((registration) => {
    const status = getEffectiveStatus(registration);

    if (activeFilter === "all") return true;
    if (activeFilter === "registered") return status === "registered";
    if (activeFilter === "checked_in")
      return status === "checked_in" || status === "attended";
    if (activeFilter === "waitlisted") return status === "waitlisted";
    if (activeFilter === "cancelled") return status === "cancelled";
    if (activeFilter === "crm_linked") {
      const attendance = attendanceByRegistrationId.get(registration.id);
      return Boolean(attendance?.client_id ?? registration.client_id);
    }
    return true;
  });

  const totalRegistrations = typedRegistrations.length;
  const confirmedCount = typedRegistrations.filter(
    (registration) => getEffectiveStatus(registration) === "registered",
  ).length;
  const checkedInCount = typedRegistrations.filter((registration) => {
    const status = getEffectiveStatus(registration);
    return status === "checked_in" || status === "attended";
  }).length;
  const waitlistCount = typedRegistrations.filter(
    (registration) => getEffectiveStatus(registration) === "waitlisted",
  ).length;
  const paidCount = typedRegistrations.filter(
    (registration) => registration.payment_status === "paid",
  ).length;
  const linkedCount = typedRegistrations.filter((registration) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    return Boolean(attendance?.client_id ?? registration.client_id);
  }).length;
  const missingWaiverCount = requiredDocumentRows.length
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
                  ? "DanceFlow Organizer Registrations"
                  : "DanceFlow Event Registrations"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Registrations
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                {typedEvent.name}
              </p>
              <p className="mt-2 text-sm text-white/75">
                Host: {organizer?.name ?? workspace?.name ?? "DanceFlow host"} •
                /events/{typedEvent.slug}
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
                href={`/app/events/${typedEvent.id}/check-in`}
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Check-in mode
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
              Event registration operations
            </h2>
            <p className="mt-2 text-sm leading-7 text-sky-900">
              Manage payment status, CRM handoff, attendance progression, and
              event-day registration and check-in flow from one place.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {totalRegistrations}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Confirmed</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {confirmedCount}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Checked In</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {checkedInCount}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Paid</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {paidCount}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Linked to CRM</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {linkedCount}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {waitlistCount} waitlisted
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Missing Waivers</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {missingWaiverCount}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            {requiredDocumentRows.length} required
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href={registrationsHref(typedEvent.id, "all")}
          className={`rounded-full px-4 py-2 text-sm ${
            activeFilter === "all"
              ? "bg-slate-900 text-white"
              : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          All
        </Link>
        <Link
          href={registrationsHref(typedEvent.id, "registered")}
          className={`rounded-full px-4 py-2 text-sm ${
            activeFilter === "registered"
              ? "bg-slate-900 text-white"
              : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Registered
        </Link>
        <Link
          href={registrationsHref(typedEvent.id, "checked_in")}
          className={`rounded-full px-4 py-2 text-sm ${
            activeFilter === "checked_in"
              ? "bg-slate-900 text-white"
              : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Checked In
        </Link>
        <Link
          href={registrationsHref(typedEvent.id, "waitlisted")}
          className={`rounded-full px-4 py-2 text-sm ${
            activeFilter === "waitlisted"
              ? "bg-slate-900 text-white"
              : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Waitlisted
        </Link>
        <Link
          href={registrationsHref(typedEvent.id, "crm_linked")}
          className={`rounded-full px-4 py-2 text-sm ${
            activeFilter === "crm_linked"
              ? "bg-slate-900 text-white"
              : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          CRM Linked
        </Link>
      </div>

      <div className="space-y-4">
        {filteredRegistrations.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-base font-medium text-slate-900">
              No registrations found
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Try a different filter or wait for new registrations to come in.
            </p>
          </div>
        ) : (
          filteredRegistrations.map((registration) => {
            const attendance =
              attendanceByRegistrationId.get(registration.id) ?? null;
            const effectiveStatus = getEffectiveStatus(registration);
            const checkedInAt =
              attendance?.checked_in_at ?? registration.checked_in_at;
            const linkedClientId =
              attendance?.client_id ?? registration.client_id;
            const linkedPayments =
              paymentsByRegistrationId.get(registration.id) ?? [];
            const ticketEmailAudit =
              ticketEmailsByRegistrationId.get(registration.id) ?? [];
            const latestTicketEmail = ticketEmailAudit[0] ?? null;
            const documentStatus = getDocumentStatus(registration.id);
            const latestSignature =
              [...documentStatus.signatures].sort(
                (left, right) =>
                  new Date(right.signed_at).getTime() -
                  new Date(left.signed_at).getTime(),
              )[0] ?? null;
            const fullName =
              `${registration.attendee_first_name} ${registration.attendee_last_name}`.trim();
            const amount = Number(
              registration.total_amount ?? registration.total_price ?? 0,
            );
            const currency = registration.currency ?? "USD";
            const attendeeRows = [
              ...(registration.event_registration_attendees ?? []),
            ].sort(
              (left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0),
            );
            const ticketsPurchased = Math.max(
              1,
              Number(registration.quantity ?? 1),
            );
            const admitsPerTicket = getTicketAdmitsPerTicket(
              registration.event_ticket_types,
            );
            const expectedAttendees = Math.max(
              1,
              ticketsPurchased * admitsPerTicket,
            );
            const issuedTicketCount = attendeeRows.filter(
              (attendee) => Boolean(attendee.ticket_code),
            ).length;
            const ticketCodesAreActive =
              isRegistrationActiveForCheckIn(registration);
            const ticketCodeStatusText = ticketCodesAreActive
              ? "Active for check-in"
              : "Not active for check-in yet";

            return (
              <div
                key={registration.id}
                className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xl font-semibold text-slate-900">
                          {fullName}
                        </h3>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            effectiveStatus,
                          )}`}
                        >
                          {effectiveStatus}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentBadgeClass(
                            registration.payment_status,
                          )}`}
                        >
                          {registration.payment_status ?? "unknown"}
                        </span>

                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {getTicketTypeName(registration.event_ticket_types)}
                        </span>

                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {kindLabel(
                            getTicketKind(registration.event_ticket_types),
                          )}
                        </span>

                        <span className="inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-200">
                          {ticketsPurchased} ticket{ticketsPurchased === 1 ? "" : "s"} •{" "}
                          admits {expectedAttendees}
                        </span>

                        {requiredDocumentRows.length ? (
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

                      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                        <span>{registration.attendee_email}</span>
                        <span>{registration.attendee_phone || "No phone"}</span>
                        <span>
                          Registered {formatDateTime(registration.created_at)}
                        </span>
                      </div>

                      {attendeeRows.length > 0 ? (
                        <details
                          className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3"
                          open={attendeeRows.length === 1}
                        >
                          <summary className="cursor-pointer text-sm font-medium text-slate-700">
                            Ticket codes & QR codes • {issuedTicketCount}/{expectedAttendees} issued
                          </summary>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {attendeeRows.map((attendee, index) => {
                              const attendeeName =
                                `${attendee.first_name ?? ""} ${attendee.last_name ?? ""}`.trim() ||
                                `Attendee ${index + 1}`;
                              const checkedInLabel = attendee.checked_in_at
                                ? `Checked in ${formatDateTime(attendee.checked_in_at)}`
                                : "Not checked in";

                              return (
                                <div
                                  key={attendee.id}
                                  className="rounded-xl border border-slate-200 bg-white p-3"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="font-medium text-slate-900">
                                        {index + 1}. {attendeeName}
                                      </p>
                                      <p className="mt-1 text-xs text-slate-500">
                                        {attendee.attendee_role === "buyer"
                                          ? "Buyer"
                                          : "Attendee"}
                                        {attendee.email
                                          ? ` • ${attendee.email}`
                                          : ""}
                                        {attendee.phone
                                          ? ` • ${attendee.phone}`
                                          : ""}
                                      </p>
                                      <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                                        <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                                          Edit attendee details
                                        </summary>
                                        <form
                                          action={updateEventRegistrationAttendeeAction}
                                          className="mt-3 grid gap-3 md:grid-cols-2"
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
                                            name="attendeeId"
                                            value={attendee.id}
                                          />

                                          <label className="text-xs font-medium text-slate-700">
                                            First name
                                            <input
                                              name="firstName"
                                              defaultValue={attendee.first_name ?? ""}
                                              required
                                              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                            />
                                          </label>

                                          <label className="text-xs font-medium text-slate-700">
                                            Last name
                                            <input
                                              name="lastName"
                                              defaultValue={attendee.last_name ?? ""}
                                              required
                                              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                            />
                                          </label>

                                          <label className="text-xs font-medium text-slate-700">
                                            Email
                                            <input
                                              name="email"
                                              type="email"
                                              defaultValue={attendee.email ?? ""}
                                              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                            />
                                          </label>

                                          <label className="text-xs font-medium text-slate-700">
                                            Phone
                                            <input
                                              name="phone"
                                              defaultValue={attendee.phone ?? ""}
                                              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                                            />
                                          </label>

                                          <div className="md:col-span-2">
                                            <button
                                              type="submit"
                                              className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                                            >
                                              Save attendee
                                            </button>
                                            <p className="mt-2 text-xs text-slate-500">
                                              This updates the attendee name/contact only. QR code and check-in status stay unchanged.
                                            </p>
                                          </div>
                                        </form>
                                      </details>
                                    </div>
                                  </div>

                                  {attendee.ticket_code ? (
                                    <div className="mt-3 space-y-3">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span
                                          className={`inline-flex rounded-lg px-2 py-1 font-mono text-xs font-semibold tracking-wide ${
                                            ticketCodesAreActive
                                              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                                              : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                                          }`}
                                        >
                                          {attendee.ticket_code}
                                        </span>
                                        <span className="text-xs text-slate-500">
                                          {ticketCodeStatusText}
                                        </span>
                                      </div>

                                      <details className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                        <summary className="cursor-pointer text-xs font-medium text-slate-700">
                                          Show QR code
                                        </summary>
                                        <div className="mt-3 flex flex-col items-center text-center">
                                          <img
                                            src={ticketQrSrc(
                                              attendee.ticket_code,
                                            )}
                                            alt={`QR code for ticket ${attendee.ticket_code}`}
                                            width={180}
                                            height={180}
                                            className="rounded-xl border border-slate-200 bg-white p-2"
                                          />
                                          <p className="mt-2 text-xs text-slate-500">
                                            Scan this QR code or enter the
                                            ticket code at check-in.
                                          </p>
                                        </div>
                                      </details>

                                      <p className="text-xs text-slate-500">
                                        {checkedInLabel}
                                      </p>
                                    </div>
                                  ) : (
                                    <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                                      No ticket code has been issued for this
                                      attendee yet.
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </details>
                      ) : (
                        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                          No QR attendee tickets have been issued yet. Expected{" "}
                          {expectedAttendees} attendee
                          {expectedAttendees === 1 ? "" : "s"} for{" "}
                          {ticketsPurchased} purchased ticket
                          {ticketsPurchased === 1 ? "" : "s"}.
                        </div>
                      )}
                    </div>

                    <div className="text-left lg:text-right">
                      <p className="text-sm text-slate-500">Amount</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">
                        {formatCurrency(amount, currency)}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">CRM Link</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {linkedClientId
                          ? getClientName(registration.clients)
                          : "Not linked"}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Check-In</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatDateTime(checkedInAt)}
                      </p>
                    </div>

                    <div
                      className={`rounded-xl border p-4 ${
                        ticketCodesAreActive
                          ? "border-emerald-200 bg-emerald-50"
                          : "border-amber-200 bg-amber-50"
                      }`}
                    >
                      <p className="text-sm text-slate-600">Ticket Codes</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {issuedTicketCount}/{expectedAttendees} QR tickets issued
                      </p>
                      <p className="mt-2 font-mono text-xs font-semibold tracking-wide text-slate-700">
                        {attendeeRows
                          .map((attendee) => attendee.ticket_code)
                          .filter(Boolean)
                          .join(", ") || "Not issued"}
                      </p>
                      <p className="mt-2 text-xs font-medium text-slate-600">
                        {attendeeRows.some((attendee) => attendee.ticket_code)
                          ? ticketCodeStatusText
                          : "Codes are issued automatically."}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Ticket Email</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {latestTicketEmail
                          ? latestTicketEmail.status === "sent" && latestTicketEmail.sent_at
                            ? `Sent ${formatDateTime(latestTicketEmail.sent_at)}`
                            : `${latestTicketEmail.status ?? "queued"} ${formatDateTime(latestTicketEmail.created_at)}`
                          : "Not sent from DanceFlow"}
                      </p>
                      {latestTicketEmail?.error_message ? (
                        <p className="mt-2 text-xs text-red-600">
                          {latestTicketEmail.error_message}
                        </p>
                      ) : latestTicketEmail?.recipient_email ? (
                        <p className="mt-2 text-xs text-slate-500">
                          To {latestTicketEmail.recipient_email}
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-slate-500">
                        {ticketEmailAudit.length} attempt
                        {ticketEmailAudit.length === 1 ? "" : "s"} recorded
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Payments Logged</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {linkedPayments.length}
                      </p>
                    </div>

                    <div
                      className={`rounded-xl border p-4 ${
                        requiredDocumentRows.length === 0
                          ? "border-slate-200 bg-slate-50"
                          : documentStatus.isComplete
                            ? "border-emerald-200 bg-emerald-50"
                            : "border-amber-200 bg-amber-50"
                      }`}
                    >
                      <p className="text-sm text-slate-600">
                        Required Documents
                      </p>
                      {requiredDocumentRows.length === 0 ? (
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

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Notes</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {registration.notes ? "Has notes" : "No notes"}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-indigo-950">
                          Ticket confirmation
                        </p>
                        <p className="mt-1 text-sm text-indigo-800">
                          Resend the confirmation email with all QR ticket codes
                          for this registration.
                        </p>
                      </div>
                      <form action={resendEventTicketConfirmationAction}>
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
                        <button
                          type="submit"
                          disabled={
                            !isRegistrationActiveForCheckIn(registration) ||
                            shouldBlockAttendanceForPayment(
                              registration.payment_status,
                            ) ||
                            !registration.attendee_email
                          }
                          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                        >
                          Resend ticket confirmation
                        </button>
                      </form>
                    </div>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-700">
                        CRM Handoff
                      </p>

                      <form
                        action={upsertEventAttendanceAction}
                        className="mt-3 space-y-3"
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

                        <div>
                          <label className="mb-1 block text-sm font-medium text-slate-700">
                            Link to Client
                          </label>
                          <select
                            name="clientId"
                            defaultValue={linkedClientId ?? ""}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2"
                          >
                            <option value="">Not linked</option>
                            {typedClients.map((client) => (
                              <option key={client.id} value={client.id}>
                                {`${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() ||
                                  client.email ||
                                  "Unnamed client"}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="mb-1 block text-sm font-medium text-slate-700">
                            Attendance Status
                          </label>
                          <select
                            name="status"
                            defaultValue={attendance?.status ?? effectiveStatus}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2"
                          >
                            <option value="registered">Registered</option>
                            <option value="checked_in">Checked In</option>
                            <option value="attended">Attended</option>
                            <option value="no_show">No Show</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                        </div>

                        <button
                          type="submit"
                          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
                        >
                          Save CRM Handoff
                        </button>
                      </form>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-700">
                        Payment Trail
                      </p>

                      {linkedPayments.length === 0 ? (
                        <p className="mt-3 text-sm text-slate-500">
                          No payments logged yet.
                        </p>
                      ) : (
                        <div className="mt-3 space-y-3">
                          {linkedPayments.map((payment) => (
                            <div
                              key={payment.id}
                              className="rounded-xl border border-slate-200 bg-white p-3"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="font-medium text-slate-900">
                                    {formatCurrency(
                                      payment.amount,
                                      payment.currency,
                                    )}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    {payment.payment_method} •{" "}
                                    {payment.source ?? "event"}
                                  </p>
                                </div>

                                <span
                                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentBadgeClass(
                                    payment.status,
                                  )}`}
                                >
                                  {payment.status}
                                </span>
                              </div>

                              {payment.refund_amount ? (
                                <p className="mt-2 text-xs text-red-600">
                                  Refunded{" "}
                                  {formatCurrency(
                                    payment.refund_amount,
                                    payment.currency,
                                  )}
                                  {payment.refunded_at
                                    ? ` • ${formatDateTime(payment.refunded_at)}`
                                    : ""}
                                </p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
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
