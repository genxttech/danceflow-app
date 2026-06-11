import Link from "next/link";
import { redirect } from "next/navigation";
import { Ticket, ArrowLeft, ClipboardCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import SellTicketsForm from "./SellTicketsForm";

type EventRow = {
  id: string;
  name: string;
  status: string;
  start_date: string;
  start_time: string | null;
};

type TicketTypeRow = {
  id: string;
  event_id: string;
  name: string;
  price: number | string;
  currency: string;
  capacity: number | null;
  active: boolean;
  attendees_per_ticket: number | null;
  sort_order: number;
};

type RegistrationRow = {
  ticket_type_id: string | null;
  quantity: number | null;
  status: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

function canSellTickets(params: {
  role: string | null | undefined;
  isPlatformAdmin: boolean;
}) {
  if (params.isPlatformAdmin) return true;

  const role = (params.role ?? "").trim().toLowerCase();

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "front_desk" ||
    role === "organizer_owner" ||
    role === "organizer_admin" ||
    role === "organizer_staff"
  );
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

function eventStatusLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export default async function SellTicketsPage() {
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

  if (
    !canSellTickets({
      role: context.studioRole,
      isPlatformAdmin: Boolean(context.isPlatformAdmin),
    })
  ) {
    redirect("/app/events");
  }

  const studioId = context.studioId;

  const [
    { data: events, error: eventsError },
    { data: ticketTypes, error: ticketsError },
    { data: registrations, error: registrationsError },
    { data: clients, error: clientsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select("id, name, status, start_date, start_time")
      .eq("studio_id", studioId)
      .not("status", "in", '("cancelled","completed")')
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true }),

    supabase
      .from("event_ticket_types")
      .select("id, event_id, name, price, currency, capacity, active, attendees_per_ticket, sort_order")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),

    supabase
      .from("event_registrations")
      .select("ticket_type_id, quantity, status")
      .eq("studio_id", studioId),

    supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone")
      .eq("studio_id", studioId)
      .order("last_name", { ascending: true })
      .order("first_name", { ascending: true }),
  ]);

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  if (ticketsError) {
    throw new Error(`Failed to load tickets: ${ticketsError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load registrations: ${registrationsError.message}`);
  }

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  const typedEvents = (events ?? []) as EventRow[];
  const typedTickets = (ticketTypes ?? []) as TicketTypeRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];
  const typedClients = (clients ?? []) as ClientRow[];

  const soldByTicketType = new Map<string, number>();

  for (const registration of typedRegistrations) {
    if (!registration.ticket_type_id || isCancelledLikeStatus(registration.status)) {
      continue;
    }

    soldByTicketType.set(
      registration.ticket_type_id,
      (soldByTicketType.get(registration.ticket_type_id) ?? 0) +
        Number(registration.quantity ?? 0)
    );
  }

  const ticketsByEventId = new Map<string, TicketTypeRow[]>();

  for (const ticketType of typedTickets) {
    const current = ticketsByEventId.get(ticketType.event_id) ?? [];
    current.push(ticketType);
    ticketsByEventId.set(ticketType.event_id, current);
  }

  const eventOptions = typedEvents
    .map((event) => ({
      ...event,
      ticketTypes: (ticketsByEventId.get(event.id) ?? []).map((ticket) => ({
        ...ticket,
        soldQuantity: soldByTicketType.get(ticket.id) ?? 0,
      })),
    }))
    .filter((event) => event.ticketTypes.length > 0);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              Event sales
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Sell tickets from the workspace
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              Use this for front desk sales, at-the-door purchases, cash payments,
              external card payments, and comps. The sale creates a confirmed
              event registration.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/events"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
            >
              <ArrowLeft className="h-4 w-4" />
              Events
            </Link>

            <Link
              href="/app/events/registrations"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] hover:bg-white/90"
            >
              <ClipboardCheck className="h-4 w-4" />
              Registrations
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Events with tickets</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {eventOptions.length}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Available ticket types</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {eventOptions.reduce((total, event) => total + event.ticketTypes.length, 0)}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Sale mode</p>
          <p className="mt-2 flex items-center gap-2 text-lg font-semibold text-slate-950">
            <Ticket className="h-5 w-5 text-violet-700" />
            Manual / front desk
          </p>
        </div>
      </section>

      {eventOptions.length === 0 ? (
        <section className="rounded-[28px] border border-amber-200 bg-amber-50 p-6">
          <h2 className="text-xl font-semibold text-amber-950">
            No sellable tickets yet
          </h2>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            Create an event and add at least one active ticket type before using
            manual ticket sales.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/app/events/new"
              className="rounded-xl bg-amber-900 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-950"
            >
              Create Event
            </Link>
            <Link
              href="/app/events"
              className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
            >
              Manage Events
            </Link>
          </div>
        </section>
      ) : (
        <SellTicketsForm events={eventOptions} clients={typedClients} />
      )}

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <h2 className="text-xl font-semibold text-slate-950">
          How manual ticket sales work
        </h2>
        <div className="mt-4 grid gap-4 text-sm leading-6 text-slate-600 md:grid-cols-3">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="font-semibold text-slate-950">1. Pick the event</p>
            <p className="mt-1">
              Only active ticket types are shown. Cancelled and completed events
              are excluded.
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="font-semibold text-slate-950">2. Record payment</p>
            <p className="mt-1">
              Cash, external card, check, comp, and other manual payment methods
              are supported.
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="font-semibold text-slate-950">3. Confirm registration</p>
            <p className="mt-1">
              The sale creates a confirmed registration, issues attendee QR codes,
              and sends you to the event registrations page.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-950">Loaded event statuses</p>
          <p className="mt-1 text-sm text-slate-600">
            {typedEvents.length > 0
              ? Array.from(new Set(typedEvents.map((event) => event.status)))
                  .map(eventStatusLabel)
                  .join(", ")
              : "No events loaded."}
          </p>
        </div>
      </section>
    </div>
  );
}