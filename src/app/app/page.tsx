import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Globe2,
  Sparkles,
  Star,
  Ticket,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { syncStudioNotifications } from "@/lib/notifications/sync";
import {
  getAccessibleStudios,
  getCurrentStudioContext,
} from "@/lib/auth/studio";

type WorkspaceRow = {
  id: string;
  name: string | null;
  stripe_connected_account_id: string | null;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  event_type: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  visibility: string;
  status: string;
  featured: boolean;
  public_directory_enabled: boolean;
};

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
};

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  payment_status: string | null;
};

type AttendanceRow = {
  id: string;
  event_registration_id: string;
  status: string;
};

function isOrganizerRole(role: string | null | undefined) {
  const normalized = (role ?? "").trim().toLowerCase();
  return normalized.startsWith("organizer_");
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateRange(startDate: string, endDate: string) {
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

function StatCard({
  label,
  value,
  icon: Icon,
  subtext,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  subtext?: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
          {subtext ? <p className="mt-2 text-sm text-slate-500">{subtext}</p> : null}
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

export default async function AppDashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const accessibleStudios = await getAccessibleStudios();
  const organizerWorkspace = isOrganizerRole(context.studioRole);

  const currentWorkspace =
    accessibleStudios.find((workspace) => workspace.studioId === studioId) ??
    accessibleStudios.find((workspace) => workspace.isSelected) ??
    null;

  await syncStudioNotifications(studioId);

  const [
    { data: workspace, error: workspaceError },
    { data: events, error: eventsError },
    { data: organizers, error: organizersError },
    { data: notifications, error: notificationsError },
    { data: registrations, error: registrationsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, stripe_connected_account_id")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
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
        visibility,
        status,
        featured,
        public_directory_enabled
      `)
      .eq("studio_id", studioId)
      .order("start_date", { ascending: true })
      .order("start_time", { ascending: true })
      .limit(8),

    supabase
      .from("organizers")
      .select("id, name, slug, active")
      .eq("studio_id", studioId)
      .order("name", { ascending: true }),

    supabase
      .from("notifications")
      .select(`
        id,
        type,
        title,
        body,
        read_at,
        created_at
      `)
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(6),

    supabase
      .from("event_registrations")
      .select(`
        id,
        event_id,
        payment_status
      `)
      .eq("studio_id", studioId),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (eventsError) {
    throw new Error(`Failed to load dashboard events: ${eventsError.message}`);
  }

  if (organizersError) {
    throw new Error(`Failed to load dashboard organizers: ${organizersError.message}`);
  }

  if (notificationsError) {
    throw new Error(`Failed to load dashboard notifications: ${notificationsError.message}`);
  }

  if (registrationsError) {
    throw new Error(`Failed to load dashboard registrations: ${registrationsError.message}`);
  }

  const typedEvents = (events ?? []) as EventRow[];
  const typedOrganizers = (organizers ?? []) as OrganizerRow[];
  const typedNotifications = (notifications ?? []) as NotificationRow[];
  const typedRegistrations = (registrations ?? []) as RegistrationRow[];

  const registrationIds = typedRegistrations.map((row) => row.id);

  let typedAttendance: AttendanceRow[] = [];
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
      throw new Error(`Failed to load dashboard attendance: ${attendanceError.message}`);
    }

    typedAttendance = (attendanceRows ?? []) as AttendanceRow[];
  }

  const totalEvents = typedEvents.length;
  const publishedCount = typedEvents.filter(
    (event) => event.status === "published" || event.status === "open"
  ).length;
  const publicCount = typedEvents.filter((event) => event.visibility === "public").length;
  const discoveryReadyCount = typedEvents.filter(
    (event) =>
      event.public_directory_enabled &&
      event.visibility === "public" &&
      (event.status === "published" || event.status === "open")
  ).length;
  const unreadCount = typedNotifications.filter((item) => !item.read_at).length;
  const activeOrganizerCount = typedOrganizers.filter((item) => item.active).length;
  const primaryOrganizer = typedOrganizers[0] ?? null;

  const paidRegistrationsCount = typedRegistrations.filter(
    (row) => row.payment_status === "paid" || row.payment_status === "partial"
  ).length;

  const checkedInRegistrationIds = new Set(
    typedAttendance
      .filter((row) => row.status === "checked_in")
      .map((row) => row.event_registration_id)
  );

  const checkedInCount = checkedInRegistrationIds.size;
  const pendingCheckInCount = Math.max(typedRegistrations.length - checkedInCount, 0);
  const payoutsReady = Boolean(workspace?.stripe_connected_account_id);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {organizerWorkspace
                  ? "DanceFlow Organizer Dashboard"
                  : "DanceFlow Studio Dashboard"}
              </p>

              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {organizerWorkspace ? "Organizer Dashboard" : "Studio Dashboard"}
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                {organizerWorkspace
                  ? "Run your organizer operations from one place, including events, registrations, check-in, organizer profile status, and recent alerts."
                  : "See the health of your current studio workspace at a glance, including clients, schedule, events, and recent alerts."}
              </p>

              {currentWorkspace ? (
                <p className="mt-4 text-sm text-white/75">
                  Current workspace:{" "}
                  <span className="font-medium text-white">
                    {currentWorkspace.studioName}
                  </span>
                </p>
              ) : workspace?.name ? (
                <p className="mt-4 text-sm text-white/75">
                  Current workspace:{" "}
                  <span className="font-medium text-white">{workspace.name}</span>
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-3">
              {organizerWorkspace ? (
                <>
                  <Link
                    href="/app/events/new"
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Create Event
                  </Link>
                  <Link
                    href="/app/events/registrations"
                    className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                  >
                    View Registrations
                  </Link>
                </>
              ) : (
                <>
                  <Link
                    href="/app/schedule"
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Open Schedule
                  </Link>
                  <Link
                    href="/app/notifications"
                    className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                  >
                    View Notifications
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          {organizerWorkspace ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <StatCard
                label="Events"
                value={totalEvents}
                icon={CalendarDays}
                subtext="Current loaded event set"
              />
              <StatCard label="Published / Open" value={publishedCount} icon={Ticket} />
              <StatCard label="Registrations" value={typedRegistrations.length} icon={ClipboardList} />
              <StatCard label="Checked In" value={checkedInCount} icon={CheckCircle2} />
              <StatCard label="Unread Notifications" value={unreadCount} icon={Bell} />
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <StatCard
                label="Events"
                value={totalEvents}
                icon={CalendarDays}
                subtext="Current loaded event set"
              />
              <StatCard label="Published / Open" value={publishedCount} icon={Ticket} />
              <StatCard label="Public" value={publicCount} icon={Globe2} />
              <StatCard label="Discovery Ready" value={discoveryReadyCount} icon={Star} />
              <StatCard label="Unread Notifications" value={unreadCount} icon={Bell} />
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <SectionCard
          title={organizerWorkspace ? "Event Snapshot" : "Workspace Snapshot"}
          subtitle={
            organizerWorkspace
              ? "A quick organizer-first summary of event publishing and readiness."
              : "A quick summary of events and workspace status."
          }
          action={
            <Link
              href="/app/events"
              className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
            >
              Open Events
            </Link>
          }
        >
          {typedEvents.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
              No events yet. Create your first event to begin publishing and discovery.
            </div>
          ) : (
            <div className="space-y-4">
              {typedEvents.slice(0, 5).map((event) => (
                <div
                  key={event.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-slate-900">
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
                      </div>

                      <p className="mt-2 text-sm text-slate-500">
                        {fmtDateRange(event.start_date, event.end_date)}
                      </p>

                      <div className="mt-2 flex flex-wrap gap-2">
                        {event.visibility === "public" ? (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                            Public
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            {event.visibility}
                          </span>
                        )}

                        {event.public_directory_enabled ? (
                          <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                            Directory On
                          </span>
                        ) : null}

                        {event.featured ? (
                          <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200">
                            Featured
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="shrink-0">
                      <Link
                        href={`/app/events/${event.id}`}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <span>Open</span>
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <div className="space-y-8">
          {organizerWorkspace && !payoutsReady ? (
            <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="max-w-xl">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                    Enable payouts
                  </p>
                  <p className="mt-2 text-sm leading-7 text-amber-900">
                    Connect payouts before taking paid registrations so DanceFlow can route ticket revenue to your organizer business.
                  </p>
                </div>
                <Link
                  href="/app/settings/billing"
                  className="inline-flex items-center justify-center rounded-xl bg-amber-900 px-4 py-3 text-sm font-medium text-white hover:bg-amber-800"
                >
                  Billing &amp; Payments
                </Link>
              </div>
            </div>
          ) : null}

          <SectionCard
            title="Organizer Profile"
            subtitle={
              organizerWorkspace
                ? "One organizer profile per organizer account."
                : "Organizer profiles available in this workspace."
            }
            action={
              primaryOrganizer ? (
                <Link
                  href={`/app/organizers/${primaryOrganizer.id}`}
                  className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                >
                  View Organizer
                </Link>
              ) : (
                <Link
                  href="/app/organizers/new"
                  className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                >
                  Create Organizer
                </Link>
              )
            }
          >
            {primaryOrganizer ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Primary organizer</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">
                  {primaryOrganizer.name}
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  /organizers/{primaryOrganizer.slug}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                    {primaryOrganizer.active ? "Active" : "Inactive"}
                  </span>
                  <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                    {activeOrganizerCount} organizer{activeOrganizerCount === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                No organizer profile yet.
              </div>
            )}
          </SectionCard>

          {organizerWorkspace ? (
            <SectionCard
              title="Registration & Check-In"
              subtitle="Today’s organizer operations at a glance."
              action={
                <Link
                  href="/app/events/registrations"
                  className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                >
                  Open Registrations
                </Link>
              }
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Registrations</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                    {typedRegistrations.length}
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Paid</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                    {paidRegistrationsCount}
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Still to Check In</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                    {pendingCheckInCount}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Link
                  href="/app/events/registrations"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  View Registration Hub
                </Link>
                <Link
                  href="/app/events/checkin"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Open Check-In Hub
                </Link>
              </div>
            </SectionCard>
          ) : (
            <SectionCard
              title="Recent Notifications"
              subtitle="Latest workspace alerts."
              action={
                <Link
                  href="/app/notifications"
                  className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                >
                  Open Notifications
                </Link>
              }
            >
              {typedNotifications.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  No recent notifications.
                </div>
              ) : (
                <div className="space-y-3">
                  {typedNotifications.slice(0, 4).map((notification) => (
                    <div
                      key={notification.id}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-slate-900">
                              {notification.title}
                            </p>
                            {!notification.read_at ? (
                              <span className="inline-flex rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white">
                                Unread
                              </span>
                            ) : null}
                          </div>
                          {notification.body ? (
                            <p className="mt-1 text-sm text-slate-600">
                              {notification.body}
                            </p>
                          ) : null}
                          <p className="mt-2 text-xs text-slate-500">
                            {fmtDateTime(notification.created_at)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}

          <SectionCard
            title="Quick Actions"
            subtitle={
              organizerWorkspace
                ? "Common organizer workflow shortcuts."
                : "Common studio workflow shortcuts."
            }
          >
            {organizerWorkspace ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Link
                  href="/app/events/new"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  New Event
                </Link>
                <Link
                  href="/app/events"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Manage Events
                </Link>
                <Link
                  href="/app/events/registrations"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Registration Hub
                </Link>
                <Link
                  href="/app/events/checkin"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Check-In Hub
                </Link>
                <Link
                  href="/app/organizers"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Organizer Profile
                </Link>
                <Link
                  href="/app/notifications"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Notifications
                </Link>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Link
                  href="/app/schedule"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Open Schedule
                </Link>
                <Link
                  href="/app/clients"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Manage Clients
                </Link>
                <Link
                  href="/app/leads"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Lead Inbox
                </Link>
                <Link
                  href="/app/events"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Events
                </Link>
                <Link
                  href="/app/payments"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Payments
                </Link>
                <Link
                  href="/app/notifications"
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                >
                  Notifications
                </Link>
              </div>
            )}
          </SectionCard>
        </div>
      </section>
    </div>
  );
}