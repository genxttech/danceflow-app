import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireStudioFeature } from "@/lib/billing/access";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type Params = Promise<{
  id: string;
}>;

type EventRow = {
  id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  event_type: string;
  short_description: string | null;
  description: string | null;
  public_summary: string | null;
  public_description: string | null;
  venue_name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  cover_image_url: string | null;
  public_cover_image_url: string | null;
  visibility: string;
  featured: boolean;
  beginner_friendly: boolean;
  public_directory_enabled: boolean;
  status: string;
  registration_required: boolean;
  account_required_for_registration: boolean;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  capacity: number | null;
  waitlist_enabled: boolean;
  refund_policy: string | null;
  faq: string | null;
  created_at: string;
  updated_at: string;
  organizers:
    | { id?: string; name: string; slug: string }
    | { id?: string; name: string; slug: string }[]
    | null;
};

type EventTagRow = {
  id: string;
  tag: string;
};

type RegistrationSummaryRow = {
  id: string;
  client_id: string | null;
  status: string;
  payment_status: string | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
};

type AttendanceSummaryRow = {
  id: string;
  event_registration_id: string;
  client_id: string | null;
  status: string;
};

type PaymentSummaryRow = {
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

type TicketTypeSummaryRow = {
  id: string;
  name: string;
  price: number;
  currency: string;
  capacity: number | null;
  active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
};

type TicketRegistrationSummaryRow = {
  ticket_type_id: string | null;
  status: string;
};

function eventTypeLabel(value: string) {
  if (value === "group_class") return "Group Class";
  if (value === "practice_party") return "Practice Party";
  if (value === "workshop") return "Workshop";
  if (value === "social_dance") return "Social Dance";
  if (value === "competition") return "Competition";
  if (value === "showcase") return "Showcase";
  if (value === "festival") return "Festival";
  if (value === "special_event") return "Special Event";
  if (value === "other") return "Other";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function eventTypeBadgeClass(value: string) {
  if (value === "group_class") return "bg-blue-50 text-blue-700";
  if (value === "practice_party") return "bg-amber-50 text-amber-700";
  if (value === "workshop") return "bg-violet-50 text-violet-700";
  if (value === "social_dance") return "bg-emerald-50 text-emerald-700";
  if (value === "competition") return "bg-red-50 text-red-700";
  if (value === "showcase") return "bg-fuchsia-50 text-fuchsia-700";
  if (value === "festival") return "bg-cyan-50 text-cyan-700";
  if (value === "special_event") return "bg-orange-50 text-orange-700";
  return "bg-slate-100 text-slate-700";
}

function statusBadgeClass(status: string) {
  if (status === "published" || status === "open") return "bg-green-50 text-green-700";
  if (status === "draft") return "bg-amber-50 text-amber-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "completed") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function visibilityLabel(value: string) {
  if (value === "public") return "Public";
  if (value === "unlisted") return "Unlisted";
  if (value === "private") return "Private";
  return value;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
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

function formatTimeRange(startTime: string | null, endTime: string | null) {
  if (!startTime && !endTime) return "Time not set";
  if (!startTime || !endTime) return startTime || endTime || "Time not set";

  const start = new Date(`2000-01-01T${startTime}`);
  const end = new Date(`2000-01-01T${endTime}`);

  const startText = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const endText = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${startText} - ${endText}`;
}

function getOrganizer(value: EventRow["organizers"]) {
  return Array.isArray(value) ? value[0] : value;
}

function registrationLabel(eventType: string) {
  return eventType === "group_class" ? "Enrollment" : "Registration";
}

function registrationRequiredLabel(eventType: string, registrationRequired: boolean) {
  if (eventType === "group_class") {
    return registrationRequired ? "Required" : "Optional";
  }
  return registrationRequired ? "Required" : "Optional";
}

function eventUsageHint(eventType: string, visibility: string) {
  const visibilityHint =
    visibility === "public"
      ? "Shown in public offerings."
      : visibility === "unlisted"
        ? "Available by direct link only."
        : "Internal/private only.";

  if (eventType === "group_class") {
    return `This class is managed as an event. ${visibilityHint}`;
  }

  if (eventType === "practice_party") {
    return `This practice party is managed as an event. ${visibilityHint}`;
  }

  return visibilityHint;
}

function fmtCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function ticketWindowState(ticket: TicketTypeSummaryRow) {
  const now = Date.now();

  if (!ticket.active) {
    return {
      label: "Inactive",
      className: "bg-slate-100 text-slate-700",
    };
  }

  if (ticket.sale_starts_at && new Date(ticket.sale_starts_at).getTime() > now) {
    return {
      label: "Scheduled",
      className: "bg-blue-50 text-blue-700",
    };
  }

  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) {
    return {
      label: "Ended",
      className: "bg-slate-100 text-slate-700",
    };
  }

  return {
    label: "On Sale",
    className: "bg-green-50 text-green-700",
  };
}

export default async function EventDetailPage({
  params,
}: {
  params: Params;
}) {
  await requireStudioFeature("organizer_tools");

  const { id } = await params;
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
    { data: event, error: eventError },
    { data: tags, error: tagsError },
    { data: registrations, error: registrationsError },
    { data: ticketTypes, error: ticketTypesError },
    { data: ticketRegistrations, error: ticketRegistrationsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select(`
        id,
        organizer_id,
        name,
        slug,
        event_type,
        short_description,
        description,
        public_summary,
        public_description,
        venue_name,
        address_line_1,
        address_line_2,
        city,
        state,
        postal_code,
        timezone,
        start_date,
        end_date,
        start_time,
        end_time,
        cover_image_url,
        public_cover_image_url,
        visibility,
        featured,
        beginner_friendly,
        public_directory_enabled,
        status,
        registration_required,
        account_required_for_registration,
        registration_opens_at,
        registration_closes_at,
        capacity,
        waitlist_enabled,
        refund_policy,
        faq,
        created_at,
        updated_at,
        organizers ( id, name, slug )
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("event_tags")
      .select("id, tag")
      .eq("event_id", id)
      .order("tag", { ascending: true }),

    supabase
      .from("event_registrations")
      .select(`
        id,
        client_id,
        status,
        payment_status,
        total_price,
        total_amount,
        currency
      `)
      .eq("event_id", id),

    supabase
      .from("event_ticket_types")
      .select(`
        id,
        name,
        price,
        currency,
        capacity,
        active,
        sale_starts_at,
        sale_ends_at
      `)
      .eq("event_id", id)
      .order("price", { ascending: true })
      .order("name", { ascending: true }),

    supabase
      .from("event_registrations")
      .select(`
        ticket_type_id,
        status
      `)
      .eq("event_id", id)
      .not("status", "in", "(cancelled,waitlisted)"),
  ]);

  if (eventError || !event) {
    notFound();
  }

  if (tagsError) {
    throw new Error(`Failed to load event tags: ${tagsError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load event registration summary: ${registrationsError.message}`);
  }

  if (ticketTypesError) {
    throw new Error(`Failed to load event ticket summary: ${ticketTypesError.message}`);
  }

  if (ticketRegistrationsError) {
    throw new Error(`Failed to load ticket registration counts: ${ticketRegistrationsError.message}`);
  }

  const typedEvent = event as EventRow;
  const typedTags = (tags ?? []) as EventTagRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationSummaryRow[];
  const typedTicketTypes = (ticketTypes ?? []) as TicketTypeSummaryRow[];
  const typedTicketRegistrations = (ticketRegistrations ?? []) as TicketRegistrationSummaryRow[];
  const organizer = getOrganizer(typedEvent.organizers);

  const registrationIds = typedRegistrations.map((row) => row.id);

  let typedAttendance: AttendanceSummaryRow[] = [];
  let typedPayments: PaymentSummaryRow[] = [];

  if (registrationIds.length > 0) {
    const [{ data: attendanceRows, error: attendanceError }, { data: paymentRows, error: paymentError }] =
      await Promise.all([
        supabase
          .from("attendance_records")
          .select(`
            id,
            event_registration_id,
            client_id,
            status
          `)
          .eq("studio_id", studioId)
          .in("event_registration_id", registrationIds),

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
          `)
          .in("registration_id", registrationIds),
      ]);

    if (attendanceError) {
      throw new Error(`Failed to load attendance summary: ${attendanceError.message}`);
    }

    if (paymentError) {
      throw new Error(`Failed to load payment summary: ${paymentError.message}`);
    }

    typedAttendance = (attendanceRows ?? []) as AttendanceSummaryRow[];
    typedPayments = (paymentRows ?? []) as PaymentSummaryRow[];
  }

  const attendanceByRegistrationId = new Map(
    typedAttendance.map((row) => [row.event_registration_id, row])
  );

  const paymentsByRegistrationId = new Map<string, PaymentSummaryRow[]>();
  for (const payment of typedPayments) {
    const current = paymentsByRegistrationId.get(payment.registration_id) ?? [];
    current.push(payment);
    paymentsByRegistrationId.set(payment.registration_id, current);
  }

  const totalRegistrations = typedRegistrations.length;
  const checkedInCount = typedRegistrations.filter((registration) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    return attendance?.status === "checked_in" || attendance?.status === "attended";
  }).length;
  const attendedCount = typedRegistrations.filter((registration) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    return attendance?.status === "attended";
  }).length;
  const linkedToCrmCount = typedRegistrations.filter((registration) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    return Boolean(attendance?.client_id ?? registration.client_id);
  }).length;
  const unlinkedToCrmCount = totalRegistrations - linkedToCrmCount;
  const cancelledCount = typedRegistrations.filter((registration) => {
    const attendance = attendanceByRegistrationId.get(registration.id);
    return attendance?.status === "cancelled" || registration.status === "cancelled";
  }).length;

  const paidCount = typedRegistrations.filter((registration) => registration.payment_status === "paid").length;
  const pendingPaymentCount = typedRegistrations.filter(
    (registration) => registration.payment_status === "pending"
  ).length;
  const refundedCount = typedRegistrations.filter(
    (registration) =>
      registration.payment_status === "refunded" || registration.payment_status === "partial"
  ).length;

  const defaultCurrency =
    typedRegistrations.find((row) => row.currency)?.currency ?? "USD";

  const grossRevenue = typedRegistrations.reduce((sum, registration) => {
    if (registration.payment_status !== "paid" && registration.payment_status !== "partial") {
      return sum;
    }
    return sum + Number(registration.total_amount ?? registration.total_price ?? 0);
  }, 0);

  const refundedAmount = typedPayments.reduce((sum, payment) => {
    return sum + Number(payment.refund_amount ?? 0);
  }, 0);

  const netCollected = Math.max(grossRevenue - refundedAmount, 0);

  const remainingCapacity =
    typedEvent.capacity == null ? null : Math.max(typedEvent.capacity - totalRegistrations, 0);

  const publicDirectoryReady =
    typedEvent.public_directory_enabled &&
    typedEvent.visibility === "public" &&
    (typedEvent.status === "published" || typedEvent.status === "open") &&
    Boolean(typedEvent.organizer_id);

  const ticketCount = typedTicketTypes.length;
  const activeTicketCount = typedTicketTypes.filter((ticket) => ticket.active).length;
  const publicTicketCount = typedTicketTypes.filter((ticket) => ticket.active).length;

  const ticketRegistrationsById = new Map<string, number>();
  for (const row of typedTicketRegistrations) {
    if (!row.ticket_type_id) continue;
    ticketRegistrationsById.set(
      row.ticket_type_id,
      (ticketRegistrationsById.get(row.ticket_type_id) ?? 0) + 1
    );
  }

  const ticketReadiness =
    typedEvent.registration_required &&
    typedEvent.visibility !== "private" &&
    typedEvent.status !== "draft" &&
    activeTicketCount > 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-3xl font-semibold tracking-tight">{typedEvent.name}</h2>

            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                typedEvent.status
              )}`}
            >
              {typedEvent.status}
            </span>

            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${eventTypeBadgeClass(
                typedEvent.event_type
              )}`}
            >
              {eventTypeLabel(typedEvent.event_type)}
            </span>

            <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
              {visibilityLabel(typedEvent.visibility)}
            </span>

            {typedEvent.featured ? (
              <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                Featured
              </span>
            ) : null}

            {typedEvent.public_directory_enabled ? (
              <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                Public Directory On
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                Public Directory Off
              </span>
            )}

            {typedEvent.beginner_friendly ? (
              <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                Beginner Friendly
              </span>
            ) : null}
          </div>

          <p className="mt-2 text-slate-600">
            {typedEvent.public_summary ||
              typedEvent.short_description ||
              "No short description provided."}
          </p>

          <p className="mt-3 text-sm text-slate-500">
            {eventUsageHint(typedEvent.event_type, typedEvent.visibility)}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/events"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Events
          </Link>

          <Link
            href={`/app/events/${typedEvent.id}/edit`}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            Edit Event
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Type</p>
          <p className="mt-2 text-xl font-semibold">{eventTypeLabel(typedEvent.event_type)}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Date Range</p>
          <p className="mt-2 text-xl font-semibold">{formatDate(typedEvent.start_date)}</p>
          <p className="mt-1 text-sm text-slate-500">to {formatDate(typedEvent.end_date)}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Time</p>
          <p className="mt-2 text-xl font-semibold">
            {formatTimeRange(typedEvent.start_time, typedEvent.end_time)}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Organizer</p>
          <p className="mt-2 text-xl font-semibold">{organizer?.name ?? "Unknown"}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">{registrationLabel(typedEvent.event_type)}</p>
          <p className="mt-2 text-xl font-semibold">
            {registrationRequiredLabel(
              typedEvent.event_type,
              typedEvent.registration_required
            )}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h3 className="text-xl font-semibold text-slate-900">Public Discovery</h3>

        <div className="mt-4 flex flex-wrap gap-2">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              typedEvent.public_directory_enabled
                ? "bg-green-50 text-green-700"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            {typedEvent.public_directory_enabled ? "Public Directory On" : "Public Directory Off"}
          </span>

          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              typedEvent.beginner_friendly
                ? "bg-blue-50 text-blue-700"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            {typedEvent.beginner_friendly ? "Beginner Friendly" : "Not Beginner Focused"}
          </span>

          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            Visibility: {visibilityLabel(typedEvent.visibility)}
          </span>

          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            Status: {typedEvent.status}
          </span>

          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              typedEvent.organizer_id
                ? "bg-green-50 text-green-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            {typedEvent.organizer_id ? "Organizer Linked" : "No Organizer"}
          </span>

          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              publicDirectoryReady
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            {publicDirectoryReady ? "Discovery Ready" : "Not Yet Discovery Ready"}
          </span>
        </div>

        <div className="mt-4 text-sm text-slate-600">
          {publicDirectoryReady ? (
            <p>
              This event is configured for public discovery and is eligible to appear in the public
              dance directory.
            </p>
          ) : (
            <p>
              This event is not currently fully eligible for public discovery. Public directory must
              be on, visibility must be public, status must be published/open, and the event must be
              linked to an organizer.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h3 className="text-xl font-semibold text-slate-900">Ticket & Registration Readiness</h3>

        <div className="mt-4 flex flex-wrap gap-2">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              typedEvent.registration_required
                ? "bg-green-50 text-green-700"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            {typedEvent.registration_required ? "Registration On" : "Registration Optional/Off"}
          </span>

          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              activeTicketCount > 0
                ? "bg-green-50 text-green-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            {activeTicketCount > 0 ? `${activeTicketCount} Active Tickets` : "No Active Tickets"}
          </span>

          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              typedEvent.waitlist_enabled
                ? "bg-purple-50 text-purple-700"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            {typedEvent.waitlist_enabled ? "Waitlist Enabled" : "Waitlist Off"}
          </span>

          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
              ticketReadiness
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            {ticketReadiness ? "Public Ticketing Ready" : "Not Yet Ticketing Ready"}
          </span>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-4">
          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Ticket Types</p>
            <p className="mt-1 font-medium text-slate-900">{ticketCount}</p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Active Tickets</p>
            <p className="mt-1 font-medium text-slate-900">{activeTicketCount}</p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Public Ticket Types</p>
            <p className="mt-1 font-medium text-slate-900">{publicTicketCount}</p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Event Capacity</p>
            <p className="mt-1 font-medium text-slate-900">
              {typedEvent.capacity ?? "Unlimited / not set"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {remainingCapacity == null ? "No event cap" : `${remainingCapacity} spots left`}
            </p>
          </div>
        </div>

        <div className="mt-4 text-sm text-slate-600">
          {ticketReadiness ? (
            <p>
              This event has the basic requirements for public ticket registration: registration is enabled, the event is not private/draft, and at least one active ticket exists.
            </p>
          ) : (
            <p>
              To make public ticket registration work smoothly, enable registration, keep the event out of draft/private state, and create at least one active ticket type.
            </p>
          )}
        </div>

        {typedTicketTypes.length > 0 ? (
          <div className="mt-6 space-y-3">
            {typedTicketTypes.map((ticket) => {
              const registrationsForTicket = ticketRegistrationsById.get(ticket.id) ?? 0;
              const remainingForTicket =
                ticket.capacity == null ? null : Math.max(ticket.capacity - registrationsForTicket, 0);
              const windowState = ticketWindowState(ticket);

              return (
                <div
                  key={ticket.id}
                  className="rounded-xl border bg-slate-50 p-4"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-slate-900">{ticket.name}</p>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                            ticket.active
                              ? "bg-green-50 text-green-700"
                              : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {ticket.active ? "Active" : "Inactive"}
                        </span>
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${windowState.className}`}
                        >
                          {windowState.label}
                        </span>
                      </div>

                      <p className="mt-2 text-sm text-slate-600">
                        {fmtCurrency(ticket.price, ticket.currency)}
                      </p>
                    </div>

                    <div className="grid gap-2 text-sm text-slate-600 md:text-right">
                      <p>
                        Capacity: {ticket.capacity ?? "Unlimited"}
                        {remainingForTicket != null ? ` • ${remainingForTicket} left` : ""}
                      </p>
                      <p>Registrations: {registrationsForTicket}</p>
                      <p>Sale starts: {formatDateTime(ticket.sale_starts_at)}</p>
                      <p>Sale ends: {formatDateTime(ticket.sale_ends_at)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
          Use the ticket manager to control pricing, sale windows, ticket-level caps, and what the public registration page can sell right now.
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4 xl:grid-cols-8">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Registrations</p>
          <p className="mt-2 text-3xl font-semibold">{totalRegistrations}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Paid</p>
          <p className="mt-2 text-3xl font-semibold">{paidCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Pending Pay</p>
          <p className="mt-2 text-3xl font-semibold">{pendingPaymentCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Refunded</p>
          <p className="mt-2 text-3xl font-semibold">{refundedCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Checked In</p>
          <p className="mt-2 text-3xl font-semibold">{checkedInCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Attended</p>
          <p className="mt-2 text-3xl font-semibold">{attendedCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Gross Revenue</p>
          <p className="mt-2 text-3xl font-semibold">{fmtCurrency(grossRevenue, defaultCurrency)}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Net Collected</p>
          <p className="mt-2 text-3xl font-semibold">{fmtCurrency(netCollected, defaultCurrency)}</p>
          <p className="mt-1 text-sm text-slate-500">
            Refunds: {fmtCurrency(refundedAmount, defaultCurrency)}
          </p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">
              Description
            </h3>
            <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">
              {typedEvent.description || "No full description provided."}
            </p>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Venue & Location</h3>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Venue</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedEvent.venue_name || "—"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Timezone</p>
                <p className="mt-1 font-medium text-slate-900">{typedEvent.timezone}</p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Start Time</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedEvent.start_time
                    ? formatTimeRange(typedEvent.start_time, typedEvent.start_time).split(" - ")[0]
                    : "—"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">End Time</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedEvent.end_time
                    ? formatTimeRange(typedEvent.end_time, typedEvent.end_time).split(" - ")[0]
                    : "—"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4 md:col-span-2">
                <p className="text-sm text-slate-500">Address</p>
                <p className="mt-1 font-medium text-slate-900">
                  {[
                    typedEvent.address_line_1,
                    typedEvent.address_line_2,
                    [typedEvent.city, typedEvent.state].filter(Boolean).join(", "),
                    typedEvent.postal_code,
                  ]
                    .filter(Boolean)
                    .join(" • ") || "No address provided."}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Public Content</h3>

            <div className="mt-4 space-y-4">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Public Summary</p>
                <p className="mt-1 text-sm text-slate-700">
                  {typedEvent.public_summary ||
                    typedEvent.short_description ||
                    "No public summary added."}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Public Description</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                  {typedEvent.public_description ||
                    typedEvent.description ||
                    "No public description added."}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Public Cover Image</p>
                <p className="mt-1 text-sm text-slate-700 break-all">
                  {typedEvent.public_cover_image_url ||
                    typedEvent.cover_image_url ||
                    "No public cover image set."}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Public URL</p>
                <p className="mt-1 font-medium text-slate-900">/events/{typedEvent.slug}</p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Tags</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {typedTags.length === 0 ? (
                    <p className="text-sm text-slate-500">No tags yet.</p>
                  ) : (
                    typedTags.map((tag) => (
                      <span
                        key={tag.id}
                        className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200"
                      >
                        {tag.tag}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Policies & FAQ</h3>

            <div className="mt-4 space-y-4">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Refund Policy</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                  {typedEvent.refund_policy || "No refund policy provided."}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">FAQ</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                  {typedEvent.faq || "No FAQ provided."}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Event Settings</h3>

            <div className="mt-4 space-y-4">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Visibility</p>
                <p className="mt-1 font-medium text-slate-900">
                  {visibilityLabel(typedEvent.visibility)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Capacity</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedEvent.capacity ?? "Unlimited / not set"}
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  {remainingCapacity == null ? "No capacity limit" : `${remainingCapacity} spots left`}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">{registrationLabel(typedEvent.event_type)} Window</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedEvent.registration_opens_at)}
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  closes {formatDateTime(typedEvent.registration_closes_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Account Required</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedEvent.account_required_for_registration ? "Yes" : "No"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Created</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedEvent.created_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Last Updated</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedEvent.updated_at)}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-xl font-semibold text-slate-900">
                {registrationLabel(typedEvent.event_type)} & Finance Summary
              </h3>

              <Link
                href={`/app/events/${typedEvent.id}/registrations`}
                className="text-sm underline"
              >
                Open registrations
              </Link>
            </div>

            <div className="mt-4 grid gap-3">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Total Registrations</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {totalRegistrations}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Paid / Pending / Refunded</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {paidCount} / {pendingPaymentCount} / {refundedCount}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Checked In / Attended</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {checkedInCount} / {attendedCount}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Gross Revenue</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {fmtCurrency(grossRevenue, defaultCurrency)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Refunded Amount / Net Collected</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {fmtCurrency(refundedAmount, defaultCurrency)} / {fmtCurrency(netCollected, defaultCurrency)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Linked to CRM / Not Yet Linked</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {linkedToCrmCount} / {unlinkedToCrmCount}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Cancelled</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {cancelledCount}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
              Use the registrations page to manage payment status, enrollment, attendance, check-ins, and CRM handoff for this offering.
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Next Steps</h3>

            <div className="mt-4 grid gap-3">
              <Link
                href={`/app/events/${typedEvent.id}/edit`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Edit Event
              </Link>

              <Link
                href={`/app/events/${typedEvent.id}/tickets`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Manage Tickets
              </Link>

              <Link
                href={`/app/events/${typedEvent.id}/registrations`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Manage Registrations
              </Link>

              <Link
                href={`/app/events/${typedEvent.id}/check-in`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Check-In Mode
              </Link>

              <Link
                href={`/events/${typedEvent.slug}`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Public Event Page
              </Link>

              <Link
                href="/app/events"
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Back to Event List
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}