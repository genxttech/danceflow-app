import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  CalendarDays,
  ClipboardCheck,
  Plus,
  Ticket,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventRow = {
  id: string;
  studio_id: string | null;
  organizer_id: string | null;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  start_date: string;
  start_time: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
};

type TicketTypeRow = {
  id: string;
  event_id: string;
  name: string;
  price: number | string;
  currency: string;
  capacity: number | null;
  active: boolean;
};

type RegistrationRow = {
  event_id: string;
  ticket_type_id: string | null;
  quantity: number | null;
  status: string | null;
};

function formatDate(event: EventRow) {
  const date = new Date(`${event.start_date}T00:00:00`);

  const dateLabel = Number.isNaN(date.getTime())
    ? "Date not set"
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);

  return event.start_time ? `${dateLabel} at ${event.start_time}` : dateLabel;
}

function formatPrice(value: number | string, currency: string) {
  const amount = typeof value === "number" ? value : Number(value ?? 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatStatus(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isCancelledLikeStatus(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  return (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "refunded" ||
    normalized === "void"
  );
}

function eventLocation(event: EventRow) {
  const parts = [event.venue_name, event.city, event.state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Location not set";
}

export default async function ManageTicketsIndexPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!context?.studioId) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [
    { data: events, error: eventsError },
    { data: ticketTypes, error: ticketTypesError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select(`
        id,
        studio_id,
        organizer_id,
        name,
        slug,
        status,
        visibility,
        start_date,
        start_time,
        venue_name,
        city,
        state
      `)
      .eq("studio_id", studioId)
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true }),

    supabase
      .from("event_ticket_types")
      .select(`
        id,
        event_id,
        name,
        price,
        currency,
        capacity,
        active
      `)
      .order("created_at", { ascending: true }),

    supabase
      .from("event_registrations")
      .select(`
        event_id,
        ticket_type_id,
        quantity,
        status
      `)
      .eq("studio_id", studioId),
  ]);

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  if (ticketTypesError) {
    throw new Error(`Failed to load ticket types: ${ticketTypesError.message}`);
  }

  if (registrationsError) {
    throw new Error(
      `Failed to load event registrations: ${registrationsError.message}`
    );
  }

  const eventRows = (events ?? []) as EventRow[];
  const ticketRows = (ticketTypes ?? []) as TicketTypeRow[];
  const registrationRows = (registrations ?? []) as RegistrationRow[];

  const ticketsByEventId = new Map<string, TicketTypeRow[]>();
  const soldByTicketTypeId = new Map<string, number>();
  const soldByEventId = new Map<string, number>();

  for (const ticket of ticketRows) {
    const current = ticketsByEventId.get(ticket.event_id) ?? [];
    current.push(ticket);
    ticketsByEventId.set(ticket.event_id, current);
  }

  for (const registration of registrationRows) {
    if (isCancelledLikeStatus(registration.status)) {
      continue;
    }

    const quantity = Number(registration.quantity ?? 0);

    if (registration.ticket_type_id) {
      soldByTicketTypeId.set(
        registration.ticket_type_id,
        (soldByTicketTypeId.get(registration.ticket_type_id) ?? 0) + quantity
      );
    }

    soldByEventId.set(
      registration.event_id,
      (soldByEventId.get(registration.event_id) ?? 0) + quantity
    );
  }

  const totalTicketTypes = ticketRows.length;
  const activeTicketTypes = ticketRows.filter((ticket) => ticket.active).length;
  const totalTicketsSold = Array.from(soldByEventId.values()).reduce(
    (total, quantity) => total + quantity,
    0
  );

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              Event tickets
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Manage Tickets
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              View ticket setup across your events, jump into ticket editing,
              review registrations, and keep event sales ready for dancers.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/events"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              <ArrowLeft className="h-4 w-4" />
              Events
            </Link>
            <Link
              href="/app/events/new"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] transition hover:bg-[#F9F1FF]"
            >
              <Plus className="h-4 w-4" />
              Create Event
            </Link>
          </div>
        </div>

        <div className="grid gap-3 border-t border-white/10 bg-black/10 px-6 py-4 md:grid-cols-4 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Events
            </p>
            <p className="mt-1 text-sm font-semibold">{eventRows.length}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Ticket types
            </p>
            <p className="mt-1 text-sm font-semibold">{totalTicketTypes}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Active ticket types
            </p>
            <p className="mt-1 text-sm font-semibold">{activeTicketTypes}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Tickets sold
            </p>
            <p className="mt-1 text-sm font-semibold">{totalTicketsSold}</p>
          </div>
        </div>
      </section>

      {eventRows.length === 0 ? (
        <section className="rounded-[28px] border border-dashed border-[#D8B4FE] bg-[#FCF8FF] p-8 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#F3E8FF] text-[#6B21A8]">
            <CalendarDays className="h-7 w-7" />
          </div>
          <h2 className="mt-4 text-2xl font-semibold text-slate-950">
            No events yet
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
            Create your first event, then add ticket types so dancers can
            register from the public event page.
          </p>
          <div className="mt-5">
            <Link
              href="/app/events/new"
              className="inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4A1363]"
            >
              <Plus className="h-4 w-4" />
              Create Event
            </Link>
          </div>
        </section>
      ) : (
        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Events with ticket tools
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Choose an event to edit ticket types, sell tickets, or review
                registrations.
              </p>
            </div>

            <Link
              href="/app/events/sell-tickets"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#E9D5FF] bg-[#FCF8FF] px-4 py-2 text-sm font-semibold text-[#6B21A8] transition hover:bg-[#F3E8FF]"
            >
              <Ticket className="h-4 w-4" />
              Sell Tickets
            </Link>
          </div>

          <div className="mt-6 space-y-4">
            {eventRows.map((event) => {
              const eventTickets = ticketsByEventId.get(event.id) ?? [];
              const activeCount = eventTickets.filter(
                (ticket) => ticket.active
              ).length;
              const soldCount = soldByEventId.get(event.id) ?? 0;

              const totalCapacity = eventTickets.reduce((total, ticket) => {
                if (ticket.capacity === null || ticket.capacity === undefined) {
                  return total;
                }

                return total + Number(ticket.capacity);
              }, 0);

              const hasUnlimited = eventTickets.some(
                (ticket) => ticket.capacity === null || ticket.capacity === undefined
              );

              return (
                <article
                  key={event.id}
                  className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-[#D8B4FE] hover:bg-[#FCF8FF]"
                >
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-[#F3E8FF] px-3 py-1 text-xs font-medium text-[#6B21A8]">
                          {formatStatus(event.status)}
                        </span>
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                          {formatStatus(event.visibility)}
                        </span>
                      </div>

                      <h3 className="mt-3 text-xl font-semibold text-slate-950">
                        {event.name}
                      </h3>

                      <p className="mt-1 text-sm text-slate-600">
                        {formatDate(event)}
                      </p>

                      <p className="mt-1 text-sm text-slate-500">
                        {eventLocation(event)}
                      </p>

                      <div className="mt-4 grid gap-3 md:grid-cols-4">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Ticket types
                          </p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">
                            {eventTickets.length}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Active
                          </p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">
                            {activeCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Sold
                          </p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">
                            {soldCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Capacity
                          </p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">
                            {hasUnlimited
                              ? "Unlimited"
                              : totalCapacity > 0
                                ? totalCapacity
                                : "Not set"}
                          </p>
                        </div>
                      </div>

                      {eventTickets.length > 0 ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {eventTickets.slice(0, 4).map((ticket) => {
                            const soldForTicket =
                              soldByTicketTypeId.get(ticket.id) ?? 0;

                            return (
                              <span
                                key={ticket.id}
                                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700"
                              >
                                {ticket.name}:{" "}
                                {formatPrice(ticket.price, ticket.currency)} ·{" "}
                                {soldForTicket} sold
                              </span>
                            );
                          })}

                          {eventTickets.length > 4 ? (
                            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500">
                              +{eventTickets.length - 4} more
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                          No ticket types yet. Add tickets before opening
                          registration.
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
                      <Link
                        href={`/app/events/${event.id}/tickets`}
                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4A1363]"
                      >
                        <Ticket className="h-4 w-4" />
                        Manage Tickets
                      </Link>

                      <Link
                        href={`/app/events/${event.id}/registrations`}
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        <ClipboardCheck className="h-4 w-4" />
                        Registrations
                      </Link>

                      <Link
                        href={`/app/events/${event.id}`}
                        className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        Event Details
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}