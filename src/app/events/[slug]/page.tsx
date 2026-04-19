import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import RegistrationForm from "./register/RegistrationForm";
import { retryEventRegistrationCheckoutAction } from "./register/actions";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";

type Params = Promise<{
  slug: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
  registration?: string;
}>;

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  short_description: string | null;
  description: string | null;
  venue_name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string;
  start_date: string;
  end_date: string;
  cover_image_url: string | null;
  visibility: string;
  featured: boolean;
  status: string;
  registration_required: boolean;
  account_required_for_registration: boolean;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  capacity: number | null;
  waitlist_enabled: boolean;
  refund_policy: string | null;
  faq: string | null;
  organizers:
    | {
        id?: string;
        name: string;
        slug: string;
        description?: string | null;
        website_url?: string | null;
        contact_email?: string | null;
      }
    | {
        id?: string;
        name: string;
        slug: string;
        description?: string | null;
        website_url?: string | null;
        contact_email?: string | null;
      }[]
    | null;
};

type TicketTypeRow = {
  id: string;
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

type EventTagRow = {
  id: string;
  tag: string;
};

type RetryRegistrationRow = {
  id: string;
  payment_status: string | null;
  attendee_email: string;
};

type TicketRegistrationCountRow = {
  ticket_type_id: string | null;
  status: string;
};

function getOrganizer(value: EventRow["organizers"]) {
  return Array.isArray(value) ? value[0] : value;
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

function eventTypeBadgeClass(value: string) {
  if (value === "group_class") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (value === "practice_party") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (value === "workshop") return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  if (value === "social_dance") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (value === "competition") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (value === "showcase") return "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-100";
  if (value === "festival") return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100";
  if (value === "special_event") return "bg-orange-50 text-orange-700 ring-1 ring-orange-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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

  return startDate === endDate ? startText : `${startText} – ${endText}`;
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

function isRegistrationOpen(event: EventRow) {
  const now = Date.now();

  if (!event.registration_required) return false;

  if (event.registration_opens_at && new Date(event.registration_opens_at).getTime() > now) {
    return false;
  }

  if (event.registration_closes_at && new Date(event.registration_closes_at).getTime() < now) {
    return false;
  }

  return true;
}

function registrationSectionHint(params: {
  eventType: string;
  registrationOpen: boolean;
  eventSoldOut: boolean;
  anyTicketAvailable: boolean;
  waitlistEnabled: boolean;
}) {
  const { eventType, registrationOpen, eventSoldOut, anyTicketAvailable, waitlistEnabled } = params;

  if (!registrationOpen) {
    return "Registration is not currently open for this event.";
  }

  if (!anyTicketAvailable && waitlistEnabled) {
    return "Ticket sales are currently full, but you can still join the waitlist without being charged.";
  }

  if (!anyTicketAvailable) {
    return "There are no ticket options currently available.";
  }

  if (eventSoldOut && waitlistEnabled) {
    return "This event is currently full, but the waitlist is open and you will not be charged to join it.";
  }

  if (eventSoldOut) {
    return "This event is currently sold out.";
  }

  if (eventType === "group_class") {
    return "Use registration to enroll in this class and reserve your spot.";
  }

  if (eventType === "practice_party") {
    return "Use registration to join this social offering and hold your spot.";
  }

  return "Use registration to reserve your spot for this event.";
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "registered") {
    return { kind: "success" as const, message: "Registration completed successfully." };
  }

  if (search.success === "paid") {
    return { kind: "success" as const, message: "Payment received. Your registration is confirmed." };
  }

  if (search.success === "waitlisted") {
    return { kind: "success" as const, message: "You were added to the waitlist. You have not been charged." };
  }

  if (search.error === "checkout_cancelled") {
    return { kind: "error" as const, message: "Checkout was cancelled. You can retry payment below." };
  }

  if (search.error === "checkout_session_failed") {
    return { kind: "error" as const, message: "Could not start Stripe Checkout. Please try again." };
  }

  return null;
}

function activeCountForTicket(ticketId: string, ticketCounts: Map<string, number>) {
  return ticketCounts.get(ticketId) ?? 0;
}

function ticketRemainingCount(ticket: TicketTypeRow, ticketCounts: Map<string, number>) {
  if (ticket.capacity == null) return null;
  return Math.max(ticket.capacity - activeCountForTicket(ticket.id, ticketCounts), 0);
}

function heroPrimaryCtaLabel(params: {
  registrationRequired: boolean;
  registrationOpen: boolean;
  allowWaitlistJoin: boolean;
}) {
  if (!params.registrationRequired) return "View Event Details";
  if (params.allowWaitlistJoin) return "Join Waitlist";
  if (!params.registrationOpen) return "View Registration Info";
  return "Register Now";
}

function accountNotice(params: {
  userEmail: string | undefined;
  accountRequiredForRegistration: boolean;
  registrationRequired: boolean;
}) {
  if (!params.registrationRequired) return null;

  if (params.userEmail) {
    return {
      kind: "signed_in" as const,
      title: "You are signed in",
      body: "You can continue with registration using your account.",
    };
  }

  if (params.accountRequiredForRegistration) {
    return {
      kind: "account_required" as const,
      title: "An account is required to register",
      body: "You can still view full event details now. Create a free account or log in before registering.",
    };
  }

  return {
    kind: "guest_allowed" as const,
    title: "You can view this event without an account",
    body: "Depending on the registration setup, you may be able to register as a guest or be asked to create a free account.",
  };
}

function InfoCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border bg-white/80 p-4 backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-base font-semibold text-slate-950">{value}</p>
      {detail ? <p className="mt-1 text-sm text-slate-600">{detail}</p> : null}
    </div>
  );
}

export default async function PublicEventDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const banner = getBanner(query);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select(`
      id,
      name,
      slug,
      event_type,
      short_description,
      description,
      venue_name,
      address_line_1,
      address_line_2,
      city,
      state,
      postal_code,
      timezone,
      start_date,
      end_date,
      cover_image_url,
      visibility,
      featured,
      status,
      registration_required,
      account_required_for_registration,
      registration_opens_at,
      registration_closes_at,
      capacity,
      waitlist_enabled,
      refund_policy,
      faq,
      organizers (
        id,
        name,
        slug,
        description,
        website_url,
        contact_email
      )
    `)
    .eq("slug", slug)
    .eq("status", "published")
    .in("visibility", ["public", "unlisted"])
    .single();

  if (eventError || !event) notFound();

  const typedEvent = event as EventRow;
  const organizer = getOrganizer(typedEvent.organizers);

  const [
    { data: tags, error: tagsError },
    { data: ticketTypes, error: ticketTypesError },
    { data: activeRegistrations, error: activeRegistrationsError },
    favoriteResult,
  ] = await Promise.all([
    supabase
      .from("event_tags")
      .select("id, tag")
      .eq("event_id", typedEvent.id)
      .order("tag", { ascending: true }),

    supabase
      .from("event_ticket_types")
      .select(`
        id,
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
      .eq("event_id", typedEvent.id)
      .eq("active", true)
      .order("price", { ascending: true })
      .order("name", { ascending: true }),

    supabase
      .from("event_registrations")
      .select("ticket_type_id, status")
      .eq("event_id", typedEvent.id)
      .not("status", "in", "(cancelled,waitlisted)"),

    user
      ? supabase
          .from("user_favorites")
          .select("id")
          .eq("user_id", user.id)
          .eq("event_id", typedEvent.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (tagsError) throw new Error(`Failed to load event tags: ${tagsError.message}`);
  if (ticketTypesError) throw new Error(`Failed to load ticket types: ${ticketTypesError.message}`);
  if (activeRegistrationsError) {
    throw new Error(`Failed to load event capacity summary: ${activeRegistrationsError.message}`);
  }
  if (favoriteResult?.error) {
    throw new Error(`Failed to load event favorite state: ${favoriteResult.error.message}`);
  }

  let retryRegistration: RetryRegistrationRow | null = null;

  if (query.registration) {
    const { data } = await supabase
      .from("event_registrations")
      .select("id, payment_status, attendee_email")
      .eq("id", query.registration)
      .eq("event_id", typedEvent.id)
      .maybeSingle();

    retryRegistration = (data as RetryRegistrationRow | null) ?? null;
  }

  const typedTags = (tags ?? []) as EventTagRow[];
  const allActiveTicketTypes = (ticketTypes ?? []) as TicketTypeRow[];
  const typedActiveRegistrations = (activeRegistrations ?? []) as TicketRegistrationCountRow[];
  const isFavorited = Boolean(favoriteResult?.data?.id);

  const activeRegistrationCount = typedActiveRegistrations.length;

  const ticketActiveCountById = new Map<string, number>();
  for (const row of typedActiveRegistrations) {
    if (!row.ticket_type_id) continue;
    ticketActiveCountById.set(row.ticket_type_id, (ticketActiveCountById.get(row.ticket_type_id) ?? 0) + 1);
  }

  const now = Date.now();

  const visibleTicketTypes = allActiveTicketTypes.filter((ticket) => {
    if (ticket.sale_starts_at && new Date(ticket.sale_starts_at).getTime() > now) return false;
    if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now) return false;
    return true;
  });

  const selectableTicketTypes = visibleTicketTypes.filter((ticket) => {
    const remaining = ticketRemainingCount(ticket, ticketActiveCountById);
    return remaining == null || remaining > 0;
  });

  const registrationOpen = isRegistrationOpen(typedEvent);

  const eventRemainingCapacity =
    typedEvent.capacity == null ? null : Math.max(typedEvent.capacity - activeRegistrationCount, 0);

  const eventSoldOut = typedEvent.capacity != null && activeRegistrationCount >= typedEvent.capacity;

  const anyTicketAvailable = selectableTicketTypes.length > 0;

  const allowWaitlistJoin =
    typedEvent.waitlist_enabled && registrationOpen && (eventSoldOut || !anyTicketAvailable);

  const topHint = registrationSectionHint({
    eventType: typedEvent.event_type,
    registrationOpen,
    eventSoldOut,
    anyTicketAvailable,
    waitlistEnabled: typedEvent.waitlist_enabled,
  });

  const accountStateNotice = accountNotice({
    userEmail: user?.email,
    accountRequiredForRegistration: typedEvent.account_required_for_registration,
    registrationRequired: typedEvent.registration_required,
  });

  const locationParts = [
    typedEvent.venue_name,
    typedEvent.address_line_1,
    typedEvent.address_line_2,
    [typedEvent.city, typedEvent.state, typedEvent.postal_code].filter(Boolean).join(" "),
  ].filter(Boolean);

  return (
    <>
      <PublicSiteHeader currentPath="events" isAuthenticated={!!user} />

      <main className="min-h-screen bg-slate-50">
        <section className="border-b bg-[linear-gradient(180deg,#f5f3ff_0%,#ffffff_22%,#f8fafc_100%)]">
          <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/discover/events"
                  className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Back to Events
                </Link>

                <Link
                  href="/discover/studios"
                  className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Browse Studios
                </Link>
              </div>

              {!user ? (
                <Link
                  href="/signup"
                  className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Create Free Account
                </Link>
              ) : null}
            </div>
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

      <section className="overflow-hidden rounded-[2rem] border border-slate-200/80 bg-white shadow-sm">
        <div className="relative">
          <div className="aspect-[16/7] w-full bg-slate-100">
            {typedEvent.cover_image_url ? (
              <img
                src={typedEvent.cover_image_url}
                alt={typedEvent.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_40%,#fff7ed_100%)] text-sm text-slate-500">
                Event image coming soon
              </div>
            )}
          </div>

          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-slate-950/20 to-transparent" />

          <div className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${eventTypeBadgeClass(
                      typedEvent.event_type
                    )}`}
                  >
                    {eventTypeLabel(typedEvent.event_type)}
                  </span>

                  {typedEvent.featured ? (
                    <span className="inline-flex rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-slate-800">
                      Featured
                    </span>
                  ) : null}

                  {typedEvent.registration_required ? (
                    <span className="inline-flex rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-slate-800">
                      Registration Required
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-slate-800">
                      Public Event
                    </span>
                  )}
                </div>

                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-5xl">
                    {typedEvent.name}
                  </h1>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-white/90 sm:text-base">
                    {typedEvent.short_description ||
                      typedEvent.description ||
                      "Public event details coming soon."}
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <a
                    href="#registration"
                    className="inline-flex rounded-xl bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-100"
                  >
                    {heroPrimaryCtaLabel({
                      registrationRequired: typedEvent.registration_required,
                      registrationOpen,
                      allowWaitlistJoin,
                    })}
                  </a>

                  {organizer?.website_url ? (
                    <a
                      href={organizer.website_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex rounded-xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                    >
                      Organizer Website
                    </a>
                  ) : null}
                </div>
              </div>

              <FavoriteButton
                targetType="event"
                targetId={typedEvent.id}
                initiallyFavorited={isFavorited}
                isAuthenticated={!!user}
                returnPath={`/events/${typedEvent.slug}`}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-slate-200/80 bg-slate-50/70 p-6 md:grid-cols-2 xl:grid-cols-4">
          <InfoCard
            label="Dates"
            value={formatDateRange(typedEvent.start_date, typedEvent.end_date)}
          />
          <InfoCard
            label="Timezone"
            value={typedEvent.timezone || "Timezone not set"}
          />
          <InfoCard
            label="Capacity"
            value={
              typedEvent.capacity == null
                ? "Open capacity"
                : `${activeRegistrationCount}/${typedEvent.capacity}`
            }
            detail={
              typedEvent.capacity == null
                ? "No overall attendance cap listed"
                : eventRemainingCapacity != null
                ? `${eventRemainingCapacity} spots remaining`
                : undefined
            }
          />
          <InfoCard
            label="Organizer"
            value={organizer?.name || "Organizer coming soon"}
            detail={organizer?.contact_email || undefined}
          />
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-[1.35fr_0.9fr]">
        <div className="space-y-8">
          <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-wrap gap-2">
              {typedTags.map((tag) => (
                <span
                  key={tag.id}
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
                >
                  {tag.tag}
                </span>
              ))}
            </div>

            <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950">
              Event Details
            </h2>

            <div className="mt-4 space-y-4 text-base leading-8 text-slate-700">
              {typedEvent.description ? (
                <p className="whitespace-pre-wrap">{typedEvent.description}</p>
              ) : (
                <p>Full public event details are coming soon.</p>
              )}
            </div>
          </section>

          <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Location</h2>

            <div className="mt-4 space-y-2 text-sm leading-7 text-slate-700">
              {locationParts.length > 0 ? (
                locationParts.map((part, index) => <p key={`${part}-${index}`}>{part}</p>)
              ) : (
                <p>Location details coming soon.</p>
              )}
            </div>
          </section>

          <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Ticket Options</h2>

            {allActiveTicketTypes.length === 0 ? (
              <p className="mt-4 text-sm leading-6 text-slate-600">No ticket types are available yet.</p>
            ) : (
              <div className="mt-5 space-y-4">
                {allActiveTicketTypes.map((ticket) => {
                  const remaining = ticketRemainingCount(ticket, ticketActiveCountById);
                  const ticketSoldOut = remaining !== null && remaining <= 0;
                  const saleOpen =
                    (!ticket.sale_starts_at || new Date(ticket.sale_starts_at).getTime() <= now) &&
                    (!ticket.sale_ends_at || new Date(ticket.sale_ends_at).getTime() >= now);

                  return (
                    <div key={ticket.id} className="rounded-2xl border bg-slate-50 p-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-950">{ticket.name}</h3>

                        {ticketSoldOut ? (
                          <span className="inline-flex rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">
                            Sold Out
                          </span>
                        ) : !saleOpen ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                            Not on sale
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">
                            Available
                          </span>
                        )}
                      </div>

                      <p className="mt-2 text-lg font-semibold text-slate-950">
                        {formatCurrency(ticket.price, ticket.currency)}
                      </p>

                      {ticket.description ? (
                        <p className="mt-2 text-sm leading-6 text-slate-600">{ticket.description}</p>
                      ) : null}

                      <div className="mt-3 space-y-1 text-sm text-slate-500">
                        <p>
                          Capacity: {ticket.capacity ?? "Unlimited"}
                          {remaining != null ? ` • ${remaining} left` : ""}
                        </p>
                        <p>Sale starts: {formatDateTime(ticket.sale_starts_at)}</p>
                        <p>Sale ends: {formatDateTime(ticket.sale_ends_at)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Refund Policy</h2>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                {typedEvent.refund_policy || "No refund policy has been provided."}
              </p>
            </div>

            <div className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">FAQ</h2>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                {typedEvent.faq || "No FAQ has been provided."}
              </p>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section
            id="registration"
            className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8"
          >
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
              {typedEvent.event_type === "group_class" ? "Enrollment" : "Registration"}
            </h2>

            <p className="mt-3 text-sm leading-6 text-slate-600">{topHint}</p>

            {accountStateNotice ? (
              <div
                className={`mt-5 rounded-2xl border p-4 text-sm ${
                  accountStateNotice.kind === "signed_in"
                    ? "border-green-200 bg-green-50 text-green-800"
                    : accountStateNotice.kind === "account_required"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                <p className="font-medium">{accountStateNotice.title}</p>
                <p className="mt-1">{accountStateNotice.body}</p>

                {!user && typedEvent.account_required_for_registration ? (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Link
                      href="/signup"
                      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      Create Free Account
                    </Link>
                    <Link
                      href="/login"
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Log In
                    </Link>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-5 grid gap-3">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Registration Opens</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedEvent.registration_opens_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Registration Closes</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedEvent.registration_closes_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Account Required</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedEvent.account_required_for_registration ? "Yes" : "No"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Capacity</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedEvent.capacity ?? "Not specified"}
                </p>
                {typedEvent.capacity != null ? (
                  <p className="mt-1 text-sm text-slate-500">{eventRemainingCapacity} spots remaining</p>
                ) : null}
              </div>
            </div>

            {eventSoldOut ? (
              <div
                className={`mt-5 rounded-2xl border p-4 text-sm ${
                  typedEvent.waitlist_enabled
                    ? "border-purple-200 bg-purple-50 text-purple-900"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                {typedEvent.waitlist_enabled
                  ? "This event is sold out, but the waitlist is open. Join the waitlist below and you will not be charged."
                  : "This event is sold out and the waitlist is not enabled."}
              </div>
            ) : null}

            {query.error === "checkout_cancelled" &&
            retryRegistration &&
            retryRegistration.payment_status !== "paid" ? (
              <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">Payment not completed</p>
                <p className="mt-1 text-sm text-amber-800">
                  Your registration was saved. Retry Stripe Checkout to finish payment.
                </p>

                <form action={retryEventRegistrationCheckoutAction} className="mt-4">
                  <input type="hidden" name="eventSlug" value={typedEvent.slug} />
                  <input type="hidden" name="registrationId" value={retryRegistration.id} />
                  <button
                    type="submit"
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                  >
                    Retry Payment
                  </button>
                </form>
              </div>
            ) : null}

            <div className="mt-6">
              {visibleTicketTypes.length > 0 ? (
                <RegistrationForm
                  eventSlug={typedEvent.slug}
                  ticketTypes={visibleTicketTypes}
                  currentUserEmail={user?.email ?? ""}
                  isSoldOut={eventSoldOut}
                  waitlistEnabled={typedEvent.waitlist_enabled}
                  accountRequiredForRegistration={typedEvent.account_required_for_registration}
                  isAuthenticated={!!user}
                />
              ) : allowWaitlistJoin ? (
                <RegistrationForm
                  eventSlug={typedEvent.slug}
                  ticketTypes={allActiveTicketTypes}
                  currentUserEmail={user?.email ?? ""}
                  isSoldOut={true}
                  waitlistEnabled={typedEvent.waitlist_enabled}
                  accountRequiredForRegistration={typedEvent.account_required_for_registration}
                  isAuthenticated={!!user}
                />
              ) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  Registration is not available yet because no active ticket types are currently on sale.
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[2rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Organizer</h2>

            <div className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
              <p className="text-base font-semibold text-slate-950">
                {organizer?.name || "Organizer coming soon"}
              </p>

              {organizer?.description ? (
                <p>{organizer.description}</p>
              ) : (
                <p>Organizer details coming soon.</p>
              )}
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              {organizer?.website_url ? (
                <a
                  href={organizer.website_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Visit Organizer Website
                </a>
              ) : null}

              {organizer?.contact_email ? (
                <a
                  href={`mailto:${organizer.contact_email}`}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Contact Organizer
                </a>
              ) : null}
            </div>
          </section>
        </div>
                    </div>
        </div>
      </section>
    </main>

    <PublicSiteFooter />
  </>
);
}