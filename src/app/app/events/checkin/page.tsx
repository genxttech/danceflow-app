import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock,
  MapPin,
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
  checked_in_at: string | null;
};

type AttendeeRow = {
  id: string;
  event_id: string;
  registration_id: string;
  checked_in_at: string | null;
};

type EventCardRow = EventRow & {
  totalRegistrations: number;
  paidRegistrations: number;
  totalTickets: number;
  checkInTotal: number;
  checkedInCount: number;
  remainingCount: number;
  timing: "past" | "today" | "upcoming";
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
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
  if (value === "public")
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (value === "unlisted")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (value === "private")
    return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getLocation(city: string | null, state: string | null) {
  const parts = [city, state].filter(Boolean);
  return parts.length ? parts.join(", ") : "Location not set";
}

function getEventTimingBucket(
  startDate: string,
): "past" | "today" | "upcoming" {
  const today = new Date();
  const todayKey = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();

  const eventDate = new Date(`${startDate}T00:00:00`);
  const eventKey = new Date(
    eventDate.getFullYear(),
    eventDate.getMonth(),
    eventDate.getDate(),
  ).getTime();

  if (eventKey < todayKey) return "past";
  if (eventKey === todayKey) return "today";
  return "upcoming";
}

function progressPercent(checkedInCount: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((checkedInCount / total) * 100));
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
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

function EventQuickCard({
  event,
  priority = false,
  actionLabel,
}: {
  event: EventCardRow;
  priority?: boolean;
  actionLabel: string;
}) {
  const percent = progressPercent(event.checkedInCount, event.checkInTotal);
  const remainingText = `${event.remainingCount} ${event.remainingCount === 1 ? "ticket" : "tickets"} remaining`;

  return (
    <article
      className={
        priority
          ? "rounded-[32px] border-2 border-[var(--brand-primary)] bg-white p-5 shadow-lg shadow-violet-100 md:p-6"
          : "rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm md:p-6"
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {priority ? (
            <p className="mb-2 inline-flex rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--brand-primary)]">
              Start here
            </p>
          ) : null}
          <h3 className="text-xl font-semibold text-slate-950">{event.name}</h3>
          <div className="mt-3 space-y-1 text-sm text-slate-500">
            <p className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-slate-400" />
              {formatDateRange(event.start_date, event.end_date)}
            </p>
            <p className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-slate-400" />
              {formatTimeRange(event.start_time, event.end_time)}
            </p>
            <p className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-slate-400" />
              {getLocation(event.city, event.state)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 sm:justify-end">
          <span
            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
              event.status,
            )}`}
          >
            {event.status}
          </span>
          <span
            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${visibilityBadgeClass(
              event.visibility,
            )}`}
          >
            {event.visibility}
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
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
            Tickets
          </p>
          <p className="mt-2 font-semibold text-slate-900">
            {event.checkInTotal}
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
        <div className="flex items-center justify-between gap-3 text-sm">
          <p className="font-medium text-violet-950">
            {event.checkedInCount}/{event.checkInTotal} checked in
          </p>
          <p className="text-violet-800">{remainingText}</p>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
          <div
            className="h-full rounded-full bg-[var(--brand-primary)]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Link
          href={`/app/events/${event.id}/check-in`}
          className={
            priority
              ? "inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-base font-semibold text-white hover:bg-slate-800"
              : "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
          }
        >
          {actionLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>

        <Link
          href={`/app/events/${event.id}/registrations`}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          View Registrations
        </Link>
      </div>
    </article>
  );
}

export default async function EventCheckInIndexPage() {
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
    .select(
      `
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
    `,
    )
    .eq("studio_id", studioId)
    .order("start_date", { ascending: true })
    .order("start_time", { ascending: true })
    .order("name", { ascending: true });

  if (eventsError) {
    throw new Error(
      `Failed to load events for check-in: ${eventsError.message}`,
    );
  }

  const typedEvents = (events ?? []) as EventRow[];
  const eventIds = typedEvents.map((event) => event.id);

  let typedRegistrations: RegistrationRow[] = [];
  let typedAttendees: AttendeeRow[] = [];

  if (eventIds.length > 0) {
    const [
      { data: registrations, error: registrationsError },
      { data: attendees, error: attendeesError },
    ] = await Promise.all([
      supabase
        .from("event_registrations")
        .select(
          `
            id,
            event_id,
            status,
            payment_status,
            checked_in_at
          `,
        )
        .in("event_id", eventIds),
      supabase
        .from("event_registration_attendees")
        .select(
          `
            id,
            event_id,
            registration_id,
            checked_in_at
          `,
        )
        .in("event_id", eventIds),
    ]);

    if (registrationsError) {
      throw new Error(
        `Failed to load registrations for check-in: ${registrationsError.message}`,
      );
    }

    if (attendeesError) {
      throw new Error(
        `Failed to load attendee tickets for check-in: ${attendeesError.message}`,
      );
    }

    typedRegistrations = (registrations ?? []) as RegistrationRow[];
    typedAttendees = (attendees ?? []) as AttendeeRow[];
  }

  const registrationsByEvent = new Map<string, RegistrationRow[]>();
  for (const registration of typedRegistrations) {
    const current = registrationsByEvent.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEvent.set(registration.event_id, current);
  }

  const attendeesByEvent = new Map<string, AttendeeRow[]>();
  for (const attendee of typedAttendees) {
    const current = attendeesByEvent.get(attendee.event_id) ?? [];
    current.push(attendee);
    attendeesByEvent.set(attendee.event_id, current);
  }

  const eventCards: EventCardRow[] = typedEvents.map((event) => {
    const registrations = registrationsByEvent.get(event.id) ?? [];
    const attendees = attendeesByEvent.get(event.id) ?? [];
    const paidRegistrations = registrations.filter(
      (registration) =>
        registration.payment_status === "paid" ||
        registration.payment_status === "partial" ||
        registration.payment_status === null,
    ).length;

    const checkedInTicketCount = attendees.filter((attendee) =>
      Boolean(attendee.checked_in_at),
    ).length;
    const checkedInRegistrationCount = registrations.filter((registration) =>
      Boolean(registration.checked_in_at),
    ).length;
    const checkInTotal =
      attendees.length > 0 ? attendees.length : registrations.length;
    const checkedInCount =
      attendees.length > 0 ? checkedInTicketCount : checkedInRegistrationCount;

    return {
      ...event,
      totalRegistrations: registrations.length,
      paidRegistrations,
      totalTickets: attendees.length,
      checkInTotal,
      checkedInCount,
      remainingCount: Math.max(checkInTotal - checkedInCount, 0),
      timing: getEventTimingBucket(event.start_date),
    };
  });

  const todayEvents = eventCards.filter((event) => event.timing === "today");
  const upcomingEvents = eventCards.filter(
    (event) => event.timing === "upcoming",
  );
  const pastEvents = eventCards.filter((event) => event.timing === "past");

  const primaryEvent =
    [...todayEvents].sort(
      (a, b) =>
        b.remainingCount - a.remainingCount || b.checkInTotal - a.checkInTotal,
    )[0] ??
    [...upcomingEvents].sort((a, b) =>
      a.start_date.localeCompare(b.start_date),
    )[0] ??
    eventCards[0] ??
    null;

  const secondaryTodayEvents = primaryEvent
    ? todayEvents.filter((event) => event.id !== primaryEvent.id)
    : todayEvents;
  const secondaryUpcomingEvents =
    primaryEvent?.timing === "upcoming"
      ? upcomingEvents.filter((event) => event.id !== primaryEvent.id)
      : upcomingEvents;
  const secondaryPastEvents =
    primaryEvent?.timing === "past"
      ? pastEvents.filter((event) => event.id !== primaryEvent.id)
      : pastEvents;

  const totalRegistrations = eventCards.reduce(
    (sum, event) => sum + event.totalRegistrations,
    0,
  );
  const totalCheckInTickets = eventCards.reduce(
    (sum, event) => sum + event.checkInTotal,
    0,
  );
  const totalCheckedIn = eventCards.reduce(
    (sum, event) => sum + event.checkedInCount,
    0,
  );
  const totalRemaining = Math.max(totalCheckInTickets - totalCheckedIn, 0);

  return (
    <main className="space-y-6 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_20%)] p-1 md:space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Organizer Check-In
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Event Check-In Hub
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Event-day check-in should be fast. Start with the most likely
                event, then scan QR codes from the sticky scan panel on the
                event page.
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
                href="/app/events/new"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Create Event
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard
              label="Events"
              value={eventCards.length}
              icon={CalendarDays}
            />
            <StatCard
              label="Registrations"
              value={totalRegistrations}
              icon={ClipboardList}
            />
            <StatCard
              label="Checked In"
              value={totalCheckedIn}
              icon={CheckCircle2}
            />
            <StatCard
              label="Still Arriving"
              value={totalRemaining}
              icon={Users}
            />
          </div>
        </div>
      </section>

      {primaryEvent ? (
        <section className="rounded-[32px] border border-violet-200 bg-violet-50/70 p-4 shadow-sm md:p-6">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
              <Search className="h-5 w-5" />
            </div>

            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Fastest path for check-in
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Tap the main event below. The event page opens with the QR
                scanner and manual ticket-code field at the top for mobile
                check-in.
              </p>
            </div>
          </div>

          <EventQuickCard
            event={primaryEvent}
            priority
            actionLabel={
              primaryEvent.timing === "past"
                ? "Review Check-In"
                : "Start Check-In"
            }
          />
        </section>
      ) : null}

      <section className="space-y-8">
        {eventCards.length === 0 ? (
          <div className="rounded-[32px] border border-dashed border-slate-300 bg-white px-6 py-16 text-center shadow-sm">
            <p className="text-lg font-semibold text-slate-900">
              No events available for check-in
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Create an event first, then return here to check attendees in.
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
            {secondaryTodayEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand-primary)]">
                    Today
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                    Other events today
                  </h2>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  {secondaryTodayEvents.map((event) => (
                    <EventQuickCard
                      key={event.id}
                      event={event}
                      actionLabel="Start Check-In"
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {secondaryUpcomingEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Upcoming
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                    Upcoming check-in events
                  </h2>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  {secondaryUpcomingEvents.map((event) => (
                    <EventQuickCard
                      key={event.id}
                      event={event}
                      actionLabel="Open Check-In"
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {secondaryPastEvents.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Past
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                    Past event check-in history
                  </h2>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  {secondaryPastEvents.map((event) => (
                    <EventQuickCard
                      key={event.id}
                      event={event}
                      actionLabel="Review Check-In"
                    />
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
