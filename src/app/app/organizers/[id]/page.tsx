import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  CalendarDays,
  Globe2,
  Mail,
  MapPin,
  Phone,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type OrganizerPageParams = Promise<{
  id: string;
}>;

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website_url: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  city: string | null;
  state: string | null;
  active: boolean;
  created_at: string;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  start_date: string;
  end_date: string;
  visibility: string;
  status: string;
  public_directory_enabled: boolean;
};

type RegistrationSummaryRow = {
  id: string;
  event_id: string;
  payment_status: string | null;
  total_price: number | string | null;
  total_amount: number | string | null;
  currency: string | null;
};


function activeBadgeClass(active: boolean) {
  return active
    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
    : "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

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

function formatDateTime(value: string) {
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
    currency: currency || "USD",
  }).format(Number.isFinite(value) ? value : 0);
}

function isPaidRegistration(row: RegistrationSummaryRow) {
  const status = (row.payment_status ?? "").trim().toLowerCase();
  return status === "paid" || status === "partial";
}

function needsPaymentReview(row: RegistrationSummaryRow) {
  const status = (row.payment_status ?? "").trim().toLowerCase();
  return status === "pending" || status === "unpaid" || status === "partial";
}


function canManageOrganizers(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner" || role === "organizer_admin";
}

function canManageEvents(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;

  return (
    role === "studio_owner" ||
    role === "studio_admin" ||
    role === "organizer_owner" ||
    role === "organizer_admin"
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
    </div>
  );
}

export default async function OrganizerDetailPage({
  params,
}: {
  params: OrganizerPageParams;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!canManageOrganizers(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app");
  }

  const { data: organizer, error: organizerError } = await supabase
    .from("organizers")
    .select(`
      id,
      name,
      slug,
      description,
      contact_email,
      contact_phone,
      website_url,
      logo_url,
      cover_image_url,
      city,
      state,
      active,
      created_at
    `)
    .eq("id", id)
    .eq("studio_id", context.studioId)
    .maybeSingle<OrganizerRow>();

  if (organizerError) {
    throw new Error(`Failed to load organizer: ${organizerError.message}`);
  }

  if (!organizer) {
    notFound();
  }

  const { data: linkedEvents, error: linkedEventsError } = await supabase
    .from("events")
    .select(`
      id,
      name,
      slug,
      event_type,
      start_date,
      end_date,
      visibility,
      status,
      public_directory_enabled
    `)
    .eq("studio_id", context.studioId)
    .eq("organizer_id", organizer.id)
    .order("start_date", { ascending: true })
    .order("name", { ascending: true });

  if (linkedEventsError) {
    throw new Error(`Failed to load organizer events: ${linkedEventsError.message}`);
  }

  const typedEvents = (linkedEvents ?? []) as EventRow[];
  const eventIds = typedEvents.map((event) => event.id);

  const { data: registrationSummary, error: registrationSummaryError } =
    eventIds.length > 0
      ? await supabase
          .from("event_registrations")
          .select("id, event_id, payment_status, total_price, total_amount, currency")
          .eq("studio_id", context.studioId)
          .in("event_id", eventIds)
      : { data: [], error: null };

  if (registrationSummaryError) {
    throw new Error(
      `Failed to load organizer registration summary: ${registrationSummaryError.message}`,
    );
  }

  const registrationsByEventId = new Map<string, RegistrationSummaryRow[]>();
  for (const registration of (registrationSummary ?? []) as RegistrationSummaryRow[]) {
    const registrations = registrationsByEventId.get(registration.event_id) ?? [];
    registrations.push(registration);
    registrationsByEventId.set(registration.event_id, registrations);
  }

  const organizerRegistrations = Array.from(registrationsByEventId.values()).flat();
  const organizerPaidRegistrations = organizerRegistrations.filter(isPaidRegistration);
  const organizerNeedsPaymentReview = organizerRegistrations.filter(needsPaymentReview);
  const organizerCurrency =
    organizerRegistrations.find((row) => row.currency)?.currency ?? "USD";
  const organizerGrossRevenue = organizerPaidRegistrations.reduce((sum, row) => {
    return sum + Number(row.total_amount ?? row.total_price ?? 0);
  }, 0);

  const publicEvents = typedEvents.filter((event) => event.visibility === "public").length;
  const publishedEvents = typedEvents.filter(
    (event) => event.status === "published" || event.status === "open"
  ).length;
  const discoveryReadyEvents = typedEvents.filter(
    (event) =>
      event.public_directory_enabled &&
      event.visibility === "public" &&
      (event.status === "published" || event.status === "open")
  ).length;

  const showCreateEvent = canManageEvents(context.studioRole, context.isPlatformAdmin);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div
          className="px-6 py-8 text-white md:px-8"
          style={{
            background:
              organizer.cover_image_url?.trim()
                ? `linear-gradient(rgba(47,15,92,0.72), rgba(75,46,131,0.82)), url(${organizer.cover_image_url}) center/cover`
                : "linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)",
          }}
        >
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Organizer Profile
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
                  {organizer.name}
                </h1>

                <span
                  className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${activeBadgeClass(
                    organizer.active
                  )}`}
                >
                  {organizer.active ? "Active" : "Inactive"}
                </span>
              </div>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                {organizer.description ||
                  "This organizer profile powers public event discovery and organizer-linked event publishing."}
              </p>

              <p className="mt-4 text-sm text-white/75">/organizers/{organizer.slug}</p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/organizers"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Organizers
              </Link>

              <Link
                href="/app/events"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Back to Events
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Linked Events" value={typedEvents.length} />
            <StatCard label="Registrations" value={organizerRegistrations.length} />
            <StatCard label="Needs Payment Review" value={organizerNeedsPaymentReview.length} />
            <StatCard
              label="Ticket Revenue"
              value={formatCurrency(organizerGrossRevenue, organizerCurrency)}
            />
          </div>
        </div>
      </section>

      <section className="grid gap-8 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-8">
          <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Sparkles className="h-5 w-5" />
              </div>

              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Organizer Details
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                  Public-facing organizer identity
                </h2>
              </div>
            </div>

            <div className="mt-6 space-y-4 text-sm text-slate-600">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Created
                </p>
                <p className="mt-2 font-medium text-slate-900">
                  {formatDateTime(organizer.created_at)}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Public Slug
                </p>
                <p className="mt-2 font-medium text-slate-900">
                  /organizers/{organizer.slug}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Description
                </p>
                <p className="mt-2 leading-7 text-slate-700">
                  {organizer.description || "No description added yet."}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Globe2 className="h-5 w-5" />
              </div>

              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Contact & Visibility
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                  Public organizer profile information
                </h2>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-2 text-slate-500">
                  <Mail className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    Contact Email
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium text-slate-900">
                  {organizer.contact_email || "No contact email"}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-2 text-slate-500">
                  <Phone className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    Contact Phone
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium text-slate-900">
                  {organizer.contact_phone || "No contact phone"}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-2 text-slate-500">
                  <MapPin className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    Location
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium text-slate-900">
                  {[organizer.city, organizer.state].filter(Boolean).join(", ") || "No location"}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-2 text-slate-500">
                  <Globe2 className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    Website
                  </span>
                </div>
                <p className="mt-2 break-all text-sm font-medium text-slate-900">
                  {organizer.website_url || "No website"}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 className="text-lg font-semibold text-slate-900">Linked Events</h2>
            <p className="mt-1 text-sm text-slate-500">
              Events currently assigned to this organizer profile, with quick links into ticket sales, registrations, check-in, and payment review.
            </p>
          </div>

          {typedEvents.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-base font-medium text-slate-900">
                No events linked yet
              </p>
              <p className="mt-2 text-sm text-slate-500">
                Assign this organizer to events to strengthen public discovery and
                organizer branding.
              </p>

              {showCreateEvent ? (
                <div className="mt-6">
                  <Link
                    href="/app/events/new"
                    className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-white hover:opacity-95"
                  >
                    <span>Create Event</span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {typedEvents.map((event) => {
                const eventRegistrations = registrationsByEventId.get(event.id) ?? [];
                const eventPaidRegistrations = eventRegistrations.filter(isPaidRegistration);
                const eventNeedsPaymentReview = eventRegistrations.filter(needsPaymentReview);
                const eventCurrency =
                  eventRegistrations.find((row) => row.currency)?.currency ?? "USD";
                const eventGrossRevenue = eventPaidRegistrations.reduce((sum, row) => {
                  return sum + Number(row.total_amount ?? row.total_price ?? 0);
                }, 0);

                return (
                <div key={event.id} className="px-6 py-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-900">
                          {event.name}
                        </h3>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            event.status
                          )}`}
                        >
                          {event.status}
                        </span>

                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {eventTypeLabel(event.event_type)}
                        </span>

                        {event.public_directory_enabled ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            Directory On
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-2 text-sm text-slate-500">
                        /events/{event.slug}
                      </p>

                      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                        <span>{formatDateRange(event.start_date, event.end_date)}</span>
                        <span>{event.visibility}</span>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Registrations</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {eventRegistrations.length}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Needs Payment Review</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {eventNeedsPaymentReview.length}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Ticket Revenue</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {formatCurrency(eventGrossRevenue, eventCurrency)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid shrink-0 gap-2 sm:min-w-48">
                      <Link
                        href={`/app/events/${event.id}`}
                        className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                      >
                        View Event
                      </Link>

                      <Link
                        href={`/app/events/${event.id}/registrations`}
                        className="inline-flex items-center justify-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Registrations
                      </Link>

                      <div className="grid grid-cols-2 gap-2">
                        <Link
                          href="/app/events/sell-tickets"
                          className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Sell Tickets
                        </Link>

                        <Link
                          href={`/app/events/${event.id}/check-in`}
                          className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Check-In
                        </Link>
                      </div>

                      <Link
                        href={`/app/events/${event.id}/tickets`}
                        className="inline-flex items-center justify-center rounded-xl border border-[var(--brand-primary)]/20 bg-[var(--brand-primary-soft)] px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]/80"
                      >
                        Ticket Setup
                      </Link>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}