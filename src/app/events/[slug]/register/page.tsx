import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  startEventRegistrationSignInAction,
} from "./actions";
import RegistrationForm from "./RegistrationForm";

type Params = Promise<{
  slug: string;
}>;

type SearchParams = Promise<{
  error?: string;
}>;

type EventRow = {
  id: string;
  studio_id: string | null;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  short_description: string | null;
  start_date: string;
  end_date: string;
  account_required_for_registration: boolean;
  registration_required: boolean;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  organizers:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null;
};

type TicketTypeRow = {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  ticket_kind: string;
  price: number;
  currency: string;
  capacity: number | null;
  active: boolean;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
};

function getOrganizer(
  value:
    | { name: string; slug: string }
    | { name: string; slug: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function kindLabel(value: string) {
  if (value === "general_admission") return "General Admission";
  if (value === "vip") return "VIP";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  const startText = start.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const endText = end.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return startDate === endDate ? startText : `${startText} - ${endText}`;
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

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

function isTicketCurrentlyAvailable(ticket: TicketTypeRow) {
  const now = new Date();

  if (!ticket.active) return false;
  if (ticket.sale_starts_at && new Date(ticket.sale_starts_at) > now) return false;
  if (ticket.sale_ends_at && new Date(ticket.sale_ends_at) < now) return false;

  return true;
}

function canRegisterForEvent(event: EventRow) {
  const now = new Date();

  if (!event.registration_required) return false;
  if (event.registration_opens_at && new Date(event.registration_opens_at) > now) return false;
  if (event.registration_closes_at && new Date(event.registration_closes_at) < now) return false;

  return true;
}

export default async function PublicEventRegisterPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  await searchParams;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: event, error: eventError }, { data: ticketTypes, error: ticketTypesError }] =
    await Promise.all([
      supabase
        .from("events")
        .select(`
          id,
          studio_id,
          name,
          slug,
          status,
          visibility,
          short_description,
          start_date,
          end_date,
          account_required_for_registration,
          registration_required,
          registration_opens_at,
          registration_closes_at,
          organizers ( name, slug )
        `)
        .eq("slug", slug)
        .eq("status", "published")
        .in("visibility", ["public", "unlisted"])
        .single(),
      supabase
        .from("event_ticket_types")
        .select(`
          id,
          event_id,
          name,
          description,
          ticket_kind,
          price,
          currency,
          capacity,
          active,
          sale_starts_at,
          sale_ends_at
        `)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
    ]);

  if (eventError || !event) {
    notFound();
  }

  if (ticketTypesError) {
    throw new Error(`Failed to load ticket types: ${ticketTypesError.message}`);
  }

  const typedEvent = event as EventRow;
  const organizer = getOrganizer(typedEvent.organizers);

  const allTicketTypes = (ticketTypes ?? []) as TicketTypeRow[];
  const typedTicketTypes = allTicketTypes
    .filter((ticket) => ticket.event_id === typedEvent.id)
    .filter((ticket) => isTicketCurrentlyAvailable(ticket));

  const availableFreeTickets = typedTicketTypes.filter(
    (ticket) => Number(ticket.price ?? 0) === 0
  );
  const registrationOpen = canRegisterForEvent(typedEvent);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">
              {organizer?.name ?? "Organizer"}
            </p>
            <h1 className="mt-1 text-4xl font-semibold tracking-tight text-slate-900">
              Register for {typedEvent.name}
            </h1>
            <p className="mt-3 text-slate-600">
              {typedEvent.short_description || "Complete your registration below."}
            </p>

            <div className="mt-4 space-y-1 text-sm text-slate-600">
              <p>{formatDateRange(typedEvent.start_date, typedEvent.end_date)}</p>
              <p>Registration opens: {formatDateTime(typedEvent.registration_opens_at)}</p>
              <p>Registration closes: {formatDateTime(typedEvent.registration_closes_at)}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/events/${typedEvent.slug}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Event
            </Link>
          </div>
        </div>
      </div>

      {!registrationOpen ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-6 py-5 text-amber-900">
          Registration is not currently open for this event.
        </div>
      ) : null}

      {registrationOpen && typedEvent.account_required_for_registration && !user ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-slate-900">Sign in required</h2>
          <p className="mt-2 text-sm text-slate-600">
            This event requires an account before registration can be completed.
          </p>

          <form action={startEventRegistrationSignInAction} className="mt-5">
            <input type="hidden" name="eventSlug" value={typedEvent.slug} />
            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Sign In to Continue
            </button>
          </form>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">Ticket Options</h2>

            {typedTicketTypes.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">
                No ticket types are available yet.
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                {typedTicketTypes.map((ticket) => (
                  <div key={ticket.id} className="rounded-2xl border bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-lg font-semibold text-slate-900">
                        {ticket.name}
                      </p>
                      <span className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                        {kindLabel(ticket.ticket_kind)}
                      </span>
                    </div>

                    <p className="mt-2 font-medium text-slate-900">
                      {formatCurrency(ticket.price, ticket.currency)}
                    </p>

                    {ticket.description ? (
                      <p className="mt-2 text-sm text-slate-600">
                        {ticket.description}
                      </p>
                    ) : null}

                    <div className="mt-3 text-sm text-slate-500">
                      Capacity: {ticket.capacity ?? "Unlimited"}
                    </div>

                    {Number(ticket.price ?? 0) > 0 ? (
                      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        Paid registration is coming soon. Free ticket types can be registered now.
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-900">Registration Form</h2>

            {!registrationOpen ? (
              <p className="mt-4 text-sm text-slate-500">
                Registration is closed or not open yet.
              </p>
            ) : typedEvent.account_required_for_registration && !user ? (
              <p className="mt-4 text-sm text-slate-500">
                Sign in to complete registration.
              </p>
            ) : availableFreeTickets.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">
                No free ticket options are currently available.
              </p>
            ) : (
              <RegistrationForm
                eventSlug={typedEvent.slug}
                ticketTypes={availableFreeTickets}
                currentUserEmail={user?.email ?? ""}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}