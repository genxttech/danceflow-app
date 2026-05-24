import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FavoriteButton from "@/components/public/FavoriteButton";
import ShareButton from "@/components/public/ShareButton";
import RegistrationForm from "./register/RegistrationForm";
import { retryEventRegistrationCheckoutAction } from "./register/actions";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import { JsonLd } from "@/components/seo/JsonLd";

type Params = Promise<{
  slug: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
  registration?: string;
  tab?: string;
}>;

type EventPublicTab =
  | "overview"
  | "tickets"
  | "schedule"
  | "private-lessons"
  | "location"
  | "details"
  | "host";

function normalizeEventPublicTab(
  value: string | undefined,
  fallback: EventPublicTab,
): EventPublicTab {
  switch (value) {
    case "tickets":
    case "schedule":
    case "private-lessons":
    case "location":
    case "details":
    case "host":
    case "overview":
      return value;
    default:
      return fallback;
  }
}

function publicTabClass(isActive: boolean) {
  return isActive
    ? "shrink-0 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm"
    : "shrink-0 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700";
}

function tabPanelClass(isActive: boolean, className: string) {
  return `${isActive ? "" : "hidden "}${className}`;
}

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
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
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
  studios:
    | {
        id?: string;
        name: string;
        slug?: string | null;
        public_name?: string | null;
        public_short_description?: string | null;
        public_about?: string | null;
        public_website_url?: string | null;
        public_email?: string | null;
        public_phone?: string | null;
        billing_plan?: string | null;
        subscription_status?: string | null;
        public_directory_enabled?: boolean | null;
      }
    | {
        id?: string;
        name: string;
        slug?: string | null;
        public_name?: string | null;
        public_short_description?: string | null;
        public_about?: string | null;
        public_website_url?: string | null;
        public_email?: string | null;
        public_phone?: string | null;
        billing_plan?: string | null;
        subscription_status?: string | null;
        public_directory_enabled?: boolean | null;
      }[]
    | null;
};

type EventLocationSessionRow = {
  session_date: string | null;
  start_time: string | null;
  end_time: string | null;
  session_label: string | null;
  series_label: string | null;
  capacity: number | null;
  sort_order: number | null;
};

type EventLocationRow = {
  id: string;
  location_name: string | null;
  venue_name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  capacity: number | null;
  sort_order: number | null;
  event_location_sessions: EventLocationSessionRow[] | null;
};

type EventScheduleItemRow = {
  schedule_date: string;
  start_time: string;
  end_time: string | null;
  title: string;
  description: string | null;
  presenter_name: string | null;
  location_label: string | null;
  sort_order: number | null;
};

type EventPrivateLessonSlotRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  price: number;
  location_label: string | null;
  status: string;
  payment_status: string;
  event_guest_coaches:
    | {
        id: string;
        name: string;
        bio: string | null;
        photo_url: string | null;
      }
    | {
        id: string;
        name: string;
        bio: string | null;
        photo_url: string | null;
      }[]
    | null;
};

type GroupedCoachSlots = {
  coach: {
    id: string;
    name: string;
    bio: string | null;
    photo_url: string | null;
  };
  slots: EventPrivateLessonSlotRow[];
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
  attendees_per_ticket: number | null;
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

const siteUrl = "https://www.idanceflow.com";

function absoluteUrl(value: string | null | undefined) {
  if (!value) return null;

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("/")) {
    return `${siteUrl}${value}`;
  }

  return `${siteUrl}/${value}`;
}

function eventDescription(event: EventRow) {
  return (
    event.short_description?.trim() ||
    event.description?.trim() ||
    `View ${event.name} event details, schedule, registration information, and host details on DanceFlow.`
  );
}

function eventLocationLabel(event: EventRow) {
  return (
    [event.venue_name, event.city, event.state].filter(Boolean).join(", ") ||
    "Location coming soon"
  );
}

function eventDateTimeForSchema(date: string | null, time: string | null) {
  if (!date) return undefined;
  return time ? `${date}T${time}` : date;
}

function getCoach(value: EventPrivateLessonSlotRow["event_guest_coaches"]) {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function formatSlotDateTimeRange(
  startsAt: string,
  endsAt: string,
  timeZone?: string,
) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Time coming soon";
  }

  const dateLabel = start.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });

  const startLabel = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });

  const endLabel = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });

  return `${dateLabel} · ${startLabel} – ${endLabel}`;
}

function formatSlotDateLabel(startsAt: string, timeZone?: string) {
  const start = new Date(startsAt);

  if (Number.isNaN(start.getTime())) {
    return "Date coming soon";
  }

  return start.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
}

function formatSlotTimeRange(
  startsAt: string,
  endsAt: string,
  timeZone?: string,
) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Time coming soon";
  }

  const startLabel = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });

  const endLabel = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });

  return `${startLabel} – ${endLabel}`;
}

function slotDateKey(startsAt: string, timeZone?: string) {
  const start = new Date(startsAt);

  if (Number.isNaN(start.getTime())) {
    return "unknown";
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(start);

  const map = new Map(parts.map((part) => [part.type, part.value]));

  return `${map.get("year")}-${map.get("month")}-${map.get("day")}`;
}

function groupPrivateLessonSlotsByDate(
  slots: EventPrivateLessonSlotRow[],
  timeZone?: string,
) {
  const groups = new Map<
    string,
    {
      dateLabel: string;
      slots: EventPrivateLessonSlotRow[];
    }
  >();

  for (const slot of slots) {
    const key = slotDateKey(slot.starts_at, timeZone);

    if (!groups.has(key)) {
      groups.set(key, {
        dateLabel: formatSlotDateLabel(slot.starts_at, timeZone),
        slots: [],
      });
    }

    groups.get(key)?.slots.push(slot);
  }

  return Array.from(groups.entries()).map(([dateKey, group]) => ({
    dateKey,
    dateLabel: group.dateLabel,
    slots: group.slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  }));
}

function groupPrivateLessonSlotsByCoach(slots: EventPrivateLessonSlotRow[]) {
  const groups = new Map<string, GroupedCoachSlots>();

  for (const slot of slots) {
    const coach = getCoach(slot.event_guest_coaches);
    if (!coach) continue;

    if (!groups.has(coach.id)) {
      groups.set(coach.id, {
        coach,
        slots: [],
      });
    }

    groups.get(coach.id)?.slots.push(slot);
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    slots: group.slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  }));
}

function hasActivePublicAccess(studio: {
  billing_plan?: string | null;
  subscription_status?: string | null;
}) {
  const status = (studio.subscription_status ?? "").trim().toLowerCase();

  return status === "active" || status === "trialing";
}

function getOrganizer(value: EventRow["organizers"]) {
  return Array.isArray(value) ? value[0] : value;
}

function getStudio(value: EventRow["studios"]) {
  return Array.isArray(value) ? value[0] : value;
}

function getEventHost(params: {
  organizer: ReturnType<typeof getOrganizer>;
  studio: ReturnType<typeof getStudio>;
}) {
  const { organizer, studio } = params;

  const name =
    organizer?.name ||
    studio?.public_name ||
    studio?.name ||
    "DanceFlow event host";

  const description =
    organizer?.description ||
    studio?.public_about ||
    studio?.public_short_description ||
    null;

  const websiteUrl =
    organizer?.website_url || studio?.public_website_url || null;
  const contactEmail = organizer?.contact_email || studio?.public_email || null;
  const hostType = organizer?.name ? "Organizer" : "Studio host";

  return {
    name,
    description,
    websiteUrl,
    contactEmail,
    hostType,
  };
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

function eventTypeBadgeClass(value: string) {
  if (value === "group_class")
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (value === "practice_party")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (value === "workshop")
    return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  if (value === "social_dance")
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (value === "competition")
    return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (value === "showcase")
    return "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-100";
  if (value === "festival")
    return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100";
  if (value === "special_event")
    return "bg-orange-50 text-orange-700 ring-1 ring-orange-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function formatDateRange(startDate: string, endDate: string | null) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate ?? startDate}T00:00:00`);

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

  return !endDate || startDate === endDate
    ? startText
    : `${startText} – ${endText}`;
}

function formatTime(value: string | null) {
  if (!value) return "";

  const date = new Date(`2000-01-01T${value}`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRange(startTime: string | null, endTime: string | null) {
  const start = formatTime(startTime);
  const end = formatTime(endTime);

  if (start && end) return `${start} – ${end}`;
  return start || end;
}

function weekdayPlural(startDate: string) {
  const date = new Date(`${startDate}T00:00:00`);
  return `${date.toLocaleDateString([], { weekday: "long" })}s`;
}

function seriesWeekCount(startDate: string, endDate: string | null) {
  if (!endDate) return null;

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end < start
  ) {
    return null;
  }

  const days = Math.round(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );

  return Math.floor(days / 7) + 1;
}

function formatEventSchedule(event: EventRow) {
  if (event.event_type !== "group_class") {
    return formatDateRange(event.start_date, event.end_date);
  }

  const timeRange = formatTimeRange(event.start_time, event.end_time);

  if (event.end_date) {
    const weeks = seriesWeekCount(event.start_date, event.end_date);

    return [
      weekdayPlural(event.start_date),
      formatDateRange(event.start_date, event.end_date),
      timeRange,
      weeks ? `${weeks}-week series` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return [
    weekdayPlural(event.start_date),
    `Starts ${formatDateRange(event.start_date, event.start_date)}`,
    timeRange,
    "Ongoing weekly class",
  ]
    .filter(Boolean)
    .join(" · ");
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

function formatSessionDate(value: string | null) {
  if (!value) return "Date coming soon";

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function eventLocationDisplayName(location: EventLocationRow) {
  return (
    location.location_name?.trim() || location.venue_name?.trim() || "Location"
  );
}

function eventLocationAddressParts(location: EventLocationRow) {
  return [
    location.venue_name && location.venue_name !== location.location_name
      ? location.venue_name
      : null,
    location.address_line_1,
    location.address_line_2,
    [location.city, location.state, location.postal_code]
      .filter(Boolean)
      .join(" "),
  ].filter(Boolean) as string[];
}

function sortLocationSessions(sessions: EventLocationSessionRow[] | null) {
  return (sessions ?? []).slice().sort((a, b) => {
    const sortA = Number(a.sort_order ?? 0);
    const sortB = Number(b.sort_order ?? 0);

    if (sortA !== sortB) return sortA - sortB;

    const dateA = `${a.session_date ?? ""} ${a.start_time ?? ""}`;
    const dateB = `${b.session_date ?? ""} ${b.start_time ?? ""}`;

    return dateA.localeCompare(dateB);
  });
}

function groupScheduleItemsByDate(items: EventScheduleItemRow[]) {
  const grouped = new Map<string, EventScheduleItemRow[]>();

  items.forEach((item) => {
    const key = item.schedule_date || "Schedule";
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  });

  return Array.from(grouped.entries()).map(([date, dateItems]) => ({
    date,
    items: dateItems.slice().sort((a, b) => {
      const timeCompare = (a.start_time ?? "").localeCompare(
        b.start_time ?? "",
      );
      if (timeCompare !== 0) return timeCompare;
      return Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0);
    }),
  }));
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

  if (
    event.registration_opens_at &&
    new Date(event.registration_opens_at).getTime() > now
  ) {
    return false;
  }

  if (
    event.registration_closes_at &&
    new Date(event.registration_closes_at).getTime() < now
  ) {
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
  const {
    eventType,
    registrationOpen,
    eventSoldOut,
    anyTicketAvailable,
    waitlistEnabled,
  } = params;

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
    return {
      kind: "success" as const,
      message: "Registration completed successfully.",
    };
  }

  if (search.success === "paid") {
    return {
      kind: "success" as const,
      message: "Payment received. Your registration is confirmed.",
    };
  }

  if (search.success === "waitlisted") {
    return {
      kind: "success" as const,
      message: "You were added to the waitlist. You have not been charged.",
    };
  }

  if (search.error === "checkout_cancelled") {
    return {
      kind: "error" as const,
      message: "Checkout was cancelled. You can retry payment below.",
    };
  }

  if (search.error === "checkout_session_failed") {
    return {
      kind: "error" as const,
      message: "Could not start Stripe Checkout. Please try again.",
    };
  }

  return null;
}

function activeCountForTicket(
  ticketId: string,
  ticketCounts: Map<string, number>,
) {
  return ticketCounts.get(ticketId) ?? 0;
}

function ticketRemainingCount(
  ticket: TicketTypeRow,
  ticketCounts: Map<string, number>,
) {
  if (ticket.capacity == null) return null;
  return Math.max(
    ticket.capacity - activeCountForTicket(ticket.id, ticketCounts),
    0,
  );
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
    <div className="group rounded-3xl border border-white/70 bg-white/85 p-4 shadow-sm ring-1 ring-slate-100 backdrop-blur transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="mb-3 h-1.5 w-12 rounded-full bg-gradient-to-r from-orange-400 via-fuchsia-500 to-violet-600" />
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-base font-semibold text-slate-950">{value}</p>
      {detail ? (
        <p className="mt-1 text-sm leading-6 text-slate-600">{detail}</p>
      ) : null}
    </div>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: event } = await supabase
    .from("events")
    .select(
      `
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
      start_time,
      end_time,
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
      ),
      studios (
        id,
        name,
        slug,
        public_name,
        public_short_description,
        public_about,
        public_website_url,
        public_email,
        public_phone,
        public_directory_enabled,
        billing_plan,
        subscription_status
      )
    `,
    )
    .eq("slug", slug)
    .eq("status", "published")
    .in("visibility", ["public", "unlisted"])
    .maybeSingle<EventRow>();

  if (!event) {
    return {
      title: "Event | DanceFlow",
      description:
        "Explore public dance events, classes, workshops, competitions, showcases, and registration options on DanceFlow.",
    };
  }

  const canonicalUrl = `${siteUrl}/events/${event.slug}`;
  const studio = getStudio(event.studios);

  if (studio && !hasActivePublicAccess(studio)) {
    return {
      title: "Event | DanceFlow",
      description:
        "Explore public dance events, classes, workshops, competitions, showcases, and registration options on DanceFlow.",
    };
  }

  const description = eventDescription(event);
  const location = eventLocationLabel(event);
  const eventType = eventTypeLabel(event.event_type);
  const imageUrl =
    absoluteUrl(event.cover_image_url) ||
    `${siteUrl}/brand/danceflow-home-hero.png`;

  return {
    title: `${event.name} | ${eventType}${
      location !== "Location coming soon" ? ` in ${location}` : ""
    }`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${event.name} | DanceFlow Event`,
      description,
      url: canonicalUrl,
      siteName: "DanceFlow",
      type: "website",
      images: [
        {
          url: imageUrl,
          alt: `${event.name} on DanceFlow`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${event.name} | DanceFlow Event`,
      description,
      images: [imageUrl],
    },
  };
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
  const defaultEventTab: EventPublicTab =
    query.success || query.error || query.registration ? "tickets" : "overview";
  const activeEventTab = normalizeEventPublicTab(query.tab, defaultEventTab);

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select(
      `
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
      start_time,
      end_time,
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
      ),
      studios (
        id,
        name,
        slug,
        public_name,
        public_short_description,
        public_about,
        public_website_url,
        public_email,
        public_phone,
        public_directory_enabled,
        billing_plan,
        subscription_status
      )
    `,
    )
    .eq("slug", slug)
    .eq("status", "published")
    .in("visibility", ["public", "unlisted"])
    .single();

  if (eventError || !event) notFound();

  const typedEvent = event as EventRow;
  const organizer = getOrganizer(typedEvent.organizers);
  const studio = getStudio(typedEvent.studios);

  if (studio && !hasActivePublicAccess(studio)) notFound();

  const eventHost = getEventHost({ organizer, studio });

  const nowIso = new Date().toISOString();

  await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "available",
      payment_status: "unpaid",
      buyer_name: null,
      buyer_email: null,
      buyer_phone: null,
      buyer_notes: null,
      client_id: null,
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: null,
      booked_at: null,
      held_until: null,
      hold_token: null,
      updated_at: nowIso,
    })
    .eq("event_id", typedEvent.id)
    .eq("status", "held")
    .lt("held_until", nowIso);

  const [
    { data: tags, error: tagsError },
    { data: ticketTypes, error: ticketTypesError },
    { data: activeRegistrations, error: activeRegistrationsError },
    { data: eventLocations, error: eventLocationsError },
    { data: eventScheduleItems, error: eventScheduleItemsError },
    { data: privateLessonSlots, error: privateLessonSlotsError },
    favoriteResult,
  ] = await Promise.all([
    supabase
      .from("event_tags")
      .select("id, tag")
      .eq("event_id", typedEvent.id)
      .order("tag", { ascending: true }),

    supabase
      .from("event_ticket_types")
      .select(
        `
        id,
        name,
        description,
        ticket_kind,
        price,
        currency,
        capacity,
        active,
        sale_starts_at,
        sale_ends_at,
        attendees_per_ticket
      `,
      )
      .eq("event_id", typedEvent.id)
      .eq("active", true)
      .order("price", { ascending: true })
      .order("name", { ascending: true }),

    supabase
      .from("event_registrations")
      .select("ticket_type_id, status")
      .eq("event_id", typedEvent.id)
      .not("status", "in", "(cancelled,waitlisted)"),

    supabase
      .from("event_locations")
      .select(
        `
        id,
        location_name,
        venue_name,
        address_line_1,
        address_line_2,
        city,
        state,
        postal_code,
        country,
        capacity,
        sort_order,
        event_location_sessions (
          session_date,
          start_time,
          end_time,
          session_label,
          series_label,
          capacity,
          sort_order
        )
      `,
      )
      .eq("event_id", typedEvent.id)
      .order("sort_order", { ascending: true }),

    supabase
      .from("event_schedule_items")
      .select(
        `
        schedule_date,
        start_time,
        end_time,
        title,
        description,
        presenter_name,
        location_label,
        sort_order
      `,
      )
      .eq("event_id", typedEvent.id)
      .eq("active", true)
      .order("schedule_date", { ascending: true })
      .order("start_time", { ascending: true })
      .order("sort_order", { ascending: true }),

    supabase
      .from("event_private_lesson_slots")
      .select(
        `
        id,
        starts_at,
        ends_at,
        price,
        location_label,
        status,
        payment_status,
        event_guest_coaches:coach_id (
          id,
          name,
          bio,
          photo_url
        )
      `,
      )
      .eq("event_id", typedEvent.id)
      .eq("status", "available")
      .eq("payment_status", "unpaid")
      .order("starts_at", { ascending: true }),

    user
      ? supabase
          .from("user_favorites")
          .select("id")
          .eq("user_id", user.id)
          .eq("event_id", typedEvent.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (tagsError)
    throw new Error(`Failed to load event tags: ${tagsError.message}`);
  if (ticketTypesError)
    throw new Error(`Failed to load ticket types: ${ticketTypesError.message}`);
  if (activeRegistrationsError) {
    throw new Error(
      `Failed to load event capacity summary: ${activeRegistrationsError.message}`,
    );
  }
  if (eventLocationsError) {
    throw new Error(
      `Failed to load event locations: ${eventLocationsError.message}`,
    );
  }
  if (eventScheduleItemsError) {
    throw new Error(
      `Failed to load event schedule: ${eventScheduleItemsError.message}`,
    );
  }
  if (privateLessonSlotsError) {
    throw new Error(
      `Failed to load private lesson slots: ${privateLessonSlotsError.message}`,
    );
  }
  if (favoriteResult?.error) {
    throw new Error(
      `Failed to load event favorite state: ${favoriteResult.error.message}`,
    );
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
  const typedActiveRegistrations = (activeRegistrations ??
    []) as TicketRegistrationCountRow[];
  const typedEventLocations = ((eventLocations ?? []) as EventLocationRow[])
    .slice()
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
  const hasDetailedLocations = typedEventLocations.length > 0;
  const typedEventScheduleItems = (
    (eventScheduleItems ?? []) as EventScheduleItemRow[]
  )
    .slice()
    .sort((a, b) => {
      const dateCompare = (a.schedule_date ?? "").localeCompare(
        b.schedule_date ?? "",
      );
      if (dateCompare !== 0) return dateCompare;
      const timeCompare = (a.start_time ?? "").localeCompare(
        b.start_time ?? "",
      );
      if (timeCompare !== 0) return timeCompare;
      return Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0);
    });
  const groupedScheduleItems = groupScheduleItemsByDate(
    typedEventScheduleItems,
  );
  const typedPrivateLessonSlots = (
    (privateLessonSlots ?? []) as EventPrivateLessonSlotRow[]
  )
    .slice()
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const privateLessonSlotGroups = groupPrivateLessonSlotsByCoach(
    typedPrivateLessonSlots,
  );
  const isFavorited = Boolean(favoriteResult?.data?.id);

  const activeRegistrationCount = typedActiveRegistrations.length;

  const ticketActiveCountById = new Map<string, number>();
  for (const row of typedActiveRegistrations) {
    if (!row.ticket_type_id) continue;
    ticketActiveCountById.set(
      row.ticket_type_id,
      (ticketActiveCountById.get(row.ticket_type_id) ?? 0) + 1,
    );
  }

  const now = Date.now();

  const visibleTicketTypes = allActiveTicketTypes.filter((ticket) => {
    if (
      ticket.sale_starts_at &&
      new Date(ticket.sale_starts_at).getTime() > now
    )
      return false;
    if (ticket.sale_ends_at && new Date(ticket.sale_ends_at).getTime() < now)
      return false;
    return true;
  });

  const selectableTicketTypes = visibleTicketTypes.filter((ticket) => {
    const remaining = ticketRemainingCount(ticket, ticketActiveCountById);
    return remaining == null || remaining > 0;
  });

  const registrationOpen = isRegistrationOpen(typedEvent);

  const eventRemainingCapacity =
    typedEvent.capacity == null
      ? null
      : Math.max(typedEvent.capacity - activeRegistrationCount, 0);

  const eventSoldOut =
    typedEvent.capacity != null &&
    activeRegistrationCount >= typedEvent.capacity;

  const anyTicketAvailable = selectableTicketTypes.length > 0;

  const allowWaitlistJoin =
    typedEvent.waitlist_enabled &&
    registrationOpen &&
    (eventSoldOut || !anyTicketAvailable);

  const topHint = registrationSectionHint({
    eventType: typedEvent.event_type,
    registrationOpen,
    eventSoldOut,
    anyTicketAvailable,
    waitlistEnabled: typedEvent.waitlist_enabled,
  });

  const accountStateNotice = accountNotice({
    userEmail: user?.email,
    accountRequiredForRegistration:
      typedEvent.account_required_for_registration,
    registrationRequired: typedEvent.registration_required,
  });

  const locationParts = [
    typedEvent.venue_name,
    typedEvent.address_line_1,
    typedEvent.address_line_2,
    [typedEvent.city, typedEvent.state, typedEvent.postal_code]
      .filter(Boolean)
      .join(" "),
  ].filter(Boolean);

  const eventPublicUrl = `${siteUrl}/events/${typedEvent.slug}`;
  const eventImageUrl =
    absoluteUrl(typedEvent.cover_image_url) ||
    `${siteUrl}/brand/danceflow-home-hero.png`;

  const eventAddressJsonLd =
    typedEvent.address_line_1 ||
    typedEvent.city ||
    typedEvent.state ||
    typedEvent.postal_code
      ? {
          "@type": "PostalAddress",
          streetAddress:
            [typedEvent.address_line_1, typedEvent.address_line_2]
              .filter(Boolean)
              .join(" ") || undefined,
          addressLocality: typedEvent.city ?? undefined,
          addressRegion: typedEvent.state ?? undefined,
          postalCode: typedEvent.postal_code ?? undefined,
          addressCountry: "US",
        }
      : undefined;

  const eventOffersJsonLd = visibleTicketTypes.map((ticket) => ({
    "@type": "Offer",
    name: ticket.name,
    description: ticket.description ?? undefined,
    price: Number(ticket.price ?? 0),
    priceCurrency: ticket.currency || "USD",
    availability:
      ticketRemainingCount(ticket, ticketActiveCountById) === 0
        ? "https://schema.org/SoldOut"
        : "https://schema.org/InStock",
    validFrom: ticket.sale_starts_at ?? undefined,
    url: `${eventPublicUrl}#registration`,
  }));

  const eventJsonLd = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: typedEvent.name,
    description: eventDescription(typedEvent),
    url: eventPublicUrl,
    image: eventImageUrl,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    startDate: eventDateTimeForSchema(
      typedEvent.start_date,
      typedEvent.start_time,
    ),
    endDate:
      eventDateTimeForSchema(typedEvent.end_date, typedEvent.end_time) ||
      eventDateTimeForSchema(typedEvent.start_date, typedEvent.end_time),
    location: {
      "@type": "Place",
      name: typedEvent.venue_name || eventLocationLabel(typedEvent),
      address: eventAddressJsonLd,
    },
    organizer: {
      "@type": "Organization",
      name: eventHost.name,
      url: eventHost.websiteUrl ?? undefined,
      email: eventHost.contactEmail ?? undefined,
    },
    offers: eventOffersJsonLd.length ? eventOffersJsonLd : undefined,
    keywords: typedTags.map((tag) => tag.tag).join(", ") || undefined,
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: siteUrl,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Events",
        item: `${siteUrl}/discover/events`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: typedEvent.name,
        item: eventPublicUrl,
      },
    ],
  };

  const eventTabs: { key: EventPublicTab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "tickets", label: typedEvent.event_type === "group_class" ? "Enrollment" : "Tickets" },
    ...(groupedScheduleItems.length > 0
      ? [{ key: "schedule" as EventPublicTab, label: "Schedule" }]
      : []),
    ...(privateLessonSlotGroups.length > 0
      ? [{ key: "private-lessons" as EventPublicTab, label: "Private Lessons" }]
      : []),
    { key: "location", label: "Location" },
    { key: "details", label: "Details" },
    { key: "host", label: "Host" },
  ];

  return (
    <>
      <JsonLd data={[eventJsonLd, breadcrumbJsonLd]} />

      <PublicSiteHeader currentPath="events" isAuthenticated={!!user} />

      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#fff7ed_0%,transparent_32%),radial-gradient(circle_at_top_right,#ede9fe_0%,transparent_34%),linear-gradient(180deg,#f8fafc_0%,#ffffff_42%,#f8fafc_100%)]">
        <section className="relative overflow-hidden border-b border-white/70">
          <div className="pointer-events-none absolute left-[-8rem] top-16 h-80 w-80 rounded-full bg-orange-200/40 blur-3xl" />
          <div className="pointer-events-none absolute right-[-8rem] top-40 h-96 w-96 rounded-full bg-violet-200/45 blur-3xl" />
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

            <section className="relative overflow-hidden rounded-[2rem] border border-white/70 bg-white/90 shadow-2xl shadow-slate-200/70 ring-1 ring-slate-100 backdrop-blur">
              <div className="relative">
                <div className="aspect-[4/3] w-full bg-slate-100 sm:aspect-[16/7]">
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

                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/35 to-orange-500/10" />
                <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-slate-950/80 to-transparent" />

                <div className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-4">
                      <div className="flex flex-wrap gap-2">
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold shadow-sm ${eventTypeBadgeClass(
                            typedEvent.event_type,
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
                        <Link
                          href={`/events/${typedEvent.slug}?tab=tickets`}
                          className="inline-flex rounded-xl bg-gradient-to-r from-orange-500 via-fuchsia-500 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-fuchsia-950/20 transition hover:scale-[1.01]"
                        >
                          {heroPrimaryCtaLabel({
                            registrationRequired:
                              typedEvent.registration_required,
                            registrationOpen,
                            allowWaitlistJoin,
                          })}
                        </Link>

                        {eventHost.websiteUrl ? (
                          <a
                            href={eventHost.websiteUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex rounded-xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                          >
                            Host Website
                          </a>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <ShareButton
                        title={typedEvent.name}
                        text={`Check out ${typedEvent.name} on DanceFlow.`}
                        url={`/events/${typedEvent.slug}`}
                        label="Share Event"
                        className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-white/15"
                      />
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
              </div>

              <div className="grid gap-4 border-t border-white/70 bg-gradient-to-r from-orange-50 via-white to-violet-50 p-5 sm:grid-cols-2 lg:grid-cols-4">
                <InfoCard
                  label="Schedule"
                  value={formatEventSchedule(typedEvent)}
                  detail={
                    formatTimeRange(
                      typedEvent.start_time,
                      typedEvent.end_time,
                    ) || typedEvent.timezone
                  }
                />
                <InfoCard
                  label="Location"
                  value={
                    hasDetailedLocations
                      ? typedEventLocations.length === 1
                        ? eventLocationDisplayName(typedEventLocations[0])
                        : `${typedEventLocations.length} locations`
                      : typedEvent.venue_name || "Location coming soon"
                  }
                  detail={
                    hasDetailedLocations && typedEventLocations.length > 1
                      ? "See dates and locations below"
                      : [typedEvent.city, typedEvent.state]
                          .filter(Boolean)
                          .join(", ")
                  }
                />
                <InfoCard
                  label="Capacity"
                  value={
                    typedEvent.capacity
                      ? `${activeRegistrationCount}/${typedEvent.capacity}`
                      : "Open"
                  }
                  detail={
                    eventRemainingCapacity != null
                      ? `${eventRemainingCapacity} spots remaining`
                      : undefined
                  }
                />
                <InfoCard
                  label="Hosted by"
                  value={eventHost.name}
                  detail={eventHost.contactEmail || eventHost.hostType}
                />
              </div>
            </section>

            <nav
              aria-label="Event page sections"
              className="sticky top-0 z-20 -mx-4 border-y border-white/70 bg-white/90 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/75 sm:-mx-6 sm:px-6 lg:top-0 lg:-mx-8 lg:px-8"
            >
              <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {eventTabs.map((tab) => (
                  <Link
                    key={tab.key}
                    href={`/events/${typedEvent.slug}?tab=${tab.key}`}
                    aria-current={activeEventTab === tab.key ? "page" : undefined}
                    className={publicTabClass(activeEventTab === tab.key)}
                  >
                    {tab.label}
                  </Link>
                ))}
              </div>
            </nav>

            <div className="grid gap-8">
              <div className="space-y-8">
                <section id="overview" className={tabPanelClass(activeEventTab === "overview", "scroll-mt-24 rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur sm:p-8")}>
                  <div className="flex flex-wrap gap-2">
                    {typedTags.map((tag) => (
                      <span
                        key={tag.id}
                        className="rounded-full border border-orange-100 bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700"
                      >
                        {tag.tag}
                      </span>
                    ))}
                  </div>

                  <div className="mt-5 flex items-center gap-3">
                    <div className="h-10 w-1.5 rounded-full bg-gradient-to-b from-orange-400 via-fuchsia-500 to-violet-600" />
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      Event Details
                    </h2>
                  </div>

                  <div className="mt-4 space-y-4 text-base leading-8 text-slate-700">
                    {typedEvent.description ? (
                      <p className="whitespace-pre-wrap">
                        {typedEvent.description}
                      </p>
                    ) : (
                      <p>Full public event details are coming soon.</p>
                    )}
                  </div>
                </section>

                {groupedScheduleItems.length > 0 ? (
                  <section id="schedule" className={tabPanelClass(activeEventTab === "schedule", "scroll-mt-24 rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur sm:p-8")}>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                        Agenda
                      </p>
                      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                        Event Schedule
                      </h2>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Times and details are provided by the event host and may
                        change.
                      </p>
                    </div>

                    <div className="mt-6 space-y-6">
                      {groupedScheduleItems.map((group) => (
                        <div
                          key={group.date}
                          className="rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-violet-50/40 p-5 shadow-sm"
                        >
                          <h3 className="text-base font-semibold text-slate-950">
                            {formatSessionDate(group.date)}
                          </h3>

                          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                            {group.items.map((item, itemIndex) => (
                              <div
                                key={`${group.date}-${item.start_time}-${item.title}-${itemIndex}`}
                                className="border-b border-slate-100 px-4 py-4 last:border-b-0"
                              >
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                    <h4 className="text-sm font-semibold text-slate-950">
                                      {item.title}
                                    </h4>
                                    {item.presenter_name ? (
                                      <p className="mt-1 text-sm text-slate-600">
                                        with {item.presenter_name}
                                      </p>
                                    ) : null}
                                    {item.location_label ? (
                                      <p className="mt-1 text-sm text-slate-600">
                                        {item.location_label}
                                      </p>
                                    ) : null}
                                  </div>

                                  <p className="text-sm font-semibold text-slate-700">
                                    {formatTimeRange(
                                      item.start_time,
                                      item.end_time,
                                    ) || "Time coming soon"}
                                  </p>
                                </div>

                                {item.description ? (
                                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                                    {item.description}
                                  </p>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                <section id="location" className={tabPanelClass(activeEventTab === "location", "scroll-mt-24 rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur sm:p-8")}>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    {hasDetailedLocations ? "Dates & Locations" : "Location"}
                  </h2>

                  {hasDetailedLocations ? (
                    <div className="mt-5 space-y-5">
                      {typedEventLocations.map((location, index) => {
                        const sessions = sortLocationSessions(
                          location.event_location_sessions,
                        );
                        const addressParts =
                          eventLocationAddressParts(location);

                        return (
                          <div
                            key={location.id}
                            className="rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-orange-50/40 p-5 shadow-sm"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                  Location {index + 1}
                                </p>
                                <h3 className="mt-1 text-lg font-semibold text-slate-950">
                                  {eventLocationDisplayName(location)}
                                </h3>
                              </div>

                              {location.capacity != null ? (
                                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                                  Capacity {location.capacity}
                                </span>
                              ) : null}
                            </div>

                            {addressParts.length > 0 ? (
                              <div className="mt-3 space-y-1 text-sm leading-6 text-slate-600">
                                {addressParts.map((part, addressIndex) => (
                                  <p
                                    key={`${location.id}-address-${addressIndex}`}
                                  >
                                    {part}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-3 text-sm text-slate-500">
                                Address details coming soon.
                              </p>
                            )}

                            <div className="mt-5">
                              <p className="text-sm font-semibold text-slate-900">
                                {typedEvent.event_type === "group_class"
                                  ? "Class dates"
                                  : "Event dates"}
                              </p>

                              {sessions.length > 0 ? (
                                <div className="mt-3 divide-y rounded-xl border bg-white">
                                  {sessions.map((session, sessionIndex) => (
                                    <div
                                      key={`${location.id}-session-${sessionIndex}`}
                                      className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                                    >
                                      <div>
                                        <p className="text-sm font-medium text-slate-950">
                                          {session.session_label ||
                                            session.series_label ||
                                            `Session ${sessionIndex + 1}`}
                                        </p>
                                        <p className="text-sm text-slate-600">
                                          {formatSessionDate(
                                            session.session_date,
                                          )}
                                        </p>
                                      </div>

                                      <p className="text-sm font-medium text-slate-700">
                                        {formatTimeRange(
                                          session.start_time,
                                          session.end_time,
                                        ) || "Time coming soon"}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="mt-3 text-sm text-slate-500">
                                  Dates for this location are coming soon.
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-4 space-y-2 text-sm leading-7 text-slate-700">
                      {locationParts.length > 0 ? (
                        locationParts.map((part, index) => (
                          <p key={`${part}-${index}`}>{part}</p>
                        ))
                      ) : (
                        <p>Location details coming soon.</p>
                      )}
                    </div>
                  )}
                </section>

                {privateLessonSlotGroups.length > 0 ? (
                  <section id="private-lessons" className={tabPanelClass(activeEventTab === "private-lessons", "scroll-mt-24 rounded-[2rem] border border-purple-100 bg-white p-5 shadow-sm sm:p-8")}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-600">
                          Add-on lessons
                        </p>
                        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                          Guest Coach Private Lessons
                        </h2>
                      </div>
                      <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">
                        Limited slots
                      </span>
                    </div>

                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      Reserve a private lesson with a guest coach. Choose one or
                      more available times, then complete one checkout in the
                      ticket checkout section below.
                    </p>

                    <div className="mt-6 space-y-4">
                      {privateLessonSlotGroups.map(({ coach, slots }) => {
                        const groupedSlots = groupPrivateLessonSlotsByDate(
                          slots,
                          typedEvent.timezone,
                        );
                        const prices = slots.map((slot) =>
                          Number(slot.price ?? 0),
                        );
                        const minPrice = Math.min(...prices);
                        const maxPrice = Math.max(...prices);
                        const priceLabel =
                          minPrice === maxPrice
                            ? formatCurrency(minPrice, "USD")
                            : `${formatCurrency(minPrice, "USD")} – ${formatCurrency(maxPrice, "USD")}`;

                        return (
                          <details
                            key={coach.id}
                            className="group rounded-2xl border bg-slate-50 p-4 open:bg-white sm:p-5"
                          >
                            <summary className="flex cursor-pointer list-none items-start justify-between gap-4">
                              <div className="flex min-w-0 gap-3 sm:gap-4">
                                {coach.photo_url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={coach.photo_url}
                                    alt=""
                                    className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-slate-200 sm:h-20 sm:w-20"
                                  />
                                ) : (
                                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-purple-50 text-lg font-semibold text-purple-700 ring-1 ring-purple-100 sm:h-20 sm:w-20">
                                    {coach.name.slice(0, 1).toUpperCase()}
                                  </div>
                                )}

                                <div className="min-w-0">
                                  <h3 className="text-base font-semibold text-slate-950 sm:text-lg">
                                    {coach.name}
                                  </h3>
                                  <p className="mt-1 text-sm text-slate-600">
                                    {slots.length} available{" "}
                                    {slots.length === 1 ? "slot" : "slots"} ·{" "}
                                    {priceLabel}
                                  </p>
                                  {coach.bio ? (
                                    <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600 group-open:line-clamp-none">
                                      {coach.bio}
                                    </p>
                                  ) : null}
                                </div>
                              </div>

                              <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 group-open:bg-slate-950 group-open:text-white">
                                <span className="group-open:hidden">
                                  View times
                                </span>
                                <span className="hidden group-open:inline">
                                  Hide
                                </span>
                              </span>
                            </summary>

                            <div className="mt-5 space-y-5">
                              {groupedSlots.map((dateGroup) => (
                                <div key={`${coach.id}-${dateGroup.dateKey}`}>
                                  <h4 className="text-sm font-semibold text-slate-950">
                                    {dateGroup.dateLabel}
                                  </h4>

                                  <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                    {dateGroup.slots.map((slot) => (
                                      <details
                                        key={slot.id}
                                        className="group/slot rounded-2xl border bg-white p-3 open:border-purple-200 open:bg-purple-50/30"
                                      >
                                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                                          <div>
                                            <p className="text-sm font-semibold text-slate-950">
                                              {formatSlotTimeRange(
                                                slot.starts_at,
                                                slot.ends_at,
                                                typedEvent.timezone,
                                              )}
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                              {slot.location_label ||
                                                "Location shared by organizer"}
                                            </p>
                                          </div>
                                          <div className="text-right">
                                            <p className="text-sm font-semibold text-slate-950">
                                              {formatCurrency(
                                                slot.price,
                                                "USD",
                                              )}
                                            </p>
                                            <p className="mt-1 text-xs font-medium text-purple-700 group-open/slot:hidden">
                                              Select
                                            </p>
                                            <p className="mt-1 hidden text-xs font-medium text-purple-700 group-open/slot:block">
                                              Selected
                                            </p>
                                          </div>
                                        </summary>

                                        <div className="mt-4 border-t pt-4">
                                          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-purple-100 bg-white p-3 transition hover:border-purple-300">
                                            <input
                                              form="event-cart-checkout-form"
                                              type="checkbox"
                                              name="slotIds"
                                              value={slot.id}
                                              data-cart-item="coach-slot"
                                              data-coach-name={coach.name}
                                              data-slot-label={formatSlotDateTimeRange(
                                                slot.starts_at,
                                                slot.ends_at,
                                                typedEvent.timezone,
                                              )}
                                              data-slot-price={Number(
                                                slot.price ?? 0,
                                              )}
                                              className="mt-1 h-4 w-4 rounded border-slate-300 text-purple-700"
                                            />
                                            <span className="min-w-0 flex-1">
                                              <span className="block text-sm font-semibold text-slate-950">
                                                Add this coach lesson to
                                                checkout
                                              </span>
                                              <span className="mt-1 block text-xs leading-5 text-slate-600">
                                                {coach.name} ·{" "}
                                                {formatSlotDateTimeRange(
                                                  slot.starts_at,
                                                  slot.ends_at,
                                                  typedEvent.timezone,
                                                )}
                                              </span>
                                              <span className="mt-1 block text-xs text-slate-500">
                                                Select more than one coach
                                                lesson if needed, then pay once
                                                in the ticket checkout section.
                                              </span>
                                            </span>
                                          </label>
                                        </div>
                                      </details>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </section>
                ) : null}

                <section id="tickets" className={tabPanelClass(activeEventTab === "tickets", "scroll-mt-24 rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur sm:p-8")}>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Ticket Options
                  </h2>

                  {allActiveTicketTypes.length === 0 ? (
                    <p className="mt-4 text-sm leading-6 text-slate-600">
                      No ticket types are available yet.
                    </p>
                  ) : (
                    <div className="mt-5 space-y-4">
                      {allActiveTicketTypes.map((ticket) => {
                        const remaining = ticketRemainingCount(
                          ticket,
                          ticketActiveCountById,
                        );
                        const ticketSoldOut =
                          remaining !== null && remaining <= 0;
                        const saleOpen =
                          (!ticket.sale_starts_at ||
                            new Date(ticket.sale_starts_at).getTime() <= now) &&
                          (!ticket.sale_ends_at ||
                            new Date(ticket.sale_ends_at).getTime() >= now);

                        return (
                          <div
                            key={ticket.id}
                            className="rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-orange-50/40 p-5 shadow-sm"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-lg font-semibold text-slate-950">
                                {ticket.name}
                              </h3>

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
                              <p className="mt-2 text-sm leading-6 text-slate-600">
                                {ticket.description}
                              </p>
                            ) : null}

                            <div className="mt-3 space-y-1 text-sm text-slate-500">
                              <p>
                                Capacity: {ticket.capacity ?? "Unlimited"}
                                {remaining != null
                                  ? ` • ${remaining} left`
                                  : ""}
                              </p>
                              <p>
                                Sale starts:{" "}
                                {formatDateTime(ticket.sale_starts_at)}
                              </p>
                              <p>
                                Sale ends: {formatDateTime(ticket.sale_ends_at)}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section id="details" className={tabPanelClass(activeEventTab === "details", "scroll-mt-24 grid gap-6 lg:grid-cols-2")}>
                  <div className="rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur sm:p-8">
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      Refund Policy
                    </h2>
                    <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                      {typedEvent.refund_policy ||
                        "No refund policy has been provided."}
                    </p>
                  </div>

                  <div className="rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur sm:p-8">
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      FAQ
                    </h2>
                    <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                      {typedEvent.faq || "No FAQ has been provided."}
                    </p>
                  </div>
                </section>
              </div>

              <div className="space-y-6">
                <section
                  id="registration"
                  className={tabPanelClass(activeEventTab === "tickets", "scroll-mt-24 rounded-[2rem] border border-orange-200/80 bg-white/95 p-6 shadow-xl shadow-orange-100/70 ring-1 ring-orange-100 backdrop-blur sm:p-8")}
                >
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-1.5 rounded-full bg-gradient-to-b from-orange-400 via-fuchsia-500 to-violet-600" />
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      {typedEvent.event_type === "group_class"
                        ? "Enrollment"
                        : "Registration"}
                    </h2>
                  </div>

                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    {topHint}
                  </p>

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
                    <div className="rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50 p-4 shadow-sm">
                      <p className="text-sm text-slate-500">
                        Registration Opens
                      </p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatDateTime(typedEvent.registration_opens_at)}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50 p-4 shadow-sm">
                      <p className="text-sm text-slate-500">
                        Registration Closes
                      </p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatDateTime(typedEvent.registration_closes_at)}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50 p-4 shadow-sm">
                      <p className="text-sm text-slate-500">Account Required</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {typedEvent.account_required_for_registration
                          ? "Yes"
                          : "No"}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50 p-4 shadow-sm">
                      <p className="text-sm text-slate-500">Capacity</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {typedEvent.capacity ?? "Not specified"}
                      </p>
                      {typedEvent.capacity != null ? (
                        <p className="mt-1 text-sm text-slate-500">
                          {eventRemainingCapacity} spots remaining
                        </p>
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
                      <p className="text-sm font-medium text-amber-900">
                        Payment not completed
                      </p>
                      <p className="mt-1 text-sm text-amber-800">
                        Your registration was saved. Retry Stripe Checkout to
                        finish payment.
                      </p>

                      <form
                        action={retryEventRegistrationCheckoutAction}
                        className="mt-4"
                      >
                        <input
                          type="hidden"
                          name="eventSlug"
                          value={typedEvent.slug}
                        />
                        <input
                          type="hidden"
                          name="registrationId"
                          value={retryRegistration.id}
                        />
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
                        accountRequiredForRegistration={
                          typedEvent.account_required_for_registration
                        }
                        isAuthenticated={!!user}
                      />
                    ) : allowWaitlistJoin ? (
                      <RegistrationForm
                        eventSlug={typedEvent.slug}
                        ticketTypes={allActiveTicketTypes}
                        currentUserEmail={user?.email ?? ""}
                        isSoldOut={true}
                        waitlistEnabled={typedEvent.waitlist_enabled}
                        accountRequiredForRegistration={
                          typedEvent.account_required_for_registration
                        }
                        isAuthenticated={!!user}
                      />
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                        Registration is not available yet because no active
                        ticket types are currently on sale.
                      </div>
                    )}
                  </div>
                </section>

                <section id="host" className={tabPanelClass(activeEventTab === "host", "scroll-mt-24 rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-lg shadow-slate-200/50 ring-1 ring-slate-100 backdrop-blur sm:p-8")}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-600">
                    {eventHost.hostType}
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                    Hosted by
                  </h2>

                  <div className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
                    <p className="text-base font-semibold text-slate-950">
                      {eventHost.name}
                    </p>

                    {eventHost.description ? (
                      <p>{eventHost.description}</p>
                    ) : (
                      <p>Host details are coming soon.</p>
                    )}
                  </div>

                  <div className="mt-5 flex flex-wrap gap-3">
                    {eventHost.websiteUrl ? (
                      <a
                        href={eventHost.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Visit Host Website
                      </a>
                    ) : null}

                    {eventHost.contactEmail ? (
                      <a
                        href={`mailto:${eventHost.contactEmail}`}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Contact Host
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


