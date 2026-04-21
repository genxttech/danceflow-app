import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStudioFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { upsertEventAttendanceAction } from "./actions";

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
  event_ticket_type_id: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
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
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
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

type ClientOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
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
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function getClientName(
  value:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  if (!client) return "Not linked";
  return `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || "Linked client";
}

function getTicketTypeName(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.name ?? "No ticket type";
}

function getTicketKind(
  value:
    | { name: string; ticket_kind: string }
    | { name: string; ticket_kind: string }[]
    | null
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.ticket_kind ?? "other";
}

function kindLabel(value: string) {
  if (value === "general_admission") return "General Admission";
  if (value === "vip") return "VIP";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "registered") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "confirmed") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "pending") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "waitlisted") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  if (status === "checked_in") return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
  if (status === "attended") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (status === "no_show") return "bg-orange-50 text-orange-700 ring-1 ring-orange-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function paymentBadgeClass(status: string | null) {
  if (status === "paid") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "pending") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "partial") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "refunded") return "bg-red-50 text-red-700 ring-1 ring-red-200";
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

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "attendance_updated") {
    return {
      kind: "success" as const,
      message: "Attendance and CRM handoff updated.",
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
  await requireStudioFeature("organizer_tools");

  const { id } = await params;
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
    { data: registrations, error: registrationsError },
    { data: attendanceRows, error: attendanceError },
    { data: paymentRows, error: paymentError },
    { data: clients, error: clientsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("events")
      .select(`
        id,
        name,
        slug,
        status,
        visibility,
        organizers ( name, slug )
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("event_registrations")
      .select(`
        id,
        client_id,
        event_ticket_type_id,
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        status,
        payment_status,
        total_amount,
        total_price,
        currency,
        checked_in_at,
        notes,
        created_at,
        clients ( id, first_name, last_name ),
        event_ticket_types ( name, ticket_kind )
      `)
      .eq("event_id", id)
      .order("created_at", { ascending: true }),

    supabase
      .from("attendance_records")
      .select(`
        id,
        event_registration_id,
        client_id,
        status,
        checked_in_at
      `)
      .eq("studio_id", studioId),

    supabase
      .from("event_payments")
      .select(`
        id,
        registration_id,
        amount,
        currency,
        payment_method,
        status,
        refund_amount,
        refunded_at,
        source
      `),

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
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  if (attendanceError) {
    throw new Error(`Failed to load attendance records: ${attendanceError.message}`);
  }

  if (paymentError) {
    throw new Error(`Failed to load payments: ${paymentError.message}`);
  }

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  const typedEvent = event as EventRow;
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedAttendanceRows = (attendanceRows ?? []) as AttendanceRow[];
  const typedPaymentRows = (paymentRows ?? []) as PaymentRow[];
  const typedClients = (clients ?? []) as ClientOption[];
  const organizer = getOrganizer(typedEvent.organizers);
  const organizerWorkspace = isOrganizerWorkspaceName(workspace?.name);

  const attendanceByRegistrationId = new Map(
    typedAttendanceRows.map((row) => [row.event_registration_id, row])
  );

  const paymentsByRegistrationId = new Map<string, PaymentRow[]>();
  for (const payment of typedPaymentRows) {
    const current = paymentsByRegistrationId.get(payment.registration_id) ?? [];
    current.push(payment);
    paymentsByRegistrationId.set(payment.registration_id, current);
  }

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
    if (activeFilter === "checked_in") return status === "checked_in" || status === "attended";
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
    (registration) => getEffectiveStatus(registration) === "registered"
  ).length;
  const checkedInCount = typedRegistrations.filter((registration) => {
    const status = getEffectiveStatus(registration);
    return status === "checked_in" || status === "attended";
  }).length;
  const waitlistCount = typedRegistrations.filter(
    (registration) => getEffectiveStatus(registration) === "waitlisted"
  ).length;
  const paidCount = typedRegistrations.filter(
    (registration) => registration.payment_status === "paid"
  ).length;
  const linkedCount = typedRegistrations.filter((registration) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    return Boolean(attendance?.client_id ?? registration.client_id);
  }).length;

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
                {organizerWorkspace ? "DanceFlow Organizer Registrations" : "DanceFlow Event Registrations"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Registrations
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                {typedEvent.name}
              </p>
              <p className="mt-2 text-sm text-white/75">
                Organizer: {organizer?.name ?? "Unknown"} • /events/{typedEvent.slug}
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
                Check-In Mode
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
              Organizer registration operations
            </h2>
            <p className="mt-2 text-sm leading-7 text-sky-900">
              Manage payment status, CRM handoff, attendance progression, and event-day registration flow from one place.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{totalRegistrations}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Confirmed</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{confirmedCount}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Checked In</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{checkedInCount}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Paid</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{paidCount}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Linked to CRM</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{linkedCount}</p>
          <p className="mt-2 text-sm text-slate-500">{waitlistCount} waitlisted</p>
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
            <p className="text-base font-medium text-slate-900">No registrations found</p>
            <p className="mt-2 text-sm text-slate-500">
              Try a different filter or wait for new registrations to come in.
            </p>
          </div>
        ) : (
          filteredRegistrations.map((registration) => {
            const attendance = attendanceByRegistrationId.get(registration.id) ?? null;
            const effectiveStatus = getEffectiveStatus(registration);
            const checkedInAt = attendance?.checked_in_at ?? registration.checked_in_at;
            const linkedClientId = attendance?.client_id ?? registration.client_id;
            const linkedPayments = paymentsByRegistrationId.get(registration.id) ?? [];
            const fullName =
              `${registration.attendee_first_name} ${registration.attendee_last_name}`.trim();
            const amount =
              Number(registration.total_amount ?? registration.total_price ?? 0);
            const currency = registration.currency ?? "USD";

            return (
              <div
                key={registration.id}
                className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xl font-semibold text-slate-900">{fullName}</h3>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            effectiveStatus
                          )}`}
                        >
                          {effectiveStatus}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentBadgeClass(
                            registration.payment_status
                          )}`}
                        >
                          {registration.payment_status ?? "unknown"}
                        </span>

                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {getTicketTypeName(registration.event_ticket_types)}
                        </span>

                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {kindLabel(getTicketKind(registration.event_ticket_types))}
                        </span>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                        <span>{registration.attendee_email}</span>
                        <span>{registration.attendee_phone || "No phone"}</span>
                        <span>Registered {formatDateTime(registration.created_at)}</span>
                      </div>
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
                        {linkedClientId ? getClientName(registration.clients) : "Not linked"}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Check-In</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatDateTime(checkedInAt)}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Payments Logged</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {linkedPayments.length}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Notes</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {registration.notes ? "Has notes" : "No notes"}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-700">CRM Handoff</p>

                      <form action={upsertEventAttendanceAction} className="mt-3 space-y-3">
                        <input type="hidden" name="eventId" value={typedEvent.id} />
                        <input type="hidden" name="registrationId" value={registration.id} />

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
                      <p className="text-sm font-medium text-slate-700">Payment Trail</p>

                      {linkedPayments.length === 0 ? (
                        <p className="mt-3 text-sm text-slate-500">No payments logged yet.</p>
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
                                    {formatCurrency(payment.amount, payment.currency)}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    {payment.payment_method} • {payment.source ?? "event"}
                                  </p>
                                </div>

                                <span
                                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentBadgeClass(
                                    payment.status
                                  )}`}
                                >
                                  {payment.status}
                                </span>
                              </div>

                              {payment.refund_amount ? (
                                <p className="mt-2 text-xs text-red-600">
                                  Refunded {formatCurrency(payment.refund_amount, payment.currency)}
                                  {payment.refunded_at ? ` • ${formatDateTime(payment.refunded_at)}` : ""}
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