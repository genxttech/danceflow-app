import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Search,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  city: string | null;
  state: string | null;
  status: string;
  visibility: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  status: string;
  payment_status: string | null;
  total_amount: number | null;
};

type AttendanceRow = {
  id: string;
  event_registration_id: string;
  status: string;
};

function formatDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  const startText = start.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const endText = end.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return startDate === endDate ? startText : `${startText} - ${endText}`;
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

function statusBadgeClass(status: string) {
  if (status === "published" || status === "open") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (status === "draft") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }
  if (status === "cancelled") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }
  if (status === "completed") {
    return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function visibilityBadgeClass(value: string) {
  if (value === "public") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (value === "unlisted") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (value === "private") return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getLocation(city: string | null, state: string | null) {
  const parts = [city, state].filter(Boolean);
  return parts.length ? parts.join(", ") : "Location not set";
}

function getEventTimingBucket(startDate: string) {
  const today = new Date();
  const todayKey = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();

  const eventDate = new Date(`${startDate}T00:00:00`);
  const eventKey = new Date(
    eventDate.getFullYear(),
    eventDate.getMonth(),
    eventDate.getDate()
  ).getTime();

  if (eventKey < todayKey) return "past";
  if (eventKey === todayKey) return "today";
  return "upcoming";
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default async function EventRegistrationsIndexPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select(`
      id,
      name,
      slug,
      event_type,
      start_date,
      end_date,
      start_time,
      end_time,
      city,
      state,
      status,
      visibility
    `)
    .eq("studio_id", studioId)
    .order("start_date", { ascending: true })
    .order("start_time", { ascending: true })
    .order("name", { ascending: true });

  if (eventsError) {
    throw new Error(`Failed to load registration events: ${eventsError.message}`);
  }

  const typedEvents = (events ?? []) as EventRow[];
  const eventIds = typedEvents.map((event) => event.id);

  let typedRegistrations: RegistrationRow[] = [];
  let typedAttendance: AttendanceRow[] = [];

  if (eventIds.length > 0) {
    const { data: registrations, error: registrationsError } = await supabase
      .from("event_registrations")
      .select(`
        id,
        event_id,
        status,
        payment_status,
        total_amount
      `)
      .in("event_id", eventIds);

    if (registrationsError) {
      throw new Error(`Failed to load registrations: ${registrationsError.message}`);
    }

    typedRegistrations = (registrations ?? []) as RegistrationRow[];

    const registrationIds = typedRegistrations.map((registration) => registration.id);

    if (registrationIds.length > 0) {
      const { data: attendanceRows, error: attendanceError } = await supabase
        .from("event_attendance")
        .select(`
          id,
          event_registration_id,
          status
        `)
        .in("event_registration_id", registrationIds);

      if (attendanceError) {
        throw new Error(`Failed to load attendance: ${attendanceError.message}`);
      }

      typedAttendance = (attendanceRows ?? []) as AttendanceRow[];
    }
  }

  const registrationsByEventId = new Map<string, RegistrationRow[]>();
  for (const registration of typedRegistrations) {
    const current = registrationsByEventId.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEventId.set(registration.event_id, current);
  }

  const attendanceByRegistrationId = new Map<string, AttendanceRow[]>();
  for (const attendance of typedAttendance) {
    const current = attendanceByRegistrationId.get(attendance.event_registration_id) ?? [];
    current.push(attendance);
    attendanceByRegistrationId.set(attendance.event_registration_id, current);
  }

  const eventCards = typedEvents.map((event) => {
    const registrations = registrationsByEventId.get(event.id) ?? [];

    const paidCount = registrations.filter(
      (registration) =>
        registration.payment_status === "paid" ||
        registration.payment_status === "partial"
    ).length;

    const pendingCount = registrations.filter(
      (registration) =>
        registration.payment_status !== "paid" &&
        registration.payment_status !== "partial"
    ).length;

    const checkedInCount = registrations.reduce((sum, registration) => {
      const attendanceRows = attendanceByRegistrationId.get(registration.id) ?? [];
      const hasCheckedIn = attendanceRows.some((row) => row.status === "checked_in");
      return sum + (hasCheckedIn ? 1 : 0);
    }, 0);

    const grossRevenue = registrations.reduce((sum, registration) => {
      if (
        registration.payment_status !== "paid" &&
        registration.payment_status !== "partial"
      ) {
        return sum;
      }

      return sum + Number(registration.total_amount ?? 0);
    }, 0);

    return {
      ...event,
      totalRegistrations: registrations.length,
      paidCount,
      pendingCount,
      checkedInCount,
      grossRevenue,
      timing: getEventTimingBucket(event.start_date),
    };
  });

  const todayEvents = eventCards.filter((event) => event.timing === "today");
  const upcomingEvents = eventCards.filter((event) => event.timing === "upcoming");
  const pastEvents = eventCards.filter((event) => event.timing === "past");
  const priorityEvents = [...todayEvents, ...upcomingEvents, ...pastEvents];

  const totalRegistrations = eventCards.reduce(
    (sum, event) => sum + event.totalRegistrations,
    0
  );
  const totalPaidRegistrations = eventCards.reduce((sum, event) => sum + event.paidCount, 0);
  const totalCheckedIn = eventCards.reduce((sum, event) => sum + event.checkedInCount, 0);
  const grossRevenue = eventCards.reduce((sum, event) => sum + event.grossRevenue, 0);

  return (
    <main className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_20%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Organizer Registrations
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Registration Hub
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                See registration volume across events, open event-specific registration details, and move quickly into check-in on event day.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/events"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Events
              </Link>

              <Link
                href="/app/events/checkin"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Open Check-In Hub
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard label="Events" value={eventCards.length} icon={CalendarDays} />
            <StatCard label="Registrations" value={totalRegistrations} icon={ClipboardList} />
            <StatCard label="Paid" value={totalPaidRegistrations} icon={CreditCard} />
            <StatCard label="Checked In" value={totalCheckedIn} icon={CheckCircle2} />
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Search className="h-5 w-5" />
          </div>

          <div>
            <h2 className="text-xl font-semibold text-slate-900">Organizer registration view</h2>
            <p className="mt-2 text-sm leading-7 text-slate-600">
              Start with today’s and upcoming events first. Use the per-event registration page for attendee detail and the check-in page when doors open.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4">
          <p className="text-sm text-violet-800">
            Gross paid registration volume across visible events:{" "}
            <span className="font-semibold">{formatMoney(grossRevenue)}</span>
          </p>
        </div>
      </section>

      <section className="space-y-8">
        {priorityEvents.length === 0 ? (
          <div className="rounded-[32px] border border-dashed border-slate-300 bg-white px-6 py-16 text-center shadow-sm">
            <p className="text-lg font-semibold text-slate-900">
              No event registrations to manage yet
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Create an event and start collecting registrations to use this page.
            </p>
            <Link
              href="/app/events/new"
              className="mt-6 inline-flex rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Create Event
            </Link>
          </div>
        ) : (
          <>
            {todayEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-primary)]">
                    Today
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                    Today&apos;s registration activity
                  </h2>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  {todayEvents.map((event) => (
                    <article
                      key={event.id}
                      className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-xl font-semibold text-slate-950">{event.name}</h3>
                          <p className="mt-2 text-sm text-slate-500">
                            {formatDateRange(event.start_date, event.end_date)} •{" "}
                            {formatTimeRange(event.start_time, event.end_time)}
                          </p>
                          <p className="mt-1 text-sm text-slate-500">
                            {getLocation(event.city, event.state)}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                              event.status
                            )}`}
                          >
                            {event.status}
                          </span>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${visibilityBadgeClass(
                              event.visibility
                            )}`}
                          >
                            {event.visibility}
                          </span>
                        </div>
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-4">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Type
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {eventTypeLabel(event.event_type)}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Total
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.totalRegistrations}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Paid
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.paidCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Checked In
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.checkedInCount}
                          </p>
                        </div>
                      </div>

                      <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4">
                        <p className="text-sm text-violet-800">
                          {event.pendingCount} registration
                          {event.pendingCount === 1 ? "" : "s"} still pending payment or completion.
                        </p>
                      </div>

                      <div className="mt-5 flex flex-wrap gap-3">
                        <Link
                          href={`/app/events/${event.id}/registrations`}
                          className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          Open Registrations
                        </Link>

                        <Link
                          href={`/app/events/${event.id}/checkin`}
                          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Open Check-In
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            {upcomingEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Upcoming
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                    Upcoming registration activity
                  </h2>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  {upcomingEvents.map((event) => (
                    <article
                      key={event.id}
                      className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-xl font-semibold text-slate-950">{event.name}</h3>
                          <p className="mt-2 text-sm text-slate-500">
                            {formatDateRange(event.start_date, event.end_date)} •{" "}
                            {formatTimeRange(event.start_time, event.end_time)}
                          </p>
                          <p className="mt-1 text-sm text-slate-500">
                            {getLocation(event.city, event.state)}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                              event.status
                            )}`}
                          >
                            {event.status}
                          </span>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${visibilityBadgeClass(
                              event.visibility
                            )}`}
                          >
                            {event.visibility}
                          </span>
                        </div>
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-4">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Type
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {eventTypeLabel(event.event_type)}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Total
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.totalRegistrations}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Paid
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.paidCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Gross
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {formatMoney(event.grossRevenue)}
                          </p>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap gap-3">
                        <Link
                          href={`/app/events/${event.id}/registrations`}
                          className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          Open Registrations
                        </Link>

                        <Link
                          href={`/app/events/${event.id}/checkin`}
                          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Open Check-In
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            {pastEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Past
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                    Past registration history
                  </h2>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  {pastEvents.map((event) => (
                    <article
                      key={event.id}
                      className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-xl font-semibold text-slate-950">{event.name}</h3>
                          <p className="mt-2 text-sm text-slate-500">
                            {formatDateRange(event.start_date, event.end_date)} •{" "}
                            {formatTimeRange(event.start_time, event.end_time)}
                          </p>
                          <p className="mt-1 text-sm text-slate-500">
                            {getLocation(event.city, event.state)}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                              event.status
                            )}`}
                          >
                            {event.status}
                          </span>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${visibilityBadgeClass(
                              event.visibility
                            )}`}
                          >
                            {event.visibility}
                          </span>
                        </div>
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-4">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Total
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.totalRegistrations}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Paid
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.paidCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Checked In
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {event.checkedInCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                            Gross
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {formatMoney(event.grossRevenue)}
                          </p>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap gap-3">
                        <Link
                          href={`/app/events/${event.id}/registrations`}
                          className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          Review Registrations
                        </Link>

                        <Link
                          href={`/app/events/${event.id}/checkin`}
                          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Review Check-In
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}