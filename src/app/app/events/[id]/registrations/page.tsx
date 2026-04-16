import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStudioFeature } from "@/lib/billing/access";
import {
  cancelEventRegistrationAction,
  checkInEventRegistrationAction,
  confirmEventRegistrationAction,
  createLeadFromRegistrationAction,
  linkEventRegistrationToClientAction,
  markEventRegistrationAttendedAction,
  markEventRegistrationPaidAction,
  refundEventRegistrationAction,
} from "./actions";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
  clientId?: string;
}>;

type EventRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  capacity: number | null;
  waitlist_enabled: boolean;
  organizers:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null;
};

type RegistrationRow = {
  id: string;
  client_id: string | null;
  attendee_first_name: string;
  attendee_last_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  quantity: number;
  unit_price: number | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
  status: string;
  payment_status: string | null;
  registration_source: string | null;
  source: string | null;
  notes: string | null;
  created_at: string;
  checked_in_at: string | null;
  promoted_from_waitlist_at: string | null;
  event_ticket_types:
    | { name: string | null }
    | { name: string | null }[]
    | null;
};

type AttendanceRow = {
  id: string;
  event_registration_id: string;
  client_id: string | null;
  status: string;
  checked_in_at: string | null;
  marked_attended_at: string | null;
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
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
};

function getOrganizer(
  value:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function getTicketName(
  value:
    | { name: string | null }
    | { name: string | null }[]
    | null
) {
  const ticket = Array.isArray(value) ? value[0] : value;
  return ticket?.name ?? "No ticket type";
}

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
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

function registrationStatusLabel(value: string) {
  if (value === "confirmed") return "Confirmed";
  if (value === "waitlisted") return "Waitlisted";
  if (value === "cancelled") return "Cancelled";
  if (value === "refunded") return "Refunded";
  if (value === "pending") return "Pending";
  if (value === "attended") return "Attended";
  if (value === "checked_in") return "Checked In";
  return value.replaceAll("_", " ");
}

function paymentStatusLabel(value: string | null) {
  if (!value) return "—";
  if (value === "paid") return "Paid";
  if (value === "pending") return "Pending";
  if (value === "refunded") return "Refunded";
  if (value === "partial") return "Partial Refund";
  return value.replaceAll("_", " ");
}

function statusBadgeClass(status: string) {
  if (status === "confirmed") return "bg-green-50 text-green-700";
  if (status === "paid") return "bg-green-50 text-green-700";
  if (status === "checked_in") return "bg-blue-50 text-blue-700";
  if (status === "attended") return "bg-emerald-50 text-emerald-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  if (status === "waitlisted") return "bg-purple-50 text-purple-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "refunded") return "bg-slate-100 text-slate-700";
  if (status === "partial") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function registrationSourceLabel(value: string | null) {
  if (value === "public_registration") return "Public Registration";
  if (value === "admin") return "Admin";
  if (value === "waitlist") return "Waitlist";
  return value?.replaceAll("_", " ") ?? "Unknown";
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "confirmed") {
    return { kind: "success" as const, message: "Registration confirmed." };
  }
  if (search.success === "cancelled") {
    return { kind: "success" as const, message: "Registration cancelled." };
  }
  if (search.success === "checked_in") {
    return { kind: "success" as const, message: "Registrant checked in." };
  }
  if (search.success === "attended") {
    return { kind: "success" as const, message: "Registrant marked attended." };
  }
  if (search.success === "payment_updated") {
    return { kind: "success" as const, message: "Payment status updated." };
  }
  if (search.success === "refunded") {
    return { kind: "success" as const, message: "Registration refunded." };
  }
  if (search.success === "linked_client") {
    return {
      kind: "success" as const,
      message: "Registration linked to existing client.",
    };
  }
  if (search.success === "linked_existing_client") {
    return {
      kind: "success" as const,
      message: "Matched and linked to existing client by email.",
    };
  }
  if (search.success === "already_linked") {
    return {
      kind: "success" as const,
      message: "Registration was already linked to a client.",
    };
  }
  if (search.success === "lead_created") {
    return {
      kind: "success" as const,
      message: "Lead created from registration and linked into CRM.",
    };
  }

  if (search.error === "registration_not_found") {
    return { kind: "error" as const, message: "Registration not found." };
  }
  if (search.error === "client_not_found") {
    return { kind: "error" as const, message: "Client not found." };
  }
  if (search.error === "possible_duplicate_client") {
    return {
      kind: "error" as const,
      message:
        "Possible duplicate client found. Review manually before creating a new lead.",
    };
  }
  if (search.error === "lead_create_failed") {
    return {
      kind: "error" as const,
      message: "Could not create CRM lead from this registration.",
    };
  }
  if (search.error === "lead_activity_failed") {
    return {
      kind: "error" as const,
      message: "Lead was created, but follow-up activity could not be recorded.",
    };
  }
  if (search.error === "checkin_failed") {
    return { kind: "error" as const, message: "Could not check in registrant." };
  }
  if (search.error === "attended_failed") {
    return {
      kind: "error" as const,
      message: "Could not mark registrant attended.",
    };
  }
  if (search.error === "cannot_check_in_unpaid") {
    return {
      kind: "error" as const,
      message: "Cannot check in an unpaid registration.",
    };
  }
  if (search.error === "cannot_check_in_cancelled") {
    return {
      kind: "error" as const,
      message: "Cannot check in a cancelled registration.",
    };
  }
  if (search.error === "cannot_attend_cancelled") {
    return {
      kind: "error" as const,
      message: "Cannot mark a cancelled registration attended.",
    };
  }
  if (search.error === "confirm_failed") {
    return { kind: "error" as const, message: "Could not confirm registration." };
  }
  if (search.error === "cancel_failed") {
    return { kind: "error" as const, message: "Could not cancel registration." };
  }
  if (search.error === "payment_update_failed") {
    return { kind: "error" as const, message: "Could not update payment." };
  }
  if (search.error === "refund_failed") {
    return { kind: "error" as const, message: "Could not refund registration." };
  }
  if (search.error === "link_client_failed") {
    return {
      kind: "error" as const,
      message: "Could not link registration to client.",
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
  await requireStudioFeature("ticketing");

  const { id } = await params;
  const query = await searchParams;
  const banner = getBanner(query);
  const requestedClientId =
    typeof query.clientId === "string" ? query.clientId : "";

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    redirect("/login");
  }

  const studioId = roleRow.studio_id as string;

  const [
    { data: event, error: eventError },
    { data: registrations, error: registrationsError },
    { data: attendanceRows, error: attendanceError },
    { data: paymentRows, error: paymentError },
    { data: clients, error: clientsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select(`
        id,
        name,
        slug,
        status,
        visibility,
        capacity,
        waitlist_enabled,
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
        attendee_first_name,
        attendee_last_name,
        attendee_email,
        attendee_phone,
        quantity,
        unit_price,
        total_price,
        total_amount,
        currency,
        status,
        payment_status,
        registration_source,
        source,
        notes,
        created_at,
        checked_in_at,
        promoted_from_waitlist_at,
        event_ticket_types ( name )
      `)
      .eq("event_id", id)
      .order("created_at", { ascending: false }),

    supabase
      .from("attendance_records")
      .select(`
        id,
        event_registration_id,
        client_id,
        status,
        checked_in_at,
        marked_attended_at
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
      .select(`
        id,
        first_name,
        last_name,
        email,
        phone,
        status
      `)
      .eq("studio_id", studioId)
      .neq("status", "archived")
      .order("first_name", { ascending: true }),
  ]);

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
    throw new Error(`Failed to load event payments: ${paymentError.message}`);
  }

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  const typedEvent = event as EventRow;
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedAttendance = (attendanceRows ?? []) as AttendanceRow[];
  const typedPayments = (paymentRows ?? []) as PaymentRow[];
  const typedClients = ((clients ?? []) as ClientOption[]).filter(
    (client) => client.status !== "archived"
  );
  const organizer = getOrganizer(typedEvent.organizers);

  const selectedClient =
    typedClients.find((client) => client.id === requestedClientId) ?? null;
  const validInitialClientId = selectedClient?.id ?? "";

  const attendanceByRegistrationId = new Map(
    typedAttendance.map((row) => [row.event_registration_id, row])
  );

  const paymentsByRegistrationId = new Map<string, PaymentRow[]>();
  for (const payment of typedPayments) {
    const current = paymentsByRegistrationId.get(payment.registration_id) ?? [];
    current.push(payment);
    paymentsByRegistrationId.set(payment.registration_id, current);
  }

  const totalRegistrations = typedRegistrations.length;
  const confirmedCount = typedRegistrations.filter(
    (row) => row.status === "confirmed"
  ).length;
  const waitlistCount = typedRegistrations.filter(
    (row) => row.status === "waitlisted"
  ).length;
  const paidCount = typedRegistrations.filter(
    (row) => row.payment_status === "paid"
  ).length;
  const linkedCount = typedRegistrations.filter((row) => !!row.client_id).length;

  return (
    <div className="space-y-8">
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

      {selectedClient ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-medium text-emerald-800">
                CRM handoff client
              </p>
              <p className="text-lg font-semibold text-emerald-950">
                {selectedClient.first_name} {selectedClient.last_name}
              </p>
              {selectedClient.email ? (
                <p className="text-sm text-emerald-800">{selectedClient.email}</p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href={`/app/clients/${selectedClient.id}`}
                className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100"
              >
                View Client
              </Link>
              <Link
                href={`/app/events/${typedEvent.id}/registrations`}
                className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100"
              >
                Clear Selection
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">
              {organizer?.name ?? "Organizer"}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
              Registrations
            </h1>
            <p className="mt-2 text-slate-600">{typedEvent.name}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/app/events/${typedEvent.id}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Event
            </Link>

            <Link
              href={`/events/${typedEvent.slug}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Public Event Page
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold">{totalRegistrations}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Confirmed</p>
          <p className="mt-2 text-3xl font-semibold">{confirmedCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Paid</p>
          <p className="mt-2 text-3xl font-semibold">{paidCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Linked to CRM</p>
          <p className="mt-2 text-3xl font-semibold">{linkedCount}</p>
        </div>
      </div>

      <div className="space-y-6">
        {typedRegistrations.length === 0 ? (
          <div className="rounded-2xl border bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-base font-medium text-slate-900">
              No registrations yet
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Registrations will appear here as attendees sign up.
            </p>
          </div>
        ) : (
          typedRegistrations.map((registration) => {
            const attendance = attendanceByRegistrationId.get(registration.id);
            const payments = paymentsByRegistrationId.get(registration.id) ?? [];
            const clientLinked = !!registration.client_id;
            const canCreateLead =
              !clientLinked &&
              registration.status !== "cancelled" &&
              registration.attendee_first_name &&
              registration.attendee_last_name &&
              registration.attendee_email;

            return (
              <div
                key={registration.id}
                className="rounded-2xl border bg-white p-6 shadow-sm"
              >
                <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-semibold text-slate-900">
                        {registration.attendee_first_name}{" "}
                        {registration.attendee_last_name}
                      </h3>

                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                          registration.status
                        )}`}
                      >
                        {registrationStatusLabel(registration.status)}
                      </span>

                      {registration.payment_status ? (
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            registration.payment_status
                          )}`}
                        >
                          {paymentStatusLabel(registration.payment_status)}
                        </span>
                      ) : null}

                      {attendance?.status ? (
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            attendance.status
                          )}`}
                        >
                          Attendance: {registrationStatusLabel(attendance.status)}
                        </span>
                      ) : null}

                      {clientLinked ? (
                        <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                          Linked to CRM
                        </span>
                      ) : null}

                      {registration.promoted_from_waitlist_at ? (
                        <span className="inline-flex rounded-full bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700">
                          Promoted from Waitlist
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Ticket</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {getTicketName(registration.event_ticket_types)}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Amount</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatCurrency(
                            Number(
                              registration.total_amount ??
                                registration.total_price ??
                                registration.unit_price ??
                                0
                            ),
                            registration.currency ?? "USD"
                          )}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Quantity</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {registration.quantity}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Created</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(registration.created_at)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Email</p>
                        <p className="mt-1 break-all font-medium text-slate-900">
                          {registration.attendee_email}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Phone</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {registration.attendee_phone ?? "—"}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">
                          Registration Source
                        </p>
                        <p className="mt-1 font-medium text-slate-900">
                          {registrationSourceLabel(
                            registration.registration_source ??
                              registration.source
                          )}
                        </p>
                      </div>

                      <div className="rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Checked In</p>
                        <p className="mt-1 font-medium text-slate-900">
                          {formatDateTime(
                            registration.checked_in_at ??
                              attendance?.checked_in_at ??
                              null
                          )}
                        </p>
                      </div>
                    </div>

                    {registration.notes ? (
                      <div className="mt-4 rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Notes</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                          {registration.notes}
                        </p>
                      </div>
                    ) : null}

                    {payments.length > 0 ? (
                      <div className="mt-4 rounded-xl border bg-slate-50 p-4">
                        <p className="text-sm text-slate-500">Payments</p>
                        <div className="mt-3 space-y-2">
                          {payments.map((payment) => (
                            <div
                              key={payment.id}
                              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusBadgeClass(
                                    payment.status
                                  )}`}
                                >
                                  {paymentStatusLabel(payment.status)}
                                </span>
                                <span className="text-sm text-slate-600">
                                  {payment.payment_method.replaceAll("_", " ")}
                                </span>
                                <span className="text-sm text-slate-500">
                                  {payment.source ?? "manual"}
                                </span>
                              </div>

                              <div className="text-sm font-medium text-slate-900">
                                {formatCurrency(
                                  payment.amount,
                                  payment.currency ?? "USD"
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="w-full max-w-xl space-y-4 xl:w-[420px] xl:min-w-[420px]">
                    <div className="rounded-2xl border bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-900">
                        Registration Actions
                      </p>

                      <div className="mt-4 flex flex-wrap gap-3">
                        <form action={confirmEventRegistrationAction}>
                          <input type="hidden" name="eventId" value={typedEvent.id} />
                          <input
                            type="hidden"
                            name="registrationId"
                            value={registration.id}
                          />
                          <button
                            type="submit"
                            className="rounded-xl border px-3 py-2 text-sm hover:bg-white"
                          >
                            Confirm
                          </button>
                        </form>

                        <form action={checkInEventRegistrationAction}>
                          <input type="hidden" name="eventId" value={typedEvent.id} />
                          <input
                            type="hidden"
                            name="registrationId"
                            value={registration.id}
                          />
                          <button
                            type="submit"
                            className="rounded-xl border px-3 py-2 text-sm hover:bg-white"
                          >
                            Check In
                          </button>
                        </form>

                        <form action={markEventRegistrationAttendedAction}>
                          <input type="hidden" name="eventId" value={typedEvent.id} />
                          <input
                            type="hidden"
                            name="registrationId"
                            value={registration.id}
                          />
                          <button
                            type="submit"
                            className="rounded-xl border px-3 py-2 text-sm hover:bg-white"
                          >
                            Mark Attended
                          </button>
                        </form>

                        <form action={markEventRegistrationPaidAction}>
                          <input type="hidden" name="eventId" value={typedEvent.id} />
                          <input
                            type="hidden"
                            name="registrationId"
                            value={registration.id}
                          />
                          <button
                            type="submit"
                            className="rounded-xl border px-3 py-2 text-sm hover:bg-white"
                          >
                            Mark Paid
                          </button>
                        </form>

                        <form action={refundEventRegistrationAction}>
                          <input type="hidden" name="eventId" value={typedEvent.id} />
                          <input
                            type="hidden"
                            name="registrationId"
                            value={registration.id}
                          />
                          <button
                            type="submit"
                            className="rounded-xl border px-3 py-2 text-sm hover:bg-white"
                          >
                            Refund
                          </button>
                        </form>

                        <form action={cancelEventRegistrationAction}>
                          <input type="hidden" name="eventId" value={typedEvent.id} />
                          <input
                            type="hidden"
                            name="registrationId"
                            value={registration.id}
                          />
                          <button
                            type="submit"
                            className="rounded-xl border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                          >
                            Cancel
                          </button>
                        </form>
                      </div>
                    </div>

                    <div className="rounded-2xl border bg-slate-50 p-4">
                      <p className="text-sm font-medium text-slate-900">CRM Handoff</p>

                      {clientLinked ? (
                        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
                          This registration is already linked to a CRM record.
                        </div>
                      ) : (
                        <div className="mt-4 space-y-4">
                          <form
                            action={linkEventRegistrationToClientAction}
                            className="space-y-3 rounded-xl border bg-white p-4"
                          >
                            <input type="hidden" name="eventId" value={typedEvent.id} />
                            <input
                              type="hidden"
                              name="registrationId"
                              value={registration.id}
                            />

                            <div>
                              <label className="mb-1 block text-sm font-medium text-slate-700">
                                Link to Existing Client
                              </label>
                              <select
                                name="clientId"
                                required
                                defaultValue={validInitialClientId}
                                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                              >
                                <option value="">Select client</option>
                                {typedClients.map((client) => (
                                  <option key={client.id} value={client.id}>
                                    {client.first_name} {client.last_name}
                                    {client.email ? ` — ${client.email}` : ""}
                                    {client.status ? ` (${client.status})` : ""}
                                  </option>
                                ))}
                              </select>
                              {selectedClient ? (
                                <p className="mt-1 text-xs text-emerald-700">
                                  Preselected from CRM handoff.
                                </p>
                              ) : null}
                            </div>

                            <button
                              type="submit"
                              className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
                            >
                              Link Existing Client
                            </button>
                          </form>

                          {canCreateLead ? (
                            <form
                              action={createLeadFromRegistrationAction}
                              className="space-y-4 rounded-xl border bg-white p-4"
                            >
                              <input type="hidden" name="eventId" value={typedEvent.id} />
                              <input
                                type="hidden"
                                name="registrationId"
                                value={registration.id}
                              />

                              <div>
                                <p className="text-sm font-medium text-slate-700">
                                  Create Lead in CRM
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                  This will create a lead, link the registration,
                                  and optionally add a follow-up task.
                                </p>
                              </div>

                              <div className="grid gap-3 md:grid-cols-2">
                                <div>
                                  <label className="mb-1 block text-sm font-medium text-slate-700">
                                    Follow-Up Date
                                  </label>
                                  <input
                                    type="date"
                                    name="followUpDate"
                                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                  />
                                </div>

                                <div>
                                  <label className="mb-1 block text-sm font-medium text-slate-700">
                                    Follow-Up Time
                                  </label>
                                  <input
                                    type="time"
                                    name="followUpTime"
                                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                  />
                                </div>
                              </div>

                              <div>
                                <label className="mb-1 block text-sm font-medium text-slate-700">
                                  Follow-Up Note
                                </label>
                                <textarea
                                  name="followUpNote"
                                  rows={3}
                                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                  placeholder="Optional note for the CRM follow-up task"
                                />
                              </div>

                              <button
                                type="submit"
                                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700"
                              >
                                Create Lead in CRM
                              </button>
                            </form>
                          ) : (
                            <div className="rounded-xl border border-slate-200 bg-slate-100 p-4 text-sm text-slate-600">
                              Lead creation is unavailable for this registration.
                            </div>
                          )}
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

      {waitlistCount > 0 && typedEvent.waitlist_enabled ? (
        <div className="rounded-2xl border border-purple-200 bg-purple-50 p-5 text-sm text-purple-800">
          There are currently {waitlistCount} waitlisted registrations for this
          event.
        </div>
      ) : null}
    </div>
  );
}