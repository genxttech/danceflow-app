import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  Sparkles,
  Ticket,
  Globe2,
  Star,
  MapPin,
  Wallet,
  Users,
  ArrowRight,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type EventRow = {
  id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  event_type: string;
  city: string | null;
  state: string | null;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  visibility: string;
  featured: boolean;
  status: string;
  registration_required: boolean;
  beginner_friendly: boolean;
  public_directory_enabled: boolean;
  organizers:
    | { id?: string; name: string; slug: string }
    | { id?: string; name: string; slug: string }[]
    | null;
};

type RegistrationSummaryRow = {
  id: string;
  event_id: string;
  status: string;
  payment_status: string | null;
  total_price: number | null;
  total_amount: number | null;
  currency: string | null;
};

type AttendanceSummaryRow = {
  id: string;
  event_registration_id: string;
  status: string;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
  public_name: string | null;
};

function isOrganizerWorkspaceRole(role: string | null | undefined) {
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

function canManageOrganizerProfile(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "organizer_owner" || role === "organizer_admin";
}

function canManageBilling(role: string | null | undefined, isPlatformAdminRole: boolean) {
  if (isPlatformAdminRole) return true;
  return role === "studio_owner" || role === "organizer_owner";
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
  if (value === "group_class") return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
  if (value === "practice_party") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (value === "workshop") return "bg-violet-50 text-violet-700 ring-1 ring-violet-200";
  if (value === "social_dance") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (value === "competition") return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  if (value === "showcase") return "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200";
  if (value === "festival") return "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200";
  if (value === "special_event") return "bg-orange-50 text-orange-700 ring-1 ring-orange-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function visibilityLabel(value: string) {
  if (value === "public") return "Public";
  if (value === "unlisted") return "Unlisted";
  if (value === "private") return "Private";
  return value;
}

function visibilityBadgeClass(value: string) {
  if (value === "public") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (value === "unlisted") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (value === "private") return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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

function getOrganizer(
  value:
    | { id?: string; name: string; slug: string }
    | { id?: string; name: string; slug: string }[]
    | null
) {
  return Array.isArray(value) ? value[0] : value;
}

function eventListingHint(eventType: string, visibility: string) {
  const publicHint =
    visibility === "public"
      ? "Shown in public offerings."
      : visibility === "unlisted"
        ? "Available by direct link only."
        : "Internal/private only.";

  if (eventType === "group_class") {
    return `Class offering managed as an event. ${publicHint}`;
  }

  if (eventType === "practice_party") {
    return `Practice party managed as an event. ${publicHint}`;
  }

  return publicHint;
}

function fmtCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
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

export default async function EventsPage() {
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
    { data: workspace, error: workspaceError },
    { data: events, error: eventsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, public_name")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("events")
      .select(`
        id,
        organizer_id,
        name,
        slug,
        event_type,
        city,
        state,
        start_date,
        end_date,
        start_time,
        end_time,
        visibility,
        featured,
        status,
        registration_required,
        beginner_friendly,
        public_directory_enabled,
        organizers ( id, name, slug )
      `)
      .eq("studio_id", studioId)
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true })
      .order("name", { ascending: true }),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load events: ${eventsError.message}`);
  }

  const workspaceName = workspace?.public_name?.trim() || workspace?.name?.trim() || "Workspace";
  const organizerWorkspace = isOrganizerWorkspaceRole(context.studioRole);
  const showCreateEvent = canManageEvents(context.studioRole, context.isPlatformAdmin);
  const showOrganizerProfile = canManageOrganizerProfile(
    context.studioRole,
    context.isPlatformAdmin
  );
  const showBilling = canManageBilling(context.studioRole, context.isPlatformAdmin);

  const typedEvents = (events ?? []) as EventRow[];
  const eventIds = typedEvents.map((event) => event.id);

  let typedRegistrations: RegistrationSummaryRow[] = [];
  let typedAttendance: AttendanceSummaryRow[] = [];

  if (eventIds.length > 0) {
    const [
      { data: registrationRows, error: registrationsError },
      { data: attendanceRows, error: attendanceError },
    ] = await Promise.all([
      supabase
        .from("event_registrations")
        .select(`
          id,
          event_id,
          status,
          payment_status,
          total_price,
          total_amount,
          currency
        `)
        .in("event_id", eventIds),

      supabase
        .from("attendance_records")
        .select(`
          id,
          event_registration_id,
          status
        `),
    ]);

    if (registrationsError) {
      throw new Error(`Failed to load event reporting: ${registrationsError.message}`);
    }

    if (attendanceError) {
      throw new Error(`Failed to load attendance reporting: ${attendanceError.message}`);
    }

    typedRegistrations = (registrationRows ?? []) as RegistrationSummaryRow[];
    typedAttendance = (attendanceRows ?? []) as AttendanceSummaryRow[];
  }

  const attendanceByRegistrationId = new Map(
    typedAttendance.map((row) => [row.event_registration_id, row])
  );

  const registrationsByEventId = new Map<string, RegistrationSummaryRow[]>();
  for (const registration of typedRegistrations) {
    const current = registrationsByEventId.get(registration.event_id) ?? [];
    current.push(registration);
    registrationsByEventId.set(registration.event_id, current);
  }

  const groupClasses = typedEvents.filter((event) => event.event_type === "group_class");
  const publishedCount = typedEvents.filter(
    (event) => event.status === "published" || event.status === "open"
  ).length;
  const featuredCount = typedEvents.filter((event) => event.featured).length;
  const publicOfferingsCount = typedEvents.filter(
    (event) =>
      (event.status === "published" || event.status === "open") &&
      event.visibility === "public"
  ).length;
  const publicGroupClassesCount = groupClasses.filter(
    (event) =>
      (event.status === "published" || event.status === "open") &&
      event.visibility === "public"
  ).length;
  const publicDirectoryCount = typedEvents.filter(
    (event) => event.public_directory_enabled
  ).length;
  const discoveryReadyCount = typedEvents.filter(
    (event) =>
      event.public_directory_enabled &&
      event.visibility === "public" &&
      (event.status === "published" || event.status === "open") &&
      Boolean(event.organizer_id)
  ).length;

  const totalRegistrations = typedRegistrations.length;
  const totalCheckedIn = typedRegistrations.filter((row) => {
    const attendance = attendanceByRegistrationId.get(row.id);
    return attendance?.status === "checked_in" || attendance?.status === "attended";
  }).length;
  const totalGrossRevenue = typedRegistrations.reduce((sum, row) => {
    if (row.payment_status !== "paid" && row.payment_status !== "partial") {
      return sum;
    }
    return sum + Number(row.total_amount ?? row.total_price ?? 0);
  }, 0);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {organizerWorkspace ? "DanceFlow Organizer Workspace" : "DanceFlow Events"}
              </p>

              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {organizerWorkspace ? "Organizer Dashboard" : "Events"}
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                {organizerWorkspace
                  ? `Manage event publishing, registrations, discovery visibility, and ticketing operations for ${workspaceName}.`
                  : "Manage public and internal offerings like group classes, practice parties, workshops, socials, and special events."}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {organizerWorkspace ? (
                <>
                  {showOrganizerProfile ? (
                    <Link
                      href="/app/organizers"
                      className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                    >
                      Organizer Profile
                    </Link>
                  ) : null}

                  {showBilling ? (
                    <Link
                      href="/app/settings/billing"
                      className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                    >
                      Billing & Payouts
                    </Link>
                  ) : null}
                </>
              ) : (
                <Link
                  href="/app"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                >
                  Back to Dashboard
                </Link>
              )}

              {showCreateEvent ? (
                <Link
                  href="/app/events/new"
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  New Event
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                {organizerWorkspace ? "Publishing controls live here" : "Group Classes Live Here"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                {organizerWorkspace
                  ? "Organizer success depends on getting events public, directory-enabled, and properly linked so dancers can actually find and register."
                  : "Group classes are managed as events, not standard appointments. Use visibility settings to control whether a class is public, unlisted, or private."}
              </p>
            </div>

            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
              <h2 className="text-lg font-semibold text-orange-950">
                {organizerWorkspace ? "Discovery readiness matters" : "Discovery and organizer publishing"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-orange-900">
                Discovery-ready events should be public, directory-enabled, and linked to
                an organizer so dancers can actually find and register for them.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total Events" value={typedEvents.length} icon={CalendarDays} />
        <StatCard label="Published / Open" value={publishedCount} icon={Ticket} />
        <StatCard label="Public Offerings" value={publicOfferingsCount} icon={Globe2} />
        <StatCard label="Discovery Ready" value={discoveryReadyCount} icon={Star} />
        <StatCard label="Registrations" value={totalRegistrations} icon={Users} />
        <StatCard label="Checked In" value={totalCheckedIn} icon={Sparkles} />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Group Classes</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{groupClasses.length}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Featured Events</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{featuredCount}</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Gross Revenue</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {fmtCurrency(totalGrossRevenue)}
          </p>
        </div>
      </div>

      {organizerWorkspace ? (
        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Globe2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Visibility
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Push more events public
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Public, directory-enabled events are the ones dancers can actually find
                  through discovery and public listings.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <Wallet className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Revenue
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Track registrations and money
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Use this page as the organizer home for ticketing performance, payment
                  status, and event-by-event revenue.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                <MapPin className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Next Action
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Finish organizer setup
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Make sure billing, organizer profile, and public discovery settings are
                  complete before launch.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Event Listings</h2>
          <p className="mt-1 text-sm text-slate-500">
            {organizerWorkspace
              ? "All organizer-managed event offerings in one operational view."
              : "All organizer and public-facing event offerings in one branded workspace."}
          </p>
        </div>

        {typedEvents.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-medium text-slate-900">No events yet</p>
            <p className="mt-2 text-sm text-slate-500">
              Create your first event offering to start publishing classes, socials,
              and special events.
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
              const organizer = getOrganizer(event.organizers);
              const discoveryReady =
                event.public_directory_enabled &&
                event.visibility === "public" &&
                (event.status === "published" || event.status === "open") &&
                Boolean(event.organizer_id);

              const eventRegistrations = registrationsByEventId.get(event.id) ?? [];
              const defaultCurrency =
                eventRegistrations.find((row) => row.currency)?.currency ?? "USD";

              const totalRegistrationsForEvent = eventRegistrations.length;
              const paidCount = eventRegistrations.filter(
                (row) => row.payment_status === "paid"
              ).length;
              const pendingPaymentCount = eventRegistrations.filter(
                (row) => row.payment_status === "pending"
              ).length;
              const checkedInCount = eventRegistrations.filter((row) => {
                const attendance = attendanceByRegistrationId.get(row.id);
                return attendance?.status === "checked_in" || attendance?.status === "attended";
              }).length;
              const grossRevenue = eventRegistrations.reduce((sum, row) => {
                if (row.payment_status !== "paid" && row.payment_status !== "partial") {
                  return sum;
                }
                return sum + Number(row.total_amount ?? row.total_price ?? 0);
              }, 0);

              return (
                <div key={event.id} className="px-6 py-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xl font-semibold text-slate-950">{event.name}</h3>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                            event.status
                          )}`}
                        >
                          {event.status}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${eventTypeBadgeClass(
                            event.event_type
                          )}`}
                        >
                          {eventTypeLabel(event.event_type)}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${visibilityBadgeClass(
                            event.visibility
                          )}`}
                        >
                          {visibilityLabel(event.visibility)}
                        </span>

                        {event.featured ? (
                          <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">
                            Featured
                          </span>
                        ) : null}

                        {event.registration_required ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            Registration Required
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {event.public_directory_enabled ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            Public Directory On
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            Public Directory Off
                          </span>
                        )}

                        {event.beginner_friendly ? (
                          <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                            Beginner Friendly
                          </span>
                        ) : null}

                        {organizer ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            Organizer Linked
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                            No Organizer
                          </span>
                        )}

                        {discoveryReady ? (
                          <span className="inline-flex rounded-full bg-[var(--brand-primary-soft)] px-2.5 py-1 text-xs font-medium text-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/15">
                            Discovery Ready
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                            Needs Discovery Setup
                          </span>
                        )}
                      </div>

                      <p className="mt-3 text-sm text-slate-500">
                        Organizer: {organizer?.name ?? "None"} • /events/{event.slug}
                      </p>

                      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-500">
                        <span>{formatDateRange(event.start_date, event.end_date)}</span>
                        <span>{formatTimeRange(event.start_time, event.end_time)}</span>
                        <span>
                          {[event.city, event.state].filter(Boolean).join(", ") || "No location"}
                        </span>
                      </div>

                      <p className="mt-3 text-sm leading-7 text-slate-600">
                        {eventListingHint(event.event_type, event.visibility)}
                      </p>

                      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Registrations</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {totalRegistrationsForEvent}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Paid</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {paidCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Pending Pay</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {pendingPaymentCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Checked In</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {checkedInCount}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs text-slate-500">Gross Revenue</p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {fmtCurrency(grossRevenue, defaultCurrency)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0">
                      <Link
                        href={`/app/events/${event.id}`}
                        className="inline-flex items-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        View Event
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}